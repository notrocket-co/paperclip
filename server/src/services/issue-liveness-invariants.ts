// THEA-2807 — Pillar 4: project-level liveness invariants.
//
// This module owns the digest-arming, phase auto-promote, and stagnation
// escalation flows for umbrella issues that have at least one active child.
//
// Wake-firing itself happens through the heartbeat service injected at
// service-construction time; the liveness module only decides WHEN to fire,
// what to write into the digest comment, and how to resolve the
// `escalation_target` token to an agent UUID.
//
// HARD CONSTRAINTS (CEO ACK addenda on THEA-2807, 2026-05-06):
//   1. NO comment posted by this service may contain the literal `@Miller`
//      token. Telegram bridge fires on the literal regardless of context;
//      only the CEO writes that token, only on THEA-1130. We enforce this
//      via the formatter (we never insert it) AND a defensive sanitize on
//      the comment-emit path (`sanitizeMillerToken`).
//   2. Phase cascade is single-hop only — `findPhaseToPromote` returns the
//      next phase, but the sweep does NOT recurse on the promoted children.
//   3. `digest_due_at` arming under simultaneous child transitions is an
//      atomic CAS — `WHERE digest_due_at IS NULL` — so only one transaction
//      wins the arm. Zero rows affected = "already armed, fine."

