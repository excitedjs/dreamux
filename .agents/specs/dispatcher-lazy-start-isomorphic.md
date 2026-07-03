# Spec: Dispatcher Agent 构造同构化 + 懒加载

## 背景

PR #281 首次在 `TeammateServiceOptions` 中添加了 `skillSources` 参数，但 Dispatcher agent 的 skill 注入仍然走 `buildLaunch` 回调内部硬编码的路径，与 TeamLeader 通过 `options` 显式传入的模式不一致。

同时，Dispatcher agent runtime 在 `Server.start()` 时总是被立即拉起（eager start），而 TeamLeader 在 rebuild 路径上已经是懒加载。我们希望 Dispatcher 也采用相同的懒加载策略。

## 当前状态分析

### Dispatcher Agent 构造流程

```
Server.start()
  → dispatcher.start()
    → ensureDispatcherWorkspace()     // 解析 cwd
    → channels.build()                // 构建未启动的 channel sessions
    → channels.adopt(channels)        // 采纳为 live
    → agent.ensureStarted()           // 拉起 runtime（调用 buildLaunch）
      → buildDispatcherLaunch()       // 内部硬编码 skillSources / mcpServers / systemPrompt / disableFeatures
        → provider.createRuntime()    // 创建 runtime
        → runtime.start() / resume()  // 启动 runtime
    → session.start({ deliver })      // 启动 channel sessions（带 deliver 回调）
    → injectRestartNoticeIfNeeded()   // 注入重启通知
    → scheduler.start()               // 启动 dispatcher cron
    → teams.startSchedulers()         // 启动 team schedulers
```

**关键特征**：
- `launch: { kind: 'inline', build: buildDispatcherLaunch }`
- `skillSources` 在 `buildDispatcherLaunch()` 内部硬编码为 `bundledDispatcherSkillRoot()`
- `mcpServers` 在 `buildDispatcherLaunch()` 内部从 `liveChannels()` 构建
- `systemPrompt` / `disableFeatures` 同样硬编码
- Runtime 在 server boot 时立即拉起，无懒加载
- Agent 在 `DispatcherService` 构造函数中创建，但此时 channels 还未 build/adopt

### TeamLeader 构造流程（rebuild 路径）

```
TeamCollection.get(teamId)
  → TeamService.rebuild()
    → buildLeader(identity)
      → createTeamLeaderAgent()
        → createTeammateService({
            launch: { kind: 'agent-ref' },
            options: { mcpServers, skillSources, disableFeatures, systemPrompt }
          })
    → scheduler.start()              // 仅启动 scheduler，不启动 runtime
    // runtime 未启动，等待首次消息
```

首次消息到达时：
```
team.deliverToLeader(input)
  → leader.channelInput(input)
    → ensureStarted({ reopenClosed: true })  // 此时才拉起 runtime
      → resolveLaunch()                      // 从 agents[].id 解析 config
        → provider.createRuntime()
        → runtime.start() / resume()
```

**关键特征**：
- `launch: { kind: 'agent-ref' }`
- `skillSources` 通过 `options.skillSources` 显式传入
- `mcpServers` 通过 `options.mcpServers` 显式传入
- `systemPrompt` / `disableFeatures` 通过 `options` 显式传入
- Runtime 懒加载：rebuild 时不启动，首次 `channelInput`/`send`/`scheduledInput` 时才启动

### 差异对比

