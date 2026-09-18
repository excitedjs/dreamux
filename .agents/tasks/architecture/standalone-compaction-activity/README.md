# Report compaction and interrupts as neutral activities instead of synthetic assistant messages

## Current state

- Goal: Provider runtimes report a context compaction and a native interrupt as text-free live-only activities; the Feishu CoT layer renders the unchanged COMPACTED SESSION and [Request interrupted by user] lines itself.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/standalone-compaction-activity/requirement.md)
- Final solution: [Neutral compaction and interrupt activities](/.agents/tasks/architecture/standalone-compaction-activity/technical-design/final.md)
- Solution review Issue: [#445](https://github.com/excitedjs/dreamux/issues/445); reviewed externally by the Devbox reviewer in place of three solution-review TeamMates, as this work group allows.
- Verification: [Contract coverage and gates](/.agents/tasks/architecture/standalone-compaction-activity/verification.md)
- Blockers: None.
- Next action: None.
- Related tasks: builds-on
  [standalone-token-usage-activity](/.agents/tasks/architecture/standalone-token-usage-activity/README.md),
  which moved the usage line to the same display-owned shape.

## Development approval

- Status: Granted on 2026-09-18. A development-authorization card in the
  operator's work-group topic asked whether to enter development on the
  recorded requirement and final solution (Issue #445), played back as three
  concrete before/after scenarios; the operator answered 「批准进入开发」.
- Approved implementation boundary: the two additive activity kinds
  (`context.compacted`, `turn.interrupted`) across `dreamux-types`, both
  built-in runtimes, the Core conversation projection, and the Feishu CoT
  rendering, with their tests, `minor` rush change files for the five
  packages, and the provider-runtime, channel, and product knowledge pages.
  No `turn.ended` status, card terminal, label text, activity id, or cold-read
  change.

## Delivery

- Pull request: [#446](https://github.com/excitedjs/dreamux/pull/446).
- Knowledge closeout: Complete. The provider-runtime domain owns the two
  kinds' contract, the per-runtime emission points, and the superseded
  2026-09-04 carrier ruling with the 2026-09-18 words beside it; the channel
  domain lists the vocabulary and the lines the Channel renders itself; the
  product catalog keeps both card lines and now states the teardown case. No
  config, CLI, state, glossary, or directory `CLAUDE.md` surface changed.
