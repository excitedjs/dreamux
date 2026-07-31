# Dynamic Workflow 编排（草案 spec）

状态：草案 v5 —— 已折入本方常驻评审团两席评审（v2）、奥菲利亚三席联合评审
（Issue #309，B1–B5 / D1–D5 / L1–L3 / P2 全部裁定落实）与异构 runtime 复
审（claude-seed / trae-claude）的补充发现。MVP 范围已按操作者「先跑起来、
精简、不过度防御」基调收敛：MVP 砍 `opts.name` 复用（每次 `agent()`
spawn 新 agent、完全隔离，避免在途 turn 被打扰导致结果偏差）、双作用域
collection 形态对齐现有 `TeammateCollection` 所有权模式、supervised-child
原语抽取列为落地前置硬约束。**v5 变更（操作者决策）：结构化输出
（`schema`）从「prompt 附加 + server 单次 JSON 校验」改为「runtime 原生
`outputSchema` 能力（codex `turn/start.outputSchema` / claude-code
`--json-schema`）+ server 单次 `JSON.parse`」，从源头利用 runtime 原生能
力，不自建校验。**

按操作者要求，本提案及配套 Issue / PR 协作全部使用中文（对仓库
"repo docs 用英文" 规则的一次性例外，不构成对该规则的修订）。

操作者实现基调：MVP 先跑起来；代码精简、贴合架构；不过度堆边界 case 防御，
使用问题遇到了再修；前期日志打足。

## 意图

给 Dreamux 的协调型 agent（TeamLeader / Dispatcher）提供一个确定性的多
agent 编排原语，契约形态对齐 Claude Code 的 `Workflow` 工具：模型编写一段
JavaScript script（`meta` + `agent()` / `parallel()` / `pipeline()` /
`phase()` / `log()`），一次提交，宿主在后台确定性地执行编排。在 Dreamux
体系下，`agent()` 驱动的是 **TeamMate**；整个 run 的终态通过现有完成投递
路径推回调用者。

操作者决策：**不做** harness 侧关键词触发或动态提示注入。使用指引以
bundled skill 形式分发，与 `team-workflow` 同机制、按需加载。

## 形态

### 工具面（挂在现有 `teammate` MCP 上）

操作者决策：不新建 MCP server。workflow 动词加入现有 `teammate` MCP 工具集
（同一 shim、同一 caller 作用域机制）：

- `workflow_run` — 提交 workflow script（内联 `script`），可带 `args`
  （原样暴露为 script 里的 `args` 全局）与 `max_concurrency`（server 钳
  制）。立即返回 `{ run_id }`；run 后台执行，终态作为一条完成 turn 推回
  调用者（与 TeamMate 完成推送同通道）。
- `workflow_status` — 读取 run 记录与 journal 中的阶段 / agent 进度。
- `workflow_stop` — 中止运行中的 workflow（语义见「stop 语义」）。
- `workflow_list` — 列出当前调用方作用域下的 run。

caller 作用域继承自 teammate MCP：`team_leader` 调用方的 `agent()` 在共享
Team 工作区生成 Team 成员；`dispatcher` 调用方的 `agent()` 生成
dispatcher 级 TeamMate。两种调用方同一片交付（作用域机制已存在）。

`run_id` 有定义的 grammar（小写字母数字 + `-`，服务端生成），所有以
`run_id` 拼路径的边界做格式校验（防路径穿越，一行校验）。

### script 契约

Claude Code Workflow 契约的对齐子集：

