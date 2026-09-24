# Code organization refactor: operator rulings ledger

Operator answers from the 2026-09-24 review session, taken question by question
against the open questions of the [audit](artifacts/audit.md) (§9) plus the
ones the discussion raised. Quotes are the operator's own words, verbatim. An
entry marked **selected** is an option the operator picked from choices
offered to them; the quoted label is that option, verbatim (the "(Recommended)"
marker the question UI appends is omitted), and where the option's own
description carried the substance it is quoted too. Text after "→"
states what the ruling means for the refactor; anything that goes beyond the
operator's words is labeled **inference**.

Where a ruling here and a proposal in the audit disagree, the ruling decides.

## Scope and source of the task

- Request: "这个仓库一直以来是 agent 自己在开发，harness 做的并不强，只有一个
  单文件700行的限制，其实这么久下来，这个东西也卡住了很多提交，大部分时候还是因为代码风格写的有问题，导致特别容易撞这个墙。咱们本次既然开始重构了，那我不希望有任何因为撞墙被拆出去的临时逻辑，特别是
  packages/dreamux/src/service
  里面这些单文件，大概率都是因为撞墙拆出来的。应该给它们放在合理的位置，模块儿之间的职责拆分也应该合理化。具体怎么样合理？这个你们来拿捏一下"
- "我希望跟随这次重构，把仓库的代码组织结构，和设计模式都好好整一下。你先帮我摸一下现状，把恶心的写法都揪出来"
- Earlier ruling this task builds on, recorded in
  [suppress-owner-close-stop-pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md):
  "不要搞什么机械拆分。700 行就是为了卡架构重构的。是不是有共性的模块可以拆出来？"
