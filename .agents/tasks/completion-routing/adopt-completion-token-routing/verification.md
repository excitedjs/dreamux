# Verification

## Implementation (single developer, code only)

- Build: `rush update` then `rush build --to @excitedjs/dreamux --to
  @excitedjs/agent-runtime-claude-code --to @excitedjs/agent-runtime-codex` —
  passed (8 packages).
- Lint: affected packages — passed. `git diff --check` — passed.
- Internal-identifier and forbidden-path scan — clean.
- Unit suites and test typecheck intentionally not run at this stage: subject
  tests were deleted in step 2 and retained consumer suites do not compile
  until the shared helpers are restored by the re-coverage stage.

## TeamLeader pre-review

- Scope containment: the source diff touches only the approved boundary (24
  files across dreamux-types, dreamux core, agent-runtime/claude-code,
  agent-runtime/codex); with test re-coverage, change files, and knowledge
  updates the full PR is larger but stays inside the approved surfaces.
- The implementation realizes every element of the approved architecture:
  submission handles, result-time completion tokens, router keyed by
  producer/token/recipient, close drainage with zero-completion stops, and the
  Last-boundary fix.

## Design notes recorded during review

1. `dreamux-types/src/index.ts` exports only the runtime-contract surface; no
   channel telemetry types are introduced (non-goal).
2. `team-service` / `teammate-collection` deliver completions through
   `deliverRuntime` with no conversation-projection wiring (non-goal).
3. `teammate-service/index.ts` creates the coordinator first and hands it the
   activity sink, preserving the existing `name()` seam.
4. `turn-coordinator.ts`: token settlement, admission, and close drainage as
   designed; the activity sink is a type-safe no-op receiver until the channel
   telemetry task lands.
5. `turn-recording.ts` initially carried a diagnostic per-turn id referenced by
   the stop-drain error message. Reviewed explicitly (no routing or dedup
   role); the operator decided on 2026-08-25 to drop it for this round because
   nothing in this repository consumes it yet — the stop error reports only the
   unsettled count and entity name. It can return with the channel telemetry
   task, which needs a per-turn grouping key.
6. `claude-code/src/runtime-submissions.ts` reports submission lifecycle only;
   tool-action display reporting is deferred to the channel telemetry task.

## Independent review adjudication

- Two read-only seats (fable, codex) ran independently against the approved
  architecture and the acceptance matrix. No blocker. Both examined the
  diagnostic turn id (design note 5); the operator later dropped it for this
  round. The four `BREAKING: Review:` change files are committed and
  `rush change --verify` passes.

## Batch test re-coverage

- Complete. All four packages green: dreamux 1082 passed / 4 legitimately
  skipped (independently re-run by the TeamLeader), claude-code 158/158,
  codex 136/136, dreamux-types 31/31. Retained dissolve/collaboration consumer
  suites pass unchanged once the shared helpers were restored.
- Also fixed: claude-code and codex `tsconfig.tests.json` had inherited an
  exclude that silently dropped `tests/` from the checked program; both now
  include their test programs and expose a `typecheck:tests` script.

## PR review round (PR #344)

- External review confirmed the token model and layering; one blocker and four
  minors, all verified and dispositioned:
  1. Blocker (real): the re-covered issue #63 live gate had lost its reaction
     tri-state assertions. Restored the `[received] -> [in progress] ->
     removed` assertions and emoji imports; the gate was executed live against
     a real codex install and passes, proving the channel reaction lifecycle
     is unchanged by this PR.
  2. Docs still naming the retired settlement object (package READMEs,
     provider-runtime and dispatcher-orchestration domains): updated to the
     submission/completion model in the same PR.
  3. This file's stale pre-re-coverage statements: refreshed.
  4. Missing `typecheck:tests` scripts in the two runtime packages: added.
  5. Two codex turn-manager nits (terminal-order entry after `failRecord`;
     dropped deferred on ambiguous `turn/start`) are recorded as known
     non-blocking follow-ups: `stop()` backstops the first and the second
     leaks nothing; both are left unchanged here to avoid untested hot-path
     churn.
