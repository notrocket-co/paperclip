// THEA-2807 fix-forward — DB-bind regression test for the stagnation sweep.
//
// Why this test exists:
//   The original Pillar 4 PR (#5) shipped 16 unit tests covering pure
//   formatter / sanitizer / resolver helpers. The DB-touching helper
//   `findStagnantUmbrellas` uses a raw `db.execute(sql\`…\`)` template that
//   inlined `${input.now}` — a JS Date — without an explicit cast. The
//   `postgres@3.4.x` driver fell back to `Buffer.byteLength(date)` and
//   crashed `ERR_INVALID_ARG_TYPE` every sweep tick (~30s) once the image
//   went live.
//
//   The fix at services/issue-liveness-invariants.ts:494 is one line:
//   `${input.now}` → `${input.now.toISOString()}::timestamptz`.
//
//   This test calls `findStagnantUmbrellas` against a real Postgres harness
//   with a seeded stagnant umbrella so the bind is exercised end-to-end.
//   It would have caught the regression had it existed before the merge.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  findStagnantUmbrellas,
  scanStagnation,
} from "../services/issue-liveness-invariants.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stagnation-bind regression test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("regression: findStagnantUmbrellas binds Date params correctly (THEA-2807 fix-forward)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stagnation-bind-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("does not throw ERR_INVALID_ARG_TYPE when binding a JS Date and returns a stagnant umbrella row", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const umbrellaId = randomUUID();
    const childId = randomUUID();

    const now = new Date("2026-05-06T18:00:00.000Z");
    const stagnationStart = new Date(now.getTime() - 30 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip stagnation bind regression",
      issuePrefix: "STBIND",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Stagnation Owner",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: umbrellaId,
        companyId,
        title: "Stagnant umbrella",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "STBIND-1",
        createdByAgentId: ownerAgentId,
        livenessInvariants: {
          stagnationThresholdHours: 24,
          escalationTarget: "ceo",
        },
        createdAt: stagnationStart,
        updatedAt: stagnationStart,
        lastChildTransitionAt: stagnationStart,
      },
      {
        id: childId,
        companyId,
        title: "Active child",
        status: "in_progress",
        priority: "medium",
        parentId: umbrellaId,
        issueNumber: 2,
        identifier: "STBIND-2",
        createdAt: stagnationStart,
        updatedAt: stagnationStart,
      },
    ]);

    // Should not throw. The pre-fix bug raised TypeError [ERR_INVALID_ARG_TYPE]
    // out of the postgres@3.4.x type encoder before any rows were returned.
    const rows = await findStagnantUmbrellas(db, { now, limit: 100 });

    const umbrella = rows.find((row) => row.id === umbrellaId);
    expect(umbrella).toBeDefined();
    expect(umbrella).toMatchObject({
      id: umbrellaId,
      identifier: "STBIND-1",
      title: "Stagnant umbrella",
      companyId,
      createdByAgentId: ownerAgentId,
    });
    expect(umbrella?.livenessInvariants).toMatchObject({
      stagnationThresholdHours: 24,
      escalationTarget: "ceo",
    });

    // postgres@3.4.x raw SQL returns timestamptz as ISO strings; the consumer
    // (`scanStagnation`) calls `.getTime()` on these and crashes if the row
    // mapping doesn't wrap them in Date. Assert the runtime shape matches
    // the declared `Date | null` return type.
    expect(umbrella?.lastChildTransitionAt).toBeInstanceOf(Date);
    expect(umbrella?.createdAt).toBeInstanceOf(Date);
  });

  it("scanStagnation runs end-to-end without per-row TypeError on Date math", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const umbrellaId = randomUUID();
    const childId = randomUUID();

    const now = new Date("2026-05-06T18:00:00.000Z");
    const stagnationStart = new Date(now.getTime() - 30 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip stagnation scan e2e",
      issuePrefix: "SCNE2E",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Scan Owner",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: umbrellaId,
        companyId,
        title: "Stagnant umbrella for scan",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "SCNE2E-1",
        createdByAgentId: ownerAgentId,
        assigneeAgentId: ownerAgentId,
        livenessInvariants: {
          stagnationThresholdHours: 24,
          escalationTarget: "creator",
        },
        createdAt: stagnationStart,
        updatedAt: stagnationStart,
        lastChildTransitionAt: stagnationStart,
      },
      {
        id: childId,
        companyId,
        title: "Active scan child",
        status: "in_progress",
        priority: "medium",
        parentId: umbrellaId,
        issueNumber: 2,
        identifier: "SCNE2E-2",
        createdAt: stagnationStart,
        updatedAt: stagnationStart,
      },
    ]);

    const addCommentCalls: Array<{ issueId: string; body: string }> = [];
    const result = await scanStagnation(db, {
      now,
      limit: 100,
      addComment: async (issueId, body) => {
        addCommentCalls.push({ issueId, body });
        return { id: randomUUID() };
      },
    });

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    const escalation = result.escalated.find((row) => row.parentId === umbrellaId);
    expect(escalation).toBeDefined();
    expect(escalation?.escalationTargetAgentId).toBe(ownerAgentId);
    // 30 hours stagnant; allow ±1h drift for the math
    expect(escalation?.hoursSinceLastSignal).toBeGreaterThanOrEqual(29);
    expect(escalation?.hoursSinceLastSignal).toBeLessThanOrEqual(31);
    expect(addCommentCalls.find((call) => call.issueId === umbrellaId)).toBeDefined();
  });

  it("excludes umbrellas that are within the stagnation threshold window", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const umbrellaId = randomUUID();
    const childId = randomUUID();

    const now = new Date("2026-05-06T18:00:00.000Z");
    const recentSignal = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip stagnation bind regression — fresh",
      issuePrefix: "STFRSH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Fresh Owner",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: umbrellaId,
        companyId,
        title: "Recently active umbrella",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "STFRSH-1",
        createdByAgentId: ownerAgentId,
        livenessInvariants: {
          stagnationThresholdHours: 24,
          escalationTarget: "ceo",
        },
        createdAt: recentSignal,
        updatedAt: recentSignal,
        lastChildTransitionAt: recentSignal,
      },
      {
        id: childId,
        companyId,
        title: "Active child",
        status: "in_progress",
        priority: "medium",
        parentId: umbrellaId,
        issueNumber: 2,
        identifier: "STFRSH-2",
        createdAt: recentSignal,
        updatedAt: recentSignal,
      },
    ]);

    const rows = await findStagnantUmbrellas(db, { now, limit: 100 });
    expect(rows.find((row) => row.id === umbrellaId)).toBeUndefined();
  });
});
