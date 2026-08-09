# Dynamic Workflow Usage Guide (Beta)

> Applies to Dreamux 0.22.x-beta. The capability is beta: its interface is
> stable, while behavior may still receive small refinements.

Dynamic Workflow is Dreamux's deterministic multi-agent orchestration
primitive. Submit JavaScript metadata plus calls to `agent()`, `parallel()`,
`pipeline()`, `phase()`, and `log()` once; the host executes the fixed graph in
the background and delivers one terminal result.

Scripts may use either the original ES module entry (`export default async
function run()`) or the ultracode entry, where the executable body follows
`export const meta` at top level and may use top-level `await` and `return`.
Each `agent()` call drives a fresh Dreamux TeamMate through any configured agent
runtime, including Codex and Claude Code.

---

## 1. When to Use a Workflow

| Scenario | Use Workflow | Use ordinary `spawn` / `send` |
|---|:---:|:---:|
| The coordination graph is known up front | Yes | |
| A list needs the same repeated multi-step treatment | Yes | |
| Several stages can run work concurrently | Yes | |
| The next step depends on human review of the previous result | | Yes |
| Instructions, agents, or tasks need mid-run changes | | Yes |

In short: use a Workflow for a fixed graph that benefits from concurrency and
should return one final result. Use ordinary TeamMate operations for interactive
iteration.

---

## 2. Examples

### 2.1 Review Workflow: Parallel Review, Then Summary

Three reviewers inspect a pull request independently, then one summary agent
combines the findings.

```js
export const meta = {
  name: 'pr-review',
  description: '3 reviewers parallel, then 1 summary',
  phases: ['review', 'summary'],
};

export default async function run() {
  phase('review');
  const reviews = await parallel([
    () => agent('Review correctness and lifecycle behavior. Return concise findings.', {
      label: 'correctness',
      phase: 'review',
      intent: 'Correctness reviewer',
    }),
    () => agent('Review architecture layering and code reuse. Return concise findings.', {
      label: 'architecture',
      phase: 'review',
      intent: 'Architecture reviewer',
    }),
    () => agent('Review test coverage and contract protection. Return concise findings.', {
      label: 'testing',
      phase: 'review',
      intent: 'Test reviewer',
    }),
  ]);

  phase('summary');
  const summary = await agent(
    `Combine these findings by severity and give a final verdict:\n${JSON.stringify(reviews)}`,
    { label: 'summary', phase: 'summary', intent: 'Technical editor' },
  );
  return { reviews, summary };
}
```

Key properties:

- `parallel([...])` starts all three reviewers before waiting at one barrier.
- A failed reviewer contributes `null` without discarding the other results.
- The summary agent receives the complete result array.

### 2.2 Audit Workflow: Parallel Structured Output

Each reviewer returns structured JSON so the workflow can process findings
without parsing free-form text.

```js
export const meta = {
  name: 'code-reuse-audit',
  description: 'Audit code reuse and return structured findings',
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
    () => agent('Review duplicated and copied code.', {
      label: 'duplication', phase: 'audit', schema: FINDING_SCHEMA,
    }),
    () => agent('Review dead code and unused public members.', {
      label: 'dead-code', phase: 'audit', schema: FINDING_SCHEMA,
    }),
    () => agent('Review repeated logic that should share one helper.', {
      label: 'consolidation', phase: 'audit', schema: FINDING_SCHEMA,
    }),
  ]);

  phase('summary');
  const summary = await agent(
    `Combine these audits and sort by net lines removed:\n${JSON.stringify(audits)}`,
    { label: 'summary', phase: 'summary' },
  );
  return { audits, summary };
}
```

The `schema` option requests runtime-native structured output. Codex receives
`outputSchema`; Claude Code receives `--json-schema`. Dreamux parses a successful
structured result once and returns the parsed JSON value. Unsupported structured
output fails that `agent()` call loudly.

### 2.3 Fix Workflow: Locate, Implement, Verify

The phases are sequential because each prompt consumes the previous result.

