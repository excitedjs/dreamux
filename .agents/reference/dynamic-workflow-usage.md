# Dynamic Workflow 使用指南（Beta）

> 适用版本：Dreamux 0.22.x-beta · 能力状态：Beta（接口稳定，行为可能微调）

Dynamic Workflow is Dreamux's deterministic multi-agent orchestration
primitive. Submit JavaScript metadata plus calls to `agent()`, `parallel()`,
`pipeline()`, `phase()`, and `log()` once; the host executes the fixed graph in
the background and delivers one terminal result.

Scripts may use either the original ES module entry (`export default async
function run()`) or the ultracode entry, where the executable body follows
`export const meta` at top level and can use top-level `await` and `return`.

它对齐 Claude Code 的 `Workflow` 工具形态，但 `agent()` 驱动的是
Dreamux 的 **TeamMate**——你可以用 codex、claude-code 等任意已接入的
runtime 来跑每个子任务。

---

## 1. 什么时候用 Workflow

| 场景 | 用 Workflow | 用普通 `spawn` / `send` |
|------|:-----------:|:----------------------:|
| 协调图已知（几个独立调查 → 汇总） | ✅ | |
| 对一个列表重复同样的多步处理 | ✅ | |
| 多阶段流水线，各阶段可并行 | ✅ | |
| 下一步依赖上一步的人工审阅 | | ✅ |
| 需要中途改指令、换人、追加任务 | | ✅ |

一句话：**结构固定、要并行、要一个最终结果 → Workflow；需要来回交互 →
普通 spawn/send。**

---

## 2. 三个真实例子

下面三个例子都来自实际使用，覆盖了最常见的三种编排形态。

### 2.1 评审工作流（并行 → 汇总）

对一个 PR 做代码审查：3 个 reviewer 并行审不同维度，最后 1 个 summary
agent 合并结论。

```js
export const meta = {
  name: 'pr-review',
  description: '3 reviewers parallel, then 1 summary',
  phases: ['review', 'summary'],
};

export default async function run() {
  phase('review');
  const reviews = await parallel([
    () => agent('审查正确性和生命周期。返回精简发现列表。', {
      label: 'correctness',
      phase: 'review',
      intent: '正确性评审',
    }),
    () => agent('审查架构分层和代码复用。返回精简发现列表。', {
      label: 'architecture',
      phase: 'review',
      intent: '架构评审',
    }),
    () => agent('审查测试覆盖和契约保护。返回精简发现列表。', {
      label: 'testing',
      phase: 'review',
      intent: '测试评审',
    }),
  ]);

  phase('summary');
  const summary = await agent(
    `合并以下评审发现，按严重程度排序，输出最终结论：\n${JSON.stringify(reviews)}`,
    { label: 'summary', phase: 'summary', intent: '技术编辑' },
  );
  return { reviews, summary };
}
```

**形态要点：**
- `parallel([...])` 同时启动 3 个 reviewer，在一个 barrier 等待全部完成
- 某个 reviewer 失败只贡献 `null`，不影响其他 reviewer 的结果
- summary agent 拿到所有结果后做合并

### 2.2 代码审计工作流（并行 + 结构化输出）

审查代码复用度，要求每个 reviewer 返回**结构化 JSON**（而不是自由文本），
方便后续自动处理。

```js
export const meta = {
  name: 'code-reuse-audit',
  description: 'Audit code reuse, return structured findings',
  phases: ['audit', 'summary'],
};

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['must-fix', 'optional', 'skip'] },
          summary: { type: 'string' },
          lines_saved: { type: 'number' },
        },
        required: ['file', 'severity', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

export default async function run() {
  phase('audit');
  const audits = await parallel([
    () => agent('审查重复代码和复制粘贴。', {
      label: 'duplication', phase: 'audit', schema: FINDING_SCHEMA,
    }),
    () => agent('审查死代码和未使用的 public 成员。', {
      label: 'dead-code', phase: 'audit', schema: FINDING_SCHEMA,
    }),
    () => agent('审查可收敛的重复逻辑和辅助函数。', {
      label: 'consolidation', phase: 'audit', schema: FINDING_SCHEMA,
    }),
  ]);

  phase('summary');
  const summary = await agent(
    `合并以下审计结果，按净减行数排序：\n${JSON.stringify(audits)}`,
    { label: 'summary', phase: 'summary' },
  );
  return { audits, summary };
}
```

