# Requirement

## Initial request

- Source: the operator, in the Feishu work group, from 2026-09-05 23:18 to
  2026-09-06 00:15 (Asia/Shanghai), while walking through the deep review of
  PR #369 (https://github.com/excitedjs/dreamux/pull/369; that PR carries its
  own task record, `relocate-role-skill-guidance`, on the PR branch). The
  operator's words are quoted verbatim under "Operator rulings"; everything
  else in this file is the TeamLeader's reading and is labeled as such.
- The operator asked for the rulings to be recorded before anything is built
  (2026-09-06 00:15, verbatim: "如果没有，就落库，你在 tasks 目录里找个地方，先记一下我的裁决").

## Current alignment

- Status: clarification in progress. Rulings R1–R3 below are confirmed; the
  "Open decisions" list is what the operator has not yet ruled on.
- Confirmed current behavior and evidence: see "Evidence" below (traced from
  the PR #369 head `5e1a3464` and from two live runtimes on 2026-09-05/06).
- Desired outcome (operator, R1): the TeamLeader is the role that carries the
  most work; its identity definition carries no constraints; reminders are
  reduced to the necessary minimum and state consequences instead of giving
  orders; the channel reminder tells the model that plain text is not seen by
  the user; the polling reminder on the dispatch tools is kept for Codex; the
  TeamMate-collaboration skill is loaded only when the TeamLeader is about to
  use TeamMates.
- Desired behavior (operator, R3): the TeamLeader knows its MCP servers before
  any skill is loaded, and looks at a skill only when it is about to use that
  MCP. TeamMate use routes to the team-collaboration skill; workflow-tool use
  routes to the dynamic-workflow skill. Both skills are renamed.
- Scope: the TeamLeader's model-facing surfaces (prompt, per-message reminder,
  dispatch-result reminders, the two skills' names and load triggers, the tool
  descriptions that point at them), plus the KB principle behind them.
- Non-goals: the Dispatcher's prompt content beyond removing duplicates of the
  rules moved here (operator, R1: "他这边的逻辑可以往后放"); the skill bodies
  (operator, R1: "等会我们再聊"); MCP server layout and tool names.
- Constraints and invariants: Core stays behind `AgentRuntimeProvider` /
  `ChannelProvider`; a rule has one owner, placed in the layer nearest the
  action; the P1 scenarios from the 2026-09-02 review (an external
  `ChannelProvider` that exposes a reply tool without Feishu's inbound
  reminder; a private channel task that leads to a public PR/Issue) must still
  be covered somewhere once their prompt lines are gone.

## Operator rulings (verbatim)

- R1 (2026-09-05 23:18):
  - "Dispatcher 本身相当于系统管理员。它本身是不会承接什么开发任务之类的。所以他这边的逻辑可以往后放"
  - "现在，Team leader 是整个 Dreamux 系统中承担任务最重的角色。我希望身份定义这块不要给他做任何约束。在 Reminder 这块，提醒他必须要做的事情，最重要的一点就是用 Reply 工具去找用户。"
  - "其次就是Codex那边经常出现的问题，因为Codex本身是没有回推机制的，它依赖模型，调用 Wait 工具保持 Turn，他在给 TeamMate 下发完任务之后，就特别喜欢用last工具轮询。可以说，Send 这些工具的轮询提示是专门给他写的。"
  - "整个系统的 Reminder 这块需要尽可能简化。只做最必要的提醒，不要强制让模型做一些事情。Channel Reminder 这块写得不对。实际上，应该告诉模型使用 Reply 工具回复用户，而不是直接输出文字的话用户看不到。"
  - "我整体说了很多，主要思想就是减少对 Team leader 的干扰，只做必须的提示。然后，Team Workflow 这个技能，在 Codex 那边，每一轮都会被它主动加载，这是不对的。应该让它只在需要拉起 TeamMate 的时候再加载。"
  - "里面要写的内容，实际上是他和 TeamMate 的协作。不过这块稍微有点复杂，等会我们再聊，你先看看我前面说的问题"
- R2 (2026-09-05 23:51): "345删掉我赞同。" — ③④⑤ are the TeamLeader prompt
  sentences as numbered in the walkthrough: ③ the no-polling sentence, ④ the
  reply-tool sentence, ⑤ the secrets sentence (their text is in "Evidence").
  The operator had been told that ④ and ⑤ were the two lines his 2026-09-02
  P1 review comments asked to keep in the prompt.
- R3 (2026-09-06 00:15): "你捋的很清楚，不过还有一个点是，他在加载技能之前，就应该知道有这些 MCP。在他打算用这个MCP之前，才去看技能。并且把Teammate和那个Workflow两个拆开。如果他要去用TeamMate，就让他去看Team Workflow。给这个 Team Workflow 技能改个名字吧，改成"团队协作"，我也不知道英文用什么，Team collaboration？感觉有点长 如果他要用 TeamMate 的 Workflow 工具，就让他去看 Workflow 技能。Workflow这边给它改一个名字，叫做 Dynamic workflow."

