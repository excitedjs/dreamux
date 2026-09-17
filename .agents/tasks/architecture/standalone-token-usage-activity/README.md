# Emit a neutral token.usage activity instead of a synthetic usage message

## Current state

- Goal: Provider runtimes report each native turn's cumulative token counters
  as one structured live-only `token.usage` activity, with no synthetic
  assistant message and no adapter-held baseline or differencing; display
  layers render the counters themselves.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/standalone-token-usage-activity/requirement.md)
- Final solution: [A neutral token.usage activity](/.agents/tasks/architecture/standalone-token-usage-activity/technical-design/final.md)
- Verification: [Contract coverage and gates](/.agents/tasks/architecture/standalone-token-usage-activity/verification.md)
- Solution review Issue: Not created — the operator directed the contract in
  a Claude Code session; the pull request is the review surface.
- Blockers: None.
- Next action: None.
- Related tasks:
  [display-turn-usage-summary](/.agents/tasks/channel/display-turn-usage-summary/README.md)
  established the line this change preserves while replacing its carrier.

## Development approval

- Status: Granted by the operator on 2026-09-17 in a Claude Code session:
  usage becomes a standalone structured activity emitted in this repository
  first; providers keep the native cumulative counters verbatim with no
  baselines, differencing, or cold-read logic; the display layer renders the
  existing one-line summary itself.
- Approved implementation boundary: the additive activity union member across
  `dreamux-types`, both built-in runtimes, the projection, and the Feishu
  channel rendering, with tests and knowledge updates. Consumer-side snapshot
  storage and statistics are out of scope.

## Delivery

- Pull request: [#442](https://github.com/excitedjs/dreamux/pull/442).
- Scope delivered: `token.usage` in both activity unions; codex and claude
  emit the structured activity in place of the synthetic message with ids and
  terminal ordering unchanged; projection maps it snake_case with
  `redacted: false`; the Feishu CoT layer renders the identical historical
  line; the compact-number formatter moved into the channel package with its
  table test; minor rush change files for the five packages; provider-runtime,
  channel, and product knowledge pages updated.
- Coverage limit: the activity's consumer-side use (snapshot differencing,
  statistics) is deliberately not built in this repository, so end-to-end
  numbers are not verified here. Real-model live tests need a connected
  environment; the pull request's Actions runs provide that signal.
- Knowledge closeout: Complete. The provider-runtime domain owns the
  cumulative/live-only contract and the per-runtime native facts; the channel
  domain lists the new payload vocabulary; the product catalog keeps the
  rendered-line specification and points at this task. No config, CLI, state,
  or glossary surface changed.
