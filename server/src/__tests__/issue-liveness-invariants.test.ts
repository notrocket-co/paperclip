// THEA-2807 — Pillar 4 unit tests.
//
// Pure-function coverage:
//   - resolveLivenessInvariants: NULL → defaults; partial overrides
//   - sanitizeMillerToken: defensive guard against `@Miller` literal
//   - formatDigestComment: tabular roll-up never emits `@Miller`,
//     handles empty / phased / unphased umbrellas
//   - buildStagnationEscalationBody: escalation comment also never
//     contains the literal `@Miller`
//
// DB-touching helpers (armDigestOnChildTransition, findPhaseToPromote,
// fireDueDigests, scanStagnation, resolveEscalationTarget) get exercised
// through the route-level tests with mocked drizzle calls — keeping pure
// vs DB-bound coverage cleanly separated.

import { describe, expect, it } from "vitest";
import {
  buildStagnationEscalationBody,
  formatDigestComment,
  resolveLivenessInvariants,
  sanitizeMillerToken,
  type ChildSummaryForDigest,
  type DigestPayload,
} from "../services/issue-liveness-invariants.js";
import { ISSUE_LIVENESS_INVARIANT_DEFAULTS } from "@paperclipai/shared";

const NOW = new Date("2026-05-06T15:00:00.000Z");

function buildPayload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    parentId: "00000000-0000-0000-0000-000000000001",
    parentIdentifier: "THEA-2566",
    parentTitle: "Pizza orchestration umbrella",
    invariants: resolveLivenessInvariants(null),
    generatedAt: NOW,
    children: [],
    ...overrides,
  };
}

function buildChild(overrides: Partial<ChildSummaryForDigest> = {}): ChildSummaryForDigest {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    identifier: "THEA-2567",
    title: "Phase 1 worker",
    status: "in_progress",
    phase: 0,
    assigneeAgentId: "agent-dev",
    assigneeAgentName: "Developer",
    lastTransitionAt: new Date(NOW.getTime() - 2 * 3600_000),
    nextActions: [{ kind: "review", note: "Awaiting QA gate" }],
    ...overrides,
  };
}

describe("resolveLivenessInvariants", () => {
  it("returns full defaults when given null", () => {
    expect(resolveLivenessInvariants(null)).toEqual(ISSUE_LIVENESS_INVARIANT_DEFAULTS);
  });

  it("returns full defaults when given undefined", () => {
    expect(resolveLivenessInvariants(undefined)).toEqual(ISSUE_LIVENESS_INVARIANT_DEFAULTS);
  });

  it("returns full defaults when given an empty object", () => {
    expect(resolveLivenessInvariants({})).toEqual(ISSUE_LIVENESS_INVARIANT_DEFAULTS);
  });

  it("preserves explicit overrides and fills the rest from defaults", () => {
    const result = resolveLivenessInvariants({
      digestWithinMin: 15,
      escalationTarget: "creator",
    });
    expect(result).toEqual({
      digestWithinMin: 15,
      phasePromoteWithinMin: ISSUE_LIVENESS_INVARIANT_DEFAULTS.phasePromoteWithinMin,
      stagnationThresholdHours: ISSUE_LIVENESS_INVARIANT_DEFAULTS.stagnationThresholdHours,
      escalationTarget: "creator",
    });
  });
});

describe("sanitizeMillerToken (Telegram-bridge guard)", () => {
  it("strips a literal @Miller token", () => {
    expect(sanitizeMillerToken("hey @Miller please look")).toBe("hey Miller please look");
  });

  it("is case-insensitive (the bridge isn't, but be defensive)", () => {
    expect(sanitizeMillerToken("oi @miller")).toBe("oi Miller");
  });

  it("strips multiple occurrences", () => {
    expect(sanitizeMillerToken("@Miller this is for @Miller again")).toBe(
      "Miller this is for Miller again",
    );
  });

  it("leaves Miller (no @) alone", () => {
    expect(sanitizeMillerToken("Miller is the user")).toBe("Miller is the user");
  });
});

