-- THEA-2806 — Pillar 5: explicit next-actions on every status flip.
-- NULL = no explicit handoff (defaults are auto-derived in app code on
-- transitions to `done`/`in_review`/`blocked`). Validated via the shared
-- issueNextActionsSchema; agents may post the camelCase `nextActions` shape
-- on PATCH /api/issues/:id and the server fires wakes on each target.
ALTER TABLE "issues" ADD COLUMN "next_actions" jsonb;
--> statement-breakpoint
COMMENT ON COLUMN "issues"."next_actions" IS 'Pillar 5 (THEA-2806) handoff payload emitted on the latest status transition. Array of {kind, targetIssueId?, targetAssigneeAgentId?, note?} or NULL when no handoff applies.';
