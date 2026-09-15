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
   Team. The binding notification card `bindChannel` already sends is the only
   announcement; the command itself answers `silent`.
2. `/bind` typed inside a topic binds the topic's chat, not the topic.
3. `/bind` in a chat registered as a Collaboration Space container answers with
   a refusal and changes no routing.
4. `/bind B` in a chat already bound to Team A rebinds to B, and the
   notification card names A as the previous Team.
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

### Assumptions (labelled, not yet confirmed)

- The collaboration-space refusal is read in code as: the current chat is a
  registered Collaboration Space container — `spaceForContainer(chatId) !==
  undefined`. The operator said "话题群"; whether a chat that is a space
  container could also not be topic-mode is not separately checked, because the
  space registration is the fact the refusal is about.
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

### More assumptions (labelled, not yet confirmed)

- `/help` renders as a Markdown list rather than a hand-built structured card.
  The premise the operator was nearly asked about did not survive checking: a
  `kind: 'text'` reply is already delivered as an interactive card holding one
  `markdown` element (`feishu-transport/src/transport/message-content.ts`), so
  the choice is only between Markdown and bespoke card JSON, not between text
  and a card.

### Blocking unknowns

- **Q5, open.** What a successful `/bind` answers. The first assumption was
  `silent`, on `/dissolve`'s ground that `bindChannel` already announces itself.
  That ground was then checked and does not hold everywhere: `notificationTarget`
  sends a non-topic notification with no `replyTo`, which in a topic-mode group
  opens a new topic, so a `/bind` typed inside a topic gets no answer where it
  was typed. See `technical-design/draft.md` section 4c.
