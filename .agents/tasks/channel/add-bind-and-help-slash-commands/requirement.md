# Requirement

## Initial request

The operator asked for three things, verbatim:

1. "飞书的 slash 命令增加一个 /bind，可以把当前群绑定给指定的团队，比如 /bind
   xxxxxx(team_name)"
2. "飞书的 slash 命令增加 /help"
3. "我感觉可以给feishu slash 也引入类似 yargs 的 开源基建，你可以帮忙选型一下"

## Current alignment

- Status: Converged. Every question raised during clarification has an operator
  answer; the remaining labelled assumptions are replayed on the
  development-authorization card.
- Confirmed current behavior and evidence:
  - The Feishu slash-command table is `COMMANDS` in
    `/packages/channel/feishu-channel/src/feishu-slash-commands.ts`, holding
    `stop`, `teams`, and `dissolve`.
  - `detectFeishuSlashCommand` returns only a command name. Everything after the
    leading token is discarded, so no command can take an argument today. Both
    `.agents/product/README.md` and `.agents/domains/channel.md` state that
    contract in prose.
  - Dispatch happens after `projectInbound`, so a command sees the same
    `FeishuTarget` the delivery path would have used: `topic` inside a
    topic-mode group, `group` otherwise.
  - `FeishuRouting.plan` walks `resolutionChain` — a topic's own binding row
    shadows its chat's binding row.
  - `FeishuBindingOperations.bindChannel` already exists and already sends
    `bindingBoundCard` into the bound target on success.
  - `FeishuChannelSession` already holds both `this.routing` and
    `this.bindings`, and its `command()` method builds the `CommandContext`, so
    a `/bind` command needs no new plumbing to reach the bind operation.
  - A team name is validated by `validateTeamId`
    (`/packages/dreamux/src/service/team-collection/types.ts`): 1–64 ASCII
    letters, digits, dots, underscores or dashes, starting with a letter or
    digit. A team name cannot contain whitespace.
  - Authorization for a command is the ordinary inbound gate and nothing more
    (`dreamuxFeishuGate`): in a group, the mention gate plus a trusted chat, or
    a trusted sender in a `follow-user` chat. `/bind` therefore reaches exactly
    the humans who can already run `/dissolve`.
- Desired outcome: The Feishu slash-command table answers two more commands —
  `/bind <team_name>`, which routes the chat the command was typed in to a named
  Team, and `/help`, which lists the table — and the table's argument reading
  goes through `yargs-parser`.
- Desired behavior: as stated by the acceptance criteria below.
- Scope: the Feishu channel's slash-command table and the recognition seam it
  crosses; the `yargs-parser` dependency on `@excitedjs/feishu-channel`; the
  knowledge owners that state the old no-argument contract.
- Non-goals:
  - No `/unbind` command. The operator did not ask for one.
  - No flags or options on any command. `yargs-parser` is taken for the
    argument-reading seam, not to add an option surface now.
  - No change to who may run a command: authorization stays the ordinary
    inbound gate.
  - No change to `/stop`, `/teams`, or `/dissolve` behavior.