**形态要点：**
- `schema` 选项让 runtime 原生输出 JSON（codex 用 `outputSchema`、
  claude-code 用 `--json-schema`），服务端只做一次 `JSON.parse`
- 带 `schema` 时 `agent()` 返回**解析后的 JSON 对象**，不是文本
- 如果 runtime 不支持结构化输出，该 `agent()` 调用会被拒绝（fail-loud）

### 2.3 修复工作流（流水线：定位 → 实施 → 验证）

对审计发现做修复：先定位代码，再实施，最后跑 build/lint/test 验证。
三个阶段**串行**（后一步依赖前一步的输出），但每个阶段内部可以并行。

```js
export const meta = {
  name: 'fix-and-verify',
  description: 'Locate → Implement → Verify pipeline',
  phases: ['locate', 'implement', 'verify'],
};

export default async function run() {
  phase('locate');
  const locations = await agent(
    `读取审计发现，在源码中定位每一项的精确位置（文件:行号 + 代码片段）。`,
    { label: 'locate', phase: 'locate', intent: '代码定位员' },
  );

  phase('implement');
  const result = await agent(
    `根据定位结果实施全部修复。完成后运行 build + lint 并修复错误。\n\n定位结果：\n${locations}`,
    { label: 'implement', phase: 'implement', intent: '高级工程师' },
  );

  phase('verify');
  const verify = await agent(
    `运行 build / lint / test，报告结果。已知 flaky 测试（team-scheduler）单独跑能过，忽略。`,
    { label: 'verify', phase: 'verify', intent: 'CI 验证工程师' },
  );

  return { locations, implementation: result, verification: verify };
}
```

**形态要点：**
- 三阶段串行：`implement` 的 prompt 里直接拼接 `locate` 的输出
- 每个阶段是独立的 TeamMate，互不干扰
- `return` 的值会作为整个 run 的最终结果投递回来

---

## 3. 脚本 API 详解

### 3.1 `meta`（必须）

```js
export const meta = {
  name: 'my-workflow',        // required compatibility identifier
  description: 'What this workflow does', // required compatibility summary
  whenToUse: 'Use when every target is known before execution.', // optional
  phases: [
    'phase1',
    { title: 'phase2', detail: 'Phase description', model: 'metadata only' },
  ],
};
```

`name` and `description` are required strings. `whenToUse` is an optional
string. Each `phases` entry may be a string or
`{ title, detail?, model? }`; `model` is descriptive metadata and does not
select an agent model or runtime.

Metadata is accepted for workflow-dialect compatibility and validated before
the orchestration body can start agents. It is not persisted on the run,
projected by `workflow_status` or `workflow_list`, or used for permission
confirmation.

Ultracode metadata must be a recursively plain literal tree: no variables,
calls, interpolation, computed properties, methods, shorthand properties, or
spread. Ultracode scripts may export only `meta`. The existing module form is
evaluated unchanged and retains its existing metadata-validation semantics.

An ultracode entry places its executable body directly after metadata:

```js
export const meta = {
  name: 'inspect-targets',
  description: 'Inspect every requested target',
  phases: [{ title: 'inspect', detail: 'Run one inspection per target' }],
};

phase('inspect');
const reports = await pipeline(
  args.targets,
  (target, originalTarget, index) =>
    agent(`Inspect ${target}`, { label: `inspect-${index}-${originalTarget}` }),
);
return reports;
```

