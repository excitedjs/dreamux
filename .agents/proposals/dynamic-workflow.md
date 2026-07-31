# Dynamic Workflow 编排（草案 spec）

状态：草案 v2 —— 已折入常驻评审团两席（架构与边界 / 生命周期与正确性）的全部发现，
待 Issue 协作评审后进入实现。

按操作者要求，本提案及配套 Issue / PR 协作全部使用中文（对仓库
"repo docs 用英文" 规则的一次性例外，不构成对该规则的修订）。

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

- `workflow_run` — 提交 workflow script（内联 `script`；MVP 不支持
  `script_path`），可带 `args`（原样暴露为 script 里的 `args` 全局）与
  `resume_from_run_id`。立即返回 `{ run_id }`；run 后台执行，终态作为一条
  完成 turn 推回调用者（与 TeamMate 完成推送同通道）。
- `workflow_status` — 从 run 记录与 journal 读取阶段 / agent 进度。
- `workflow_stop` — 中止运行中的 workflow（语义见「stop 语义」）。
- `workflow_list` — 列出当前调用方作用域下的 run。

caller 作用域继承自 teammate MCP：`team_leader` 调用方的 `agent()` 在共享
Team 工作区生成 Team 成员；`dispatcher` 调用方的 `agent()` 生成
dispatcher 级 TeamMate。两种调用方同一片交付（作用域机制已存在）。

### script 契约

Claude Code Workflow 契约的对齐子集：

- `export const meta = { name, description, phases? }` — 纯字面量。
- `agent(prompt, opts?)` — 驱动一次 TeamMate turn，等待 settle，返回最终
  文本。`opts`：`label`、`phase`、`schema`、`agentType`（agent-runtime
  id）、`intent` 覆盖、`identity`（人设文本，透传给 `teammate.spawn` 现有
  `identity` → system-prompt append）、`name`（已存在 TeamMate 的具体名
  字——该调用走 `send` 复用该常驻 agent 的会话上下文，而非新 `spawn`；
  名字只在本 run 的作用域内解析，跨作用域名字直接报错）。
- `parallel(thunks)` — 屏障；失败的 thunk 归于 `null`。
- `pipeline(items, ...stages)` — 逐 item 分阶段流水，无跨 item 屏障。
- `phase(title)`、`log(message)` — 进度行，经 runner→server 上报后由
  server 落 journal。
- `args` 全局 — `workflow_run` 的 `args` 值，原样注入。
- 确定性约束：script 内 `Date.now` / `Math.random` / 无参 `new Date`
  抛错（会破坏 resume）。

**vm 沙箱边界（安全契约，非实现细节）**：script 在 runner 子进程的
`node:vm` context 中执行，context 暴露且仅暴露：`meta` 导出槽、`agent`、
`parallel`、`pipeline`、`phase`、`log`、`args`，以及标准 JS 内建对象
（除上述确定性禁项）。`require`、动态 `import`、`process`、`Buffer`、
`fetch`、任何文件系统 / 网络 / 计时器 API **一律不在 context 内**。
script 能做的唯一外部动作就是通过 `agent()` 驱动 TeamMate。

对齐子集之外（操作者确认）：token `budget`（暂缓——Dreamux 目前没有
按-turn token 用量管道）、嵌套 `workflow()`（设计上不支持：普通 TeamMate
本就没有 teammate MCP，runner 的 vm context 里也没有 `workflow` 全局——
与仓库现有"用注入而非运行时检查阻止嵌套调度"同模式）、命名 workflow
注册表（后续）、per-agent worktree 隔离 / cwd 覆盖（砍掉——workflow
agent 一律使用所在作用域的常规工作区）。模型选择不是缺口：`agentType`
选的就是 Dreamux 现有的 agent-runtime id 面。

### 执行模型

- **runner 受监督子进程（非 detached）。** server 不在自己的事件循环里跑
  模型编写的 JS（一个 busy-loop script 会卡死所有 dispatcher——与
  no-sync-IO 同一条红线）。`workflow.run` 为每个 run 启动一个**受监督的**
  runner 子进程：随 server 关停被杀；runner 意外退出 / 崩溃（server 存活）
  → run 标 `failed`，终态 envelope 照常推给调用者。runner 通过 admin
  socket 与 server 通信；per-run token 经环境变量注入 runner，`workflow.
  agent_start` / `agent_wait` / `emit` 处理器逐请求校验 token **且校验 run
  仍处于 `running`**——孤儿 runner（旧 token）的请求被拒后必须自杀；socket
  断开同样自杀。runner 入口是内部子命令 `dreamux workflow-runner`（复用
  现有 bin 启动器，不新增全局 bin）。
