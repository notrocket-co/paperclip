import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNextActionsHardModeRejectionPayload,
  computeDefaultNextActions,
  isNextActionsHardModeEnabled,
  isNextActionsRequiredStatus,
  NEXT_ACTIONS_HARD_MODE_ENV_VAR,
  shouldRejectMissingNextActions,
  type NextActionsContext,
} from "../services/issue-next-actions.js";

const ISSUE = {
  id: "issue-1",
  identifier: "PAP-100",
  createdByAgentId: "agent-creator",
};

const EMPTY_CONTEXT: NextActionsContext = {
  parentAssigneeAgentId: null,
  parentAssigneeUserId: null,
  ceoAgentId: null,
  unblockedDependents: [],
};

describe("THEA-2806 Pillar 5 — computeDefaultNextActions", () => {
  it("returns null when status didn't change", () => {
    expect(
      computeDefaultNextActions({
        newStatus: "in_review",
        previousStatus: "in_review",
        issue: ISSUE,
        context: EMPTY_CONTEXT,
      }),
    ).toBeNull();
  });

  it("returns null when transitioning to a non-required status", () => {
    expect(
      computeDefaultNextActions({
        newStatus: "in_progress",
        previousStatus: "todo",
        issue: ISSUE,
        context: EMPTY_CONTEXT,
      }),
    ).toBeNull();
  });

  describe("in_review", () => {
    it("targets parent.assigneeAgentId when present", () => {
      const result = computeDefaultNextActions({
        newStatus: "in_review",
        previousStatus: "in_progress",
        issue: ISSUE,
        context: {
          ...EMPTY_CONTEXT,
          parentAssigneeAgentId: "agent-parent",
          ceoAgentId: "agent-ceo",
        },
      });
      expect(result).toEqual([
        expect.objectContaining({
          kind: "review",
          targetIssueId: "issue-1",
          targetAssigneeAgentId: "agent-parent",
        }),
      ]);
      expect(result?.[0]?.note).toContain("PAP-100");
    });

    it("falls back to CEO when parent has only a userId", () => {
      const result = computeDefaultNextActions({
        newStatus: "in_review",
        previousStatus: "in_progress",
        issue: ISSUE,
        context: {
          ...EMPTY_CONTEXT,
          parentAssigneeAgentId: null,
          parentAssigneeUserId: "user-miller",
          ceoAgentId: "agent-ceo",
        },
      });
      expect(result).toEqual([
        expect.objectContaining({
          kind: "review",
          targetAssigneeAgentId: "agent-ceo",
        }),
      ]);
      expect(result?.[0]?.note).toContain("falling back to CEO");
    });

    it("falls back to CEO when there is no parent", () => {
      const result = computeDefaultNextActions({
        newStatus: "in_review",
        previousStatus: "in_progress",
        issue: ISSUE,
        context: { ...EMPTY_CONTEXT, ceoAgentId: "agent-ceo" },
      });
      expect(result).toEqual([
        expect.objectContaining({ targetAssigneeAgentId: "agent-ceo" }),
      ]);
    });

    it("returns an empty array when neither parent agent nor CEO can be resolved", () => {
      const result = computeDefaultNextActions({
        newStatus: "in_review",
        previousStatus: "in_progress",
        issue: ISSUE,
        context: EMPTY_CONTEXT,
      });
      expect(result).toEqual([]);
    });
  });

  describe("blocked", () => {
    it("targets the createdByAgent (Phase-1 advisory fallback)", () => {
      const result = computeDefaultNextActions({
        newStatus: "blocked",
        previousStatus: "in_progress",
        issue: ISSUE,
        context: EMPTY_CONTEXT,
      });
      expect(result).toEqual([
        expect.objectContaining({
          kind: "decide",
          targetAssigneeAgentId: "agent-creator",
        }),
      ]);
      expect(result?.[0]?.note).toMatch(/Phase 1 advisory/);
    });

    it("returns an empty array when createdByAgent is missing", () => {
      const result = computeDefaultNextActions({
        newStatus: "blocked",
        previousStatus: "in_progress",
        issue: { ...ISSUE, createdByAgentId: null },
        context: EMPTY_CONTEXT,
      });
      expect(result).toEqual([]);
    });
  });

  describe("done", () => {
    it("emits a build next-action for each unblocked dependent with an assignee", () => {
      const result = computeDefaultNextActions({
        newStatus: "done",
        previousStatus: "in_review",
        issue: ISSUE,
        context: {
          ...EMPTY_CONTEXT,
          unblockedDependents: [
            { id: "dep-1", assigneeAgentId: "agent-dep-1" },
            { id: "dep-2", assigneeAgentId: "agent-dep-2" },
          ],
        },
      });
      expect(result).toHaveLength(2);
      expect(result?.[0]).toEqual(
        expect.objectContaining({
          kind: "build",
          targetIssueId: "dep-1",
          targetAssigneeAgentId: "agent-dep-1",
        }),
      );
      expect(result?.[1]).toEqual(
        expect.objectContaining({
          kind: "build",
          targetIssueId: "dep-2",
          targetAssigneeAgentId: "agent-dep-2",
        }),
      );
    });

    it("filters out dependents without an assignee", () => {
      const result = computeDefaultNextActions({
        newStatus: "done",
        previousStatus: "in_review",
        issue: ISSUE,
        context: {
          ...EMPTY_CONTEXT,
          unblockedDependents: [
            { id: "dep-1", assigneeAgentId: null },
            { id: "dep-2", assigneeAgentId: "agent-dep-2" },
          ],
        },
      });
      expect(result).toEqual([
        expect.objectContaining({ kind: "build", targetIssueId: "dep-2" }),
      ]);
    });

    it("returns an empty array when no dependents are unblocked", () => {
      const result = computeDefaultNextActions({
        newStatus: "done",
        previousStatus: "in_review",
        issue: ISSUE,
        context: EMPTY_CONTEXT,
      });
      expect(result).toEqual([]);
    });
  });
});

