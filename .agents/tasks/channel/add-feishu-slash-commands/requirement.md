# Requirement

## Initial request

The operator asked for `/` commands on the Feishu side, starting with exactly
three: `/stop`, `/teams`, and `/dissolve`. More commands are expected later.

## Confirmed current behavior

Verified against current source, not inherited from any document.

- `/introduce` is the only slash command that exists today
  (`packages/channel/feishu-channel/src/introduce.ts`, `INTRODUCE_RE`; it is the
  only such command regex in the repository). It runs before the access gate
  because it bootstraps peer-bot trust, which is a Channel-owned fact.
- The Core Command catalog (`packages/dreamux/src/command/catalog.ts`) publishes
  `team.list` and `team.dissolve`, but nothing that interrupts a running turn.
  The only stop-shaped Command is `workflow.stop`.
- `TeamRecord.leader_agent_runtime` already exists
  (`service/team-collection/types.ts`) and is projected into `TeamView`
  (`team.status`) and `TeamHistoryRow` (`team.history`). `TeamListRow`
  (`team.list`) omits it; `read-model.ts` `listRow` simply does not copy it.
- Team status vocabulary is `starting | running | closed`.
- `FeishuBindingRecord.display` is an optional human label passed by whoever
  called `bind_channel` / `bind_collaboration_space`; its schema description is
  "Optional human label for this target in listings." It is not a Feishu chat
  name, and the automatic per-topic provisioning path passes `display: null`
  (`feishu-channel.ts`), so auto-provisioned bindings never carry one.
- `feishu-transport` exposes `resolveUserName` but no chat-name lookup.
- A Feishu direct-message chat cannot be bound to a Team (`bindChannel` in
  `feishu-session-bindings.ts` refuses `p2p`), so a DM never has a bound Team.
- `team.dissolve` requires a non-blank `note`. Invoked through the Command port
  its requester is `dispatcher` (`dispatcher-service/index.ts`), which requires a
  reclaimable managed worktree before anything stops and refuses otherwise
  unless `force` is set (`team-service/closing.ts`).
- External channel binding is deliberately Channel-owned and absent from Core
  (stated in the `team-collection/commands.ts` header), so Core holds no
  cross-channel binding registry a Channel could read.

## Desired behavior

### Shared by every command

- The Feishu channel recognizes and executes commands deterministically. A
  recognized command is consumed: it is not also delivered to an agent as an
  ordinary message.
- In a group or topic a command triggers only when this bot is @-mentioned, even
  when that chat does not require a mention for ordinary delivery. A direct
  message has no mention, so the command triggers directly.
- Authorization is the ordinary inbound delivery gate. Commands add no sender
  allowlist and no confirmation step, including `/dissolve`.
- When a command has no object to act on, reply with one short line stating why
  and do nothing else.
- The three commands are one extensible command table, not three special cases.

### Command recognition

- Text messages only. A slash command inside a rich-text post is not recognized;
  this follows `detectIntroduce`, which already refuses every non-text message.
- Leading Feishu mention placeholder tokens are stripped first, longest key
  first, so an `@`-prefixed command still matches. `detectIntroduce` already does
  exactly this and explains why the ordering matters.
- After stripping, the message must *start* with the command token, which must be
  followed by whitespace or end of message. A command appearing mid-message is
  never recognized, so quoting one in a sentence cannot fire it.
- Matching is case-insensitive, as `INTRODUCE_RE` already is.
- Everything after the command token is ignored entirely. No command takes an
  argument. The operator verified this is what Claude Code does and chose the
  same rule.

### `/stop`

- Interrupts the current turn of the agent this conversation talks to directly:
  the bound Team's TeamLeader in a group or topic, the Dispatcher Agent in a
  direct message.
- It does not touch TeamMates that agent started.
- This needs a new Core capability that interrupts a running turn and reaches the
  runtime through `AgentRuntimeProvider`. It is the only one of the three that
  adds a Core capability.

### `/teams`

- Lists only Teams whose status is `running`.
- Answers with the Running Team locator card, rendered by the Feishu channel in
  TypeScript rather than by an agent.
- Per Team the card shows the agent-runtime tag, the Team name, a short intent,
  and that Team's Feishu bindings (group and topic), grouped by repository
  basename.
- `team.list` gains `leader_agent_runtime` on its row.
- `feishu-transport` gains a chat-name lookup shaped like the existing
  `resolveUserName`, used to render a binding entry with the chat's current name.
  `display` is not usable for this: auto-provisioned bindings never have one.
- Colors come from a fixed palette chosen by a stable hash of the name, one
  palette for repositories and one for agent runtimes. No name-to-color table.
- Repository panels are always collapsed by default.
- Only Feishu's own bindings appear. The card carries no cross-channel view.

### `/dissolve`

- Dissolves the Team bound to this conversation.
- The command generates the `note`; `force` is never sent.
- Three outcomes are reported: dissolved, no bound Team, or refused. A refusal
  reports the reason, and the Team keeps running.