| 维度 | Dispatcher (当前) | TeamLeader (rebuild) | 是否需要统一 |
|------|-------------------|---------------------|-------------|
| skillSources 注入 | `buildLaunch` 内部硬编码 | `options.skillSources` | ✅ 是 |
| mcpServers 注入 | `buildLaunch` 内部从 liveChannels 构建 | `options.mcpServers` | ✅ 是 |
| systemPrompt 注入 | `buildLaunch` 内部硬编码 | `options.systemPrompt` | ✅ 是 |
| disableFeatures | `buildLaunch` 内部硬编码 | `options.disableFeatures` | ✅ 是 |
| launch kind | `inline` (config from dispatchers[]) | `agent-ref` (config from agents[]) | ❌ 合理差异（config 源不同） |
| state 持久化 | `status.json` via `DispatcherStore.bindRuntime()` | identity store | ❌ 合理差异 |
| runtime 启动时机 | Server boot 时立即 | rebuild 时懒加载 | ✅ 是 |
| agent 创建时机 | 构造函数中（channels 还未就绪） | rebuild 中（MCP 描述符已就绪） | ✅ 是 |
| 有 worktree manager | 无 | 有 | ❌ 合理差异（dispatcher 不 close） |

## 目标

1. **构造同构化**：Dispatcher agent 的 `skillSources`、`mcpServers`、`systemPrompt`、`disableFeatures` 通过 `TeammateServiceOptions` 显式传入，与 TeamLeader 模式一致
2. **懒加载**：Dispatcher agent runtime 在 server boot 时不启动，仅在以下触发时拉起：
   - Channel 收到未绑定到 team 的消息（需要 dispatcher 处理）
   - `daemon restart --notify-resumed --dispatcher <id>` 触发的重启
   - Dispatcher 自身的 scheduled task（cron job）到期时 runtime 未运行

## 设计方案

### 核心思路：延迟 agent 创建到 `prepareChannels()`

Dispatcher agent 不能在构造函数中创建的原因是：MCP 描述符依赖 live channel sessions，而 sessions 在构造时还未 build。解决方案是**将 agent 创建延迟到 `prepareChannels()` 中**，此时 channels 已 build + adopt，MCP 描述符完全确定，可以作为静态数组传入。

这使得 Dispatcher agent 的创建模式与 TeamLeader 完全同构：都是在 MCP 描述符就绪后，通过 `options.mcpServers` 静态数组传入。

### 1. `TeammateServiceOptions` 保持 `mcpServers` 静态数组

不需要 `mcpServersProvider`。`mcpServers` 保持为静态数组，因为 agent 创建时 MCP 描述符已经就绪：

```typescript
// teammate-service/index.ts — 保持不变
export interface TeammateServiceOptions {
  mcpServers?: readonly AgentRuntimeMcpServer[];
  skillSources?: readonly AgentRuntimeSkillSource[];
  disableFeatures?: readonly string[];
  systemPrompt?: AgentRuntimeSystemPrompt;
}
```

### 2. `resolveLaunch()` 合并 options 到 inline buildLaunch 结果

在 `TeammateService.resolveLaunch()` 中，当 `buildLaunch` 存在时（inline 模式），将 `options` 中的值合并到构建结果中。这使得 Dispatcher 通过 options 传入的 `skillSources`、`mcpServers`、`systemPrompt`、`disableFeatures` 生效：

```typescript
// teammate-service/index.ts — resolveLaunch()
private resolveLaunch(): RuntimeLaunchSpec {
  const identity = this.current();
  if (this.deps.buildLaunch !== undefined) {
    const spec = this.deps.buildLaunch(identity, this.state);
    // Merge construction-time options into the inline-built spec so the
    // dispatcher agent uses the same option-passing pattern as TeamLeader.
    if (this.skillSources.length > 0) {
      spec.context.skillSources = this.skillSources;
    }
    if (this.mcpServers.length > 0) {
      spec.context.mcpServers = [...this.mcpServers];
    }
    if (this.disableFeatures.length > 0) {
      spec.context.disableFeatures = [
        ...(spec.context.disableFeatures ?? []),
        ...this.disableFeatures,
      ];
    }
    if (this.systemPrompt !== undefined) {
      spec.context.systemPrompt = this.systemPrompt;
    }
    return spec;
  }
  // agent-ref path unchanged...
}
```

### 3. `createDispatcherAgent()` 重构：通过 options 传入角色配置