describe("isNextActionsRequiredStatus", () => {
  it("returns true for done / in_review / blocked", () => {
    expect(isNextActionsRequiredStatus("done")).toBe(true);
    expect(isNextActionsRequiredStatus("in_review")).toBe(true);
    expect(isNextActionsRequiredStatus("blocked")).toBe(true);
  });

  it("returns false for other statuses", () => {
    expect(isNextActionsRequiredStatus("in_progress")).toBe(false);
    expect(isNextActionsRequiredStatus("todo")).toBe(false);
    expect(isNextActionsRequiredStatus("backlog")).toBe(false);
    expect(isNextActionsRequiredStatus("cancelled")).toBe(false);
  });
});

describe("THEA-2825 / THEA-2852 — hard-mode toggle", () => {
  const originalEnv = process.env[NEXT_ACTIONS_HARD_MODE_ENV_VAR];

  beforeEach(() => {
    delete process.env[NEXT_ACTIONS_HARD_MODE_ENV_VAR];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[NEXT_ACTIONS_HARD_MODE_ENV_VAR];
    } else {
      process.env[NEXT_ACTIONS_HARD_MODE_ENV_VAR] = originalEnv;
    }
  });

  describe("isNextActionsHardModeEnabled", () => {
    it("returns false when the env var is unset (default OFF)", () => {
      expect(isNextActionsHardModeEnabled()).toBe(false);
    });

    it("returns true only for the literal string 'true'", () => {
      process.env[NEXT_ACTIONS_HARD_MODE_ENV_VAR] = "true";
      expect(isNextActionsHardModeEnabled()).toBe(true);
    });

    it("returns false for truthy-ish but non-canonical values", () => {
      for (const candidate of ["1", "TRUE", "yes", "on", " true ", ""]) {
        process.env[NEXT_ACTIONS_HARD_MODE_ENV_VAR] = candidate;
        expect(isNextActionsHardModeEnabled()).toBe(false);
      }
    });
  });

  describe("shouldRejectMissingNextActions (gate ON)", () => {
    const baseInput = {
      hardModeEnabled: true,
      existingStatus: "in_progress",
      nextActionsBody: undefined,
    };

    for (const status of ["done", "in_review", "blocked"] as const) {
      it(`rejects flips to ${status} without nextActions in body`, () => {
        expect(
          shouldRejectMissingNextActions({
            ...baseInput,
            requestedStatus: status,
            nextActionsBody: undefined,
          }),
        ).toBe(true);
      });

      it(`rejects flips to ${status} when nextActions === null`, () => {
        expect(
          shouldRejectMissingNextActions({
            ...baseInput,
            requestedStatus: status,
            nextActionsBody: null,
          }),
        ).toBe(true);
      });

      it(`accepts flips to ${status} with explicit nextActions array`, () => {
        expect(
          shouldRejectMissingNextActions({
            ...baseInput,
            requestedStatus: status,
            nextActionsBody: [
              {
                kind: "review",
                targetIssueId: "issue-1",
                targetAssigneeAgentId: "agent-1",
              },
            ],
          }),
        ).toBe(false);
      });

      it(`accepts flips to ${status} with [{ kind: "terminal" }] (no follow-up)`, () => {
        expect(
          shouldRejectMissingNextActions({
            ...baseInput,
            requestedStatus: status,
            nextActionsBody: [{ kind: "terminal" }],
          }),
        ).toBe(false);
      });

      it(`accepts flips to ${status} with empty array (matches Phase-1 explicit semantics)`, () => {
        expect(
          shouldRejectMissingNextActions({
            ...baseInput,
            requestedStatus: status,
            nextActionsBody: [],
          }),
        ).toBe(false);
      });
    }

    it("does NOT reject when status is unchanged (no flip)", () => {
      expect(
        shouldRejectMissingNextActions({
          hardModeEnabled: true,
          requestedStatus: "in_review",
          existingStatus: "in_review",
          nextActionsBody: undefined,
        }),
      ).toBe(false);
    });

    it("does NOT reject when flipping to a non-required status", () => {
      expect(
        shouldRejectMissingNextActions({
          hardModeEnabled: true,
          requestedStatus: "in_progress",
          existingStatus: "todo",
          nextActionsBody: undefined,
        }),
      ).toBe(false);
    });

    it("does NOT reject when status field is omitted from the body", () => {
      expect(
        shouldRejectMissingNextActions({
          hardModeEnabled: true,
          requestedStatus: undefined,
          existingStatus: "in_progress",
          nextActionsBody: undefined,
        }),
      ).toBe(false);
    });
  });

  describe("shouldRejectMissingNextActions (gate OFF — Phase-1 regression guard)", () => {
    it("never rejects when hardModeEnabled is false, even with required-status flips and no nextActions", () => {
      for (const status of ["done", "in_review", "blocked"]) {
        expect(
          shouldRejectMissingNextActions({
            hardModeEnabled: false,
            requestedStatus: status,
            existingStatus: "in_progress",
            nextActionsBody: undefined,
          }),
        ).toBe(false);
        expect(
          shouldRejectMissingNextActions({
            hardModeEnabled: false,
            requestedStatus: status,
            existingStatus: "in_progress",
            nextActionsBody: null,
          }),
        ).toBe(false);
      }
    });
  });

  describe("buildNextActionsHardModeRejectionPayload", () => {
    it("returns a structured 422 body with the spec one-liner and rollback recipe", () => {
      const payload = buildNextActionsHardModeRejectionPayload({
        requestedStatus: "done",
        existingStatus: "in_progress",
      });
      expect(payload.error).toBe("issue.next_actions.required");
      expect(payload.message).toMatch(/explicit nextActions/);
      expect(payload.message).toMatch(/terminal/);
      expect(payload.details).toMatchObject({
        status: "done",
        previousStatus: "in_progress",
        requiredField: "nextActions",
      });
      expect(payload.details.docsRef).toMatch(/AGENTS\.md §11/);
      expect(payload.details.spec).toMatch(/kind/);
      expect(payload.details.rollback).toContain(NEXT_ACTIONS_HARD_MODE_ENV_VAR);
      expect(payload.details.rollback).toMatch(/restart/);
    });
  });
});