- **`agent()` = spawn-or-reuse，await。** 每次 `agent()` 由 runner 调
  `workflow.agent_start`：无 `opts.name` 时 server 在本作用域生成新成员
  （生成名 + opts 里的 `intent`/`identity`）；有 `opts.name` 时对该常驻
  TeamMate 走 `send`。**完成注册接缝（对现有集合契约的显式改动）**：
  `TeammateCollection.spawn`/`send` 增加可选的按调用 initiator 覆盖参数，
  workflow 提交路径用它把该 turn 的完成注册到 **run**（`WorkflowRun` 实现
  `CompletionInitiator`），并且**注册先于提交**完成（消除快 settle 抢先
  命中拓扑 initiator、把中间结果注入 TeamLeader/dispatcher 会话的窗口）。
  workflow 驱动的 turn 永不注入调用者会话；只有 run 终态会。
- **Team 作用域走 TeamService 的注入路径。** team-scope 的
  `WorkflowService` 不依赖裸 `TeammateCollection.spawn`（那会绕过共享工作
  区注入与 Team closed / leader 代际检查），依赖的是 `TeamService` 现有的
  工作区注入 spawn 路径（与 `TeamLeaderHandle.spawnTeamMate` 同层）。
  `team.dissolve` 先 stop 该 Team 的全部 run 再解散成员。
- **agent_wait 有界轮询。** `workflow.agent_wait` 是有界请求（超时约 10s，
  与 admin client 默认一致）：结果未就绪即返回 `pending`，runner 重询——
  不与 server 关停时的 admin drain 互锁。结果数据源：`WorkflowRun` 内存
  缓冲（由 journal result 行背书）；若 router 投递在终态分支被丢，
  `agent_wait` 兜底回读该 producer `turn.jsonl` 的 settled 行（注意该路径
  assistant 文本有 160k 截断上限，对 `schema` 校验的影响一并接受）。
- **终态投递。** run 到达终态（`completed` / `failed` / `stopped`）时，
  `WorkflowRun` 将终态 envelope **直接**投给在 run 创建时解析好的调用者
  agent（dispatcher agent 或 team leader）的 `completionInput`——不经
  router 的 settle 路径（run 终态不是 teammate turn）。至多一次由 run
  记录的单次终态状态迁移保证。envelope id 形如 `workflow:<run_id>`，完成
  渲染新增 workflow 变体文案（复用现有渲染管道与超额溢出目录）。
- **终态自动 close（对模型完全静默）。** run 终态时，service 等全部
  in-flight turn 自然 settle 后，**静默 close 该 run 驱动过的全部
  TeamMate**（新生成的与复用的都关）以释放 runtime 进程——操作者决策。
  这是纯资源行为，不是模型可见契约：`teammate.close` 无副作用、`send`
  可从记录的 `session_id` 自动拉起，agent 保持完全可寻址、可续聊。任何
  工具描述、skill 文本、完成渲染都不提 auto-close。每次 `agent()` 用到的
  具体 TeamMate 名都会记进 journal、`workflow_status` 与终态推送，调用者
  事后可直接 teammate `send` 单聊。
- **并发上限（server 侧强制）。** 每 run 默认 8 个并发 agent（Dreamux 的
  agent 是完整 CLI 进程，远重于 Claude Code 的进程内 subagent），
  `workflow_run` 可带 `max_concurrency` 请求值、由 server 钳制；超额的
  `agent_start` 在 server 侧排队。上限在 `WorkflowService` 内以每 run
  信号量实现——runner/vm 侧不可绕过。生命周期上限（失控兜底）：每 run
  200 个 agent。
- **结构化输出（`schema`）。** 现有 runtime 都不支持强制输出 schema，由
  宿主实现：server 在 prompt 后附加 schema 指令块，对 settle 文本做
  JSON 校验（围栏 JSON 提取），不匹配则把校验错误原地 `send` 给同一
  TeamMate（有界重试，默认 2 次），仍失败该次调用归于 `null`。