将 `buildDispatcherLaunch()` 中硬编码的 `skillSources`、`mcpServers`、`systemPrompt`、`disableFeatures` 移到 `createDispatcherAgent()` 的 `options` 中。`mcpServers` 作为静态数组传入（由调用方在 channels 就绪后构建）：

```typescript
// dispatcher-service/agent.ts — createDispatcherAgent()
export function createDispatcherAgent(deps: DispatcherAgentDeps): TeammateService {
  const identity = debugIdentity(deps.id, deps.config);
  // persist debug record... (unchanged)

  const agent = createTeammateService({
    dispatcherId: deps.id,
    identity,
    launch: { kind: 'inline', build: (ident, state) => buildDispatcherLaunch(deps, ident, state) },
    options: {
      mcpServers: deps.mcpServers,  // 静态数组，由调用方在 channels 就绪后构建
      skillSources: [{
        name: 'dispatcher',
        path: bundledDispatcherSkillRoot(),
        source: 'dreamux-core',
      }],
      systemPrompt: {
        replace: DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
        append: [DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS],
      },
      disableFeatures: [DISABLE_FEATURE_CRON],
    },
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities: deps.identities,
    turnsStore: deps.turnsStore,
    // no worktrees (unchanged)
    log: deps.log,
    nextSubmissionSeq: () => 0,
    trackSettleCapture: () => { /* no-op */ },
    routeSettledCompletion: (producerName, turnId, completion) =>
      routeSettled(deps.router, producerName, turnId, completion),
  });
  return agent;
}
```

`DispatcherAgentDeps` 新增 `mcpServers` 字段，移除 `liveChannels`（MCP 描述符由调用方构建好传入）：

```typescript
export interface DispatcherAgentDeps {
  id: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  router: CompletionRouter;
  log: DreamuxLogger;
  adminSocketPath: string;
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
  resolveCwd: () => string;
  mcpServers: readonly AgentRuntimeMcpServer[];  // 新增：构建好的 MCP 描述符
  // 移除 liveChannels
}
```

`buildDispatcherLaunch()` 简化为只处理 dispatcher 特有逻辑（provider resolution、state binding、paths、cwd），不再设置 skillSources/mcpServers/systemPrompt/disableFeatures（这些由 options 合并）：

```typescript
function buildDispatcherLaunch(
  deps: DispatcherAgentDeps,
  _identity: TeamMateIdentity,
  _state: AgentRuntimeStateCallbacks,
): RuntimeLaunchSpec {
  const id = deps.id;
  const row = deps.dispatchers.get(id);
  if (row === null) throw new Error(`no dispatcher '${id}'`);
  const dispatcherConfig = mustDispatcherConfig(deps.config, id);
  const provider = deps.agentRuntimeProviders.resolve(
    dispatcherConfig.runtime.provider,
  );
  const cwd = deps.resolveCwd();
  return {
    provider,
    checkpointId: row.thread_id,
    context: {
      identity: { runtime_id: id, checkpoint_id: row.thread_id },
      config: dispatcherConfig.runtime.config,
      cwd,
      // skillSources, mcpServers, systemPrompt, disableFeatures 由 options 合并（resolveLaunch）
      state: deps.dispatchers.bindRuntime(id),  // status.json 仍为权威状态源
      paths: dispatcherHostPaths,
      logger: deps.log,
    },
  };
}
```

**关于 state**：保持 `state: deps.dispatchers.bindRuntime(id)`，因为 `status.json` 是 dispatcher 的权威状态存储。`buildLaunch` 的 `_state` 参数（identity store）被忽略，因为 dispatcher 不走 identity store 持久化。这与 TeamLeader 是合理的架构差异。

### 4. `DispatcherService` 延迟 agent 创建 + 拆分启动流程

