# Feishu /bind and /help slash commands

## Current state

- Goal: Add /bind <team_name> and /help to the Feishu slash-command table, and settle whether the table needs an argument-parsing library
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/add-bind-and-help-slash-commands/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/channel/add-bind-and-help-slash-commands/technical-design/final.md)
- Solution review Issue: [#426](https://github.com/excitedjs/dreamux/issues/426)
- Blockers: None. Requirement converged and the solution was reviewed on issue #426; every finding is adjudicated in the final solution.
- Next action: None.
- Related tasks: [add-feishu-slash-commands](/.agents/tasks/channel/add-feishu-slash-commands/README.md) built the command table this task extends.

## Development approval

- Status: **Granted by the operator on 2026-09-15**, in answer to a
  development-authorization card sent through `ask_user_question` in the Feishu
  work group. The card played back the acceptance criteria, implementation
  scope, non-goals, verification plan, and two residual risks, and named
  `requirement.md` plus `technical-design/final.md` as the boundary. The
  operator's answer, verbatim: "批准，开工".
- The card was re-sent once. The first card was answered with a question rather
  than an approval — "现在的 bind 应该不支持 bind 到话题吧？话题的绑定关系是不是
  只有协作空间可以做到？" — which was answered before approval was asked again.
  A question is not an approval.
- Approved implementation boundary:
  [requirement.md](/.agents/tasks/channel/add-bind-and-help-slash-commands/requirement.md)
  plus
  [technical-design/final.md](/.agents/tasks/channel/add-bind-and-help-slash-commands/technical-design/final.md).
  Anything outside them returns to the operator.

## Delivery

- Pull request: [PR #428](https://github.com/excitedjs/dreamux/pull/428).
- Implementation: one developer TeamMate, one writer, 17 files. It stopped once
  mid-task to report that acceptance criterion 4 was unsatisfiable, which was
  correct — see the correction recorded in `requirement.md` and section 4b of
  the final solution.
- Verification: `rush update`, then `build`, `lint`, `test`, and
  `typecheck:tests`, all green, re-run independently by the TeamLeader rather
  than taken from the developer's report. The three `SUCCESS WITH WARNINGS`
  operations in `test` are pre-existing stderr logging in the Codex runtime,
  Claude Code runtime, and Dreamux packages; `feishu-channel` is not among them.
  Feishu channel: 550 tests. No live Feishu chat was exercised.

### Simplification pass

Run after the PR was open, against `origin/next...HEAD`, on the operator's
request. Applied, all behavior-preserving and re-verified on all four gates:

- `FeishuSlashCommandInvocation.args` narrowed from `yargs-parser`'s
  `Arguments` to `readonly string[]`. The invocation crosses
  `FeishuInboundDelivery`, a pinned public export, so the old shape put both an
  `any` index signature and a devDependency-only type into the published
  `.d.ts`; `yargs-parser` no longer appears in any emitted declaration.
  `String(first)` went with it.
- `CommandContext.spaceContainer: FeishuSpaceRecord | null` became
  `inSpaceContainer: boolean`. No row read a field of the record, and the
  `?? null` normalization hop is gone with it.
- `resolutionChain` now derives from `containingChat`, so "a topic's parent is
  its group" is written once in `routing/target.ts` instead of twice.
- `FeishuTargetSelectorFields` deleted from `tools/types.ts` — dead before this
  task, with zero references anywhere, and left behind when its sibling
  selector type was removed.
- `feishu-channel.ts` stopped shadowing `command`'s own `input` parameter.
- The numeric-looking Team name fixture had been copied verbatim into two
  `it.each` tables; it is now one named constant both read.
- Documentation: the selector history was told twice in `channel.md` and is now
  told once; the stale code blocks and the appended "**Correction.**" paragraph
  in the final solution were rewritten in place, per the task-record rule
  against appending change history.

Not applied, and why:

- **The Collaboration Space refusal stays in the command.** Pushing it into
  `FeishuRouting.bind` would close a real hole — `bind_channel` can bind a
  Space container and silently stop its topics from being provisioned — but it
  changes MCP behavior, and the operator's ruling named `/bind`. Recorded in
  `channel.md` under *Team binding and authorization*, and in section 11 of the
  final solution, where the original justification for the placement was wrong
  and has been corrected. **Open question for the operator.**
- **`announceIn` stays on `bindChannel`.** The alternative — answering through
  `FeishuSlashCommandReply.card` — either double-messages a `/bind` typed in an
  ordinary group or reintroduces the same `sameTarget` condition one layer up.
- **`bindHarness` is the fifth copy of the `FeishuChannelSession` bootstrap.**
  Four more sit inline in the same test file and two in sibling files. Only the
  `invoke` stub, the access policy, and whether `start()` runs actually vary.
  Extracting a helper for the new copy alone would add a mechanism while every
  original survived; the honest fix is one `tests/helpers/` session factory that
  replaces all of them, which is its own change. **Cleanup trail.**

### Knowledge closeout

| Owner | Result |
| --- | --- |
| `.agents/tasks/**` | This record, `requirement.md`, `technical-design/final.md`. |
| `.agents/product/README.md` | The slash-command entry now names five commands and states that a command may take an argument; three entries added — `/bind`'s behavior, the `Previous Team` line on every bind path, and `/help` rendering the table. |
| `.agents/domains/channel.md` | Slash-command section: the five-row table, `usage`/`summary`, the single `yargs-parser` recognition seam and why `parse-positional-numbers` is off, `/bind`'s behavior, and the correction that a command may now change routing. Card placement: `announceIn`, and why a card sent away from its target carries no anchor Team. Routing tools: the binding operations take a `FeishuTarget`, the selector type is gone, and the MCP wire input still cannot tell a direct message from a group. |
| `packages/channel/feishu-channel/CLAUDE.md` | Dependency boundary admits `yargs-parser`; slash-command responsibility restated. |
| `package.json` | `yargs-parser` runtime dependency, `@types/yargs-parser` dev dependency, and the description's dependency claim. |
| Rush change file | `@excitedjs/feishu-channel`, type `minor`, ordinary note. No persisted file shape changed, so no `BREAKING:` and no `Rebuild:`. |
| `dreamux-maintenance` | N/A. No config or persisted-state shape, validation, default, ownership, or meaning changed. |
| `.agents/root.md` | N/A. No routing entry point moved. |
