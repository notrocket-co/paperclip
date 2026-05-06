// THEA-2806 — Pillar 5: explicit handoff payload on every status flip.
//
// This module computes default `nextActions` for transitions to
// `done` / `in_review` / `blocked` when the agent did not provide an
// explicit payload, and exposes a small helper to log the Phase-1 advisory
// when a status flip lands without an explicit emission.
//
// Wake-firing itself happens in the route handler (routes/issues.ts) by
// converting each NextAction into a wakeups-map entry; this module only
// derives the structured data.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import type { IssueNextAction } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// Status transitions that MUST carry an explicit nextActions payload (or get
// auto-derivation). Mirrors the AC list verbatim.
export const NEXT_ACTIONS_REQUIRED_STATUSES = ["done", "in_review", "blocked"] as const;
export type NextActionsRequiredStatus = (typeof NEXT_ACTIONS_REQUIRED_STATUSES)[number];

export function isNextActionsRequiredStatus(status: string): status is NextActionsRequiredStatus {
  return (NEXT_ACTIONS_REQUIRED_STATUSES as readonly string[]).includes(status);
}

export interface NextActionsContext {
  // The transitioning issue's parent (resolves the in_review default target).
  parentAssigneeAgentId: string | null;
  parentAssigneeUserId: string | null;
  // CEO fallback agent — used when in_review's parent assignee resolves to a
  // userId (Miller / human). Per CEO decision THEA-2806 cmt 0287aad9: CEO is
  // the screen between agents and humans, so default routing should mirror
  // that. Null when no CEO agent exists in the company (rare).
  ceoAgentId: string | null;
  // Blocked dependents that became unblocked by this issue's transition to
  // done. Each entry has the dependent's id + its current assignee. Empty
  // array means no auto-derivation for `done`.
  unblockedDependents: Array<{ id: string; assigneeAgentId: string | null }>;
}

export interface ComputeDefaultNextActionsInput {
  newStatus: string;
  previousStatus: string;
  issue: {
    id: string;
    identifier: string | null;
    createdByAgentId: string | null;
  };
  context: NextActionsContext;
}

/**
 * Compute the default nextActions for a status transition. Pure function —
 * given resolved context, returns a deterministic array. Returns `null` when
 * the transition does not warrant auto-derivation (e.g. status didn't flip,
 * or flipped to a status outside the required set).
 */
export function computeDefaultNextActions(
  input: ComputeDefaultNextActionsInput,
): IssueNextAction[] | null {
  const { newStatus, previousStatus, issue, context } = input;
  if (newStatus === previousStatus) return null;
  if (!isNextActionsRequiredStatus(newStatus)) return null;

  if (newStatus === "in_review") {
    // Sub-Q2: parent.assigneeAgentId, falling back to the CEO agent if the
    // parent resolves to a userId or null. Note that we never auto-target a
    // userId — wakes only fire on agents.
    const target = context.parentAssigneeAgentId ?? context.ceoAgentId ?? null;
    if (!target) return [];
    return [
      {
        kind: "review",
        targetIssueId: issue.id,
        targetAssigneeAgentId: target,
        note: buildReviewNote(issue, context),
      },
    ];
  }

  if (newStatus === "blocked") {
    // Sub-Q3 Phase 1: createdByAgentId fallback. Phase 2 will reject without
    // an explicit emission entirely; this branch keeps the soak window from
    // breaking existing agents.
    const target = issue.createdByAgentId ?? null;
    if (!target) return [];
    return [
      {
        kind: "decide",
        targetIssueId: issue.id,
        targetAssigneeAgentId: target,
        note: buildBlockedNote(issue),
      },
    ];
  }

  // done → walk unblocked-dependents, emit a build/review next-action per
  // dependent that now has all blockers resolved. The existing
  // `listWakeableBlockedDependents` lookup already filters for that.
  return context.unblockedDependents
    .filter((dep) => !!dep.assigneeAgentId)
    .map((dep) => ({
      kind: "build" as const,
      targetIssueId: dep.id,
      targetAssigneeAgentId: dep.assigneeAgentId,
      note: buildUnblockNote(issue, dep),
    }));
}

function buildReviewNote(
  issue: ComputeDefaultNextActionsInput["issue"],
  context: NextActionsContext,
): string {
  const parts = [`${issue.identifier ?? issue.id} flipped to in_review`];
  if (context.parentAssigneeAgentId) {
    parts.push("(targeting parent assignee)");
  } else {
    parts.push("(parent has no agent assignee — falling back to CEO)");
  }
  return parts.join(" ");
}

function buildBlockedNote(issue: ComputeDefaultNextActionsInput["issue"]): string {
  return `${issue.identifier ?? issue.id} flipped to blocked — Phase 1 advisory targeting createdByAgent. Replace with explicit nextActions naming the resolver in Phase 2.`;
}

function buildUnblockNote(
  issue: ComputeDefaultNextActionsInput["issue"],
  dep: { id: string },
): string {
  return `Blocker ${issue.identifier ?? issue.id} resolved — your issue ${dep.id} is now unblocked.`;
}

/**
 * Resolve the lookups required for `computeDefaultNextActions` against the
 * database. Returns the structured context the pure function consumes.
 */
export async function resolveNextActionsContext(
  db: Db,
  input: {
    companyId: string;
    parentId: string | null;
    unblockedDependents: Array<{ id: string; assigneeAgentId: string | null }>;
  },
): Promise<NextActionsContext> {
  const ceoRow = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.role, "ceo")))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  let parentAssigneeAgentId: string | null = null;
  let parentAssigneeUserId: string | null = null;
  if (input.parentId) {
    const parent = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, input.parentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (parent) {
      parentAssigneeAgentId = parent.assigneeAgentId ?? null;
      parentAssigneeUserId = parent.assigneeUserId ?? null;
    }
  }

  return {
    parentAssigneeAgentId,
    parentAssigneeUserId,
    ceoAgentId: ceoRow?.id ?? null,
    unblockedDependents: input.unblockedDependents,
  };
}

/**
 * Phase-1 advisory: log a structured warning when a transition that *should*
 * carry an explicit nextActions emission lands without one. The PATCH route
 * also stamps `nextActionsAdvisoryMissing: true` into the issue.updated
 * activity-log details so the CEO sweep summary can count occurrences.
 */
export function logMissingNextActionsAdvisory(input: {
  issueId: string;
  identifier: string | null;
  newStatus: string;
  previousStatus: string;
  actorAgentId: string | null;
  actorUserId: string | null;
  derivedKinds: string[];
}): void {
  logger.warn(
    {
      issueId: input.issueId,
      identifier: input.identifier,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      actorAgentId: input.actorAgentId,
      actorUserId: input.actorUserId,
      derivedKinds: input.derivedKinds,
      thea2806: true,
    },
    "issue.next_actions.missing_advisory",
  );
}