import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import {
  ISSUE_LIVENESS_ESCALATION_TOKENS,
  ISSUE_LIVENESS_INVARIANT_DEFAULTS,
  type IssueLivenessInvariants,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const CLOSED_STATUSES = ["done", "cancelled"] as const;
const STAGNATION_SCAN_LIMIT = 50;
const PHASE_PROMOTE_SCAN_LIMIT = 50;
const FIRE_DUE_DIGESTS_LIMIT = 50;

/**
 * Resolve a possibly-null persisted invariants payload into a fully-defaulted
 * record. This is the single source of truth for "what does this umbrella
 * actually require?" — every read site goes through here.
 */
export function resolveLivenessInvariants(
  raw: IssueLivenessInvariants | null | undefined,
): Required<IssueLivenessInvariants> {
  return {
    digestWithinMin: raw?.digestWithinMin ?? ISSUE_LIVENESS_INVARIANT_DEFAULTS.digestWithinMin,
    phasePromoteWithinMin:
      raw?.phasePromoteWithinMin ?? ISSUE_LIVENESS_INVARIANT_DEFAULTS.phasePromoteWithinMin,
    stagnationThresholdHours:
      raw?.stagnationThresholdHours ?? ISSUE_LIVENESS_INVARIANT_DEFAULTS.stagnationThresholdHours,
    escalationTarget: raw?.escalationTarget ?? ISSUE_LIVENESS_INVARIANT_DEFAULTS.escalationTarget,
  };
}

/**
 * The Telegram bridge fires on the literal `@Miller` token in any comment
 * body. The CEO is the sole authorized writer of that token (and only on
 * THEA-1130). The liveness service must never emit it, period — the
 * formatters below construct strings without it, and this final pass is a
 * defensive guard against future regressions.
 */
export function sanitizeMillerToken(body: string): string {
  return body.replace(/@Miller/gi, "Miller");
}

export interface ChildSummaryForDigest {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  phase: number | null;
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
  lastTransitionAt: Date | null;
  nextActions: Array<{
    kind: string;
    note?: string | null;
    targetAssigneeAgentId?: string | null;
  }> | null;
}

export interface DigestPayload {
  parentId: string;
  parentIdentifier: string | null;
  parentTitle: string;
  invariants: Required<IssueLivenessInvariants>;
  generatedAt: Date;
  children: ChildSummaryForDigest[];
}

/**
 * Format the digest comment body that gets posted on the parent. Tabular
 * roll-up so a human reader can scan child state in five seconds. The
 * formatter never inserts the literal `@Miller` token; the final
 * `sanitizeMillerToken` call is a belt-and-braces guard.
 */
export function formatDigestComment(payload: DigestPayload): string {
  const { parentIdentifier, parentTitle, invariants, generatedAt, children } = payload;
  const heading = parentIdentifier
    ? `## ${parentIdentifier} — liveness digest`
    : "## Liveness digest";

  const lines: string[] = [
    heading,
    "",
    `_Auto-generated ${generatedAt.toISOString()} per the ${invariants.digestWithinMin}-min digest invariant._`,
    "",
    `**Umbrella**: ${parentTitle}`,
    "",
  ];

  if (children.length === 0) {
    lines.push("_No active children — this umbrella has no work tracked._");
    return sanitizeMillerToken(lines.join("\n"));
  }

  const phasedChildren = children.some((child) => child.phase !== null);
  lines.push(
    phasedChildren
      ? "| Identifier | Phase | Status | Stuck (h) | Assignee | Next |"
      : "| Identifier | Status | Stuck (h) | Assignee | Next |",
  );
  lines.push(
    phasedChildren
      ? "| --- | --- | --- | --- | --- | --- |"
      : "| --- | --- | --- | --- | --- |",
  );

  for (const child of children) {
    const stuckHours = child.lastTransitionAt
      ? Math.max(0, (generatedAt.getTime() - child.lastTransitionAt.getTime()) / 3600_000)
      : null;
    const stuckCell = stuckHours === null ? "—" : stuckHours.toFixed(1);
    const assigneeCell = child.assigneeAgentName ?? (child.assigneeAgentId ? "(agent)" : "—");
    const identCell = child.identifier ?? child.id.slice(0, 8);
    const nextCell = formatChildNextActions(child.nextActions);
    if (phasedChildren) {
      const phaseCell = child.phase === null ? "—" : String(child.phase);
      lines.push(
        `| ${identCell} | ${phaseCell} | ${child.status} | ${stuckCell} | ${assigneeCell} | ${nextCell} |`,
      );
    } else {
      lines.push(`| ${identCell} | ${child.status} | ${stuckCell} | ${assigneeCell} | ${nextCell} |`);
    }
  }

  lines.push("");
  lines.push(
    "_Stagnation threshold: " +
      `${invariants.stagnationThresholdHours} h — escalation target: ${invariants.escalationTarget}._`,
  );

  return sanitizeMillerToken(lines.join("\n"));
}

function formatChildNextActions(
  nextActions: ChildSummaryForDigest["nextActions"],
): string {
  if (!nextActions || nextActions.length === 0) return "—";
  const first = nextActions[0];
  const kind = first.kind;
  const noteFragment = first.note ? ` — ${truncate(first.note, 60)}` : "";
  return `${kind}${noteFragment}`;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

/**
 * Atomic CAS arm of `digest_due_at` on the parent. If the column is NULL,
 * sets it to `now() + withinMin minutes` and returns true. If the column is
 * already set (race between concurrent child transitions), the UPDATE
 * affects 0 rows and we return false — the existing arm stands.
 *
 * Always bumps `last_child_transition_at` to keep stagnation accurate, even
 * when the digest was already armed.
 */
export async function armDigestOnChildTransition(
  db: Db,
  input: { parentId: string; now: Date; withinMin: number },
): Promise<{ armed: boolean }> {
  const dueAt = new Date(input.now.getTime() + input.withinMin * 60_000);
  // CAS-arm: only the first concurrent transition wins.
  const armResult = await db
    .update(issues)
    .set({ digestDueAt: dueAt, lastChildTransitionAt: input.now })
    .where(and(eq(issues.id, input.parentId), isNull(issues.digestDueAt)))
    .returning({ id: issues.id });

  if (armResult.length > 0) return { armed: true };

  // Already armed — still update last_child_transition_at so stagnation
  // accounting isn't broken by the race-loser.
  await db
    .update(issues)
    .set({ lastChildTransitionAt: input.now })
    .where(eq(issues.id, input.parentId));

  return { armed: false };
}

interface PhaseClosureSnapshot {
  phase: number;
  totalCount: number;
  closedCount: number;
}

/**
 * Returns the next phase to promote (`fromPhase + 1`) when every phase-N
 * child of the given umbrella is in {`done`, `cancelled`}. Returns null if
 * any phase-N child is still active OR if there are no phase-(N+1) children
 * waiting in `backlog`.
 *
 * Per CEO Sub-Q5: an all-cancelled phase still triggers promotion ("phase
 * fully cleared" is operationally identical regardless of disposition).
 *
 * Per CEO scope-clarification: single-hop only — the caller does NOT
 * recurse on the freshly-promoted phase even if its children are also
 * trivially closeable.
 */
export async function findPhaseToPromote(
  db: Db,
  input: { parentId: string; closedChildPhase: number | null },
): Promise<{ nextPhase: number; eligibleChildIds: string[] } | null> {
  const fromPhase = input.closedChildPhase ?? 0;

  // 1. Phase-N closure check.
  const phaseRows = await db
    .select({ status: issues.status, phase: issues.phase })
    .from(issues)
    .where(
      and(
        eq(issues.parentId, input.parentId),
        isNull(issues.hiddenAt),
        sql`coalesce(${issues.phase}, 0) = ${fromPhase}`,
      ),
    );

  if (phaseRows.length === 0) return null;
  const stillActive = phaseRows.some(
    (row) => !(CLOSED_STATUSES as readonly string[]).includes(row.status),
  );
  if (stillActive) return null;

  // 2. Find phase-(N+1) children currently in backlog.
  const nextPhase = fromPhase + 1;
  const promoteRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.parentId, input.parentId),
        isNull(issues.hiddenAt),
        eq(issues.status, "backlog"),
        eq(issues.phase, nextPhase),
      ),
    )
    .limit(PHASE_PROMOTE_SCAN_LIMIT);

  if (promoteRows.length === 0) return null;

  return {
    nextPhase,
    eligibleChildIds: promoteRows.map((row) => row.id),
  };
}