```js
export const meta = {
  name: 'fix-and-verify',
  description: 'Locate, implement, and verify a fix',
  phases: ['locate', 'implement', 'verify'],
};

export default async function run() {
  phase('locate');
  const locations = await agent(
    'Locate every finding in source and return file, line, and code context.',
    { label: 'locate', phase: 'locate', intent: 'Code investigator' },
  );

  phase('implement');
  const result = await agent(
    `Implement every accepted fix and run build plus lint.\n\nLocations:\n${locations}`,
    { label: 'implement', phase: 'implement', intent: 'Senior engineer' },
  );

  phase('verify');
  const verification = await agent(
    'Run the focused build, lint, and tests. Report exact results and failures.',
    { label: 'verify', phase: 'verify', intent: 'CI verifier' },
  );

  return { locations, implementation: result, verification };
}
```

Each call creates an independent TeamMate. The returned object becomes the
Workflow's terminal result.

---

## 3. Script API

### 3.1 `meta` (Required)

```js
export const meta = {
  name: 'my-workflow',
  description: 'What this workflow does',
  whenToUse: 'Use when every target is known before execution.',
  phases: [
    'phase1',
    { title: 'phase2', detail: 'Phase description', model: 'metadata only' },
  ],
};
```

`name` and `description` are required strings. `whenToUse` is an optional
string. Each `phases` entry may be a string or
`{ title, detail?, model? }`. `detail` and `model` are descriptive compatibility
metadata; `model` does not select an agent model or runtime.

Metadata is validated before the orchestration body can start agents. It is not
persisted on the run, projected by `workflow_status` or `workflow_list`, or used
for permission confirmation.

Ultracode metadata must be a recursively plain literal object: no variables,
calls, interpolation, computed properties, methods, shorthand properties, or
spread. An ultracode script may export only `meta`. The existing module form is
evaluated byte-for-byte unchanged and retains normal module evaluation
semantics.

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

### 3.2 `agent(prompt, options?)`

Starts a fresh TeamMate and waits for its turn to settle.

```js
const result = await agent('Review the API contract.', {
  label: 'review-api',
  phase: 'review',
  intent: 'API contract reviewer',
  identity: 'A precise compatibility reviewer',
  agentType: 'claude-code',
  schema: { ... },
});
```

Return and failure behavior:

- Without `schema`, a successful call returns the TeamMate's final text and an
  ordinary failed turn returns `null`.
- With `schema`, Dreamux requests native structured output and returns the
  parsed JSON value. An ordinary failed native turn still returns `null`.
- Unsupported structured output, or a runtime-reported successful schema result
  that is empty or invalid JSON, rejects the `agent()` promise with a contract
  error that distinguishes empty output from invalid JSON.

A directly awaited rejection fails the Workflow unless the script catches it.
`parallel()` and `pipeline()` contain a rejected thunk or item as `null`, so the
other results remain available.

Every `agent()` call creates a new TeamMate. Calls do not reuse an existing
TeamMate because steering an in-flight turn would make result ownership
ambiguous.

### 3.3 `parallel(thunks)`

Starts all thunks together and waits at one barrier.

```js
const results = await parallel([
  () => agent('Task A', { label: 'A' }),
  () => agent('Task B', { label: 'B' }),
  () => agent('Task C', { label: 'C' }),
]);
// results preserve thunk order: [resultA, resultB, resultC]
```

- At most 4096 functions are accepted. The size check happens atomically before
  any thunk runs.
- A failed thunk contributes `null` without affecting other results.
- Total duration is approximately the duration of the slowest thunk.

### 3.4 `pipeline(items, ...stages)`

Processes each item through every stage in order while different items advance
independently.