**构造函数变更**：
- 不再创建 `this.agent`，改为 `this.agent: TeammateService | null = null`
- `scheduler` 的 `getRuntime` 和 `submitScheduled` 回调需要处理 `this.agent === null` 的情况
- `_teammates` 和 `teams` 的 `initiatorFor` 回调同理

```typescript
// dispatcher-service/index.ts — constructor
export class DispatcherService {
  private agent: TeammateService | null = null;  // 延迟创建

  constructor(opts: DispatcherServiceOptions) {
    // ... channels, identities, turnsStore, router, worktrees 创建不变 ...

    // agent 不再在构造函数中创建，延迟到 prepareChannels()

    this.scheduler_ = new SchedulerService({
      ownerId: opts.id,
      store: new CronJobStore({...}),
      absentRuntimeStrategy: 'submit',  // 从 'miss' 改为 'submit'，支持懒拉起
      getRuntime: () => this.agent?.getRuntime() ?? null,
      submitScheduled: (input) => {
        if (this.agent === null) {
          // agent 还未创建（理论上不会发生，因为 scheduler 在 prepareChannels 后才启动）
          return Promise.resolve({ status: 'failed', error: new Error('agent not created') });
        }
        return this.agent.scheduledInput(input);
      },
      log: opts.log,
    });

    // _teammates 和 teams 的 initiatorFor 回调需要处理 this.agent === null
    this._teammates = new TeammateCollection({
      ...,
      initiatorFor: (producer) => this.initiatorFor(producer),
      ...,
    });

    this.teams = new TeamCollection({
      ...,
      initiatorFor: (producer) => this.initiatorFor(producer),
      ...,
    });
  }
```

**`prepareChannels()`**（server boot 时调用）：
- 解析 workspace cwd
- 构建并采纳 channel sessions
- **创建 agent**（此时 channels 已 live，MCP 描述符可静态构建）
- 启动 channel sessions（带 deliver 回调）
- 启动 team schedulers
- **不**启动 agent runtime
- **不**启动 dispatcher scheduler

```typescript
async prepareChannels(): Promise<void> {
  if (this.channels.live().size > 0) return; // already prepared
  const id = this.id;
  const row = this.dispatchers.get(id);
  if (row === null) throw new Error(`no dispatcher '${id}'`);

  const dispatcherConfig = mustConfig(this.config, id);
  assertRunnableChannelShape(dispatcherConfig, this.channelProviders);

  this.workspaceCwd = await ensureDispatcherWorkspace(this.config, id);

  // Build + adopt channels
  const channels = await this.channels.build();
  this.channels.adopt(channels);

  // Now channels are live — create the agent with static MCP descriptors
  const mcpServers = dispatcherMcpServerDescriptors({
    dispatcherId: id,
    channels: this.channels.live(),
    adminSocketPath: this.adminSocketPath,
  });
  this.agent = createDispatcherAgent({
    id,
    config: this.config,
    dispatchers: this.dispatchers,
    agentRuntimeProviders: this.agentRuntimeProviders,
    identities: this.identities,
    turnsStore: this.turnsStore,
    router: this.router,
    log: this.log,
    adminSocketPath: this.adminSocketPath,
    resolveCwd: () => this.mustWorkspaceCwd(),
    mcpServers,  // 静态数组，此时已完全确定
  });

  // Start channel sessions (deliver callback triggers lazy runtime start)
  for (const [channelId, session] of channels) {
    await session.start({
      deliver: async (turn, envelope, hooks) =>
        asInboundDeliveryResult(
          await this.routeChannelInput(channelId, turn, envelope, hooks),
        ),
    });
  }

  // Start team schedulers (independent of dispatcher runtime;
  // team leaders have their own lazy-start via absentRuntimeStrategy: 'submit')
  await this.teams.startSchedulers();

  this.prepared = true;
}
```

**`start()`**（懒加载触发时调用）：
- 确保 `prepareChannels()` 已执行
- 调用 `agent.ensureStarted()` 启动 runtime
- 注入重启通知（如果有）
- 启动 dispatcher scheduler

