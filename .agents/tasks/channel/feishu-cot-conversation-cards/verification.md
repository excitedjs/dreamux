# Verification

## Implementation and review

- The implementation stays within the approved packages: Dreamux types and
  core, the two built-in Agent Runtime providers, Feishu Channel/transport,
  their bundled role prompts, tests, and Rush metadata.
- Review converged after closing the per-EntityTurn settlement, fail-open
  projection, late-activity, redaction, bounded-state, dispatcher isolation,
  leader correlation, and COT deadline-reaping findings. No accepted blocker or
  major finding remains open.
- Display remains observational: runtime admission, settlement, completion
  routing, delivery, and shutdown semantics are unchanged.

## Test coverage

- `@excitedjs/agent-runtime-claude-code`: extended
  `runtime-activity.test.ts` to cover live assistant/tool activity, neutral tool
  action classification, folded streams, normalized tool results, and a
  fail-open activity sink. Failed tool-result content is also pinned as the
  provider error detail, including JSON serialization of structured mixed
  content, with `null` reserved for unavailable detail.
- `@excitedjs/agent-runtime-codex`: extended `turn-manager.test.ts` for live
  assistant/tool activity, required nullable tool actions, folding, and
  activity-sink failure isolation.
- `@excitedjs/dreamux-types`: extended the runtime contract suite to pin the
  required-but-nullable tool action and the dispatcher/TeamLeader/Team-member
  Channel turn event union, including settled status and redaction fields.
- `@excitedjs/dreamux`: added conversation-projection and EntityTurnCoordinator
  suites for scope, sanitization, 512-fact caps, exactly-once settlement for
  folded submissions, failed/stopped mapping, late-activity fencing, full-bus
  integration, four-entry fail-open behavior, throwing identity/logger paths,
  and retained-turn cleanup. Existing channel-provider, collaboration, E2E, and
  live Codex suites were updated for the no-automatic-reaction contract without
  weakening submit-before-ack or mid-turn folding. Team-member integration
  coverage pins all four public event kinds, stopped settlement per admitted
  turn on collection close, and zero projection for dispatcher-spawned
  TeamMates.
- `@excitedjs/feishu-channel`: added COT adapter, event projection, outbox,
  reply-routing, and state suites covering inbound anchoring, dispatcher chat
  isolation, foreign-origin zero-state behavior, TeamLeader settlement
  correlation, semantic event grouping, serialized byte/event limits, failure
  isolation, 512/512/64 state caps, and deadline-based quota release. The
  former inbound reaction cleanup suites now assert zero automatic reactions
  while retaining explicit `react` tool behavior and the remaining inbound
  cleanup contract. The later anchoring coverage adds TeamLeader Reply
  next-anchor and binding-fallback precedence, the real
  transport-to-bot-to-session receipt chain, fail-open receipt observers and
  loggers, dispatcher non-leakage, delayed-receipt rejection after re-anchor,
  and binding-notification rejection after route replacement. Direct state and
  binding-notification integration suites pin both staleness guards, including
  same-chat cross-topic rejection and same-target last-write-wins. The bot suite
  pins forwarding of the per-message creation observer. Tool-event coverage
  also proves that normal results omit duplicate arguments and that provider
  detail remains uncleaned while respecting the escaped-byte cap. Lifecycle
  fence coverage rejects late submitted facts after Team close, route unbind,
  and route replacement; keeps another endpoint for the same live leader
  renderable without accepting the rejected turn's activity; matches fences
  and interruption to the authoritative accepted binding rather than visible
  target fallbacks; filters foreign routes before quota admission; rejects a
  late fallback plus its following internal turn; proves
  Team restart clears both leader-wide and endpoint route fences while a
  matching re-bind clears its route fence; and pins both 512-entry drop-oldest
  bounds. The Feishu role boundary also pins all Team-member event kinds as
  strict display no-ops. Reply routing proves a TeamLeader target conflict is
  contained after the visible send succeeds.
- `@excitedjs/feishu-transport`: added the COT transport suite for anchored
  create, explicit `reply_in_thread`, 1..50 append bounds, completion, business
  errors, and bounded request timeouts. The real text-send loop is covered for
  synchronous per-card receipt ordering and ordinals, partial-send failure, and
  fail-open observer errors; existing reaction coverage now retains only
  `addReaction`.

## Final gates

- `node common/scripts/install-run-rush.js update` — passed with no lockfile
  drift after the Lark SDK dependency update.
- `node common/scripts/install-run-rush.js build` — passed for the full
  workspace.
- `node common/scripts/install-run-rush.js typecheck` — passed for all packages
  that declare the source typecheck command.
- `node common/scripts/install-run-rush.js typecheck:tests` — passed for all six
  packages that declare the test-aware typecheck command.
- `node common/scripts/install-run-rush.js lint` — passed.
- `node common/scripts/install-run-rush.js test` — passed: 151 test files,
  2,073 tests passed, 4 skipped. The fourth skip preserves the cleanup-revival
  scenario while detail cleanup remains intentionally disabled;
  active coverage pins raw detail preservation and the escaped-byte cap. The
  real Codex live gates ran without `DREAMUX_SKIP_LIVE_CODEX` and passed 7/7.
- `.agents/scripts/check.sh` — passed.
- `git diff --check` — passed.
- Synchronous package-source I/O, internal-identifier, private-host/path,
  source-trace, and committed-secret scans — clean.

## Residual review

- TeamLeader presentation intentionally remains single-active. A stale settled
  event is a no-op; per-turn leader presentations are a future refinement, not
  part of this change.
- `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
  remains at the 700-line lint cap and should be split before further edits.
- No configuration, persisted-state, or path shape changed, so the bundled
  dispatcher-maintenance skill requires no synchronization.