```js
const reports = await pipeline(
  args.targets,
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

- At most 4096 items are accepted. The size check happens atomically before any
  stage runs.
- Every stage receives `(previousResult, originalItem, index)`. For the first
  stage, `previousResult` and `originalItem` are the same value.
- If one stage fails, later stages for that item do not run and the item
  contributes `null`.

### 3.5 `phase(title)` and `log(message)`

```js
phase('review');
log('Completed 3 of 5 reviews');
```

`phase()` records the current phase. `log()` records the latest progress line
reported by `workflow_status`.

### 3.6 `args`

The exact `args` value supplied to `workflow_run` is available as a global:

```js
export default async function run() {
  return pipeline(args.targets, ...);
}
```

---

## 4. Run and Monitor

### 4.1 Submit

```js
workflow_run({
  script: '<workflow source>',
  args: { targets: ['a.ts', 'b.ts'] },
  max_concurrency: 16,
})
// -> { run_id: 'run-abc123' }
```

`max_concurrency` is optional, defaults to 16, and accepts only integers from 1
through 16. Invalid values are rejected before a run is created; they are not
clamped.

For an admitted request, `workflow_run` returns `run_id` immediately. Script
normalization, compilation, entry, or metadata failures happen asynchronously
and produce a durable failed run plus its terminal completion.

### 4.2 Status

```js
workflow_status({ run_id: 'run-abc123' })
```

Returns the current phase, agent progress, concrete TeamMate names, and terminal
result when available.

### 4.3 List

```js
workflow_list()
```

Lists runs in the current dispatcher or TeamLeader caller scope.

### 4.4 Stop

```js
workflow_stop({ run_id: 'run-abc123' })
```

Reserves the stopped outcome and returns immediately. In-flight agent turns
settle before the stopped terminal completion is delivered. Immediately after
the call, `workflow_status` may briefly remain `running`; this does not mean the
stop failed.

---

## 5. Constraints

### 5.1 Sandbox

Workflow scripts cannot:

- import or require modules;
- access the filesystem, network, process, or timers;
- call `Date.now()`, `Math.random()`, or `new Date()` without arguments.

Scripts may use the Workflow functions, `args`, and standard JavaScript
intrinsics such as `JSON`, `Array`, `Object`, and `Promise`.

### 5.2 Concurrent Writes

Workflow agents inside one Team share the Team workspace. Concurrent writes can
conflict. Keep concurrent agents read-only, assign disjoint write paths, or use
one agent for overlapping edits.

### 5.3 Exact Limits

- Each run can start at most **1000 agents** across its complete lifecycle.
- Each `parallel()` call accepts at most **4096 functions**.
- Each `pipeline()` call accepts at most **4096 items**.
- `max_concurrency` defaults to **16** and accepts only integers from **1
  through 16**.
- An individual turn timeout is controlled by the selected runtime.

These are the canonical user-facing Workflow limits. The
[current architecture](current-architecture.md#dynamic-workflows) describes
where they are enforced without duplicating their numeric values.

### 5.4 Structured Output Support

| Runtime | Native mechanism | Scope |
|---|---|---|
| Codex | `turn/start.outputSchema` | Per turn |
| Claude Code | `--json-schema` | Per spawned session |

Unsupported `schema` fails that `agent()` call loudly. Dreamux does not emulate
schema validation in prompts or silently degrade to free-form text. A built-in
runtime reports a completed schema turn only after its native mechanism produces
structured output. Dreamux then parses the JSON text once. Empty output and
invalid JSON after reported success are distinct agent contract errors, never a
successful `null`.

---

## 6. Pattern Reference

| Need | Pattern |
|---|---|
| Independent tasks followed by a summary | `parallel([...])` plus one summary agent |
| Repeated multi-stage list processing | `pipeline(items, stage1, stage2, ...)` |
| Sequential dependency chain | Consecutive `await agent(...)` calls |
| Structured results | Pass `schema` to `agent()` |
| Partial-failure containment | Use `parallel()` or `pipeline()` |
| Visible progress | Use `label`, `phase`, and `log()` |

---

## 7. Workflow Versus Ordinary TeamMate Operations

| Dimension | Workflow | `spawn` / `send` |
|---|---|---|
| Orchestration | One deterministic submission | Interactive steps |
| Concurrency | Native `parallel()` / `pipeline()` | Managed by the caller |
| Result | One terminal return value | One result per turn |
| Partial failure | Failed items become `null` in helpers | Handled by the caller |
| Best fit | Fixed batch coordination | Iterative decisions and steering |

## Implementation Sources

- `/packages/dreamux/src/service/workflow-service/`
- `/packages/dreamux/src/mcp/teammate-mcp.ts`
- `/packages/dreamux/skills/shared/workflow/SKILL.md`