### 3.2 `agent(prompt, opts?)`

启动一个**全新的** TeamMate 并等待它的 turn 结束。

```js
const result = await agent('任务描述', {
  label: 'review-api',        // 进度展示用的标签
  phase: 'review',            // 归属阶段（对应 meta.phases）
  intent: 'API 契约评审',      // TeamMate 的任务意图
  identity: '...',            // 可选：稳定身份文本（用于常驻角色）
  agentType: 'claude-code',   // 可选：指定 runtime（默认用 dispatcher 配置的）
  schema: { ... },            // 可选：JSON Schema，要求结构化输出
});
```

**Return and failure behavior:**
- without `schema`, a successful call returns the TeamMate's final text and an
  ordinary failed turn returns `null`;
- with `schema`, Dreamux asks the selected runtime for native structured output
  and returns the parsed JSON value; an ordinary failed native turn retains the
  existing `null` result;
- unsupported structured output, or a runtime-reported successful schema result
  that is empty or invalid JSON, rejects the `agent()` promise.

A directly awaited rejection fails the workflow unless the script catches it.
`parallel()` and `pipeline()` intentionally contain a rejected thunk or item as
`null`, preserving the other results.

**重要：** 每次 `agent()` 都 spawn 新 TeamMate，不复用。这是故意的——
避免在途 turn 被打扰导致结果偏差。

### 3.3 `parallel(thunks)`

同时启动所有 thunk，在一个 barrier 等待全部完成。

```js
const results = await parallel([
  () => agent('任务 A', { label: 'A' }),
  () => agent('任务 B', { label: 'B' }),
  () => agent('任务 C', { label: 'C' }),
]);
// results: [resultA, resultB, resultC]，顺序与 thunks 一致
```

- At most 4096 functions are accepted. The limit is checked atomically before
  any thunk runs.
- 某个 thunk 失败 → 对应位置是 `null`，**不影响**其他结果
- 所有 thunk 并行启动，总耗时 ≈ 最慢的那个

### 3.4 `pipeline(items, ...stages)`

对 `items` 中的每个元素，依次经过 `stages` 中的每个阶段。不同元素可以
在不同阶段独立推进（类似装配线）。

```js
const reports = await pipeline(
  args.targets,                          // 输入列表
  (target, originalTarget, index) => agent(`Inspect ${target}`, {
    label: `inspect-${index}-${originalTarget}`,
    phase: 'inspect',
    schema: INSPECT_SCHEMA,
  }),
  (report, originalTarget, index) => agent(`Rank ${originalTarget}`, {
    label: `rank-${index}`,
    phase: 'rank',
  }),
);
```

- At most 4096 items are accepted. The limit is checked atomically before any
  stage runs.
- Every stage receives `(previousResult, originalItem, index)`. For the first
  stage, `previousResult` and `originalItem` are the same value.
- 每个 item 独立经过所有 stage
- 某个 item 在某个 stage 失败 → 该 item 后续 stage 不再执行，最终贡献 `null`
- 适用于「每个元素都要做同样多步处理」的场景

### 3.5 `phase(title)` / `log(message)`

```js
phase('review');   // 标记当前进入 review 阶段
log('已完成 3/5 项');  // 记录一条进度日志
```

- `phase()` 的参数应该出现在 `meta.phases` 里
- `log()` 输出会出现在 `workflow_status` 的进度中

### 3.6 `args`

`workflow_run` 传入的 `args` 参数，在脚本里作为全局变量直接使用：

```js
// 调用方：workflow_run({ script, args: { targets: ['a.ts', 'b.ts'] } })
export default async function run() {
  const reports = await pipeline(args.targets, ...);
}
```

---

## 4. 运行和监控

### 4.1 提交运行

```
workflow_run({
  script: "<上面的脚本字符串>",
  args: { ... },          // 可选，脚本里用 args 访问
  max_concurrency: 16,    // optional; defaults to 16, valid range 1..16
})
// → { run_id: "run-abc123" }
```