```typescript
async start(): Promise<void> {
  if (this.agent?.getRuntime() !== null) return;
  if (this.starting !== null) return this.starting;
  const promise = this.doStartRuntime().finally(() => {
    this.starting = null;
  });
  this.starting = promise;
  return promise;
}

private async doStartRuntime(): Promise<void> {
  if (!this.prepared) await this.prepareChannels();
  const agent = this.agent!;  // non-null after prepareChannels

  let runtime: AgentRuntime;
  try {
    await agent.ensureStarted();
    runtime = this.mustRuntime();
  } catch (err) {
    throw err;
  }

  try {
    await this.injectRestartNoticeIfNeeded(this.id, runtime);
    await this.scheduler.start();
  } catch (err) {
    this.scheduler.stop();
    try { await agent.stop(); } catch { /* best effort */ }
    throw err;
  }

  this.log.info({ dispatcher_id: this.id }, 'dispatcher runtime ready');
}
```

**`stop()` 更新**：处理 `this.agent` 可能为 null 的情况。

```typescript
async stop(): Promise<void> {
  this.scheduler.stop();
  this.teams.stopSchedulers();
  await this.channels.closeAll(this.log);
  if (this.agent !== null) {
    try {
      await this.agent.stop();
    } catch (err) {
      this.log.error({ dispatcher_id: this.id, err: errInfo(err) }, 'error stopping dispatcher');
    }
  }
}
```

### 5. `routeChannelInput()` 懒启动 runtime

当收到未绑定到 team 的消息时，如果 runtime 未启动，先启动再投递：

```typescript
async routeChannelInput(
  channelId: string,
  input: InboundTurnInput,
  envelope: ChannelInboundEnvelope,
  hooks?: InboundDeliveryHooks,
): Promise<AgentRuntimeTurnResult> {
  this.assertNotShuttingDown();
  const target = envelope.target;
  if (target.bindable) {
    const routed = await this.channels.resolveInboundBinding({
      channelId,
      target,
    });
    if (routed !== null && (await this.teams.isOpenTeam(routed.owner.teamName))) {
      const team = await this.teams.get(routed.owner.teamName);
      const result = await team.deliverToLeader(input);
      if (result.status === 'submitted') await hooks?.onAccepted?.(input);
      return result;
    }
  }
  // Unbound message: lazy-start the dispatcher runtime if not running
  if (this.agent?.getRuntime() === null) {
    await this.start();
  }
  const runtime = this.agent?.getRuntime() ?? null;
  if (runtime === null) return { status: 'stopped' };
  return runtime.channelInput(input, hooks);
}
```

### 6. Scheduler 懒启动：`absentRuntimeStrategy` 改为 `'submit'`

Dispatcher scheduler 当前配置 `absentRuntimeStrategy: 'miss'`，runtime 未启动时直接丢弃 cron job。改为 `'submit'` 后，scheduled task 会触发 `submitScheduled` → `agent.scheduledInput()` → `ensureStarted()` → 拉起 runtime。

这与 TeamLeader scheduler 的行为一致。

**注意**：scheduler 在 `start()`（runtime 启动时）中启动，所以 cron job 触发时 `this.agent` 一定已创建（因为 `prepareChannels()` 在 `start()` 之前执行）。

### 7. `Server.start()` 改为 prepareChannels + 条件性 eager start

```typescript
// server.ts — start()
const rows = this.repos.dispatchers.listEnabled();
for (const row of rows) {
  const dispatcher = this.getDispatcher(row.dispatcher_id);
  try {
    // Always prepare channels so inbound messages can be received
    await dispatcher.prepareChannels();
    // Eagerly start runtime only when this dispatcher is a restart
    // notification target (it has a checkpoint to resume + a notice pending)
    if (this.restartIntent?.hasTarget(row.dispatcher_id) && row.thread_id !== null) {
      await dispatcher.start();
    }
  } catch (err) {
    this.log.error({ dispatcher_id: row.dispatcher_id, err: errInfo(err) },
      'dispatcher failed to start');
  }
}
```

