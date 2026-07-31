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
- `workflow_stop` stops a running `run_id`. In-flight agent turns settle before
  the stopped terminal completion is delivered.

Use `workflow_status` for an explicit progress check or recovery, not as a polling
loop. After a run, use a recorded concrete TeamMate name with `send` when a result
needs an interactive follow-up.

## Script Entry

Provide one module with literal metadata and a default async entry function:

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

## Script API

`agent(prompt, opts?)` starts a fresh TeamMate and waits for its settled turn.
Options are:

- `label` and `phase` for readable progress;
- `agentType` for an agent-runtime id from `get_capabilities`;
- `intent` and `identity` for the TeamMate's task and persona;
- `schema` for a JSON Schema object handled by the selected runtime.

Without `schema`, `agent()` returns final text or `null` when that call fails. With
`schema`, it returns the parsed JSON value or `null` when the runtime result is not
valid JSON. A runtime that cannot provide structured output rejects that
`agent()` call.

`parallel(thunks)` starts its thunk functions together and waits at one barrier.
A failed thunk contributes `null` without discarding the other results.

`pipeline(items, ...stages)` processes each item through its stages in order while
different items can advance independently. Use it when every item needs the same
multi-step treatment:

```js
export const meta = {
  name: 'inspect-and-rank',
  description: 'Inspect each target, then rank the reports',
  phases: ['inspect', 'rank'],
};

export default async function run() {
  const reports = await pipeline(
    args.targets,
    (target) => agent(`Inspect ${target}`, {
      label: `inspect-${target}`,
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
    (report) => agent(`Rank this report: ${JSON.stringify(report)}`, {
      label: 'rank',
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