立即返回 `run_id`，run 在后台执行。完成时会推送一条完成 turn 给你。

### 4.2 查看状态

```
workflow_status({ run_id: "run-abc123" })
```

返回：当前阶段、各 agent 的进度（label / phase / 状态）、最终结果（如果
已完成）。

### 4.3 列出运行

```
workflow_list()
```

列出当前调用方作用域下的所有 run。

### 4.4 停止运行

```
workflow_stop({ run_id: "run-abc123" })
```

保留终态、立即返回。进行中的 agent turn 会结算完才投递 `stopped` 终态。
**stop 后 `workflow_status` 可能短暂仍显示 `running`**——这是正常的，
不是 stop 失败。

---

## 5. 约束和注意事项

### 5.1 脚本不能做的事

脚本运行在受限沙箱里，**不能**：
- `import` / `require` 任何模块
- 访问文件系统、网络、进程、定时器
- 使用 `Date.now()` / `Math.random()` / `new Date()`（保证确定性）

脚本只能用：`agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`
/ `args` / 标准 JS 内置（`JSON` / `Array` / `Object` / `Promise` 等）。

### 5.2 并行写文件要小心

同一个 Team 内的 workflow agents 共享 Team 工作区。如果多个 agent 同时
写文件，会冲突。建议：
- 并行的 agent 保持**只读**，或
- 给每个 agent 分配**明确独立的文件路径**，或
- 写操作只用**一个 agent** 串行做

### 5.3 生命周期上限

- Each run can start at most **1000 agents**.
- Each `parallel()` call accepts at most **4096 functions**.
- Each `pipeline()` call accepts at most **4096 items**.
- `max_concurrency` defaults to **16** and accepts **1..16**.
- 单个 agent 的 turn 超时由 runtime 配置决定

### 5.4 结构化输出的 runtime 支持

| Runtime | 支持方式 | 范围 |
|---------|---------|------|
| codex | `turn/start.outputSchema` | 每 turn |
| claude-code | `--json-schema` flag | 每 turn（spawn 时） |

Unsupported `schema` fails that `agent()` call loudly. Dreamux does not emulate
schema validation in prompts or silently degrade to free-form text. A built-in
runtime reports a completed schema turn only after its native mechanism has
produced structured output; Dreamux then parses the JSON text once. Empty or
invalid JSON after reported success is an agent error, not a successful `null`.

---

## 6. 常见模式速查

| 需求 | 模式 |
|------|------|
| N 个独立任务 → 汇总 | `parallel([...])` + 1 个 summary agent |
| 列表每项做多步处理 | `pipeline(items, stage1, stage2, ...)` |
| 串行依赖链 | 连续 `await agent(...)`，把上一步输出拼进下一步 prompt |
| 要结构化结果 | 给 `agent()` 传 `schema` |
| 容错（部分失败不影响整体） | `parallel` / `pipeline` 天然容错，失败项为 `null` |
| 进度可见 | 用 `label` + `phase` + `log()` |

---

## 7. 与普通 spawn/send 的对比

| 维度 | Workflow | spawn / send |
|------|----------|--------------|
| 编排 | 一次提交，确定性执行 | 逐步交互 |
| 并行 | 原生 `parallel` / `pipeline` | 需手动管理 |
| 结果 | 一个最终 `return` 值 | 每条 turn 独立 |
| 容错 | 部分失败 → `null` | 需手动处理 |
| 适用 | 结构固定的批量任务 | 需要人工判断的迭代任务 |

---

## 8. 从哪获取更多

- 内置 skill：`workflow`（加载后获得完整 API 参考）
- 提案与设计决策：`.agents/archive/proposals/dynamic-workflow.md`
- 开发流程 skill：`.agents/skills/dev-workflow/SKILL.md`（评审团工作流的实战用法）
