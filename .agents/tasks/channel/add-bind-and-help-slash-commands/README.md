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

- **`announceIn` stays on `bindChannel`.** The alternative — answering through
  `FeishuSlashCommandReply.card` — either double-messages a `/bind` typed in an
  ordinary group or reintroduces the same `sameTarget` condition one layer up.
- **The repeated `FeishuChannelSession` bootstrap in tests stays as it is.**
  Eight construction sites across four test files share one field set, varying
  only in the `invoke` stub, the access policy, and whether `start()` runs.
  Offered as a `tests/helpers/` session factory replacing all eight, the
  operator chose **"不做"** on a question card dated 2026-09-15: a test that
  spells out its own setup reads better than one that delegates it. This is a
  ruling, not an unpaid cleanup — do not re-propose it.

### Closing the Collaboration Space container hole

The one item the simplification pass escalated instead of fixing. Asked as a
question card on 2026-09-15; the operator chose **"现在堵，进 #428"**. The
option labels were the TeamLeader's; the choice is his.

- **The defect.** A `group` binding row on a Collaboration Space's container
  answers `plan` for every topic under it, because a topic resolves to its
  parent group before `provision` is reached. The Space then stops giving new
  topics their own Team and says nothing. `/bind` refused it; MCP
  `bind_channel` did not, and no layer between the tool and the document read
  `spaces` at all.
- **The fix.** `FeishuRouting.bind` refuses a `kind: 'group'` target whose chat
  is some Space's container, inside the same `store.update` commit that
  enforces `requireOwner` and for the same stated reason. Putting it at the
  routing document rather than at an entry point is what makes it hold for
  every caller, present and future.
- **Narrow on purpose.** Only the whole chat is refused. A topic inside the
  Space stays bindable — that is precisely the bind automatic provisioning
  installs, so refusing topics would break the mechanism the rule protects.
- **What the command lost.** `/bind`'s own Space branch, `CommandContext`'s
  `inSpaceContainer`, and the `spaceForContainer` call that fed it. The command
  table no longer knows Collaboration Spaces exist, and every `/bind` refusal
  now reaches the sender through the one `Command /bind failed: …` wrapper
  instead of one row having its own sentence.
- **Two behavior deltas, neither asked about because neither is a choice.** The
  Space refusal now carries that prefix; and a `/bind` naming a missing Team in
  a Space chat reports the Team error rather than the Space error, because the
  Space check now sits below `team.status`.
- **Tests.** Two direct `FeishuRouting` cases — the container group is refused
  and commits nothing, a topic inside the Space still binds and its sibling
  still plans `provision` — plus the existing end-to-end `/bind` refusal, which
  now runs against a live Team so a green result cannot be the closed-Team
  refusal wearing the Space refusal's name. The MCP tool tests
  (`feishu-routing-tools.test.ts`) drive a `fakeSession` whose `bindChannel` is
  a recording stub, so they prove the tool forwards, not that the invariant
  holds; the invariant is proven at `FeishuRouting` directly, which is the layer
  both paths share.

**The reverse order, found while closing the first and ruled on the same day.**
Registering a Collaboration Space on a chat that already carried a group binding
reproduced the identical shadowing from the other side — found by reading
`bindSpace`, then confirmed with a throwaway probe rather than left as an
inference: `bindSpace` returned a `space_id` and a fresh topic then planned
`bound` instead of `provision`. It went back as its own question card; the
operator chose **"堵，拒绝注册"**.

`bindSpace` now refuses a container chat carrying a `group` row, inside its own
commit, and names the Team that holds it — `bind_collaboration_space` is
Dispatcher-only, so which Team owns a route is a read that caller is entitled
to, unlike the `requireOwner` refusal next door, which deliberately withholds it.

With both writes guarded the two checks stopped being two rules. The invariant —
**a chat carries either a whole-chat binding or a Collaboration Space, never
both** — is stated once on `FeishuRoutingDocument` in `routing/document.ts`, the
type that declares `bindings` and `spaces` together and whose header already
says they are one consistency domain. Each method's comment points at it instead
of restating it. A shared predicate was considered and rejected: the two sides
query different collections and would need a direction parameter, which is a
mechanism added while both checks survive.