这需要 `RestartIntentConsumer` 添加一个非破坏性的 `hasTarget()` 方法：

```typescript
// daemon/restart-intent.ts
hasTarget(dispatcherId: string): boolean {
  return this.remaining.has(dispatcherId);
}
```

并在 `Server` 中保存 `restartIntent` 引用（当前 `Server` 没有保存，只传给了 `dispatchers.setRestartIntent()`）。

### 8. `DispatcherService` 新状态字段

```typescript
private prepared = false;  // channels prepared and listening, agent created
```

## 影响范围

| 文件 | 变更类型 |
|------|----------|
| `packages/dreamux/src/service/teammate-service/index.ts` | `resolveLaunch()` inline 路径合并 options |
| `packages/dreamux/src/service/dispatcher-service/agent.ts` | 重构：`mcpServers` 通过 deps 传入，角色配置通过 options 传入；`buildDispatcherLaunch()` 简化 |
| `packages/dreamux/src/service/dispatcher-service/index.ts` | 延迟 agent 创建到 `prepareChannels()`；拆分 `prepareChannels()` + `start()`；`routeChannelInput()` 懒启动；`absentRuntimeStrategy: 'submit'` |
| `packages/dreamux/src/server.ts` | boot 时 `prepareChannels()` + 条件 eager start；保存 `restartIntent` 引用 |
| `packages/dreamux/src/daemon/restart-intent.ts` | 添加 `hasTarget()` 方法 |
| `packages/dreamux/src/service/team-service/leader-agent.ts` | 无变更（参考模式） |
| 相关测试文件 | 更新以适配新的启动流程 |

## 不变量保持

1. **`status.json` 仍然是 dispatcher 运行时状态的权威来源**：`buildDispatcherLaunch()` 仍然设置 `state: deps.dispatchers.bindRuntime(id)`。
2. **Dispatcher MCP 描述符从 live channel sessions 派生**：在 `prepareChannels()` 中 channels 已 build + adopt 后构建，作为静态数组传入 agent。
3. **重启通知仅在 checkpoint resume 时注入**：`injectRestartNoticeIfNeeded()` 仍然检查 `runtime.wasCheckpointResumed()`。
4. **TeamLeader 懒加载行为不变**：本次变更不影响 TeamLeader。
5. **Channel sessions 先于 runtime 启动**：`prepareChannels()` 启动 channel sessions，`start()` 启动 runtime。这是预期的顺序变化——懒加载的本质就是允许消息在 runtime 就绪前到达。
6. **`initiatorFor` 回调在 agent 创建后才被调用**：`initiatorFor` 在 turn settle 时被调用，此时 `prepareChannels()` 已执行（因为 turn settle 意味着有消息被处理，而消息处理需要 channel sessions 已启动）。

## 已解决的设计决策

1. **`mcpServers` vs `mcpServersProvider`**：不需要 provider。通过将 agent 创建延迟到 `prepareChannels()`，MCP 描述符在创建时已完全确定，直接用静态数组。
2. **scheduler 启动时机**：dispatcher scheduler 在 `start()`（runtime 启动时）启动。因为 `absentRuntimeStrategy: 'submit'` 会触发 runtime 拉起，所以 scheduler 必须在 runtime 可拉起的阶段启动。
3. **team schedulers 启动时机**：在 `prepareChannels()` 中启动。team schedulers 有自己的 `absentRuntimeStrategy: 'submit'`，可独立于 dispatcher runtime 触发 team leader 懒加载。
4. **`absentRuntimeStrategy`**：dispatcher scheduler 从 `'miss'` 改为 `'submit'`，与 TeamLeader 一致，使 scheduled task 成为第三个懒启动触发路径。
