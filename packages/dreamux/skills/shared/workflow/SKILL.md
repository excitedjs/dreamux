---
name: workflow
description: Deterministic multi-agent orchestration with workflow_run, workflow_status, workflow_stop, and workflow_list. Load for staged, parallel, or pipelined TeamMate work that should produce one terminal result.
---

# Dynamic Workflow

Use a workflow when the coordination graph is known up front: several independent
investigations, repeated work over a list, or multiple stages that should run in
the background and return one combined result. Use ordinary `spawn` and `send`
when the next instruction depends on an interactive review of the previous turn.

Within a Team, workflow agents share the Team workspace. Keep concurrent prompts
read-only, or assign clearly independent edit paths. Use one agent at a time for
overlapping writes.

## Run Tools

- `workflow_run` accepts an inline `script`, optional `args`, and optional
  `max_concurrency`. It returns `{ run_id }` immediately; Dreamux pushes one
  terminal completion when the run finishes.
- `workflow_status` reads the current phase, agent progress, concrete TeamMate
  names, and terminal result for one `run_id`.
- `workflow_list` lists runs in the current caller scope.
- `workflow_stop` stops a running `run_id`. It reserves the terminal state and
  returns immediately; in-flight agent turns settle before the stopped terminal
  completion is delivered. Right after `workflow_stop` returns, `workflow_status`
  may still read `running` until the run settles to `stopped` — do not treat a
  transient `running` as a failed stop.

`max_concurrency` defaults to 16 and accepts only integers from 1 through 16.
Invalid values are rejected before a run is created rather than clamped. Each
run can start at most 1000 agents across its complete lifecycle.

Use `workflow_status` for an explicit progress check or recovery, not as a polling
loop. After a run, use a recorded concrete TeamMate name with `send` when a result
needs an interactive follow-up.

## Script Entry

Dreamux accepts two script entry forms. The existing module form exports
metadata and a default async entry function:

```js
export const meta = {
  name: 'review-and-summarize',
  description: 'Review several areas and combine the findings',
  phases: ['review', 'summary'],
};

export default async function run() {
  phase('review');
  const reviews = await parallel([
    () => agent('Review the API. Return concise findings.', {
      label: 'api-review',
      phase: 'review',
      intent: 'API contract reviewer',
    }),
    () => agent('Review the lifecycle. Return concise findings.', {
      label: 'lifecycle-review',
      phase: 'review',
      intent: 'Lifecycle reviewer',
    }),
  ]);

  phase('summary');
  const summary = await agent(`Combine these findings:\n${JSON.stringify(reviews)}`, {
    label: 'summary',
    phase: 'summary',
    intent: 'Technical editor',
  });
  return { reviews, summary };
}
```

`args` is the exact value supplied to `workflow_run`. Return plain serializable
data from `run()`.

The ultracode form exports literal metadata and then places the workflow body at
top level:

```js
export const meta = {
  name: 'review-and-summarize',
  description: 'Review several areas and combine the findings',
  whenToUse: 'Use when the review targets are known before execution.',
  phases: [
    { title: 'review', detail: 'Independent review passes' },
    { title: 'summary', model: 'documentary metadata only' },
  ],
};

phase('review');
const reviews = await parallel([
  () => agent('Review the API. Return concise findings.', {
    label: 'api-review',
    phase: 'review',
  }),
  () => agent('Review the lifecycle. Return concise findings.', {
    label: 'lifecycle-review',
    phase: 'review',
  }),
]);

phase('summary');
return agent(`Combine these findings:\n${JSON.stringify(reviews)}`, {
  label: 'summary',
  phase: 'summary',
});
```

For the ultracode form, `meta` must be a recursively plain literal object, and
the script may not import modules or export anything else. Dreamux wraps the
top-level body in the canonical async entry function. The module form remains
unchanged, including its existing module-evaluation semantics.

Metadata requires string `name` and `description`. `whenToUse` is an optional
string. `phases` may contain strings or objects shaped as
`{ title, detail?, model? }`; `detail` and `model` are descriptive metadata
only. A phase's `model` does not select an agent runtime or model.

## Script API

`agent(prompt, opts?)` starts a fresh TeamMate and waits for its settled turn.
Options are:

- `label` and `phase` for readable progress;
- `agentType` for an agent-runtime id from `get_capabilities`;
- `intent` and `identity` for the TeamMate's task and persona;
- `schema` for a JSON Schema object handled by the selected runtime.

Without `schema`, `agent()` returns final text or `null` when the turn fails.
With `schema`, Dreamux passes the schema through the runtime's native
structured-output mechanism and returns the parsed JSON value; an ordinary
failed native turn retains the existing `null` result. A runtime that cannot
provide structured output, or a runtime-reported successful schema result that
is empty or invalid JSON, rejects that `agent()` call. When directly awaited,
the rejection fails the workflow unless the script catches it.

`parallel(thunks)` accepts at most 4096 functions, starts them together, and
waits at one barrier. The size limit is checked before any thunk runs. A failed
thunk contributes `null` without discarding the other results.

`pipeline(items, ...stages)` processes each item through its stages in order while
different items can advance independently. It accepts at most 4096 items and
checks that limit before any stage runs. Every stage receives
`(previousResult, originalItem, index)`. A failed item contributes `null`
without discarding the other items or failing the workflow. Use it when every
item needs the same multi-step treatment:

```js
export const meta = {
  name: 'inspect-and-rank',
  description: 'Inspect each target, then rank the reports',
  phases: ['inspect', 'rank'],
};

export default async function run() {
  const reports = await pipeline(
    args.targets,
    (target, originalTarget, index) => agent(`Inspect ${target}`, {
      label: `inspect-${index}-${originalTarget}`,
      phase: 'inspect',
      schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          risks: { type: 'array', items: { type: 'string' } },
        },
        required: ['target', 'risks'],
        additionalProperties: false,
      },
    }),
    (report, originalTarget, index) =>
      agent(`Rank ${originalTarget}: ${JSON.stringify(report)}`, {
        label: `rank-${index}`,
        phase: 'rank',
      }),
  );
  log(`Processed ${reports.length} targets`);
  return reports;
}
```

`phase(title)` records the current phase. `log(message)` records a progress line.
Scripts cannot import modules or use host process, filesystem, network, or timer
APIs. `Date.now()`, `Math.random()`, and `new Date()` without arguments are also
unavailable so orchestration stays deterministic.

## References

| Task | Load when | Reference |
| --- | --- | --- |
| Code review run | Carrying a change review (pull/merge request, git range, or working-tree diff) as one workflow run: eligibility gate, multi-lens finders, confidence-scored verification, one synthesized report. | [Code review](references/code-review.md) |
| Orchestration and prompt patterns | Writing TeamMate prompts inside scripts, choosing `pipeline` versus `parallel`, and applying quality patterns: adversarial verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic. | [Orchestration patterns](references/orchestration-patterns.md) |