/**
 * Resolve `escalationTarget` to an agent UUID. Tokens:
 *   - `"ceo"` (default) → company CEO agent
 *   - `"creator"`       → umbrella's createdByAgentId
 *   - `<uuid>`          → literal agent id (returned as-is if it's a UUID)
 *
 * Per CEO Sub-Q6: never resolves to a userId. Special token `"miller"` is
 * NOT in the schema (validators reject it); we resolve it the same as
 * `"ceo"` defensively in case a future schema relaxation lands.
 */
export async function resolveEscalationTarget(
  db: Db,
  input: { companyId: string; createdByAgentId: string | null; target: string },
): Promise<string | null> {
  const target = input.target.toLowerCase();
  if (target === "ceo" || target === "miller") {
    const ceo = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.role, "ceo")))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return ceo?.id ?? null;
  }
  if (target === "creator") {
    return input.createdByAgentId ?? null;
  }
  // Literal UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.target)) {
    return input.target;
  }
  return null;
}

/**
 * Fetch every digest payload currently due for firing. Joins parent + all
 * non-hidden children; the caller assembles the comment + wake.
 */
export async function listDueDigestPayloads(
  db: Db,
  input: { now: Date; limit?: number },
): Promise<DigestPayload[]> {
  const limit = input.limit ?? FIRE_DUE_DIGESTS_LIMIT;
  const parentRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      companyId: issues.companyId,
      livenessInvariants: issues.livenessInvariants,
    })
    .from(issues)
    .where(
      and(
        isNotNull(issues.digestDueAt),
        lte(issues.digestDueAt, input.now),
        isNull(issues.hiddenAt),
      ),
    )
    .orderBy(asc(issues.digestDueAt))
    .limit(limit);

  if (parentRows.length === 0) return [];

  const parentIds = parentRows.map((row) => row.id);
  const childRows = await db
    .select({
      id: issues.id,
      parentId: issues.parentId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      phase: issues.phase,
      assigneeAgentId: issues.assigneeAgentId,
      nextActions: issues.nextActions,
      updatedAt: issues.updatedAt,
      completedAt: issues.completedAt,
      cancelledAt: issues.cancelledAt,
      startedAt: issues.startedAt,
    })
    .from(issues)
    .where(
      and(
        sql`${issues.parentId} = any(${sql.raw(`array['${parentIds.join("','")}']::uuid[]`)})`,
        isNull(issues.hiddenAt),
      ),
    );

  const agentIds = Array.from(
    new Set(
      childRows
        .map((row) => row.assigneeAgentId)
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  const agentMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        sql`${agents.id} = any(${sql.raw(`array['${agentIds.join("','")}']::uuid[]`)})`,
      );
    for (const row of agentRows) {
      agentMap.set(row.id, row.name);
    }
  }

  const childrenByParent = new Map<string, ChildSummaryForDigest[]>();
  for (const row of childRows) {
    if (!row.parentId) continue;
    const lastTransitionAt =
      row.completedAt ?? row.cancelledAt ?? row.startedAt ?? row.updatedAt ?? null;
    const arr = childrenByParent.get(row.parentId) ?? [];
    arr.push({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      phase: row.phase,
      assigneeAgentId: row.assigneeAgentId,
      assigneeAgentName: row.assigneeAgentId ? agentMap.get(row.assigneeAgentId) ?? null : null,
      lastTransitionAt,
      nextActions: (row.nextActions as ChildSummaryForDigest["nextActions"]) ?? null,
    });
    childrenByParent.set(row.parentId, arr);
  }

  return parentRows.map((parent) => ({
    parentId: parent.id,
    parentIdentifier: parent.identifier,
    parentTitle: parent.title,
    invariants: resolveLivenessInvariants(parent.livenessInvariants ?? null),
    generatedAt: input.now,
    children: (childrenByParent.get(parent.id) ?? []).sort((a, b) => {
      const phaseA = a.phase ?? 0;
      const phaseB = b.phase ?? 0;
      if (phaseA !== phaseB) return phaseA - phaseB;
      return (a.identifier ?? a.id).localeCompare(b.identifier ?? b.id);
    }),
  }));
}

