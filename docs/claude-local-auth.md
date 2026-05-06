# claude-local adapter — OAuth credential races

How the `claude_local` adapter shares Anthropic OAuth credentials with the
local Claude CLI, why concurrent runs occasionally surface a synthetic
"Not logged in" failure as `claude_auth_required`, and what mitigation
the adapter applies. Future recovery tickets should cite this doc rather
than re-deriving the cause.

## Shared-HOME architecture

When Paperclip runs multiple agents on a single host, every agent that
spawns the local Claude CLI inherits the same `HOME` directory. The CLI
reads and writes its OAuth state from two files under `HOME`:

- `~/.claude/.credentials.json` — the active access token, refresh
  token, and account metadata. The CLI overwrites this file in place
  whenever it auto-refreshes the token in-process.
- `~/.claude.json` — additional CLI configuration; not security-critical
  to this race but cohabits the same directory.

A host-side rotator (`/paperclip/bin/account-rotator.sh`) owns the pool
of OAuth accounts and swaps the active one in `.credentials.json` when
the current account approaches its 5-hour quota.

## The race

Two writers can update `.credentials.json`:

1. **The Claude CLI itself**, in-process during a run, when its current
   access token nears expiry.
2. **The host-side rotator**, on its scheduled cadence.

When two CLI processes run concurrently and both trigger an in-flight
refresh, they race on the same file:

- Process A asks Anthropic for a new token, receives `T1`, writes it.
- Process B asks for a new token, receives `T2`, writes it.
- The refresh server invalidates `T1` the moment `T2` is issued.
- Process A's in-memory copy is now stale. Its next API call returns
  Anthropic's OAuth-rejection canned response — `subtype=success` with
  body `"Not logged in. Please run /login."` — rather than a real 401.

The harness surfaces that synthetic-success body as `claude_auth_required`,
and the run fails until the next CLI invocation reads a healthy token.

The race window is the credential-write window (sub-second). The
recovery flow's effective action is "wait, then re-checkout" — which
works precisely because the next CLI invocation reads the file after
writers settle.

The host-side rotator compounds the race when its credential write is
non-atomic; a partial read can land a malformed JSON or an
about-to-be-invalidated token in the CLI's in-memory state.

## Forensics — see THEA-2946

Full incident timeline, recovery-ticket chain, and root-cause analysis
live in the parent issue's forensics comment:

- [THEA-2946](../../../) — comment `fd7ccacc-1380-433c-97ac-2e804975d109`

That comment also documents the choice to apply `Fix A + Fix B` rather
than per-run credential isolation (`Fix C`).

## Mitigation A — adapter retry-with-pause (this fix, THEA-2953)

When the first attempt of a Claude run reports `requiresLogin`, the
adapter sleeps `1500–3000ms` (jittered) and retries the run **once**
before bubbling `claude_auth_required` to the harness. If the second
attempt also returns `requiresLogin`, the error surfaces as today — the
adapter does not loop.

Implementation: `packages/adapters/claude-local/src/server/execute.ts`,
inside the `try` block around the `runAttempt` call.

Log line on retry, surfaced through the adapter's `onLog` channel:

```text
[claude-local] auth retry-with-pause (race window) — attempt 2/2
```

Grep that line in run logs to measure how often the race fires after
deploy.

Why this is enough on its own: the racing-writer window is sub-second,
so a short pause + reread typically catches a healthy token after the
sibling writer finishes.

## Mitigation B — atomic credential write (THEA-2954)

Tracked separately. Patches `/paperclip/bin/account-rotator.sh` and
`/paperclip/bin/reauth.sh` to write `.credentials.json.tmp` then
`mv` (POSIX atomic rename) instead of streaming JSON directly into the
target file. Removes the rotator-side racing channel, but does not
address CLI-on-CLI races between two concurrent Paperclip runs — Fix A
covers that.

## Verification — THEA-2955

A separate QA gate runs five sequential heartbeats on a test agent and
asserts zero `claude_auth_required` failures across the soak window,
inspecting adapter logs for the retry log line above.

## Future recovery instruction

If recovery tickets fire again after both fixes are deployed, do **not**
re-derive the race from first principles. Read the retry log line above
in the adapter run logs to confirm whether the in-adapter retry already
fired. Then escalate per the parent forensics comment in THEA-2946.

If the race is recurring at a rate that the single-shot retry no longer
absorbs, escalate by considering Fix C (per-run credential isolation
via `CLAUDE_CONFIG_DIR=$tmp/claude-$runId`) — outlined in the same
forensics comment as the next-cheapest mitigation.