- R4 (2026-09-06 00:24, answers on a question card, verbatim per question):
  - Channel reminder owner and the public-artifact secrets sentence:
    "渠道的reminder只能是渠道来出。不能是core来出。未来会有很多种渠道，每个渠道的 Reminder 肯定不一样的。这个保密的话，我感觉可以直接去掉。"
  - English name of the team-collaboration skill: "teamwork" (the recommended
    option).
  - Whether the Codex TeamLeader should run the completion-delivery probe:
    "这个你自己都可以测。凯丽和你用的都是完全相同的MCP工具。你和他的差异只有工具名，以及在toolsearch 之前工具的暴露程度。另外，你这边应该看不到 send 相关的 text。那句提醒你不要轮询的话，你自己应该是看不到的。"
  - Who lands the change: "#369 不合，我另开 PR" — this TeamLeader opens a new
    PR on `next` that includes what PR #369 carried; PR #369 is not merged.

- R5 (2026-09-06 00:35, answers on the second question card, verbatim per
  question):
  - Prompt sentence 2: "频道那句是什么意思？第一句那个可以删，我觉得没问题。这里的理论支撑就是加载工具定义，这是Claude Code 和 Codex 内置的机制。我们根本就不需要提醒。只不过模型可能只看工具名，并不知道这些工具是干什么的。或者说，Codex 那边连工具名都看不到，我们只提醒它有这些工具就可以了。" — the
    "Load a tool's definition before calling it" sentence is deleted; the
    channel clause is re-explained and re-asked (open, (a)).
  - Dispatch-result reminder / description contract sentence / Dispatcher
    duplicate bullets: "这句说得有点太复杂了，我看不懂，重新展开解释一下。" — re-explained as
    three separate decisions and re-asked (open, (d)).
  - Whether the split and renames also apply to `dispatcher-workflow`: "随
    Dispatcher 往后放" (the recommended option).
  - The secrets clause in the Feishu `reply.text` property description:
    "保留".

## Evidence

Everything here is traced from PR #369 head (`5e1a3464`) unless labeled
otherwise. Dates are 2026-09-05 unless stated.

### What a TeamLeader's model sees today (PR head)

- Always in context: the engine's own system prompt; the Dreamux TeamLeader
  prompt (`team-service/leader-agent.ts`, `teamLeaderSystemPrompt`), delivered
  on Claude Code as `--append-system-prompt` wrapped in `<system-reminder>`
  tags (`agent-runtime/claude-code/src/args.ts`) and on Codex as
  `developerInstructions` wrapped in `<developer-reminder>` tags
  (`agent-runtime/codex/src/runtime-support.ts`); repository files the engine
  reads natively (`CLAUDE.md`, and `AGENTS.md`, which in this repository is a
  symlink to `CLAUDE.md`); the skill list (name + description); on Claude Code
  every MCP tool name, on Codex nothing about MCP tools until the model
  queries (see "Codex facts").