- `export const meta = { name, description, phases? }` — 纯字面量。
- `agent(prompt, opts?)` — 生成一个新 TeamMate、提交一个 turn、等待
  settle，返回最终文本（有 `schema` 时为解析后的结构值或 `null`）。
  `opts`：`label`、`phase`、`schema`、`agentType`（agent-runtime id）、
  `intent` 覆盖、`identity`（人设文本，透传给 `teammate.spawn` 现有
  `identity` → system-prompt append）。
  **`schema` 走 runtime 原生结构化输出能力（操作者最终决策）。** server
  把 `schema`（JSON Schema）作为 `outputSchema` 透传给 `AgentRuntime`，
  由 provider 映射到各自原生机制：codex `turn/start` 的 `outputSchema`
  字段、claude-code `--json-schema` 参数。server **不在 prompt 后附加
  schema 指令块、不做 JSON 校验/围栏提取**——模型在 runtime 原生约束下
  直接产出符合 schema 的 JSON，server settle 后仅做一次 `JSON.parse`：
  成功返回结构值，解析失败归 `null` 并打 WARN 日志。runtime 不支持
  `outputSchema` 时，`agent()` 直接抛错（fail-loud，不静默降级为纯文本）。
  **MVP 每次 `agent()` 都 spawn 新 agent，完全隔离（操作者最终决策）。**
  现有 runtime 的 active-turn folding 是锁定契约，复用常驻 agent 会引入
  「在途 turn 被打扰 / 结果偏差」风险；即便加 `AgentBusyError` 约束，把一
  个正在 busy 的 agent 编排进 workflow 本身也不是好事。因此 MVP **不支持**
  `opts.name` 复用——每次 `agent()` 生成全新的、独占归属于该 run 的
  TeamMate，与其他 run / 普通 send 完全隔离。`opts.name` 复用为后续能力
  （需先建立 TeamMate 级 turn 串行边界）。run 结束后对结果中记录的名字直
  接 teammate `send` 单聊续聊**不受影响**。
- `parallel(thunks)` — 屏障；失败的 thunk 归于 `null`。
- `pipeline(items, ...stages)` — 逐 item 分阶段流水，无跨 item 屏障。
- `phase(title)`、`log(message)` — 进度行，经 runner→server IPC 上报后由
  server 落 journal。
- `args` 全局 — `workflow_run` 的 `args` 值，原样注入。
- 确定性约束：script 内 `Date.now` / `Math.random` / 无参 `new Date`
  抛错（为将来 resume 保留确定性；MVP 不实现 resume）。

**vm 的定位（评审 D1 裁定）**：script 在 runner 子进程的 `node:vm`
context 中执行。`node:vm` **不是安全边界**（Node 官方明确其不适用于不受
信代码）；script 是**可信代码**——由本 dispatcher / TeamLeader 模型生成，
不是任意用户输入。vm 在这里的作用是**限定 script 的可调用 API 面**：
context 只暴露 `meta` 导出槽、`agent`、`parallel`、`pipeline`、`phase`、
`log`、`args` 与标准 JS 内建（除确定性禁项）；`require`、动态 `import`、
`process`、`Buffer`、`fetch`、fs / 网络 / 计时器不在 context 内。不引入
OS 级隔离（过度工程）。

对齐子集之外（操作者确认）：token `budget`（暂缓——无按-turn 用量管道）、
嵌套 `workflow()`（设计上不支持：普通 TeamMate 没有 teammate MCP，vm
context 里也没有 `workflow` 全局）、命名 workflow 注册表（后续）、
per-agent worktree 隔离 / cwd 覆盖（砍掉）。模型选择走 `agentType`
（现有 agent-runtime id 面），不是缺口。

### 执行模型

- **runner = fork 出的受监督子进程，IPC 通信（评审 D2 裁定）。** server
  不在自己的事件循环里跑模型编写的 JS（busy-loop 会卡死所有 dispatcher，
  与 no-sync-IO 同红线）。每个 run 由 server `fork` 一个 runner 子进程。
  **落地前置硬约束（评审 P1-2）**：在 `dreamux-utils` 或 core
  `platform/` 抽取中立 `SupervisedChild` 原语（封装 spawn/fork +
  detached + exit 回调 + SIGTERM→轮询→SIGKILL 两阶段 stop），codex、
  claude-code、workflow-runner 三方共用——**不写第三份 supervisor**。
  runner 与 server 的全部通信走父子进程 IPC channel，不占用 admin
  socket、不新增公共 admin 方法、不需要 per-run token（runner 是 server
  自己 fork 的同 UID 子进程，身份由父进程绑定）：
  - runner → server：`agent_start`（一次 agent() 调用）、`emit`
    （phase/log 行）；
  - server → runner：`agent_result`（对应调用 settle 后**事件式推送**，
    无轮询、无长轮询，与 admin drain 零交互）、`abort`（stop 时）。
  runner 随 server 关停被杀；runner 意外退出/崩溃（server 存活）→ run 标
  `failed`，终态照常投递。**已知限制（评审 L3，接受不补防御）**：server
  被 SIGKILL/OOM 硬杀时，busy-loop 中的 runner 可能残留为孤儿进程——记录
  在案，不引入独立父存活监督。
