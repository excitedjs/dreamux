# Requirement

Status: confirmed by the operator on 2026-11-24 through the requirement card,
after the Dispatcher read tool was added to the scope in the same card. After
that confirmation the operator ruled on where that tool lives, on how
outbound Markdown is handled, and on replacing rather than appending the
Dispatcher's prompt; all are under "Confirmed operator decisions". Every
other later change is a correction of a fact.

## Initial request

- Operator request (2026-11-24, Feishu topic): research how to add a WeChat
  ("weixin") channel to Dreamux as a new plugin. Follow-up the same day: WeChat
  provides an official integration path for OpenClaw, and that path should be
  the basis.
- Reference for the Dispatcher's role, named by the operator on 2026-11-24:
  https://github.com/nwverse/persona (MIT). Its coordinator is the model for
  a Dispatcher that carries the Weixin channel. The role material read, through
  the GitHub API at that day's `main`:
  - `server/internal/prompts/assistant/supervision_instructions.md` and
    `supervise.md`: task supervision;
  - `server/internal/prompts/agents/delegate.md`: screening the questions
    Agents put to the owner;
  - `docs/assistant/agent-work.md`: work state, triage, closeout, and the
    safety boundary.
- Platform evidence, read on 2026-11-24: the published source of Tencent's
  MIT-licensed `@tencent-weixin/openclaw-weixin` 2.4.10
  (https://github.com/Tencent/openclaw-weixin) and the WeChat open-document
  page for the ClawBot QR endpoints
  (https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html).
  No live request against the Weixin backend has been made yet; every platform
  fact below comes from reading that source.

## Confirmed current behavior and evidence

- Dreamux ships one Channel provider, Feishu (`packages/channel/feishu-channel`,
  an always-loaded plugin). The repository holds no WeChat or OpenClaw code
  or record (searched for `openclaw`, `weixin`, `wechat`).
- A plugin contributes a Channel provider through
  `ContributeHost.channelProviders.contribute`, addressed in config as
  `builtin:<name>` (`packages/dreamux-types/src/plugin.ts`). An `npm:` channel
  ref instead registers its raw ref as the provider id, and that id becomes
  the model-facing MCP server name; `external-channel-provider.ts` records
  that shape as unsettled.
- Plugin launch instructions are append-only. `LaunchDraft` carries
  `instructions` and `skillSources`; the Dispatcher composes
  `[base, ...instructions]` for a runtime with `replace` semantics and
  `[append, ...instructions]` for one with `append` semantics
  (`packages/dreamux/src/service/dispatcher-service/agent.ts`).
- The Dispatcher's own tools for Team work are `team` `create`, `send`,
  `list`, `status`, `history`, and `dissolve`, plus `teammate` tools and
  `cron` (`.agents/domains/dispatcher-skill.md`). A managed TeamLeader has no
  completion subscription of its own: only a Team's answer to an explicit
  Dispatcher request (`team.create`'s prompt, `team.send`) carries the
  Dispatcher as reply recipient, and such an automatic result is delivered
  to a live Dispatcher runtime without waking a dormant one
  (`.agents/domains/dispatcher-orchestration.md`, "Completion Routing").
- The Dispatcher base prompt today describes a coordinator: "The dispatcher
  working directory is coordination space, not a target repository: you
  coordinate, and repository implementation, refactoring, debugging, and review
  work is done by TeamMates or Teams unless the user explicitly asks this
  Dispatcher to inspect or edit local files."
  (`packages/dreamux/src/service/dispatcher-service/base-prompt.ts`).
- `dreamux onboard` collects a channel's config through the provider's
  `onboard.collect` and writes the returned block into `config.json`; Feishu
  keeps `app_secret` there. Re-running onboard for an existing dispatcher id
  replaces that dispatcher's `channels` with the ones the run selects
  (`packages/dreamux/src/onboard/config-files.ts`).
- Weixin platform facts, from the official plugin 2.4.10 source:
  - the backend is the iLink Bot API at `https://ilinkai.weixin.qq.com`, over
    HTTP JSON; media goes through a CDN with AES-128-ECB;
  - login is a QR scan: `POST ilink/bot/get_bot_qrcode?bot_type=3` returns a
    `qrcode` token; `GET ilink/bot/get_qrcode_status?qrcode=…` is a 35 s long
    poll. Its status is `wait`, `scaned`, `confirmed`, or `expired`, and
    `confirmed` returns `bot_token`, `ilink_bot_id`, `ilink_user_id`, and
    `baseurl`. The plugin also handles `scaned_but_redirect` (poll the
    `redirect_host` instead), `need_verifycode` (it reads a code from stdin),
    `verify_code_blocked`, and `binded_redirect`;
  - inbound is `ilink/bot/getupdates`, a long poll (35 s client timeout) with a
    cursor `get_updates_buf` that must be carried into the next request;
  - outbound is `ilink/bot/sendmessage`; it must carry a `context_token`, which
    only an inbound user message supplies. Without one the call still answers
    HTTP 200 and nothing is delivered;
  - `errcode` / `ret` `-14` on `getupdates` means the `bot_token` is stale.
    The official plugin pauses that account for one hour and the operator
    must scan again. No lifetime for the token is stated anywhere;
  - the plugin declares direct chats only (`groupPolicy: "disabled"`);
  - the plugin passes Markdown through to Weixin and removes only what
    Weixin does not render: its filter keeps bold, code fences, inline code,
    tables, horizontal rules, headings H1 to H4, and italics around non-CJK
    text, and strips italics around CJK text, headings H5 and H6, and images
    (`src/messaging/markdown-filter.ts`). So Weixin renders a subset of
    Markdown; which constructs exactly has not been observed live. An earlier
    version of this requirement said Weixin shows plain text; that was wrong;
  - the request header `iLink-App-Id` is the literal `bot` in the published
    package, and `bot_agent` is an observability label only.
- The official package cannot be a dependency: it declares `openclaw` as a
  peer dependency and ties its messaging to the OpenClaw plugin SDK.

## Desired outcome

An operator can enable one opt-in plugin, point a Dispatcher's channel at it,
scan a QR code with WeChat, and then talk to that Dispatcher from a WeChat
direct chat. The Dispatcher behaves as the operator's personal agent: it
forms Teams for the work, follows and pushes each Team, and reports to the
operator when a report is due. It can read for itself what each Team's leader
last said and did, so that following a Team does not rest on what the Team
says about itself.

> Status of this requirement (2026-11-25): slices 1 and 2 are confirmed.
> Slice 3 (the `dreamux plugin` and `dreamux channel` commands) and the change
> it makes to slice 1 (login only through a command, never by the daemon) are
> recorded below in their second wording, after the operator's objection to
> the first, and wait for the operator's confirmation card. Where an older
> line below says the daemon fetches a QR code itself, the slice 3 lines are
> the current intent.

## Desired behavior

1. **One plugin, one package.** The plugin contributes the `weixin` Channel
   provider and supplies the Dispatcher launch instructions. Weixin I/O,
   login, message handling, state, and the instructions live in one package
   in this repository that depends on `@excitedjs/dreamux-types` and
   `@excitedjs/dreamux-utils` (the boundary every provider package has,
   `.agents/domains/provider-runtime.md`), on one QR-encoding package for the
   terminal QR code (card, 2026-11-25), and never imports
   `@excitedjs/dreamux`.
2. **Login only through a command; the daemon never fetches a QR code.**
   WeChat login and re-login are the Weixin package's own `login` command,
   run as `dreamux plugin run @excitedjs/weixin-channel login` (behaviors
   11 and 12; card, 2026-11-25). A session with no stored credential does not
   start: that Dispatcher fails to start with the plugin's own message naming
   the command, and other Dispatchers start as before. When Weixin reports the credential stale (`-14`), the
   session clears the credential, stops polling, sends nothing further for
   that account, and logs the same message. Nothing about the credential is
   written to `config.json`. (Supersedes "runtime QR login", card of
   2026-11-24; the operator's later card answer is "只在 setup 里扫码".)
3. **Inbound.** Each polled message from the account that scanned the QR code
   is submitted to `dispatcher.submit` with a stable `source_id`, display
   attributes naming the source as `weixin` and carrying the sender, message,
   and time, and a standing reminder stating that the operator sees only what
   the `reply` tool sends. A message from any other sender is not submitted.
   The latest `context_token` per sender is kept so a later send can carry it.
4. **Inbound content.** Text is delivered faithfully. An image or file item is
   downloaded from the CDN, decrypted, and delivered as an attachment. An item
   kind the channel does not handle is delivered as a short marker, not as
   raw JSON.
5. **Outbound.** The channel publishes one MCP tool, `reply(text)`, to the
   Dispatcher caller only. A TeamLeader's catalog on this channel is empty:
   a Team reaches the operator only through the Dispatcher. The tool sends
   text to the operator the way the official plugin does: it keeps the
   Markdown Weixin renders (bold, code fences, inline code, tables,
   horizontal rules, headings H1 to H4) and removes what Weixin does not
   render (italics around CJK text, headings H5 and H6, images). When no
   `context_token` is on record, the tool refuses and says that the operator
   must message first.
6. **Dispatcher prompt.** A Dispatcher configured with this channel runs on a
   role prompt written for this role, which says that it is the operator's
   personal agent in a WeChat direct chat. On a runtime that can replace its
   base prompt, the role prompt takes the place of the built-in Dispatcher
   prompt; only on a runtime that can only append is the role part appended
   to the runtime's own prompt. The Dispatcher works mainly by forming
   Teams; it follows and pushes each Team's work; and it reports to the
   operator at the moments a report is due. Its responsibilities follow the
   Persona coordinator the operator named:
   - **It owns the outcome.** A Team's report is a claim; the Dispatcher
     checks it against what the operator asked before telling the operator
     something is done.
   - **It decides what is the operator's and what is its own.** Choices inside
     the execution are the Dispatcher's to make for the operator, by the
     operator's own words first. Three kinds go to the operator: an
     irreversible action (deploying, releasing, merging, deleting data,
     force-pushing, a message sent outward), a socially visible action (a
     comment, a request for someone's attention, a change to someone else's
     work), and any change to the goal itself (whether to do the work, a
     wider or narrower scope, a different result). So does anything only the
     operator can do, such as signing in. When unsure, it asks.
   - **It advances each Team.** When a Team stops unfinished, is blocked,
     goes the wrong way, or waits on something, the Dispatcher reads the
     state, then steers, unblocks, changes the approach, reassigns, or ends
     it. A question a Team raises is answered by the Dispatcher unless it is
     one of the operator's three kinds.
   - **It reports only what the operator needs.** A report is one of three
     things: a checked result, a decision that is the operator's, or a
     blocker the Dispatcher cannot resolve and who must resolve it. When a
     request starts work that will take long, the Dispatcher may first send
     one short receipt saying what was arranged (card, 2026-11-25: "允许一条
     简短回执"). A report says nothing is still being worked on. A round with nothing to report
     ends without a message. A decision put to the operator says what it is
     about, why now, the recommended answer, and what not choosing costs.
   - **An offer is not a blocker.** A Team ending with "shall I also …" has
     not stopped on the operator.
   The instructions also state what the platform makes true: the operator is
   on a phone in a direct chat, sees nothing until a `reply` is sent, reads
   a subset of Markdown, and must have sent a message before anything can
   reach them.
7. **Shutdown.** `close()` aborts the in-flight long poll and drains the
   Channel-owned writes.
8. **The Dispatcher can read a Team's work.** The Dispatcher's `team` MCP
   server gains a read-only tool, `team.last`, that returns one Team's
   TeamLeader recent
   output and activity: its assistant messages, oldest first, including the
   turn in progress, so that its last completed turn can be read; its tool
   records on request; and paging for older records. Reading starts or
   resumes nothing. It is available to every Dispatcher, with or without the
   Weixin channel, because it changes no behavior a Dispatcher already has.
9. **`dreamux plugin add <npm package name>` installs and registers a plugin.**
   The argument is always the npm package name; no short name is introduced
   ("这里始终都用 NPM 包名，先不引入任何短名", card, 2026-11-25). The command
   installs the package into Dreamux's plugin directory with npm, unless the
   package is already resolvable there because the operator installed it by
   other means; loads it once to prove it is a plugin Dreamux can load; and
   adds its `npm:` ref to `plugins[]` in `config.json`. It leaves every other
   key of `config.json` as written. It runs while the daemon is running: the
   running daemon keeps the plugins it loaded at its start, and the new one
   is loaded the next time the daemon starts. The command's output says so
   and names `dreamux daemon restart`. (Card, 2026-11-25: the operator's
   words are under behavior 13.)
10. **`dreamux plugin remove <npm package name>` and `dreamux plugin list`.**
   `remove` takes the ref out of `plugins[]` and uninstalls the package from
   the plugin directory. It refuses, changing nothing, while a configured
   Dispatcher uses a channel provider that plugin contributes. `list` shows
   each registered plugin: its ref, its name, whether it can be loaded, and
   the providers it contributes.
11. **`dreamux plugin run <npm package name> [arguments…]` runs the plugin's
    own command line.** Dreamux names no verb for a plugin: the arguments go
    to the command line the installed package ships, in the operator's
    terminal, and the package decides what its commands are, what they ask,
    and where they keep their own state. A channel provider that needs no
    operator action ships no command line; one that needs another action
    ships that one. The operator's objection that ruled out a named verb:
    “这个add 我理解，login 的话默认 channel 要实现 login 流程吧？现在其实我们
    没办法确保每一个 channel 都有 login 流程，这也是之前我告诉你 setup 可能并
    不是一个好的方式的原因。因为相当于 dreamux 定义了原语，让插件去实现，那如
    果某个插件或者某个 channel 他不需要 login ，而需要其他的动作呢？” and the
    ruling, “插件自带命令行，Dreamux 只转发” (card, 2026-11-25). The Weixin
    package's `login` is the WeChat login: it draws a QR code, waits for the
    scan, and stores the credential in the Channel-owned state file. The
    command changes no configuration; the login itself is the plugin's, not
    Dreamux's.
12. **`dreamux channel add <npm package name>` wires a channel into the
    configuration.** The argument is the npm package name of the registered
    plugin that contributes the channel ("不应该是包名吗", card, 2026-11-25);
    the configuration itself keeps recording the provider as the plugin
    mechanism has it (`builtin:weixin`). The command asks for a new
    Dispatcher's id, working directory, and agent runtime, and creates that
    Dispatcher with the channel on it; it never changes an existing
    Dispatcher. If the provider collects configuration, the command asks for
    it as `dreamux onboard` does. It runs no plugin command line: what to do
    next is the plugin's to say (“这个add 我理解”, card, 2026-11-25).

13. **Plugins are added while Dreamux runs.** None of these commands asks
    the operator to stop the daemon first. A change takes effect the next
    time the daemon starts, which a Dispatcher does for itself when its work
    allows. The operator's words: “这个插件还是要支持运行时添加，因为大部分时候其实
    是 dispatcher 自己给自己安装插件。你可以让它不立即生效，因为 dispatcher 可以
    在跑完之后可以给自己重启。但你不能要求他先把 Dreamux 停掉，再去安装插件，
    Dreamux 如果停掉，Dispatcher 的会话也就停了，它没有办法给自己安装插件的。”
    (card, 2026-11-25, asked about `plugin run`; “答案同上一个问题”).

    This supersedes the rule the maintenance reference states today
    (`dreamux-maintenance/references/config-envelope.md`): a hand edit made
    while the daemon runs is not read and is discarded by the next
    `config.agents.replace`, so `config.json` is hand-edited with the daemon
    stopped and `dispatchers[]` "stays hand-edit-with-the-daemon-stopped
    only". The reference and the code comments that repeat it change with
    this slice.

    Ruling: “本次接受这个窗口，下一个 pr 来统一梳理 Dispatcher 的 config 自维护
    机制。” (card, 2026-11-25). Nothing here prevents or repairs the loss; the
    maintenance reference states it, and the Dispatcher's own config
    maintenance is to be sorted out in a following change by the operator's
    word, not in this task.

## Scope

- A new package in `packages/channel/`, published as its own npm package.
  An operator installs it and lists its `npm:` ref in `plugins[]`; the plugin
  then contributes the provider `weixin`, addressed as `builtin:weixin`.
  Dreamux's built-in plugin registry does not name it, and it is not a
  dependency of `@excitedjs/dreamux` (ruling of 2026-11-25).
- Whatever small core change is needed for a channel-configured Dispatcher to
  receive the plugin's instructions; the exact home is a solution decision.
- A second slice, ruled into this task on 2026-11-24: a read-only tool on the
  Dispatcher's `team` MCP server that reads a TeamLeader's recent output and
  activity. It is core, in the Team domain, and is designed, approved, and
  reviewed as its own slice under the same gates.
- A third slice, ruled in on 2026-11-25: the `dreamux plugin` commands
  (`add`, `remove`, `list`, `run`) and `dreamux channel add`. Core learns no
  Weixin concept and names no plugin verb: the commands are written for any
  plugin and any channel provider. The Channel provider gains no capability.
- Unit tests for the protocol client, login, inbound, outbound, and state.
- `dreamux-maintenance` and the `.agents/` knowledge updates that a new
  Channel-owned state file and a new package require.
- Publishing the package: the operator handles it.

## Non-goals

- Group chat, binding a chat to a Team, multiple WeChat accounts per channel,
  and voice transcoding ("群聊、绑定 Team、多账号、语音转码先不做").
- A Dispatcher that carries both a Feishu and a Weixin channel. That
  combination is not considered, supported, or tested.
- Sending images or files to WeChat, the typing indicator, slash commands,
  quoted-message handling, and chain-of-thought or other cards.
- An upward-reporting tool from a TeamLeader to the Dispatcher, and a
  TeamLeader `reply` to the operator.
- Depending on `@tencent-weixin/openclaw-weixin`, or embedding OpenClaw.
- Entering a verification code Weixin asks for during login, a `channel
  remove` command (it would have to decide what happens to a Dispatcher and
  its state files), short names for plugins, a plugin index or marketplace,
  and teaching `dreamux onboard` about external plugins.
- Persona's hub machinery behind its coordinator: automatic stall and
  no-progress detection, scheduled supervision rounds, session triage, the
  closeout record format, standing authorizations, and the question-routing
  ladder. Only the coordinator's responsibilities are adopted, as Dispatcher
  instructions; no such mechanism is added to Dreamux here.

## Constraints and invariants

- Operator rulings, quoted verbatim:
  - "不需要拆分 transport 和 channel，写在一起就行了"
  - "这个东西不是一个单独的 channel provider 而是一个插件，其实就是因为微信 只支持单聊，没有群聊，所以 dispatcher 本身承担的是 personal agent 。他的 system prompt 就不能按照现在这样写了。"
  - "群聊、绑定 Team、多账号、语音转码先不做"
  - "就放当前仓库，我来帮你处理发包问题"
  - "单聊不绑团队，全走 Dispatcher （personal  agent 模式）"
  - On how the personal agent works: "主要以拉团队 为主，Dispatcher 负责监控、推进各个团队的工作，并在合适的时机向用户汇报。"
  - "你先不要急，我们不考虑同时拥有 feishu 和 weixin 两个 channel 配置的场景"
  - "https://github.com/nwverse/persona 给你参考下这个仓库，他的协调者就是 Dreamux 挂了 weixin channel 之后 dispatcher 的角色，你可以参考下他的职责。仓库可以拉到 ~/Development 目录下"
  - On upward reporting: "不加，靠一轮结束的回复" (card, 2026-11-24)
  - On the Dispatcher reading a TeamLeader's output: "并入本任务" (card,
    2026-11-24)
  - On the Dispatcher's prompt: "微信的这个channel。系统提示词应该考虑完全替换。
    除非说用那种不支持替换的provider ，才考虑追加。"
    "本质上，如果你想要实现Persona的那5个职责，追加提示词，我估计效果其实不会很好。"
    (message, 2026-11-25)
  - On publishing: "就按NPM包来发。Bootstrap那边其实已经发过了。PR还没有合入而已"
    (message, 2026-11-25)
  - On the plugin commands: "我们继续扩展一个新特性，增加一个 dreamux plugin add
    命令，用来增加 weixin channel 这个插件，也支持 dreamux plugin setup -p
    插件名，执行指定插件的配置流程，weixin 的扫码逻辑就做在这个里面。"
    (card, 2026-11-25)
  - On where WeChat login happens: "只在 setup 里扫码" (card, 2026-11-25).
    The daemon never fetches a QR code; the command that does has since moved
    from `plugin setup` to the plugin's own `login` (below).
  - On the slice 3 requirement card (2026-11-25): the package is installed
    into a Dreamux-managed directory (not beside the Dreamux install); the
    setup shows the QR code in the terminal, which allows one QR-encoding
    third-party package in the Weixin package; when no Dispatcher uses the
    plugin's channel, the setup command offers to create one
    interactively and never changes an existing Dispatcher. The requirement
    itself was answered "需要修改" without a named change; the TeamLeader
    asked which part and holds slice 3 in clarification.
    Asked which part, the operator wrote: "主要在 setup 这里，这只是我给的一个
    演示，但是这个命令其实不太好，他一不对称。二给插件约束了安装方式。但是
    我目前没有更好的想法" (card, 2026-11-25).
  - Shown three candidate command surfaces, the operator chose the two-layer
    one: `dreamux plugin` (`add`, `remove`, `list`) for plugin code and
    `dreamux channel` (`add`, `login`) for wiring a channel and logging in,
    with login as a Channel provider capability (card, 2026-11-25). Of its
    `channel` pair, `add` stands and `login` was then withdrawn by the
    operator's objection quoted under behavior 11, in favor of
    `dreamux plugin run`.
  - On how plugin commands name a plugin: "这里始终都用 NPM 包名，先不引入
    任何短名" (card, 2026-11-25). No naming convention and no index.
  - On the channel commands' argument, asked by the operator on the
    requirement card: "channel 这里为什么是 builtin:weixin ？不应该是包名吗？"
    (2026-11-25). Every command takes the npm package name; `builtin:weixin`
    stays what the configuration records.
  - The TeamLeader's readings, labeled and open to objection:
    `plugin remove` refuses while a configured Dispatcher uses a channel the
    plugin contributes; `plugin add` skips the install when the package is
    already resolvable in the plugin directory.
- Core stays behind `ChannelProvider`; no Weixin concept enters core.
- The channel names no Feishu tool, state, or extension api.
- Package source uses async fs only.
- The platform contract is undocumented beyond the QR endpoints and may
  change; the package keeps every endpoint path and field name in one place.
- No validation, retry, or recovery path without a named scenario. The named
  scenarios so far: a long poll that returns empty after its timeout; a stale
  token (`-14`); an expired QR code; a QR poll redirected to another host
  (`scaned_but_redirect`); a verification code Weixin asks for during login
  (`need_verifycode`), which a daemon has no way to enter; a transient
  network failure of one background request in a daemon that runs for days;
  and `close()` arriving while a poll, a download, or a write is in flight.
  scenarios so far are a long poll that returns empty after its timeout, a
  stale token (`-14`), and an expired QR code.

## Acceptance criteria

1. With the plugin listed in `plugins[]` and a Dispatcher whose only channel
   uses it, `dreamux doctor` and `dreamux serve` load the channel, and the
   model-facing MCP server is named `channel-weixin`.
2. With no stored credential,
   `dreamux plugin run @excitedjs/weixin-channel login` shows a QR code; after
   the operator scans it, a message sent from that WeChat
   account reaches the Dispatcher Agent as one `<channel>` envelope. A start
   without a stored credential fails for that Dispatcher only and names the
   login command.
3. A `reply` call from the Dispatcher runtime sends one WeChat message.
   Bold, code fences, inline code, and tables reach it as written; italics
   around CJK text, headings H5 and H6, and images do not reach it as markup
   or as raw syntax.
4. After a restart with a stored credential and cursor, no new scan is
   needed and no already-delivered message is submitted a second time.
5. A `-14` answer clears the credential, stops every further request for
   that account, and names the login command in the log; `dreamux doctor`
   then reports the channel as not logged in.
6. On a runtime that replaces its base prompt, a Dispatcher with this channel
   runs on the personal-agent prompt in place of the built-in Dispatcher
   prompt; on a runtime that can only append, the personal-agent part is
   appended to the runtime's own prompt. A Dispatcher without this channel
   runs on the built-in Dispatcher prompt, unchanged.
7. `rush build`, `rush lint`, `rush test`, and `rush typecheck:tests` pass.
8. From a Dispatcher runtime, the new `team` read tool returns a Team's
   TeamLeader recent output, including its last completed turn and a turn in
   progress, and its tool records when asked; a later page reaches older
   records; and calling it starts, resumes, or interrupts nothing.
9. One live end-to-end check by the operator (`plugin add`, `channel add`,
   `plugin run … login`, scan, send, receive, restart, `plugin run … login`),
   recorded in the task record. It needs the operator's WeChat account and is not automated.
10. `dreamux plugin add @excitedjs/weixin-channel` followed by
    `dreamux channel add @excitedjs/weixin-channel` on a fresh installation
    needs no hand edit of `config.json`, and `config.json` keeps every key
    the commands did not add. `dreamux plugin run @excitedjs/weixin-channel
    login` then runs the installed package's `login` with the terminal
    attached; `plugin run` on a package that ships no command line says so
    and runs nothing.
11. With the daemon running, `plugin add` installs and registers the plugin
    and changes nothing about the running process; after `dreamux daemon
    restart` the daemon loads it. `plugin remove` and `channel add` behave
    the same way.
12. A plugin that is registered but not installed fails `dreamux serve` and
    `dreamux doctor` as it does today, and `dreamux plugin add` repairs it.
13. `dreamux plugin remove` on a plugin whose channel a Dispatcher uses
    refuses and changes nothing; after that channel is gone from the
    configuration it removes the plugin.
14. `dreamux plugin list` names each registered plugin and says whether it
    can be loaded.
15. With the daemon running, `plugin run` runs the plugin's command line.

## Decisions and unknowns

- Confirmed operator decisions:
  - A new task record is created for this work (card, 2026-11-24).
  - Re-login entry: "运行期自动出码" — the daemon fetches a QR code itself
    when it has no credential or the credential went stale, writes the link to
    the channel log, waits for the scan, and replaces an expired code with a
    new one (card, 2026-11-24). Superseded on 2026-11-25 by "只在 setup 里
    扫码": the daemon no longer fetches a QR code.
  - Working style of the personal agent: the verbatim ruling quoted above
    (card, 2026-11-24). The option "does the work itself by default" was not
    chosen.
  - All five coordinator responsibilities go into the personal agent's system
    prompt ("五条都要", card, 2026-11-24).
  - Feishu and Weixin are never configured on one Dispatcher (message,
    2026-11-24).
  - A TeamLeader reports upward only through its end-of-turn reply; no
    upward-reporting tool and no direct TeamLeader-to-operator `reply` is
    added (card, 2026-11-24).
  - The Dispatcher gets a read-only `team` tool for a TeamLeader's recent
    output and activity, inside this task as a second slice (card,
    2026-11-24).
  - The requirement is confirmed as recorded here (card, 2026-11-24).
  - `team.history` keeps its recovery-search meaning; the read tool is
    `team.last` ("保留 history，加 team.last", card, 2026-11-24).
  - The operator then delegated where the tool lives: "等等，我在想是 加
    team.last 更好，还是给 teammate.last 放开 tl 更好？你看下哪个改动更小
    选哪个吧" (message, 2026-11-24). The TeamLeader chose `team.last` on the
    evidence: `teammate.last` resolves a name through the TeamMate
    collection's own store, bound to `teammate/<name>/` and checked by
    `assertInCollection` (`service/agent/index.ts`, `mustIdentity`), so
    opening it to a TeamLeader means a read from the TeamMate collection
    into a Team's directory, which `service/CLAUDE.md` forbids ("never the
    dispatcher agent or a Team's leader"). `TeamCollection` already reads a
    leader's identity (`leaderIdentity`, through `readAgentIdentity`), which
    is what `readAgentActivity` takes.
  - The Dispatcher's prompt for this channel is replaced, not appended to;
    appending is the fallback for a runtime that cannot replace. The operator
    expects the five responsibilities to work poorly as an appended text
    (message, 2026-11-25, quoted under "Constraints and invariants"). This
    came as the change requested on the solution-confirmation card
    ("需要修改", card, 2026-11-25).
  - Outbound Markdown: "按官方插件的做法" (card, 2026-11-24) — keep the
    Markdown Weixin renders and remove only what it does not, as the
    official plugin's filter does, and tell the model in the Dispatcher
    instructions what Weixin renders. Whether Weixin renders exactly those
    constructs is checked in the operator's live run.
  - The package is published as an npm package and enabled through its
    `npm:` ref in `plugins[]`; it is not registered as a Dreamux built-in
    (message, 2026-11-25, quoted under "Constraints and invariants"). The
    earlier plan to add it to `BUILTIN_PLUGIN_PACKAGES` and to the
    dependencies of `@excitedjs/dreamux` is dropped.
  - A plugin's operator actions are the plugin's own command line, which
    Dreamux forwards to (`dreamux plugin run <npm package name> [arguments…]]`);
    Dreamux names no verb for a plugin, so `dreamux channel login` and the
    earlier `dreamux plugin setup` are both dropped, and the Channel provider
    gains no login capability (card, 2026-11-25; the objection and the ruling
    are quoted under behavior 11). The three alternatives shown were, beyond
    the chosen one, no forwarding command at all (`npx`) and a list of actions
    the provider declares.
  - Plugins are added while the daemon runs and take effect at its next
    start; no command requires stopping the daemon first. The words are
    quoted under behavior 13 (card, 2026-11-25). This replaces an earlier
    TeamLeader wording, never confirmed, under which every command that
    changed something refused while the daemon ran.
  - An `npm:` plugin is looked up in the plugin directory only; the change
    note for that leads with `BREAKING:` and carries `Rebuild: dreamux plugin
    add <package>` (“只认插件目录”, card, 2026-11-25).
- Card (2026-11-25): the operator allows one short receipt when a request
  starts work that will take long ("允许一条简短回执"), because WeChat has no
  typing indicator or process card. Progress messages stay forbidden.
- Card (2026-11-25): the operator confirmed the final solution in
  `technical-design/final.md`.
- Where the five responsibilities come from, in the Persona material:
  - A Team's report is a claim, not verification: it is checked against
    every criterion the operator asked for before it is reported as a result
    (`supervision_instructions.md`, "Before accepting, independently check
    every current criterion").
  - Report upward only results, owner decisions, or unsolved blockers; never
    a process or "still working" update (`supervision_instructions.md`).
  - Answer internal execution choices for the owner; only irreversible,
    socially visible, and goal-changing decisions, and what only the owner
    can do, go to the owner; when unsure, ask (`delegate.md`).
  - A trailing optional offer does not mean the work is blocked
    (`agent-work.md`, "Decision principles").
- Assumptions, each unconfirmed and each non-blocking:
  - Only the account that scanned the QR code may talk to the bot. There is
    no allowlist setting.
  - "Follows and pushes each Team" uses the checkpoints Dreamux already has:
    a Team's answer to a Dispatcher request, the Dispatcher's own `team`
    reads, and a cron fire. A Team's autonomous activity between requests is
    not pushed to the Dispatcher, and this task does not change that.
  - The Dispatcher Agent keeps today's coordinator boundary on files: the
    ruling keeps Teams as the ones doing repository work.
  - Which Markdown constructs Weixin renders. The evidence is the official
    plugin's filter; it has not been observed live.
- Facts behind the upward-reporting decision: a Team's reply reaches the
  Dispatcher only when its turn answers an explicit Dispatcher request
  (`deliverCompletionToDispatcher`, `service/team/service.ts`), and it opens
  a Dispatcher turn; a TeamLeader has no tool that reaches the Dispatcher or
  the operator mid-turn; a reply that arrives while the Dispatcher runtime is
  not live is answered `stopped` and not delivered, because a push-back never
  wakes its recipient (`service/agent/service.ts`, `admitToRuntime`).
- Facts behind the read-tool decision, the state before this task: what the
  Dispatcher can read about a Team today
  (`packages/dreamux/src/service/team/mcp.ts`, `team-summary.ts`).
  `team.status` returns the Team record and leader state fields
  (`leader_state`, `leader_intent`, `leader_runtime_status`,
  `leader_last_error`, member count, close facts) and no output;
  `team.history` is a search over Team records for recovery, "a compact
  recovery list, not a raw event timeline"; `team.list` returns summary rows.
  `teammate` `last`, `history`, and `status` do read output and activity,
  but only for dispatcher-owned ordinary TeamMates. So a Team's work was
  visible to the Dispatcher only through the Team's own end-of-turn reply
  and those status fields. `readAgentActivity`
  (`packages/dreamux/src/service/agent/activity.ts`) is the existing read
  behind `teammate.last`.
- Blocking unknowns: none for the requirement.
- Open risks:
  - Third-party use of the iLink API is not addressed by any WeChat statement;
    the platform may change or restrict it without notice.
  - The operator runs Dreamux as a daemon, so the QR link is seen only when
    the channel log is read.
  - The reference responsibilities come from a system whose hub computes
    stalls and rounds; in Dreamux the same responsibilities rest on the
    Dispatcher's judgment at the existing checkpoints.