Topic rows never conflict, so a Space whose topics are already provisioned can
still be renamed or repolicied — covered by its own test, because that is the
case a careless version of this rule would break.

**The refusal sits above the create/update fork, and that is now pinned.** The
re-review (Devbox, 2026-09-15, approved on `20604ba1`) observed that the
decision to refuse the rename path as well — the one question this task put to
the reviewer — had no test holding it, and that the placement is exactly what a
later "helpful" change would relax. A document holding the coexistence can no
longer be produced through either API, so the test seeds one on disk, which is
what a pre-rule document actually is. It asserts the document still loads
(validation is shape-only, so this cannot block a channel start), that it plans
`bound` for a fresh topic — the malfunction the rule prevents — that renaming
the space is refused, and that unbinding the chat then lets the rename through
and restores `provision`. The rename assertions check one row, the same
`space_id`, and an unchanged `generation`, so the refused call is provably the
update branch rather than a creation that hit the same guard. Verified
discriminating by removing the guard: the test fails.

**Operator check: an existing conflict must not stop the daemon (2026-09-15).**
Asked to approve the merge, the operator raised this instead, in his words:
"这个MCP工具的冲突和本地工具的冲突，它在运行时可以处理，但是如果磁盘上已经有已经
冲突的部分了，这部分还是不要让daemon完全起不来才对". Verified rather than
answered from the design: `validated` is envelope-only — object, version,
channel id, two arrays — and never inspects a row; `initialize` loads and
subscribes, `start` wires the bot, and the only event-driven routing write is
`forgetTeamRoutes`, which removes rows. No startup path reaches either refusal.
A session test now seeds a coexistence document, runs a real
`FeishuChannelSession` through `initialize` and `start`, and asserts it comes up
with both rows intact and `plan` unchanged. The property is stated in
`channel.md` and in the maintenance reference, so the next person to consider
tightening validation sees why it is shape-only.

### Knowledge closeout

| Owner | Result |
| --- | --- |
| `.agents/tasks/**` | This record, `requirement.md`, `technical-design/final.md`. |
| `.agents/product/README.md` | The slash-command entry now names five commands and states that a command may take an argument; four entries added — `/bind`'s behavior, the refusal to bind a Collaboration Space's own chat on any path, the `Previous Team` line on every bind path, and `/help` rendering the table. |
| `.agents/domains/channel.md` | Slash-command section: the five-row table, `usage`/`summary`, the single `yargs-parser` recognition seam and why `parse-positional-numbers` is off, `/bind`'s behavior, and the correction that a command may now change routing. Card placement: `announceIn`, and why a card sent away from its target carries no anchor Team. Routing tools: the binding operations take a `FeishuTarget`, the selector type is gone, and the MCP wire input still cannot tell a direct message from a group. |
| `packages/channel/feishu-channel/CLAUDE.md` | Dependency boundary admits `yargs-parser`; slash-command responsibility restated. |
| `package.json` | `yargs-parser` runtime dependency, `@types/yargs-parser` dev dependency, and the description's dependency claim. |
| Rush change file | Four. Three are `@excitedjs/feishu-channel` type `minor` with ordinary notes: the command surface, the Collaboration Space container refusal, and the reverse-order refusal in `bind_collaboration_space`. The fourth is `@excitedjs/dreamux` type `none` for the maintenance-reference update — that reference lives inside `packages/dreamux`, so mirroring the rule there makes the package count as changed even though none of its code moved, and CI's declaration check fails without it. No persisted file shape changed, so no `BREAKING:` and no `Rebuild:`. |
| `dreamux-maintenance` | `references/builtin-feishu.md`, the owning reference for the Feishu routing document: a chat carries either a whole-chat binding or a collaboration space, never both, and which tool refuses which. The shape did not change; the meaning of a valid document did. Carries its own `@excitedjs/dreamux` change file, since the reference ships inside that package. |
| `.agents/root.md` | N/A. No routing entry point moved. |