/**
 * Clear `digest_due_at` after a successful digest emission. Stamps
 * `last_digest_at = now` so the stagnation predicate has a backstop when a
 * fully-quiet umbrella never received a child transition (yet still
 * generates a digest at first arming).
 */
export async function recordDigestFired(
  db: Db,
  input: { parentId: string; now: Date },
): Promise<void> {
  await db
    .update(issues)
    .set({ digestDueAt: null, lastDigestAt: input.now })
    .where(eq(issues.id, input.parentId));
}

interface StagnantUmbrellaRow {
  id: string;
  identifier: string | null;
  title: string;
  companyId: string;
  livenessInvariants: IssueLivenessInvariants | null;
  createdByAgentId: string | null;
  lastChildTransitionAt: Date | null;
  lastDigestAt: Date | null;
  createdAt: Date;
}

/**
 * Find umbrellas where:
 *   - liveness_invariants IS NOT NULL (umbrella opted in via backfill)
 *   - has at least one non-hidden, non-terminal child
 *   - max(last_child_transition_at, last_digest_at, created_at) is older
 *     than `stagnationThresholdHours` ago
 *
 * Per CEO risk-flag: a 100%-closed umbrella never triggers stagnation.
 * The "active children" subquery enforces that.
 */
export async function findStagnantUmbrellas(
  db: Db,
  input: { now: Date; limit?: number },
): Promise<StagnantUmbrellaRow[]> {
  const limit = input.limit ?? STAGNATION_SCAN_LIMIT;
  // postgres@3.4.x raw `db.execute(sql\`…\`)` does not coerce timestamptz to
  // Date — values come back as ISO strings. Type the SQL row accordingly so
  // the row mapping below knows it has to wrap each timestamp in `new Date()`.
  type StagnantRowSql = {
    id: string;
    identifier: string | null;
    title: string;
    company_id: string;
    liveness_invariants: IssueLivenessInvariants | null;
    created_by_agent_id: string | null;
    last_child_transition_at: string | null;
    last_digest_at: string | null;
    created_at: string;
  };
  const rawRows = await db.execute(sql`
    SELECT
      i.id,
      i.identifier,
      i.title,
      i.company_id,
      i.liveness_invariants,
      i.created_by_agent_id,
      i.last_child_transition_at,
      i.last_digest_at,
      i.created_at
    FROM issues i
    WHERE i.liveness_invariants IS NOT NULL
      AND i.hidden_at IS NULL
      AND i.status NOT IN ('done', 'cancelled')
      AND EXISTS (
        SELECT 1 FROM issues c
         WHERE c.parent_id = i.id
           AND c.hidden_at IS NULL
           AND c.status NOT IN ('done', 'cancelled')
      )
      AND GREATEST(
        COALESCE(i.last_child_transition_at, i.created_at),
        COALESCE(i.last_digest_at, i.created_at),
        i.created_at
      ) <
        ${input.now.toISOString()}::timestamptz - (
          (COALESCE((i.liveness_invariants->>'stagnationThresholdHours')::int, 24)) * INTERVAL '1 hour'
        )
    ORDER BY GREATEST(
        COALESCE(i.last_child_transition_at, i.created_at),
        COALESCE(i.last_digest_at, i.created_at),
        i.created_at
    ) ASC
    LIMIT ${limit}
  `);

  const rows = rawRows as unknown as StagnantRowSql[];
  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    companyId: row.company_id,
    livenessInvariants: row.liveness_invariants,
    createdByAgentId: row.created_by_agent_id,
    lastChildTransitionAt: row.last_child_transition_at ? new Date(row.last_child_transition_at) : null,
    lastDigestAt: row.last_digest_at ? new Date(row.last_digest_at) : null,
    createdAt: new Date(row.created_at),
  }));
}