- **`agent()` = spawn 新成员 + await settle。** `agent_start` 时 server
  在本作用域生成新成员（生成名 + opts 的 `intent`/`identity`/
  `agentType`），提交 prompt，等 settle 后经 IPC 推回结果。
- **完成归属 = 按 producer 所有权，在 spawn 时接线（评审 B1 的解法）。**
  不做「注册先于提交」（`turnId` 在 runtime 受理后才存在，逻辑上无法先
  注册），也不做两阶段协议：MVP 里 workflow 生成的成员**独占归属于该
  run**，其 `TeammateService` 在创建时就把 settle 投递接线到
  `WorkflowRun`（per-entity 的 `routeSettledCompletion` 依赖注入，而非
  settle 后按 turnId 查注册表）。因此不存在快 settle 抢先命中拓扑
  initiator 的窗口，workflow 中间结果**结构上**不可能注入调用者会话；
  也不依赖对 `CompletionRouter` pending 表的任何时序假设。（这一解法
  成立的前提正是 B2：run 独占每个 producer 的全部 turn。）
- **终态投递复用 `CompletionRouter`（评审 B4 裁定）。** run 创建时即向
  router 注册终态 key（`workflow:<run_id>`，initiator = 调用者 agent，
  注册先于任何可能的终态迁移）；run 到达终态（`completed` / `failed` /
  `stopped`）时调 `router.settle` 投递终态 envelope——重试、异常、
  at-most-once 全部沿用 router 现有策略，不在 `WorkflowRun` 另建投递
  状态机。完成渲染新增 workflow 变体文案（复用现有渲染管道与溢出目录）。
- **终态自动 close（对模型完全静默）。** run 终态时，等全部 in-flight
  turn 自然 settle 后，**静默 close 本 run 生成的全部 TeamMate**（MVP 下
  即"驱动过的全部"，因为没有复用）以释放 runtime 进程——操作者决策。
  `close` 后 `send` 仍可从记录的 `session_id` 拉起续聊，agent 保持可寻
  址。任何工具描述、skill 文本、完成渲染都不提 auto-close。每次
  `agent()` 的具体 TeamMate 名记进 journal、`workflow_status` 与终态推
  送。
- **提交路径 = 窄 capability，逐调用重入现有 gate（评审 B5 裁定）。**
  `WorkflowService` 不持裸 `TeammateCollection` / 裸 `TeamService` /
  bound method；注入的是 server-local 的窄提交 capability：dispatcher
  作用域每次调用重入 `DispatcherTaskDrain` admission；team 作用域每次
  调用经 `TeamLeaderHandle` / lease 路径重验 closing fence 与 leader
  代际。「无反向 import」以此成立。
- **并发上限（server 侧强制）。** 每 run 默认 8 个并发 agent，
  `max_concurrency` 请求值由 server 钳制；超额 `agent_start` 在 server
  侧排队（每 run 信号量，runner 侧不可绕过）。生命周期上限：每 run 200
  个 agent。
- **结构化输出（`schema`）走 runtime 原生能力，无重试（评审 D3
  裁定 + 操作者决策）。** `schema`（JSON Schema 对象）经 `AgentRuntime`
  中性 seam 透传为 `outputSchema`，provider 映射到原生机制：codex
  `turn/start.outputSchema`、claude-code `--json-schema`。server **不**
  在 prompt 附加 schema 指令块、**不**做围栏 JSON 提取/校验——模型在
  runtime 原生约束下直接产出符合 schema 的 JSON。settle 后 server 仅
  做一次 `JSON.parse(resultText)`：成功返回结构值，解析失败该次调用归
  `null` 并打 WARN 日志。runtime 不支持 `outputSchema` 时 `agent()`
  直接抛错（fail-loud）。校验重试是后续能力（需先设计 per-attempt
  journal）。