- Making a refusal observable requires a Core change: the dissolve receipt must
  await the pre-stop worktree assessment instead of returning ahead of it.

## Scope

- Feishu channel command recognition, dispatch, and reply rendering.
- `team.list` row extension with the leader agent runtime.
- A `feishu-transport` chat-name lookup.
- `/introduce`'s acknowledgement text, which the operator ruled becomes English
  in this task. Only its wording changes.
- One new Core capability that interrupts a running turn.

## Non-goals

- Any command beyond the three named ones.
- A cross-channel binding view on the `/teams` card.
- Sender allowlists or confirmation flows for these commands.
- A forced dissolve from a chat command.

## Acceptance criteria

1. In a group bound to a running Team, `@bot /stop` sent while that TeamLeader is
   mid-turn ends that turn; the TeamMates it started keep running.
2. The same message without the mention is not treated as a command.
3. `/stop` sent when nothing is running answers with one line saying so.
4. `/teams` answers with a card listing exactly the Teams whose status is
   `running`, each carrying its leader's agent runtime.
5. Two `/teams` calls with unchanged Teams produce the same colors for the same
   repository and the same agent runtime.
6. A binding entry on the card shows the chat's current name, including for a
   Team whose binding was created by automatic provisioning.
7. `/dissolve` in a group bound to a Team with a clean worktree dissolves it;
   `team.list` no longer reports it as `running`.
8. `/dissolve` in a direct message answers with one line saying the conversation
   has no bound Team, and dissolves nothing.
9. `/dissolve` on a Team whose managed worktree cannot be reclaimed answers with
   the reason and leaves the Team running.
10. `@bot /stop now please` is recognized and the trailing words change nothing.
11. `@bot I already sent /stop` is not recognized as a command and is delivered
    as an ordinary message.
12. A rich-text post whose first line is `/teams` is not recognized as a command.

## Decisions and unknowns

### Confirmed operator decisions

- `/stop` means interrupt the current turn, accepting that this adds a Core
  capability.
- `/stop` stops only the agent this conversation talks to, not that agent's
  TeamMates.
- A group command requires an @-mention of this bot, without exception.
- These commands use ordinary inbound delivery authorization; `/dissolve` gets no
  sender allowlist and no second confirmation.
- `/teams` lists running Teams only.
- `/teams` is rendered by the Channel, with chat names resolved live.
- Colors may be a fixed cycle, absent entirely, or a stable hash per repository
  and per agent runtime; the operator offered all three and preferred stability.
  A stable hash over a fixed palette is what this task takes.
- `team.list` should carry the TeamLeader's agent runtime; the operator asked for
  that extension to ride along with this task.
- When a command has no object to act on, answer with one line explaining why.
- Every user-facing string these commands produce is English — the card and the
  plain-text replies alike. The operator ruled this after seeing the alternative:
  the TeamLeader had asked for Chinese in review, on the ground that the
  channel's existing replies are Chinese or bilingual, and that finding was
  withdrawn. These commands do not follow the surrounding convention.
- `/introduce`'s acknowledgement becomes English too, by a separate operator
  ruling that named only `/introduce`. The channel's other Chinese surfaces — the
  ask-user cards, the binding notification cards, the pairing replies — were put
  to the operator and are out of scope unless he rules on them.
- The codex minimum version is not raised. When the TeamLeader proposed bumping
  it, the operator refused and told him to check the source at 0.137 instead;
  `turn/interrupt` is present there with the same shape.
- The dissolve receipt awaits the worktree assessment. `TeamService.dissolve`
  returned `{ accepted: true, status: 'submitted' }` synchronously and ran the
  whole dissolve — including the check that can refuse it — behind that receipt,
  logging a failure and telling the caller nothing. The TeamLeader first
  described a refusal as observable, which was wrong, then proposed changing only
  the dispatcher path. The operator rejected both framings and ruled that the
  worktree check simply goes first, for either requester: "你把 worktree 检查放在
  第一位，不就可以了？" ("just put the worktree check first, doesn't that do it?").
- A command is recognized only at the start of the message, and everything after
  the command token is ignored entirely. The operator checked Claude Code's
  behavior and chose to match it. The accepted cost is that a message combining a
  command with a real request loses the request.

### TeamLeader decisions the operator did not object to

- Commands are handled deterministically by the Channel rather than delivered to
  an agent to interpret. A `/stop` delivered as an ordinary message would queue
  behind the very turn it is meant to end.
- "Group commands require a mention" constrains groups and topics only; a direct
  message has no mention to require.
- Implemented as one command table, because more commands are expected.
- Case-insensitive matching and text-messages-only recognition follow
  `detectIntroduce` rather than adding a second parsing rule for these commands.

### Unknowns

- How the Core interrupt capability is shaped, and where command dispatch sits
  relative to the access gate and route resolution, are technical-solution
  questions, not requirement questions.