- Where this record lands: **selected** "提交进 PR #453 的分支".
- Storage infrastructure ([issue #448](https://github.com/excitedjs/dreamux/issues/448),
  task [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md)):
  **selected** "并入这次重构". → The #448 solution is part of this refactor.
  Inference: its §3.7 fallback ("if the rewrite crosses [700 lines], the record
  transitions move into their own module") is the cap-driven split this task
  forbids and does not carry over; with code-only counting (R1) `run.ts` has
  headroom (inference from the audit's line counts).

## Harness and style

- R1 line cap counting: **selected** "只算代码行". → `max-lines` skips comments
  and blank lines; the test that locks today's counting
  (`packages/dreamux/tests/no-sync-io-gate.test.ts`) is changed knowingly.
- R2 formatter: **selected** "加，放在删除阶段之后做". → `prettier --check` in
  `rush lint`, one dedicated formatting commit after the deletion stage; the
  `packages/eslint-config/CLAUDE.md` "no formatting churn" line is waived for
  that one commit (the question put that waiver to the operator: "eslint-config
  的 CLAUDE.md 写着「不要引入格式化改动」，所以需要你破例一次").
- R3 `exactOptionalPropertyTypes`: **selected** "开启".
- R4 tests: "这个仓库对于怎么样写单元测试是没有指导的，我也知道，直接去检测代码段是非常垃圾的写法。只去清理单测，其实是不够的，需要从源头上解决这个问题，至少有一个知识库的章节去指导模型到底要写哪些单测"
  → a knowledge-base chapter on which unit tests to write. Inference, from the
  audit's H9: the source-text tests the audit lists (§3.2) are removed, and a
  recorded guard such a test carries gets an equivalent behavior test or
  import-gate rule in the same change.
- R5 dependency gate: **selected** "dependency-cruiser".

## Domain shape and naming

- R6 naming: asked "为什么要改这个名字？你是说，Dispatcher 和 Team leader
  在代码里面都是 Teammate Service，和本身的 Teammate 撞了，是吧？", then
  **selected** "改成 Agent，三类都改", whose description read "类名和目录改成
  Agent…；错误信息按实际角色措辞；完成通知文案按模型可见文案规则改。dreamux-types
  公开名字和 `.tm.` 段不动". Not ruled: the `teammate:` keys in Command and
  MCP results.
- R7 domain cut: "这块我不建议照抄 agent-entity，agent-entity 的设计我都看不懂";
  asked "原本是按照 service 类来拆分的，现在这样拆分是引入了循环依赖问题吗？";
  then **selected** "合成一个目录，文件间定方向", whose description read
  "team-collection + team-service 合成 service/team/，依赖方向 store ← service ←
  collection；agent 这边同样合成 service/agent/，把 agent-entity
  按职责拆进去。不再有单独的 entity 这一层". → `service/agent/` replaces
  `agent-entity/`, `teammate-service/`, and `teammate-collection/`;
  `service/team/` replaces `team-collection/` and `team-service/`; files inside
  a directory follow one declared direction (store ← service ← collection).
  The audit's `team-entity/` kernel is not built.
- R8 plugin hook objects: **selected** "保持传真实对象" (plugins keep receiving
  the real `DispatcherService` / `TeamService` objects).
- R9 built-in providers: **selected** "codex / claude-code 也改成始终加载的插件".

## Lifecycle

- R10 stopping: "这个排空是什么意思来着？就是等他们自然结束嘛？这个预期应该是完全不等，直接强制杀掉。我都已经要解散团队了，我当然是要停掉当前所有正在跑的Agent了，因为他们后面消耗的所有token都是没有意义的，尽可能快的给他们结束掉，避免浪费token才是这个路径的最正确选择。在整个系统里，我感觉没有任何一个地方需要有排空逻辑。当然，这个系统的功能还是非常多的。如果你找到了需要等待排空的场景，可以跟我说。"
  Then "现在是怎么强杀的？" and "这个点我感觉我们纠结了半天了，你先停止下一轮提问，我们拆解一下这块逻辑。"
  After the stop paths were walked through (every path already kills first and
  waits only for in-flight Dreamux operations): "workflow 里的 teammate
  和普通的 teammate 没什么区别，在我最初的设计里，close 这个动作是 TeamMate
  Service 自闭环的，一层一层往上走，批量调用关闭。 / 你这个方案也是没什么问题的。确实这块写得非常乱。但实际上逻辑是清楚的，代码根本没必要写得这么复杂。"
  → one self-contained close per Agent (kill the runtime, settle its own
  in-flight work, write the closed record); every container (Workflow run,
  Team, Dispatcher, Server) only calls close on its children, layer by layer.
  A child under construction registers with its parent first and closes itself
  if the parent is already closing (inference: this replaces the second sweep).
- R11 in-process Dispatcher restart: "没有这个需求，把打开和关闭都删掉", and
  "没有这个诉求，只要 Daemon 启动的时候，Dispatcher 全部都启动。延迟的只是
  Dispatcher 的 Agent Service，或者说，是 Agent Service 延迟拉起 Provider
  那边的进程。" → the `dispatcher.start` Command, its CLI verb, and the
  reopen-after-stop logic are deleted.
- R12 reads and the admission gate: asked "这个闸门是放在哪的？是说 Dispatcher 的
  enable 和 disable 吗？", then **selected** "读操作也都挡". → while a Dispatcher
  stops, status and history reads are refused too (`getTeamHistory` gains the gate).
- R13 closed-scope refusal code: **selected** "统一成一个明确的错误码".

## Commands, completion, and prompts

- R14 Command/MCP validation: **selected** "统一，Command 也拒绝" (one reader;
  the admin Command rejects an empty prompt, blank `agent_runtime`, or blank
  `intent` like MCP does).
- R15 Dispatcher status vocabulary: **selected** "统一成 runtime 的说法"
  (ready / starting / degraded / stopping / stopped).
- R16 `team.create` completion routing: "这个点从代码上看出来，和我真实使用的情况并不一样，飞书
  channel 自动创建团队的第一条消息并不会推送给
  Dispatche。不然我早就从COT上观察出来了。这是一个很严重的问题，难道 feishu channel
  这边是固定调用了 create 不带 prompt，然后又调用了 submit
  吗？如果真有这个问题，那实际上算是一个遗留的严重老bug。只不过现在没有人这样调用罢了
  / 正常来说，只有 Dispatcher 手动通过 MCP 调用的 Create 和
  Submit，才会回推给他。不然它会受到无数的上下文推送攻击". → verified: Feishu
  provisioning calls `team.create` without a prompt and then `team.submit` as
  an external Command, while `team.create` with `leader.prompt` from any
  external caller pushes the leader's completion to the Dispatcher Agent.
  Inference, applying the operator's rule above: `team.create` states its
  recipient like `team.submit`, so only the Dispatcher's own MCP calls push back.
- R17 `dispatcher.submit` error codes: **selected** "改成中性的提交错误码".
- R18 completion dedupe: "我看不懂，你应该给我解释一下，这到底是个什么问题", then
  "这个地方3层我都嫌多，这3层能缩成一层吗？不行的话，缩成两层可以吗？" → the
  producer-name layer goes; one layer keyed by the completion object if every
  Agent's completions have exactly one possible recipient, otherwise two
  (completion → recipient). The invariant is verified during implementation.
- R19 Dispatcher base prompt ("You are Codex…"): "这个地方是因为Codex才支持整体替换系统提示词，然后claude
  code是不支持的。先保持现状" (unchanged; the audit's "leak" reading is withdrawn).
- R20 repository request: **selected** "合成一份，去掉 slug".

## Persistence and configuration

- R21 persisted shapes: "可以按照你说的来做，持久化这块，没有办法保证你检查所有字段时，都和你要求的
  Schema 完全一致。仓库对于持久化的策略，整体需要调整成允许未知字段，只拒绝错误的类型和缺少的字段"
  and, on scope, **selected** "config.json 也放宽". → every persisted file,
  `config.json` included, tolerates unknown fields and rejects only wrong
  types and missing fields. Consequences: the cron `action` input goes and
  `action.intent` / `dispatcher_id` are no longer written (old files still
  read); the worktree identity readers keep every file readable; the plugin
  loader's "a `config` block for a plugin with no `config.read` fails
  loading" rule (PR #453) rested on "the config loader rejects unknown input
  everywhere else" and is revisited (inference).
- R22 diagnostic ledgers: "这个机制应该不止 access.json
  里有，好像很多地方都有。都是应该进日志的内容." → facts no code reads
  (`access.json` `last_gate`, `observed_chats`, `warnings`, and every other
  such field the refactor finds) go to logs, not persisted files.
- R23 cron per-owner job cap: **selected** "删掉".
- R24 codex `turn_timeout_ms`: **selected** "删掉这个配置项".
- R25 codex `approval_policy`: "先把配置项删掉，代码内写死never".
- R26 relocation variables: asked "为什么这个地方会有两个变量？不应该只有一个吗",
  then **selected** "只留 DREAMUX_ROOT". → `config.json` lives at
  `<root>/config.json`; `DREAMUX_CONFIG_DIR` and onboard `--config-dir` are
  deleted; the service unit writes `DREAMUX_ROOT`. An install that used a
  non-default config directory must re-run the service install (`BREAKING:`
  with `Rebuild:`).
- R27 onboard and the config directory: **selected** "onboard 也认这个变量"
  (inference: superseded in effect by R26, so onboard follows `DREAMUX_ROOT`).

## Providers

- R28 provider output re-checks in Core: asked "这块限制的是什么？", then
  **selected** "删掉，边界由 provider 负责".
- R29 Claude Code legacy CLI path: "不需要加门槛，直接删，兼容分支，只保留
  command_lifecycle 这一套".
- R30 `injectEnv` / `HOST_INJECT_ENV` / `isSynthetic`: **selected** "都删掉".
- R31 runtime native home: "这里其实是每个 runtime 配置都可能不同，因为 我会在 env
  里覆盖 CODEX_HOME" → the native home is resolved per Agent from its
  effective spawn env (`process.env` plus that agent's `extra_env`), by one
  resolver the runtime, the activity reader, and doctor share.
- R32 activity vocabularies: "这其实是两套机制。我倒是没有什么太大的倾向。因为它们的来源不同，一个来自
  rollout 文件，一个来自 RPC
  的推送。强行统一，反而可能会写一堆胶水代码。如果只是形状统一，而且代码只是删除、没有增加的话，我觉得可以统一。"
- R33 provider supervisors creating the cwd: "这个是执行的 bash 命令行？这个在
  windows 上完全没法兼容吧？ / 我理解这个操作问题不大，因为我确实误清理过
  worktree，mkdir -p 至少能让 agent 启动起来，到时候让 agent 自己重建worktree
  ，任务还能继续下去。如果起不来的话，我手动重建 worktree 就有点麻烦了"
  (unchanged; it is `fs.promises.mkdir`, not a shell command).
- R34 uninstall guard: **selected** "保留，目录名由 provider 提供".

## Feishu

- R35 `FeishuInstanceApi.submitToTeam`: asked "这个是从哪来的？" and
  "这个是PR上新引入的是吧?就是为了让其他插件在收到卡片回执之后,能够重新提交给Team
  leader?", then "需要是需要，但是投递这个动作真的需要暴露出来，让外部插件来实现吗？",
  then **selected** "飞书自己投递，删掉 submitToTeam". → a card action handler
  returns what to forward; Feishu resolves the conversation's Team and delivers
  through the ask-user settlement path.
- R36 `sendCard.mode`: **selected** "从接口里去掉".
- R37 cards: **selected** "统一到 Card 2.0".
- R38 routing `generation` / `origin`: **selected** "不再写入，注释改正".
- R39 feishu-transport diagnostic secret list: "把这个日志删掉".
- R40 binding-notification retry: **selected** "保留这次重试".
- R41 where an outbound message landed. First "这块也是一个老问题了,我觉得值得好好设计一下",
  then "Q33 并没有给出最终的设计.我只是说这个地方要好好设计一下，你并没有跟我讨论。" Discussed:
  - Landing rule: "可以，你就当它始终带那个值就行。现在这个bug其实我遇到的挺多的。不过它也不太影响使用罢了。"
    → the landing place is the Feishu send/reply response's `chat_id` /
    `thread_id` (present on the SDK's typed response; treated as always
    present); inference, assumption, read-after-send, and the
    TeamLeader-only special case go.
  - Topic anchor: "这个我理解可以，但是它有一个问题。你这个持久化的值，到底在哪些场景下会生效？",
    then **selected** "存根消息，删掉「退回父群」" → each bound topic's root
    message id is persisted once at binding; Channel-authored cards for that
    topic reply to it; the parent-chat fallback and the in-memory
    newest-message table go.
  - TeamLeader COT after a restart: **selected** "保持不显示".
  - Context: "因为不只是系统自动发的卡片，模型在调用 reply
    工具的时候，刚好遇到了压缩；压缩有可能会把 Message ID
    丢掉。所以它会在话题群里边把消息发成话题群里面的一个新话题、现在这个解决方案是：在系统提示词里面给它追加最开始的那条
    Message ID。"
  - Reply tool without a message id: "这个地方场景还挺多的：话题群既可以绑定成协作空间，又可以直接绑定给团队,然后普通的群聊也可以开topic.我不确定你能不能把这些场景全部都覆盖上";
    "只有一个点：如果这个话题群是整体绑定的，并且没有传 Message
    ID，就允许它开新话题。剩下的我看起来都没什么问题 /
    不然的话，你会把模型在话题群里开话题的路全部堵住。"; and
    "实际上，这个地方唯一要堵的，就是飞书自动创建团队这个场景。如果这个话题群已经绑定成了协作空间，那新开话题的所有动作都非常危险。之前撞过很多次这个bug."
    → only a Collaboration Space chat is guarded: a reply without a message id
    goes under the caller's bound topic root, and with no unique bound topic it
    is refused with an instruction to pass one. Every other chat keeps today's
    behavior. Inference, not objected to: the message-id guidance
    `leaderIdentity` writes into a provisioned leader's identity is deleted
    once the Channel guard exists.
- R42 bootstrap and `.workspace`: "这里和 .gitignore 有什么关系？如果把
  dispatcher cwd 配置到仓库里是用户自己的责任 / .workspace
  会被自动初始化成git 仓库嘛？", then "你的理解是错的，Dispatcher
  CWD是不能指向一个仓库的，但是我们也没有必要去检查。正常它是创建在一堆仓库的父目录。比如说有些人喜欢用Repos目录，我比较喜欢用
  Development
  目录。这种目录会是用户检出各种开发仓库的地方。。但也不排除有些人会把它配置到父目录，或者直接配置到某个仓库里。这种我们都不需要管"
  → bootstrap unchanged on this point; no handling for a Dispatcher cwd inside a
  repository.

## Resolved by the rulings above

- Audit §9 item 27 (per-store corrupt-file policy, journal role): #448's
  owner-supplied loaders decide it.
- Audit §9 item 28 (worktree identity parser strictness): R21 decides it.