- **journal：只写不读（评审 D4/D5 裁定，MVP 砍 resume）。** journal 是
  run 的结构化事件日志与将来 resume 的数据基础，MVP **只写入、不读取复
  放**；`resume_from_run_id` 不进 MVP 工具面。server（`WorkflowRun`）是
  唯一写者；行格式：头行 `{ kind: 'run', version: 1, run_id,
  script_hash, caller, ... }`（未知 version 读取端 fail-loud）、
  `{ kind: 'submit', index, name, turn_id }`、`{ kind: 'result', index,
  status }`（结果正文过大时截断/引用）、`{ kind: 'phase' | 'log' }`、
  `{ kind: 'end', status }`。追加失败 → run `failed`（fail-loud）。JSONL
  追加/读取复用现有低层 primitive（与 `AgentTurnsStore` 共享，不自行
  解析他人文件）。
- **日志（操作者明确要求，MVP 必做）。** journal 之外，pino 组件日志落
  `~/.dreamux/logs/workflow/<dispatcher>.log`：run 创建/终态、每次
  `agent_start`/settle（含 producer 名与 turn_id）、schema 解析失败、
  并发排队、stop、runner 退出码——关键路径全覆盖。
- **stop 语义。** `workflow_stop`：向 runner 发 `abort` 并杀 runner →
  该 run 后续 settle 只记录不投递 → in-flight TeamMate turn 自然 settle
  （**不**对任何 TeamMate runtime 做 mid-turn stop）→ 全部 settle 后走
  终态 auto-close → run 标 `stopped`，终态照常经 router 投递。
- **失败语义。** script 语法错误 / 抛出 → run `failed`，错误随终态推
  送。单次 `agent()` 失败归 `null`（对齐 Claude Code 契约），script 可
  `.filter(Boolean)`。
- **生命周期挂点（评审 L1/L2 裁定）。** `WorkflowService` 同时进入
  `DispatcherService.doStop` 与 `shutdown` 清扫序（杀 runner、遗留 run
  标 `stopped` fail-loud；stop→start 不复活 run）。Team 侧：外层
  closing fence 升起时**立即关闭 workflow admission 并取消队列**，再走
  既有 detach → transfer → 成员关闭顺序；`team.dissolve` 因此不会在
  route teardown 期间被幸存 runner 重新拉起成员。server 重启后遗留
  `running` 的 run 标 `stopped`（几行 fail-loud，不是防御机器）。

### 服务架构（新增 `workflow-service`）

操作者指示：新开一个 Workflow Service。遵循仓库 collection + entity 模式：

- 新目录 `service/workflow-service/`。`WorkflowService` 是作用域持有的
  collection：`DispatcherService` 持有一个（dispatcher-scope run），每个
  `TeamService` 持有一个（Team-scope run）——**与现有 `TeammateCollection`
  所有权模式同构**（`DispatcherService` 持一个 dispatcher-scope
  `TeammateCollection`，每个 `TeamService` 持一个 team-scope
  `TeammateCollection`，见 `team-service/index.ts:134-149`）。每个活跃 run
  是一个 `WorkflowRun` entity，持有 run 记录、journal 与 runner 子进程句
  柄。run 记录带 `teamId` 字段（null = dispatcher 作用域），admin 方法复用
  `teammateTargetFor` 按 `caller_kind` 路由到对应作用域的
  `WorkflowService`——不新建路由逻辑。
- 依赖单向注入、无反向 import：窄提交 capability（见执行模型 B5 条）、
  `CompletionRouter`（终态注册/settle）、`platform/paths.ts` 的 run 目录
  builder、supervised-child primitive。