- **journal：server 单写者 + 写前序。** journal 的**唯一写者是 server
  （`WorkflowRun`）**；runner 的 `phase()`/`log()` 经 `workflow.emit` 上
  报。记录形态（jsonl，逐行追加）：
  - 头行：`{ kind: 'run', run_id, script_hash, args_hash, caller, ... }`
  - 提交行（**写前**，先于 spawn/send 提交落盘）：
    `{ kind: 'submit', index, key, name, turn_id }`，`index` 在**发起时**
    分配（单调递增，与 settle 顺序无关），`key` = prompt + 规范化 opts 的
    内容哈希。
  - 结果行（**先落盘、`agent_wait` 才把结果交给 runner**）：
    `{ kind: 'result', index, status, result }`。
  - 进度行：`{ kind: 'phase' | 'log', ... }`；终态行：`{ kind: 'end',
    status }`。
  journal 追加失败 → run 立即 `failed`（fail-loud）。resume 读取端容忍
  崩溃残留的尾部半行。
- **resume 匹配规则（对并发发起顺序鲁棒）。** `resume_from_run_id` 不用
  "严格前缀"：把旧 journal 中**已有 result 的调用**按 `key` 组成多重集，
  新 run 的每次 `agent()` 按 `key` 消费一次匹配（同 key 多条按 FIFO），
  命中即直接返回缓存结果、**不触碰任何 TeamMate**；无匹配的调用 live 执
  行。这样 `parallel()` / `pipeline()` 下发起顺序漂移不会产生伪分歧。
  **崩溃窗口约束**：只有 submit 行而无 result 行的调用，resume 时按
  `turn_id` 回读该 producer `turn.jsonl` 的 settled 行**重挂接**；找不到
  settled 行则该调用归于 `null`——**绝不重发**（`opts.name` 的 `send`
  非幂等，重发会向常驻 agent 二次注入同一提示）。
- **stop 语义。** `workflow_stop`：杀 runner → 注销该 run 全部 pending
  完成注册（后续 settle 有记录、不投递）→ in-flight TeamMate turn 自然
  settle（**不**对任何 TeamMate runtime 做 mid-turn stop——尤其不能破坏
  `opts.name` 复用的、先于 run 存在的常驻 agent 的会话）→ 全部 settle 后
  按终态自动 close 流程收尾 → run 标 `stopped`。
- **失败语义。** script 语法错误 / 抛出 → run `failed`，错误随终态推送。
  单次 `agent()` 失败 / 中止归于 `null`（对齐 Claude Code 契约），script
  可 `.filter(Boolean)`。
- **重启语义。** MVP 不支持 run 跨 server 重启存活：重启后把遗留
  `running` 的 run 标 `stopped`（`workflow_status` fail-loud）。鉴于
  team-scope `WorkflowService` 随 `TeamService` 懒构造，孤儿判定同时在
  `workflow_status` / `workflow_list` 读取路径兜底（记录 `running` 但无
  存活句柄即判孤）。journal 使断点后的手动 resume 可行。

### 服务架构（新增 `workflow-service`）

操作者指示：新开一个 Workflow Service，并设计好与现有架构的组合。遵循
仓库的 collection + entity 模式：

- 新目录 `service/workflow-service/`。`WorkflowService` 是作用域持有的
  collection：`DispatcherService` 持有一个（dispatcher-scope run），每个
  `TeamService` 持有一个（Team-scope run）——与 `TeammateCollection` 同款
  双作用域形态。每个活跃 run 是一个 `WorkflowRun` entity，持有 run 记录、
  journal 与 runner 子进程句柄。
- 依赖单向注入、无反向 import：所在作用域的 TeamMate 提交路径
  （dispatcher-scope 用 `TeammateCollection`；team-scope 用 `TeamService`
  的工作区注入路径）、按调用 initiator 覆盖接缝、`platform/paths.ts` 的
  run 目录 builder、异步子进程监督。
- **关停序**：`DispatcherService.shutdown` 将 `WorkflowService` 排进现有
  清扫序——杀全部 runner、run 标 `stopped`（终态投递在关停中放弃，与
  channel inbound 掉线同理：durable 恢复靠读面）。