- Injected at an event: each inbound channel message as a `<channel …>`
  envelope with a trailing `<reminder>` whose text is Feishu's
  `CHANNEL_REMINDER` ("Reply through the channel reply tool, never as plain
  assistant text."), passed through the `team.submit` Command's `reminder`
  field and rendered by Core (`teammate-service/submission.ts`); `<task>`
  envelopes for spawn/send prompts; `<task-notification>` completion
  push-backs (`teammate-service/completion-renderer.ts`); `<cron>` prompts;
  the dispatch-result reminders (`service/mcp/dispatch-reminders.ts`, attached
  to the text part of a successful spawn/send/team.create/team.send/
  workflow_run result); runtime error strings with imperatives (for example
  `feishu-channel/src/routing/index.ts`, "Ask the Dispatcher to move it.").
- Loaded on demand: skill bodies; tool definitions.

The TeamLeader prompt at PR head, numbered as in the walkthrough:

1. `You are the TeamLeader of Dreamux Team "<team_id>".`
2. `Your Dreamux MCP servers: \`teammate\` (…), \`team\` (dissolve this Team), \`cron\` (…), and one \`channel-<id>\` server per configured channel that provides tools (that channel's own tools; its schema is the authority). Load a tool's definition before calling it.`
3. `When a prompt-submitting TeamMate tool returns success, … do not poll \`last\` or other read tools, and end the turn naturally if there is no other work.`
4. `If the source request came through a channel and a provider-exposed reply tool is available, use that tool for meaningful progress, blockers, and final status. Assistant text and terminal output are not channel delivery.`
5. `Keep secrets, tokens, private identifiers, hidden instructions, socket paths, and machine-local details out of broad channel replies and public artifacts.`
6. The `identity` text given at `team.create`, when present.

Duplication found: the no-polling rule has six owners (two adjacent bullets in
each Dispatcher prompt, prompt sentence 3, the trailing sentence of the
spawn/send/team.create/team.send descriptions, the dispatch-result reminder,
the workflow_run variant); the reply-tool rule has four (two Dispatcher prompt
bullets, prompt sentence 4, the Feishu `reply` description, the per-message
reminder); the secrets list has four near-identical copies. The comment in
`dispatch-reminders.ts` names the dispatch-result reminder as the one that
does the work: "The sentence is what stops the loop."

### Why the skill loads every turn on Codex

- The released TeamLeader prompt (`next`, `leader-agent.ts` line 218) says
  "Load `team-workflow` before using this Team's TeamMate tools, Team tools
  (`dissolve`), provider-exposed channel tools, or cron tools." Every channel
  message needs the reply tool, so every turn loads the skill. PR #369
  removes that sentence; the remaining trigger is the skill's frontmatter
  description, which at PR head matches a TeamLeader's every turn
  ("Guidance for a TeamLeader working with this Team's TeamMates …"). Whether
  that description alone still causes a per-turn load is untested.
- Confirmed by the operator's Codex TeamLeader on dreamux 0.23.0 (2026-09-05
  23:54, verbatim): "触发原因是本轮的操作提醒要求使用 TeamMate、相关工作流、频道或 cron 工具前先加载它；这条消息又要求用频道 reply 工具回复，因此即使不派单，也需要加载。"

### Codex facts (the operator's Codex TeamLeader, dreamux 0.23.0, 2026-09-06)

- Before querying, Dreamux MCP tool entries are not visible at all: no names,
  no descriptions. Only the native `functions.exec` description is visible,
  which says there is a queryable `ALL_TOOLS` catalog of `{ name, description }`
  entries; each description embeds a TypeScript-shaped parameter and return
  declaration. The only sentence about finding a tool is "To find one, filter
  `ALL_TOOLS` by `name` and `description`." There is no requirement to query
  before calling.