- Constraints and invariants:
  - Channel-authored command text stays English (PR #379 operator ruling).
  - The Channel does not validate a team name or re-derive a bindability rule
    the binding layer already owns; a refusal reaches the conversation in the
    owning layer's own words.

## Acceptance criteria

1. `/bind <team_name>` typed in an ordinary group binds that chat to the named
   Team. The binding notification card is the only announcement; the command
   itself answers `silent`.
1a. The binding notification card is delivered into the conversation the
   command was typed in, including when that is a topic. A bind requested
   through the MCP tool, which has no such conversation, still announces into
   the bound target.
2. `/bind` typed inside a topic binds the topic's chat, not the topic.
3. Binding the whole chat a Collaboration Space is registered on is refused and
   changes no routing, on every path that reaches the routing document —
   `/bind` and MCP `bind_channel` alike. A topic inside that Space stays
   bindable, which is what automatic provisioning installs.
4. `/bind B` in a chat already bound to Team A rebinds the chat to B, and the
   binding notification card names A as the previous Team. This holds on every
   bind path, not only the command's: an MCP-initiated rebind shows the line
   too.
5. `/bind` with no argument answers with its own usage line.
6. `/bind` naming a missing or closed Team answers with the binding layer's own
   sentence, and nothing changes.
7. `/bind` in a direct message binds nothing and writes no binding row.
8. `/help` lists every command in the table, each with its usage and one-line
   summary, in English.
9. A team name that looks like a number — `123`, `1e5`, `0x1f` are all legal
   under `validateTeamId` — binds that exact name rather than a coerced number.
10. Adding a row to the command table makes the command appear in `/help`
    without a second edit anywhere.

## Decisions and unknowns

### Confirmed operator decisions

- **Task lineage (2026-09-15).** A new task record, rather than reopening
  `add-feishu-slash-commands`. The operator chose "新建任务" on the
  clarification card.
- **`/bind` target (2026-09-15).** The operator chose "永远绑整个群": `/bind`
  binds the chat-level target regardless of whether it was typed inside a topic
  or in the group's main area.
- **Collaboration-space refusal (2026-09-15).** The operator's words, verbatim:
  "如果话题群已经被绑定成协作空间，/bind 就给它报错。"
- **The refusal covers MCP too (2026-09-15).** Asked on a question card whether
  to close the matching hole in `bind_channel`, the operator chose
  **"现在堵，进 #428"**. The option labels and descriptions on that card were
  written by the TeamLeader; what is his is the choice. This extends the ruling
  above to a surface it did not name, which is why it was asked rather than
  inferred.
- **The reverse order is refused as well (2026-09-15).** Asked on a further
  question card whether `bindSpace` should refuse a chat already bound as a
  whole, the operator chose **"堵，拒绝注册"** over the alternative of silently
  clearing the existing binding. Same provenance: his is the choice, not the
  wording.

### Assumptions (labelled, not yet confirmed)

- The collaboration-space refusal is read in code as: the bind's target is the
  whole chat (`kind: 'group'`) and some registered Space names that chat as its
  container. The operator said "话题群"; whether a chat that is a space
  container could also not be topic-mode is not separately checked, because the
  space registration is the fact the refusal is about. Restricting it to
  `group` is not a narrowing of his words but the mechanism: a group row is the
  one that shadows every topic under it.
- A successful `/bind` answers `silent`, on the same ground `/dissolve` does:
  `bindChannel` already sends `bindingBoundCard` into the target, so a text
  receipt would be the second message about one event. A refusal still answers
  in words.
- A `/bind` with no argument answers with the command's own usage line rather
  than a bespoke error sentence.

### More confirmed operator decisions

- **Rebinding (2026-09-15).** The operator chose "直接改绑（推荐）": `/bind B`
  in a chat bound to Team A rebinds, exactly as the Dispatcher's `bind_channel`
  tool does. No new check is added.
- **Library selection (2026-09-15).** The operator chose "引入 yargs-parser",
  against the TeamLeader's recommendation to add no library at all. The
  recommendation and its data are kept in the solution so the trade-off stays
  legible; the ruling stands.

- **The binding card names the displaced Team (2026-09-15).** The developer
  stopped on acceptance criterion 4 and was right to: `bindingBoundCard` took no
  previous-Team parameter and `bindChannel` never passed one, so a rebind
  announced the new Team and said nothing about the one it displaced. Told that
  adding the line changes an existing card on every bind path including
  MCP-initiated ones, the operator ruled, verbatim: "加一行 Previous Team".
- **Where the binding card goes (2026-09-15).** Offered three receipt shapes for
  a successful `/bind`, the operator asked instead: "不能把原本发卡的逻辑调整
  正确吗". The card is made to land in the conversation that asked for the bind,
  which makes a receipt unnecessary; `/bind` answers `silent` in every case.

### More assumptions (labelled, not yet confirmed)

- `/help` renders as a Markdown list rather than a hand-built structured card.
  The premise the operator was nearly asked about did not survive checking: a
  `kind: 'text'` reply is already delivered as an interactive card holding one
  `markdown` element (`feishu-transport/src/transport/message-content.ts`), so
  the choice is only between Markdown and bespoke card JSON, not between text
  and a card.

### Blocking unknowns

- None.
