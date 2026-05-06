import { describe, expect, it } from "vitest";
import {
  computeDefaultNextActions,
  isNextActionsRequiredStatus,
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
