// THEA-2825 / THEA-2852 — route-level matrix for the Phase-2 hard-mode gate.
//
// Asserts gate-on rejects status flips into done / in_review / blocked when
// `nextActions` is missing, gate-off preserves Phase-1 advisory behavior, and
// explicit `nextActions` payloads (including `[{ kind: "terminal" }]`) are
// accepted under hard mode.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockResolveContext = vi.hoisted(() => vi.fn());
const mockComputeDefault = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-next-actions.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-next-actions.js")>(
    "../services/issue-next-actions.js",
  );
  return {
    ...actual,
    resolveNextActionsContext: mockResolveContext,
    computeDefaultNextActions: mockComputeDefault,
  };
});

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const BASE_ISSUE = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-100",
  title: "Test ticket",
  description: null,
  priority: "medium",
  parentId: "parent-1",
  assigneeAgentId: "agent-actor",
  assigneeUserId: null,
  createdByAgentId: "agent-creator",
  createdByUserId: null,
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
  nextActions: null,
};

const HARD_MODE_ENV = "NEXT_ACTIONS_HARD_MODE";

describe("THEA-2825 / THEA-2852 — PATCH /issues/:id hard-mode gate", () => {
  // Bumped above vitest's 5s default to cover the first-test cold-load of
  // the routes module via `vi.importActual` (the rest of the suite is fast
  // once the module graph is cached).
  vi.setConfig({ testTimeout: 20000 });

  const originalEnv = process.env[HARD_MODE_ENV];

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.update.mockReset();
    mockResolveContext.mockReset();
    mockComputeDefault.mockReset();
    mockLogActivity.mockClear();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockResolveContext.mockResolvedValue({
      parentAssigneeAgentId: "agent-parent",
      parentAssigneeUserId: null,
      ceoAgentId: "agent-ceo",
      unblockedDependents: [],
    });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[HARD_MODE_ENV];
    } else {
      process.env[HARD_MODE_ENV] = originalEnv;
    }
  });

  describe("gate ON (NEXT_ACTIONS_HARD_MODE=true)", () => {
    beforeEach(() => {
      process.env[HARD_MODE_ENV] = "true";
    });

    for (const status of ["done", "in_review", "blocked"] as const) {
      it(`rejects PATCH status=${status} without nextActions with HTTP 422 + structured error`, async () => {
        mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_progress" });

        const res = await request(await createApp())
          .patch("/api/issues/issue-1")
          .send({ status });

        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({
          error: "issue.next_actions.required",
          details: {
            status,
            previousStatus: "in_progress",
            requiredField: "nextActions",
          },
        });
        expect(res.body.message).toMatch(/explicit nextActions/);
        expect(res.body.details.rollback).toContain(HARD_MODE_ENV);

        // Auto-derivation block must be short-circuited.
        expect(mockIssueService.update).not.toHaveBeenCalled();
        expect(mockComputeDefault).not.toHaveBeenCalled();
        expect(mockResolveContext).not.toHaveBeenCalled();

        // Activity-log row recorded.
        expect(mockLogActivity).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "issue.next_actions.hard_mode_reject",
            entityType: "issue",
            entityId: "issue-1",
            details: expect.objectContaining({
              previousStatus: "in_progress",
              newStatus: status,
              requiredField: "nextActions",
            }),
          }),
        );
      });

      it(`rejects PATCH status=${status} when nextActions === null`, async () => {
        mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_progress" });
        const res = await request(await createApp())
          .patch("/api/issues/issue-1")
          .send({ status, nextActions: null });
        expect(res.status).toBe(422);
        expect(mockIssueService.update).not.toHaveBeenCalled();
      });
    }

    it("accepts PATCH status=in_review with explicit nextActions (existing shape)", async () => {
      const targetAgentId = "11111111-1111-1111-1111-111111111111";
      const targetIssueId = "22222222-2222-2222-2222-222222222222";
      mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_progress" });
      mockIssueService.update.mockResolvedValueOnce({
        ...BASE_ISSUE,
        status: "in_review",
        nextActions: [
          {
            kind: "review",
            targetIssueId,
            targetAssigneeAgentId: targetAgentId,
            note: "ready for review",
          },
        ],
      });

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({
          status: "in_review",
          nextActions: [
            {
              kind: "review",
              targetIssueId,
              targetAssigneeAgentId: targetAgentId,
              note: "ready for review",
            },
          ],
        });

      expect(res.status).toBe(200);
      // Auto-derivation must NOT run when an explicit payload is present, even
      // under hard mode. (Phase-1 contract — see Pillar 5 routes test for the
      // independent regression guard on this branch.)
      expect(mockComputeDefault).not.toHaveBeenCalled();
      // No hard-mode reject activity row was logged.
      const rejectCall = mockLogActivity.mock.calls.find(
        ([, payload]) => (payload as { action?: string }).action === "issue.next_actions.hard_mode_reject",
      );
      expect(rejectCall).toBeUndefined();
    });

    it("accepts PATCH status=in_review with nextActions: [{ kind: 'terminal' }]", async () => {
      mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_progress" });
      mockIssueService.update.mockResolvedValueOnce({
        ...BASE_ISSUE,
        status: "in_review",
        nextActions: [{ kind: "terminal" }],
      });

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "in_review", nextActions: [{ kind: "terminal" }] });

      expect(res.status).toBe(200);
      expect(mockComputeDefault).not.toHaveBeenCalled();
      const rejectCall = mockLogActivity.mock.calls.find(
        ([, payload]) => (payload as { action?: string }).action === "issue.next_actions.hard_mode_reject",
      );
      expect(rejectCall).toBeUndefined();
    });

    it("does NOT reject PATCH that omits the status field entirely", async () => {
      mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_progress" });
      mockIssueService.update.mockResolvedValueOnce({
        ...BASE_ISSUE,
        status: "in_progress",
        priority: "high",
      });

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ priority: "high" });

      expect(res.status).toBe(200);
      const rejectCall = mockLogActivity.mock.calls.find(
        ([, payload]) => (payload as { action?: string }).action === "issue.next_actions.hard_mode_reject",
      );
      expect(rejectCall).toBeUndefined();
    });
  });

  describe("gate OFF (env unset — Phase-1 advisory regression guard)", () => {
    beforeEach(() => {
      delete process.env[HARD_MODE_ENV];
    });

    it("flipping to in_review without nextActions falls through to Phase-1 advisory + auto-derivation", async () => {
      mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_progress" });
      mockIssueService.update
        .mockResolvedValueOnce({ ...BASE_ISSUE, status: "in_review" })
        .mockResolvedValueOnce({
          ...BASE_ISSUE,
          status: "in_review",
          nextActions: [
            {
              kind: "review",
              targetIssueId: "issue-1",
              targetAssigneeAgentId: "agent-parent",
              note: "auto",
            },
          ],
        });
      mockComputeDefault.mockReturnValue([
        {
          kind: "review",
          targetIssueId: "issue-1",
          targetAssigneeAgentId: "agent-parent",
          note: "auto",
        },
      ]);

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "in_review" });

      expect(res.status).toBe(200);
      expect(mockComputeDefault).toHaveBeenCalled();
      // Phase-1 advisory row landed; hard-mode reject row did NOT.
      const advisoryCall = mockLogActivity.mock.calls.find(
        ([, payload]) => (payload as { action?: string }).action === "issue.next_actions_advisory",
      );
      expect(advisoryCall).toBeDefined();
      const rejectCall = mockLogActivity.mock.calls.find(
        ([, payload]) => (payload as { action?: string }).action === "issue.next_actions.hard_mode_reject",
      );
      expect(rejectCall).toBeUndefined();
    });
  });

  describe("gate OFF (env=false explicitly — same as unset)", () => {
    beforeEach(() => {
      process.env[HARD_MODE_ENV] = "false";
    });

    it("flipping to done without nextActions does not 422", async () => {
      mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_review" });
      mockIssueService.update.mockResolvedValueOnce({
        ...BASE_ISSUE,
        status: "done",
      });
      mockComputeDefault.mockReturnValue([]);

      const res = await request(await createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "done" });

      expect(res.status).toBe(200);
    });
  });
});
