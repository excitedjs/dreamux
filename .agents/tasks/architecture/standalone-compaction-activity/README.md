# Report runtime activity natively: compaction and interrupt kinds, provider ids, one type in camelCase

## Current state

- Goal: Provider runtimes report a context compaction and a native interrupt as text-free live-only activities, rendered by the Feishu CoT layer as the unchanged lines; every activity id is the provider's own id; `RuntimeActivity` is the only activity type from runtime to Channel; the four Core events are camelCase.
- State: `implementation`
- Requirement: [Current requirement](/.agents/tasks/architecture/standalone-compaction-activity/requirement.md)
- Final solution: [One native activity vocabulary from runtime to Channel](/.agents/tasks/architecture/standalone-compaction-activity/technical-design/final.md)
- Solution review Issue: [#445](https://github.com/excitedjs/dreamux/issues/445); reviewed externally by the Devbox reviewer in place of three solution-review TeamMates, as this work group allows.
- Verification: [Contract coverage and gates](/.agents/tasks/architecture/standalone-compaction-activity/verification.md) (first scope; rewritten after the second implementation).
- Blockers: None.
- Next action: the developer TeamMate implements the second scope on #446.
- Related tasks: builds-on
  [standalone-token-usage-activity](/.agents/tasks/architecture/standalone-token-usage-activity/README.md),
  which moved the usage line to the same display-owned shape; supersedes the
  activity-type decision in
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).

## Development approval

- First scope: granted on 2026-09-18. A development-authorization card in the
  operator's work-group topic asked whether to enter development on the
  recorded requirement and final solution (Issue #445), played back as three
  concrete before/after scenarios; the operator answered 「批准进入开发」. The
  boundary was the two additive kinds across `dreamux-types`, both runtimes,
  the Core projection, and the Feishu CoT rendering, with no activity id
  change. That implementation is on #446 and was approved there by the Devbox
  reviewer.
- Second scope (native ids, merged type, camelCase events): granted on
  2026-09-18. The operator chose to fold it into #446 (card answers
  「并进 #446」 twice). After the Devbox reviewer's second round on #445 (no
  blocking issue), a development-authorization card played back the rendered
  card (unchanged), the id change on an interrupted Claude turn, the single
  activity type, the four camelCase events with the rest left to #447, the
  implementation boundary, and the verification plan; the operator answered
  「批准进入开发」. The same card asked whether `teammate.input` drops its
  unread `redacted` too; the answer was 「顺手删掉」.
- Approved implementation boundary: `dreamux-types` (merged union with base
  shape and native-id doc, `TeammateActivity` removed, four events in
  camelCase, `redacted` removed from activities and `teammate.input`), both
  built-in runtimes' ids, the Core projection (redaction in place), the Core
  event producers and seal, the Feishu CoT layer and its readers of the four
  events, their tests, the five change files, and the provider-runtime and
  channel knowledge pages. No persisted file, MCP payload, CLI output, label
  text, card terminal, or emission order changes.

## Delivery

- Pull request: [#446](https://github.com/excitedjs/dreamux/pull/446), open.
- Knowledge closeout: done for the first scope; redone after the second
  implementation.