export function buildStagnationEscalationBody(input: {
  identifier: string | null;
  title: string;
  invariants: Required<IssueLivenessInvariants>;
  hoursSinceLastSignal: number;
}): string {
  const ident = input.identifier ?? "this umbrella";
  const body = [
    `## ${ident} — stagnation escalation`,
    "",
    `No child of **${input.title}** has transitioned, and no digest has been posted, ` +
      `for ${input.hoursSinceLastSignal.toFixed(1)} hours ` +
      `(threshold: ${input.invariants.stagnationThresholdHours}h).`,
    "",
    `Liveness invariant escalation_target: ${input.invariants.escalationTarget}.`,
    "",
    "Pinging Miller is the CEO's call — surface this to him via the digest path if it warrants attention.",
  ].join("\n");
  return sanitizeMillerToken(body);
}

/**
 * Hook helper for the route layer: when a child issue transitions to a
 * terminal state and its parent declares a phase auto-promote invariant,
 * promote phase-(N+1) children from `backlog → todo` and return their ids
 * + the new phase for wake-firing on their assignees.
 */
export async function promotePhaseChildren(
  db: Db,
  input: { childIds: string[] },
): Promise<{ promoted: number }> {
  if (input.childIds.length === 0) return { promoted: 0 };
  const result = await db
    .update(issues)
    .set({ status: "todo", updatedAt: new Date() })
    .where(
      and(
        sql`${issues.id} = any(${sql.raw(`array['${input.childIds.join("','")}']::uuid[]`)})`,
        eq(issues.status, "backlog"),
      ),
    )
    .returning({ id: issues.id });
  return { promoted: result.length };
}

/**
 * Locate the parent that just had a phase-N child close, AND whose
 * invariants are non-null AND whose phase-(N+1) backlog is non-empty.
 * Returns the parent + new-phase + child-ids that should be wakable.
 *
 * Caller should run this BEFORE arming the digest, in the same hook, so
 * that a single child-close transition can both promote and arm.
 */
