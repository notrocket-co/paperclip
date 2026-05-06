-- THEA-2807 — Pillar 4: project-level liveness invariants.
-- Adds the per-issue invariant declaration plus the bookkeeping fields the
-- digest-arming and phase-auto-promote sweeps consume. NULL on
-- liveness_invariants behaves identically to '{}'::jsonb (defaults fire
-- either way); we backfill every issue with at least one active child to
-- '{}' so the dashboard tile gets a clean SELECT.

ALTER TABLE "issues" ADD COLUMN "liveness_invariants" jsonb;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "phase" integer;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "digest_due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_child_transition_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_digest_at" timestamp with time zone;
--> statement-breakpoint
COMMENT ON COLUMN "issues"."liveness_invariants" IS 'Pillar 4 (THEA-2807) invariant declaration. NULL = defaults (30/30/24, escalation_target=ceo). {} also = defaults; either shape is treated identically by the sweep.';
--> statement-breakpoint
COMMENT ON COLUMN "issues"."phase" IS 'Pillar 4 (THEA-2807) per-child phase membership for phase auto-promote. NULL = phase 0; only used when the parent declares an invariant.';
--> statement-breakpoint
COMMENT ON COLUMN "issues"."digest_due_at" IS 'Pillar 4 (THEA-2807) timestamp at which a parent issue must post a child-state digest. Armed by the first child transition after the previous digest fired (atomic CAS), cleared once the digest fires.';
--> statement-breakpoint
COMMENT ON COLUMN "issues"."last_child_transition_at" IS 'Pillar 4 (THEA-2807) wall-clock of the most recent child transition under this parent. Used by the stagnation predicate.';
--> statement-breakpoint
COMMENT ON COLUMN "issues"."last_digest_at" IS 'Pillar 4 (THEA-2807) wall-clock of the most recent liveness digest comment posted on this parent. Backstop for stagnation calculation when no child has ever transitioned.';
--> statement-breakpoint
CREATE INDEX "issues_company_digest_due_idx" ON "issues" USING btree ("company_id","digest_due_at") WHERE "digest_due_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "issues_company_phase_parent_idx" ON "issues" USING btree ("company_id","parent_id","phase") WHERE "parent_id" IS NOT NULL AND "phase" IS NOT NULL;
--> statement-breakpoint
-- Backfill: every issue that has at least one non-hidden, non-terminal child
-- gets liveness_invariants = '{}'::jsonb so the dashboard tile and sweep
-- queries can select on `IS NOT NULL`. Defaults (30/30/24/ceo) apply whether
-- the column is NULL or '{}'; this is a pure visibility tag.
UPDATE "issues" SET "liveness_invariants" = '{}'::jsonb
  WHERE "liveness_invariants" IS NULL
    AND "id" IN (
      SELECT DISTINCT "parent_id" FROM "issues"
      WHERE "parent_id" IS NOT NULL
        AND "hidden_at" IS NULL
        AND "status" NOT IN ('done','cancelled')
    );
