// THEA-4855 (WS-0): Tests for the single-child-transition cascade.
// Verifies that a parent agent is woken when one of its subtasks transitions
// to done/cancelled (issue_child_completed) or in_progress (issue_child_started),
// independently of the all-children-done gate.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getWakeableParentForChildTransition: vi.fn(),
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
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
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

function makeIssue(overrides: Record<string, unknown>) {
  return {
    id: "child-1",
    companyId: "company-1",
    identifier: "PAP-200",
    title: "A subtask",
    description: null,
    priority: "medium",
    parentId: "parent-1",
    assigneeAgentId: "agent-child",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

describe("THEA-4855: child-transition cascade in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    delete process.env.PAPERCLIP_CHILD_TRANSITION_WAKE;
  });

  it("wakes the parent agent when a child transitions to done (issue_child_completed)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.getWakeableParentForChildTransition.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-parent",
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-parent",
        expect.objectContaining({
          reason: "issue_child_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            childIssueId: "child-1",
            childStatus: "done",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.child_transition",
            childIssueId: "child-1",
          }),
        }),
      );
    });
  });

  it("wakes the parent agent when a child transitions to cancelled (issue_child_completed)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockIssueService.getWakeableParentForChildTransition.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-parent",
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "cancelled" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-parent",
        expect.objectContaining({
          reason: "issue_child_completed",
          payload: expect.objectContaining({ childStatus: "cancelled" }),
        }),
      );
    });
  });

  it("wakes the parent agent when a child transitions to in_progress (issue_child_started)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.getWakeableParentForChildTransition.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-parent",
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "in_progress" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-parent",
        expect.objectContaining({
          reason: "issue_child_started",
          payload: expect.objectContaining({
            issueId: "parent-1",
            childIssueId: "child-1",
            childStatus: "in_progress",
          }),
        }),
      );
    });
  });

  it("does not fire when the child has no parent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress", parentId: null }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done", parentId: null }));

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockIssueService.getWakeableParentForChildTransition).not.toHaveBeenCalled();
    });
  });

  it("does not fire when the parent has no assignee (service returns null)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.getWakeableParentForChildTransition.mockResolvedValue(null);

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    // Allow async wakeups to settle before asserting
    await new Promise((r) => setTimeout(r, 20));
    const childTransitionCalls = mockWakeup.mock.calls.filter(
      ([, opts]) => opts?.reason === "issue_child_completed" || opts?.reason === "issue_child_started",
    );
    expect(childTransitionCalls).toHaveLength(0);
  });

  it("does not fire when the env gate is set to false", async () => {
    process.env.PAPERCLIP_CHILD_TRANSITION_WAKE = "false";
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.getWakeableParentForChildTransition.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-parent",
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockIssueService.getWakeableParentForChildTransition).not.toHaveBeenCalled();
  });

  it("does not re-fire when a child transitions from in_progress to in_progress (no-op)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "in_progress" }));
    mockIssueService.getWakeableParentForChildTransition.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-parent",
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "in_progress" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const childTransitionCalls = mockWakeup.mock.calls.filter(
      ([, opts]) => opts?.reason === "issue_child_started",
    );
    expect(childTransitionCalls).toHaveLength(0);
  });
});