- run 目录 builder **合并为一个**（评审 P2 裁定，对齐
  `dispatcherAgentEntityDir` 对象参数模式）：
  `workflowRunDir({ dispatcherId, teamId: string | null, runId })` →
  - dispatcher 作用域：`<state>/<dispatcher>/workflow/<run_id>/`
  - Team 作用域：`<state>/<dispatcher>/team/<team>/workflow/<run_id>/`
- admin 面（仅调用者侧四个方法；runner 走 IPC，不进 admin namespace）：
  `workflow.run`、`workflow.status`、`workflow.stop`、`workflow.list`，
  按 `caller_kind` 路由，与 `teammateTargetFor` 同款。teammate MCP 把
  四个 `workflow_*` 工具映射到它们。

### Skill（"怎么用"的分发面）

新增 bundled skill `workflow`：加入 `BUNDLED_SKILL_NAMES` 与
`normalizeAgentRuntimeSkillSources` 的 requiredSources 防遮蔽清单（评审
P2：用户自定义技能根同名不得遮蔽）。与现有 `team-workflow` 是不同技能。
放置在新增共享技能根（`packages/dreamux/skills/shared/workflow/`），
dispatcher 与 team-leader 两角色的 `skillSources` 都追加该共享根。内容：
什么时候 workflow 优于手驱 TeamMate、script 契约、pipeline vs parallel、
schema 用法、run 后对具体名字 `send` 续聊。TeamLeader 系统提示现有行
**不**扩展；`workflow_*` 工具描述按名引用该 skill（操作者决策：skill，
不做提示注入）。

## 硬约束

- server 与 runner 源码均禁同步阻塞 IO（`n/no-sync` 适用）。
- 所有新增跨进程路径一律在 `platform/paths.ts` 构造。
- 单写者规则：workflow 生成的成员共享 Team 工作区；skill 指引只读或明确
  独立的编辑（提示级约束，代码级隔离不在范围内）。
- 模型可见文本遵循 `.agents/reference/model-facing-writing.md`。

## 验收（MVP）

- TeamLeader 提交一段多阶段 script（`pipeline` ≥2 阶段、≥3 个 agent、含
  一次 `schema` 调用），收到单条终态推送携带 script 返回值；run 中途
  `workflow_status` 可见分阶段进度。
- **workflow 驱动的中间 turn 不注入调用者会话**（含 external-runtime
  fixture 的快 settle 场景——所有权接线在 spawn 时完成，结构上无窗口）。
- busy-loop script 不劣化 server（跑在 runner 进程里；`stop` 可杀）。
- runner 中途被杀（模拟崩溃）→ run 标 `failed`，调用者收到终态推送。
- `schema` 调用返回解析后的结构值；runtime 原生约束下产出不合法 JSON
  即归 `null`（单次 `JSON.parse`，无重试）。
- run 结束后 agent 保持可寻址：对结果中记录的具体名字 `send` 可拉起并
  续聊（auto-close 除读面 `closed` 状态外不可感知）；`identity` 调用可
  证实人设生效。
- `dispatcher.stop` / server 重启后遗留 run 标 `stopped`（fail-loud）；
  Team closing fence 升起后 workflow admission 立即关闭。
- 日志断言：run 创建/agent settle/终态在组件日志中可见。
- 依赖真实 runtime 的测试遵循 fail-loud 约定（不静默 skip）。

## 不做（MVP）

- 关键词 /"ultracode" 式触发或任何动态系统提示注入。
- `opts.name` 复用常驻 agent（评审 B2 + 操作者决策：busy agent 编入
  workflow 会导致结果偏差，MVP 完全隔离；后续需先建立 TeamMate 级
  turn 串行边界）。
- `resume_from_run_id` / journal 读取复放（评审 D4/D5；journal 格式按可
  复放设计，读取端后续再做）。
- schema 解析失败重试（评审 D3；runtime 原生约束 + 单次 `JSON.parse`，
  不重试）。
- per-run token / runner 私有 admin RPC（评审 D2；IPC 替代）。
- token 预算统计、嵌套 `workflow()`、命名 workflow 注册表、per-agent
  worktree 隔离 / cwd 覆盖。
- server 硬杀后的孤儿 runner 监督（评审 L3，接受限制并记录）。
- run 跨重启自动恢复。