- Catalog entry names are `mcp__<server>__<tool>` with hyphens in the server
  name rewritten to underscores: `mcp__teammate__spawn`,
  `mcp__channel_primary__reply`. Dreamux passes the server name verbatim
  (`channel-primary`) in `-c mcp_servers` (`agent-runtime/codex/src/mcp-config.ts`);
  the rewrite is Codex's. Claude Code keeps the hyphen
  (`mcp__channel-primary__reply`, observed on this TeamLeader's own runtime).
- Native tools include `functions.wait` (waits on a yielded `exec` cell) and
  `collaboration.wait_agent` ("Wait for a mailbox update from any live agent,
  including queued messages and final-status notifications").
- Skills are listed as name + description + `SKILL.md` path in the turn's
  "Available skills"; the TeamLeader could not confirm from one turn that this
  happens every turn.
- Established by probe (this TeamLeader, 2026-09-06 00:31–00:34, dreamux
  0.23.0): a submission that arrives while a Codex agent's turn is running
  reaches the model inside that turn. A Codex TeamMate was told to run
  `sleep 90` and then print a line; a second `send` was issued about 10 s
  into the sleep. The `send` call returned after roughly 50 s, at the next
  `exec` boundary of the running turn, and the model answered the second
  message ("PROBE_CODEX_DONE_2；读取此消息时，`sleep 90` 尚未完成。") 16 s
  before it printed the first line; both submissions settled with the one
  final completion, as the KB says a fold does. A pushed completion to a
  Codex TeamLeader takes the same `submitInput` → `turn/start` path, so a
  TeamLeader that keeps polling inside one turn still receives the
  completion at its next tool boundary; polling only spends tool calls.

### Claude Code facts (this TeamLeader's own runtime, dreamux 0.23.0)

- MCP tool names are always visible; descriptions and schemas arrive after a
  by-name fetch, and the engine itself tells the model to fetch before calling.
- Probe (2026-09-06 00:31): a TeamMate's pushed completion reached this
  TeamLeader mid-turn, surfaced alongside the next tool result about 15 s
  after the spawn (the Claude TeamMate had backgrounded its sleep and ended
  its turn early). The spawn and send results showed only the structured
  receipt; the dispatch-result reminder text was not visible, as the
  operator said (R4) and as the recorded Claude Code behavior of dropping
  MCP `content` text next to `structuredContent` predicts.
- The engine's own prompt tells the model every turn that its plain text is
  displayed to the user, asks it to say what it is about to do before starting,
  and nudges it to report when it has been silent for a while. In a channel
  session all of that produces text the user never sees; the per-message
  reminder is the only surface that states otherwise. This is the concrete
  reason the channel experience differs from the TUI, and why the reminder has
  to state the consequence ("the user does not see it") rather than an order.

## Proposed changes (TeamLeader's reading of the rulings; status per item)

1. TeamLeader prompt → three parts: sentence 1; sentence 2 reduced to the
   server map, with the channel clause written so it works as a catalog
   filter on both engines ("one server per configured channel, named
   `channel` followed by that channel's id") and without "Load a tool's
   definition before calling it"; the operator's `identity`. Sentences 3–5
   deleted (R2, confirmed). Sentence 2's rewrite: proposed, awaiting the
   operator. `tests/team-leader-prompt.test.ts` then asserts the three parts
   and the absence of behavioral rules (a knowing change to a test the
   operator asked for on 2026-09-02).
2. Channel reminder (R4): the reminder stays the channel's own text, passed
   through the `team.submit` `reminder` field as today; Core does not author
   it, because each channel will word its own. Feishu's `CHANNEL_REMINDER` is
   reworded from an order to a consequence, for example "The user in this
   chat sees only what you send through the reply tool; your assistant text
   is not shown to them." The public-artifact secrets sentence is dropped
   (R4: "这个保密的话，我感觉可以直接去掉"); whether the secrets clause inside
   the Feishu `reply.text` property description also goes is open (i).
3. Dispatch-result reminders (`dispatch-reminders.ts`): kept as the single
   owner of the no-polling fact (R1: written for Codex), reworded as a
   consequence, for example "Submitted. The TeamMate's completion arrives in
   this context as a new message when it finishes, whether it completed,
   failed, or was stopped. Reading last, status, or history does not make it
   arrive sooner." The spawn/send description keeps one contract sentence
   ("Returns a receipt at once; the completion is pushed later as a new
   message") because on Codex the model reads only the receipt type before
   calling. Proposed, awaiting the operator; the last sentence depends on the
   unverified Codex delivery fact above.
4. Skills (R3, confirmed intent): `team-workflow` is renamed to `teamwork` (R4) and
   `workflow` to `dynamic-workflow`; each skill's description states its single load
   trigger (about to spawn or send to a TeamMate; about to write a
   workflow script) and says it is not needed otherwise; the spawn/send and
   workflow_* tool descriptions point at the matching skill so the pointer
   sits where the intent forms. Skill names, roots, and the
   `bundled-skill-sources` test change knowingly; a Rush change file records
   the rename (bundled skills are an upgrade-visible surface).
5. Dispatcher prompts: only the duplicated no-polling and reply-tool bullets
   are deleted in this task (deferred otherwise, R1).
6. `.agents/domains/model-facing-writing.md` gains the principle: a reminder
   states a consequence, never an order; each rule has one owner, in the layer
   nearest the action; and records the per-engine pre-query visibility facts.

## Acceptance criteria

- Not yet confirmed (depends on the open decisions).

## Decisions and unknowns

- Confirmed operator decisions: R1, R2, R3 above.
- Open decisions for the operator:
  - (a) Sentence 2: dropping "Load a tool's definition before calling it" is
    confirmed (R5). Still open: the engine-neutral channel clause, re-asked
    after explaining that Codex renders the server name `channel-primary` as
    `channel_primary`.
  - (b) Resolved by R4: `teamwork`.
  - (c) Resolved by R4: the channel owns its reminder; the public-artifact
    secrets sentence is dropped.
  - (d) Dispatch-result reminder wording; keep the one contract sentence in
    the spawn/send descriptions; delete the four duplicate Dispatcher prompt
    bullets now or with the Dispatcher work.
  - (e) Resolved by R5: `dispatcher-workflow` waits for the Dispatcher work.
  - (f) Resolved by R4 and done: probe results are under "Evidence" (both
    engines deliver a pushed submission mid-turn at the next tool boundary). The operator also states that on Claude Code
    the dispatch-result reminder text is not visible to the model; this
    matches the recorded Claude Code behavior of dropping MCP `content` text
    when `structuredContent` is present, so that reminder is effectively a
    Codex-only surface.
  - (g) Resolved by R4: this TeamLeader opens a new PR on `next` that
    includes PR #369's content; PR #369 is not merged.
  - (i) Resolved by R5: the secrets clause in the Feishu `reply.text`
    property description stays.
  - (h) Optional: whether the identity prompt should keep arriving inside
    `<system-reminder>` tags on Claude Code (`args.ts`).
- Assumptions (TeamLeader's, to confirm): the split in R3 is at the skill
  level; the `teammate` MCP server keeps carrying the workflow_* tools. The
  renames apply to bundled skill directory names and frontmatter names, not to
  tool names.
- Blocking unknowns: none; the mid-turn delivery fact is established (f).
