# `NEXT_ACTIONS_HARD_MODE` — Pillar 5 hard-mode toggle

Status: Phase-2 draft (see `THEA-2825`, drafted via `THEA-2852`). **Default
OFF** — flipping the env var on requires Miller approval per the parent
ticket. Do not enable in any environment without that green light.

## What it does

Gates the close-out protocol introduced in `THEA-2806` (Pillar 5 — explicit
`nextActions` handoff payloads on every status flip). Two modes:

| `NEXT_ACTIONS_HARD_MODE` | Behavior |
| --- | --- |
| unset (default) / `false` / anything ≠ `"true"` | Phase-1 advisory. Status flips into `done` / `in_review` / `blocked` without an explicit `nextActions` body trigger auto-derivation, a `issue.next_actions.missing_advisory` warn-log, and an `issue.next_actions_advisory` activity-log row. The PATCH succeeds. |
| `"true"` | Phase-2 hard-mode. The same status flips with no explicit `nextActions` body are rejected with HTTP 422 + a structured error and an `issue.next_actions.hard_mode_reject` activity-log row. The auto-derivation block is short-circuited. |

`nextActions: [{ kind: "terminal" }]` is accepted under hard mode as the
canonical "no follow-up" sentinel, alongside any non-empty `nextActions`
array and an explicitly empty array. See `AGENTS.md §11` for the close-out
protocol shape.

Relevant code:

- Toggle + gate helpers: `server/src/services/issue-next-actions.ts`
  (`isNextActionsHardModeEnabled`, `shouldRejectMissingNextActions`,
  `buildNextActionsHardModeRejectionPayload`).
- Wiring: `server/src/routes/issues.ts` PATCH `/issues/:id` handler — the
  gate fires immediately after `assertAgentIssueMutationAllowed` and before
  any side-effecting work.

## Rollback recipe

If hard-mode is enabled and we need to fall back to Phase-1 advisory
behavior in production:

1. Edit `/projects/ai-stack/docker-compose.yml` and either set
   `NEXT_ACTIONS_HARD_MODE=false` under the `paperclip` service `environment:`
   block, or remove the line entirely.
2. `agent-compose up -d paperclip` — recreates the container with the new
   env. No migration to undo; the toggle is purely runtime.
3. Confirm: `docker exec paperclip env | grep NEXT_ACTIONS_HARD_MODE` should
   either show `=false` or print nothing.
4. Sanity-check Phase-1 is back: PATCH any test issue to `in_review`
   without a `nextActions` body — the request should return `200` and you
   should see an `issue.next_actions_advisory` activity-log row instead of
   a `422`.

The structured 422 body that hard-mode emits also embeds the rollback hint
in `details.rollback`, so any agent that hits the gate during dogfood gets
the recipe inline.

## Cutover plan (informational — gated on Miller approval)

Hard-mode flips on after the ≥1 week Phase-1 advisory soak shows the
explicit-emission rate is high enough that the REJECT path won't break
agents in flight. Per `THEA-2825`:

1. CEO surfaces the soak-window summary + recommendation via `THEA-1130`.
2. Miller approves.
3. Set `NEXT_ACTIONS_HARD_MODE=true` in compose, restart the paperclip
   container, and watch the `issue.next_actions.hard_mode_reject`
   activity-log counter for the first 24h.
4. If retry rates spike, follow the rollback recipe above.