- admin 面（方法名遵循现有 `teammate.*` 命名习惯）：
  - 调用者侧：`workflow.run`、`workflow.status`、`workflow.stop`、
    `workflow.list` —— 按 `caller_kind` 路由，与 `teammateTargetFor` 同款
    （dispatcher → `DispatcherService` 的 workflows；team_leader → 该
    Team 的 workflows）。teammate MCP 把四个 `workflow_*` 工具映射到它们。
  - runner 私有侧：`workflow.agent_start`、`workflow.agent_wait`、
    `workflow.emit` —— 逐请求校验 per-run token（env 注入）与 run 存活。
- run 目录（builder 落 `platform/paths.ts`，命名如
  `dispatcherWorkflowRunDir(dispatcherId, runId)` /
  `teamWorkflowRunDir(dispatcherId, teamId, runId)`）：
  - dispatcher 作用域：`<state>/<dispatcher>/workflow/<run_id>/`
  - Team 作用域：`<state>/<dispatcher>/team/<team>/workflow/<run_id>/`

### Skill（"怎么用"的分发面）

新增 bundled skill `workflow`：加入 `BUNDLED_SKILL_NAMES`，与现有
`team-workflow` 是**不同的**技能（后者管 TeamMate 手驱协作，前者管编排
script 的写法与适用判断）。放置在新增的共享技能根（如
`packages/dreamux/skills/shared/workflow/`），dispatcher 与 team-leader
两个角色的 `skillSources` 都追加该共享根——避免在两个角色目录里复制同一
份技能。内容涵盖：什么时候 workflow 优于手驱 TeamMate、script 契约、
pipeline vs parallel、schema 用法、resume 与常驻 agent 复用/续聊——改写
自 Claude Code Workflow 工具文档。TeamLeader 系统提示现有 "Load
`team-workflow`" 行**不**扩展；`workflow_*` 工具描述按名引用该 skill，
与今天工具的发现路径一致（操作者决策：skill，不做提示注入）。

## 硬约束

- server 与 runner 源码均禁同步阻塞 IO（`n/no-sync` 适用）。
- 所有新增跨进程路径一律在 `platform/paths.ts` 构造。
- 单写者规则：workflow 生成的成员共享 Team 工作区；skill 指引只读或明确
  独立的编辑（与今天同为提示级约束；代码级隔离不在范围内）。
- 模型可见文本（工具描述、skill、完成渲染）遵循
  `.agents/reference/model-facing-writing.md`。

## 验收

- TeamLeader 提交一段多阶段 script（`pipeline` ≥2 阶段、≥3 个 agent、含
  一次 `schema` 调用），收到单条终态推送携带 script 返回值；run 中途
  `workflow_status` 可见分阶段进度。
- **workflow 驱动的中间 turn 不注入调用者会话**（快 settle 场景亦然）。
- busy-loop script 不劣化 server（跑在 runner 进程里；`stop` 可杀）。
- runner 中途被杀（模拟崩溃）→ run 标 `failed`，调用者收到终态推送。
- `schema` 调用返回解析后的对象；持续不合法的 agent 在有界重试后归于
  `null`。
- script 未变的 `resume_from_run_id` 100% 从 journal 复放、零 spawn/send；
  **崩溃窗口**（有 submit 无 result）的调用经 turn 记录重挂接或归于
  `null`，绝不重发。
- `stop` 后被复用（`opts.name`）的常驻 agent 会话完好，可继续 `send`。
- run 结束后 agent 保持可寻址：对结果中记录的具体名字 `send` 可拉起并
  续聊（auto-close 除读面 `closed` 状态外不可感知）；`opts.name` 调用可
  证实复用了上下文；`identity` 调用可证实人设生效。
- server 重启后遗留 run 被 fail-loud 标 `stopped`（含懒构造 team 作用域
  的读取路径兜底）。
- 依赖真实 runtime 的测试遵循 fail-loud 约定（不静默 skip）。

## 不做

- 关键词 /"ultracode" 式触发或任何动态系统提示注入。
- token 预算统计（等按-turn 用量管道就绪后再议）。
- 嵌套 `workflow()`（设计上不支持）、命名 workflow 注册表。
- per-agent worktree 隔离或 cwd 覆盖（操作者决策砍掉）。
- run 跨重启自动恢复（仅 journal 辅助的手动 resume）。