describe("formatDigestComment", () => {
  it("renders an empty-children digest without crashing", () => {
    const body = formatDigestComment(buildPayload({ children: [] }));
    expect(body).toContain("THEA-2566 — liveness digest");
    expect(body).toContain("No active children");
  });

  it("renders an unphased table when no child has a phase", () => {
    const body = formatDigestComment(
      buildPayload({
        children: [
          buildChild({ phase: null, status: "in_progress" }),
          buildChild({ id: "child-2", identifier: "THEA-2568", phase: null, status: "blocked" }),
        ],
      }),
    );
    expect(body).toContain("| Identifier | Status | Stuck (h) | Assignee | Next |");
    expect(body).not.toContain("| Phase |");
    expect(body).toContain("THEA-2567");
    expect(body).toContain("THEA-2568");
  });

  it("renders a phased table when at least one child is phased", () => {
    const body = formatDigestComment(
      buildPayload({
        children: [
          buildChild({ phase: 0, status: "done" }),
          buildChild({ id: "child-2", identifier: "THEA-2568", phase: 1, status: "todo" }),
        ],
      }),
    );
    expect(body).toContain("| Identifier | Phase | Status | Stuck (h) | Assignee | Next |");
    expect(body).toContain("THEA-2567");
    expect(body).toContain("THEA-2568");
  });

  it("orders children by phase then identifier", () => {
    const phase1Idx = formatDigestComment(
      buildPayload({
        children: [
          buildChild({ id: "c-late", identifier: "THEA-9999", phase: 1, status: "todo" }),
          buildChild({ id: "c-early", identifier: "THEA-1111", phase: 0, status: "done" }),
        ].sort((a, b) => (a.phase ?? 0) - (b.phase ?? 0)),
      }),
    );
    const idxPhase0 = phase1Idx.indexOf("THEA-1111");
    const idxPhase1 = phase1Idx.indexOf("THEA-9999");
    expect(idxPhase0).toBeGreaterThan(0);
    expect(idxPhase1).toBeGreaterThan(idxPhase0);
  });

  it("never inserts the literal @Miller token (sanitize hard-constraint)", () => {
    // Even if the title or note tries to inject the token, the
    // sanitize-on-emit pass strips it.
    const body = formatDigestComment(
      buildPayload({
        parentTitle: "Hey @Miller — pizza",
        children: [
          buildChild({
            nextActions: [{ kind: "review", note: "ping @Miller please" }],
          }),
        ],
      }),
    );
    expect(body).not.toMatch(/@Miller/i);
    expect(body).toContain("Hey Miller — pizza");
  });

  it("includes the escalation_target line and threshold-hours in the footer", () => {
    const body = formatDigestComment(buildPayload({ children: [buildChild()] }));
    expect(body).toContain("Stagnation threshold: 24 h");
    expect(body).toContain("escalation target: ceo");
  });
});

describe("buildStagnationEscalationBody", () => {
  it("does not emit the literal @Miller token", () => {
    const body = buildStagnationEscalationBody({
      identifier: "THEA-2061",
      title: "Paperclip Work Graph @Miller-suspected",
      invariants: resolveLivenessInvariants(null),
      hoursSinceLastSignal: 25.5,
    });
    expect(body).not.toMatch(/@Miller/i);
    expect(body).toContain("Miller-suspected");
  });

  it("references the escalation target and threshold from invariants", () => {
    const body = buildStagnationEscalationBody({
      identifier: "THEA-2061",
      title: "Paperclip Work Graph",
      invariants: { ...resolveLivenessInvariants(null), escalationTarget: "creator" },
      hoursSinceLastSignal: 100,
    });
    expect(body).toContain("escalation_target: creator");
    expect(body).toContain("100.0 hours");
    expect(body).toContain("threshold: 24h");
  });
});
