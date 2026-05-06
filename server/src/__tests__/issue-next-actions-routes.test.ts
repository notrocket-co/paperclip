import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockResolveContext = vi.hoisted(() => vi.fn());
const mockComputeDefault = vi.hoisted(() => vi.fn());

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
  logActivity: vi.fn(async () => undefined),
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

describe("THEA-2806 Pillar 5 — PATCH /issues/:id wake firing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.update.mockReset();
    mockResolveContext.mockReset();
    mockComputeDefault.mockReset();
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

  it("auto-derives + fires a review wake when an agent flips to in_review without nextActions", async () => {
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
            note: "PAP-100 ready for review",
          },
        ],
      });
    mockComputeDefault.mockReturnValue([
      {
        kind: "review",
        targetIssueId: "issue-1",
        targetAssigneeAgentId: "agent-parent",
        note: "PAP-100 ready for review",
      },
    ]);

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "in_review" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-parent",
        expect.objectContaining({
          reason: "issue_next_action_review",
          payload: expect.objectContaining({
            issueId: "issue-1",
            originIssueId: "issue-1",
            nextActionKind: "review",
            nextActionNote: "PAP-100 ready for review",
            nextActionSource: "auto_derived",
          }),
          contextSnapshot: expect.objectContaining({
            wakeReason: "issue_next_action_review",
            nextActionSource: "auto_derived",
          }),
        }),
      );
    });
  });

  it("respects an explicit nextActions payload and marks the wake as explicit", async () => {
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
          note: "Please review my approach",
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
            note: "Please review my approach",
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(mockComputeDefault).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        targetAgentId,
        expect.objectContaining({
          reason: "issue_next_action_review",
          payload: expect.objectContaining({
            nextActionSource: "explicit",
            nextActionNote: "Please review my approach",
          }),
        }),
      );
    });
  });

  it("does not fire a wake when explicit nextActions is [{ kind: 'terminal' }]", async () => {
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
    // Existing wakeups (e.g. issue_status_changed) may still fire, but no
    // next_action_* wake should be emitted.
    const calls = mockWakeup.mock.calls.filter(([_agentId, opts]) =>
      typeof opts.reason === "string" && opts.reason.startsWith("issue_next_action_"),
    );
    expect(calls).toEqual([]);
  });

  it("auto-derives a decide wake when flipping to blocked", async () => {
    mockIssueService.getById.mockResolvedValue({ ...BASE_ISSUE, status: "in_progress" });
    mockIssueService.update
      .mockResolvedValueOnce({ ...BASE_ISSUE, status: "blocked" })
      .mockResolvedValueOnce({
        ...BASE_ISSUE,
        status: "blocked",
        nextActions: [
          {
            kind: "decide",
            targetIssueId: "issue-1",
            targetAssigneeAgentId: "agent-creator",
            note: "blocked — needs resolver",
          },
        ],
      });
    mockComputeDefault.mockReturnValue([
      {
        kind: "decide",
        targetIssueId: "issue-1",
        targetAssigneeAgentId: "agent-creator",
        note: "blocked — needs resolver",
      },
    ]);

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-creator",
        expect.objectContaining({
          reason: "issue_next_action_decide",
        }),
      );
    });
  });
});