export async function maybePromotePhase(
  db: Db,
  input: {
    parentId: string;
    closedChildId: string;
    closedChildPhase: number | null;
  },
): Promise<{
  promoted: number;
  nextPhase: number | null;
  promotedChildren: Array<{ id: string; assigneeAgentId: string | null }>;
} | null> {
  const parent = await db
    .select({ livenessInvariants: issues.livenessInvariants, id: issues.id })
    .from(issues)
    .where(eq(issues.id, input.parentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!parent || parent.livenessInvariants === null) return null;

  const eligible = await findPhaseToPromote(db, {
    parentId: input.parentId,
    closedChildPhase: input.closedChildPhase,
  });
  if (!eligible) return null;

  const promotedRows = await db
    .update(issues)
    .set({ status: "todo", updatedAt: new Date() })
    .where(
      and(
        sql`${issues.id} = any(${sql.raw(`array['${eligible.eligibleChildIds.join("','")}']::uuid[]`)})`,
        eq(issues.status, "backlog"),
      ),
    )
    .returning({ id: issues.id, assigneeAgentId: issues.assigneeAgentId });

  if (promotedRows.length === 0) return null;
  return {
    promoted: promotedRows.length,
    nextPhase: eligible.nextPhase,
    promotedChildren: promotedRows.map((row) => ({
      id: row.id,
      assigneeAgentId: row.assigneeAgentId,
    })),
  };
}

/**
 * Heartbeat-callable: list every umbrella whose digest is due, format the
 * comment, post it, and return a wake-fan-out plan for the caller to
 * enqueue. Pure side-effect on the DB (writes the comment); the caller
 * fans out the wakes.
 */
export interface FireDueDigestsResult {
  fired: number;
  wakeups: Array<{
    parentId: string;
    parentAssigneeAgentId: string | null;
    commentId: string;
  }>;
}

export async function fireDueDigests(
  db: Db,
  input: {
    now: Date;
    limit?: number;
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => Promise<{ id: string }>;
  },
): Promise<FireDueDigestsResult> {
  const payloads = await listDueDigestPayloads(db, { now: input.now, limit: input.limit });
  if (payloads.length === 0) return { fired: 0, wakeups: [] };

  const wakeups: FireDueDigestsResult["wakeups"] = [];
  let fired = 0;
  for (const payload of payloads) {
    try {
      const body = formatDigestComment(payload);
      const comment = await input.addComment(payload.parentId, body, {
        agentId: undefined,
        userId: undefined,
        runId: null,
      });
      const parentRow = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, payload.parentId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      await recordDigestFired(db, { parentId: payload.parentId, now: input.now });
      wakeups.push({
        parentId: payload.parentId,
        parentAssigneeAgentId: parentRow?.assigneeAgentId ?? null,
        commentId: comment.id,
      });
      fired += 1;
    } catch (err) {
      logger.warn(
        { err, parentId: payload.parentId, thea2807: true },
        "issue_liveness_invariants.digest_fire_failed",
      );
    }
  }
  return { fired, wakeups };
}

export interface ScanStagnationResult {
  scanned: number;
  escalated: Array<{
    parentId: string;
    escalationTargetAgentId: string;
    commentId: string;
    hoursSinceLastSignal: number;
  }>;
}

export async function scanStagnation(
  db: Db,
  input: {
    now: Date;
    limit?: number;
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => Promise<{ id: string }>;
  },
): Promise<ScanStagnationResult> {
  const stagnantRows = await findStagnantUmbrellas(db, { now: input.now, limit: input.limit });
  if (stagnantRows.length === 0) return { scanned: 0, escalated: [] };

  const escalated: ScanStagnationResult["escalated"] = [];
  for (const row of stagnantRows) {
    try {
      const invariants = resolveLivenessInvariants(row.livenessInvariants);
      const escalationTargetAgentId = await resolveEscalationTarget(db, {
        companyId: row.companyId,
        createdByAgentId: row.createdByAgentId,
        target: invariants.escalationTarget,
      });
      if (!escalationTargetAgentId) {
        logger.warn(
          { parentId: row.id, target: invariants.escalationTarget, thea2807: true },
          "issue_liveness_invariants.escalation_target_unresolved",
        );
        continue;
      }

      const lastSignalAt =
        row.lastChildTransitionAt ?? row.lastDigestAt ?? row.createdAt ?? input.now;
      const hoursSinceLastSignal = Math.max(
        0,
        (input.now.getTime() - lastSignalAt.getTime()) / 3600_000,
      );
      const body = buildStagnationEscalationBody({
        identifier: row.identifier,
        title: row.title,
        invariants,
        hoursSinceLastSignal,
      });
      const comment = await input.addComment(row.id, body, {
        agentId: undefined,
        userId: undefined,
        runId: null,
      });
      // Stamp last_digest_at so we don't re-escalate the same umbrella every
      // tick — next escalation requires another stagnationThresholdHours.
      await recordDigestFired(db, { parentId: row.id, now: input.now });
      escalated.push({
        parentId: row.id,
        escalationTargetAgentId,
        commentId: comment.id,
        hoursSinceLastSignal,
      });
    } catch (err) {
      logger.warn(
        { err, parentId: row.id, thea2807: true },
        "issue_liveness_invariants.stagnation_escalation_failed",
      );
    }
  }
  return { scanned: stagnantRows.length, escalated };
}

// Re-export defaults under a stable name for the route hook + tests.
export const LIVENESS_DEFAULTS = ISSUE_LIVENESS_INVARIANT_DEFAULTS;
export const ESCALATION_TOKENS = ISSUE_LIVENESS_ESCALATION_TOKENS;
