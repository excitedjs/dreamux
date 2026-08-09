# Workflow ultracode dialect parity

- **Status:** Implemented historical proposal; current behavior is documented in
  [Dynamic Workflow usage](../../reference/dynamic-workflow-usage.md) and
  [Current architecture](../../reference/current-architecture.md)
- **Date:** 2026-08-08
- **Issue:** [#318](https://github.com/excitedjs/dreamux/issues/318)
- **Affects:** Dynamic Workflow script compilation, runner semantics,
  workflow-owned TeamMate prompts, run limits, tests, and model-facing
  workflow documentation

## Intent

Make Dreamux Dynamic Workflow execute the two ultracode-dialect acceptance
scripts attached to issue #318 without modifying those scripts.

This slice implements only requests 1-4 from the issue:

1. accept a top-level workflow body, object-form phases, and `whenToUse`;
2. pass `(previousResult, originalItem, index)` to every pipeline stage;
3. give schema-constrained workflow agents a runtime-enforced structured-output
   contract with native schema retry behavior;
4. raise the documented workflow limits to 16 concurrent agents, 1000 agent
   calls per run, and 4096 items per `parallel()` or `pipeline()` call.

The existing Dreamux module form and Dreamux-only `intent` and `identity` agent
options remain supported.

## Source facts

This section records the implementation baseline when the proposal was
approved. It is historical context, not current behavior.

The current runner evaluates user text directly as an ES module and requires a
default exported function. A top-level `return`, as used by both acceptance
scripts, is therefore a syntax error
([`runner.ts`](/packages/dreamux/src/service/workflow-service/runner.ts)).

The runner currently validates `meta.phases` as `string[]`, gives each pipeline
stage only the prior value, and places no per-call bound on `parallel()` or
`pipeline()`
([`runner.ts`](/packages/dreamux/src/service/workflow-service/runner.ts)).

`WorkflowRun` currently caps a run at 200 agent calls. `WorkflowService` defaults
and clamps `max_concurrency` to 8
([`run.ts`](/packages/dreamux/src/service/workflow-service/run.ts),
[`index.ts`](/packages/dreamux/src/service/workflow-service/index.ts)).

Workflow-owned TeamMates already pass `schema` through the neutral
`outputSchema` runtime contract. Codex applies it per turn; Claude Code applies
it when the fresh owned runtime is created. Providers already own native
schema enforcement. Dreamux currently parses a completed schema result once and
maps invalid JSON to `null`
([`owned-teammates.ts`](/packages/dreamux/src/service/teammate-collection/owned-teammates.ts),
[`agent-runtime.ts`](/packages/dreamux-types/src/agent-runtime.ts),
[`run.ts`](/packages/dreamux/src/service/workflow-service/run.ts)).

## Script compilation and entry contract

Workflow script normalization belongs to the workflow-service layer. The
durable run is created and its terminal route is registered before the child
starts, exactly as today. The child invokes the workflow-service normalizer
before it evaluates any user code. A syntax, entry-shape, or metadata error
therefore produces a durable failed run and terminal completion after
`workflow_run` has returned `{ run_id }`; it must not turn into a synchronous
MCP or admin rejection. Normalization must not be implemented as provider logic
or as prompt rewriting.

`script_hash` remains the SHA-256 of the original submitted or file-loaded
source, not the normalized module. Normalization is an execution detail and
does not change the durable record meaning.

The normalizer accepts both entry forms:

- the existing module form with `export const meta = ...` and
  `export default async function run() { ... }`;
- the ultracode form with `export const meta = ...` followed by a top-level
  script body that can use top-level `await` and `return`.

Entry-form selection is based only on the parsed presence of a default export:

- a module with a default export is legacy module form and is evaluated
  unchanged with the existing runtime metadata validation;
- a module without a default export is ultracode form. Its `meta` export stays
  at module scope, while all other top-level statements are source-range wrapped
  in a generated default async entry function.

The runner therefore executes one canonical default-entry shape without
changing legacy module semantics. Existing module-form top-level statements,
including their current success or failure behavior, are not reclassified as
an ambiguous mixed form.

Both forms preserve the runner's two-stage safety invariant. Module evaluation
can expose and evaluate metadata and define the canonical entry function, but
`agent`, `parallel`, and `pipeline` are installed only after metadata validation.
The ultracode body runs only when the validated entry function is invoked.

Normalization uses `acorn` as a direct production dependency of
`@excitedjs/dreamux`, with source ranges and parser options that accept
top-level `await` and `return`. It must not use regular expressions or delimiter
counting to find the metadata declaration or rewrite top-level returns. It must
not depend at runtime on TypeScript, Espree, a transitive parser, a test-only
compiler, or another development tool.

`meta` remains a required exported object. Ultracode-form metadata must be a
statically readable literal so it can stay outside the generated entry function
without executing the workflow body. Legacy module-form metadata keeps the
existing runtime evaluation and validation behavior. The accepted runtime
metadata shape is:

```ts
interface WorkflowScriptMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<
    | string
    | {
        title: string;
        detail?: string;
        model?: string;
      }
  >;
}
```

Final implementation review moved `WorkflowScriptMeta` to the private
`packages/dreamux/src/service/workflow-service/script-meta.ts` owner beside its
runtime validator. Metadata is child-local validation state rather than an IPC
message, so `protocol.ts` remains limited to parent/runner message contracts;
the normalizer and runner do not duplicate the metadata shape.

For ultracode form, `name`, `description`, `whenToUse`, phase `title`, phase
`detail`, and phase `model` values must be literal strings when present.
The whole initializer must be a recursively plain literal tree: object and
array literals containing string, number, boolean, or null literals, with
non-computed object keys and no methods, shorthand properties, or spreads.
Unknown metadata fields may remain forward-compatible when their values satisfy
the same literal-tree rule, but malformed known fields fail the run before an
agent starts. Legacy module form does not gain a new literal-only restriction.
Phase `model` is accepted as inert compatibility metadata; it does not select or
override an agent runtime.

`whenToUse`, object phase details, and object phase models are accepted and
validated for dialect compatibility only. This slice does not persist workflow
metadata on `WorkflowRunRecord` and does not project it through
`workflow_status` or `workflow_list`.

The top-level body supports ordinary module-scope declarations and helper
functions, top-level `await`, early `return`, and the existing workflow globals.
Imports and dynamic imports remain disabled. The deterministic intrinsic and
host-global restrictions remain unchanged.

Existing module-form scripts preserve their current behavior and validation
path.

In ultracode form, `export const meta = ...` is the only permitted import/export
declaration. Additional exports and all imports fail normalization rather than
being wrapped into an invalid function body.

## Runner API contract

`pipeline(items, ...stages)` invokes every stage as:

```js
stage(previousResult, originalItem, index)
```

For the first stage, `previousResult` and `originalItem` are the same input
item. `originalItem` remains unchanged for later stages, and `index` is the
zero-based position in the original `items` array.

Existing one-argument stage callbacks remain source-compatible because
JavaScript ignores unused arguments. Per-item failures still produce `null`
without discarding other items.

`parallel(thunks)` keeps its existing barrier and null-on-thunk-failure
semantics.

Both helpers reject inputs longer than 4096 before invoking any thunk or stage:

- `parallel()` reports that its maximum is 4096 functions;
- `pipeline()` reports that its maximum is 4096 items.

There is no silent truncation. The limit is per helper call, not cumulative
across a run.

## Schema output contract

Schema enforcement remains behind the existing provider-neutral
`outputSchema` capability. This change must not add model, effort, tool, or
provider-specific structured-output fields to `@excitedjs/dreamux-types`.

Every workflow-owned agent receives this workflow-role append instruction before
its first turn:

> You are executing one agent call inside a Dreamux workflow. Your final
> response is the return value consumed by the workflow, not a human-facing
> progress message. Return only the requested value. When an output schema is
> provided, use the runtime's structured-output mechanism and satisfy the
> schema exactly.

The workflow role instruction is supplied through a host-private, operation-
owned system-prompt-append capability on `SpawnOwnedTeamMateOptions`. The
capability is generic to exclusive owners rather than a workflow-specific
boolean, and it does not widen the public Agent Runtime ABI. `TeammateCollection`
combines append sources once at its existing entity-construction boundary in
this order:

1. operation-owned workflow role guidance;
2. caller-supplied TeamMate `identity` guidance.

The instruction is not persisted as TeamMate identity, is not concatenated into
the task prompt, and is rendered by each runtime adapter through its native
system-prompt mechanism.

The existing runtime-native schema mechanisms own model retry on schema
mismatch:

- Codex receives `outputSchema` on `turn/start`; its structured-output tool
  protocol can reject a mismatched tool payload and let the same native turn
  retry.
- Claude Code receives `--json-schema` for its fresh workflow-owned runtime;
  its `StructuredOutput` tool protocol can reject a mismatched payload and let
  the same native turn retry.

For both built-in runtimes, the observable contract is: a schema-invalid model
attempt is never settled to WorkflowRun as a successful result. The same native
turn may retry internally and eventually settle one schema-valid value, or the
native turn settles as failed after its own bounded policy. Dreamux does not
create another TeamMate, submit another model turn, prescribe a provider retry
count, or implement a second JSON-Schema validator. Native retry attempts count
as one workflow agent call and hold one concurrency slot until that turn
settles.

The existing neutral ABI uses an implicit validation claim: when
`outputSchema` was requested and the runtime settles that turn with
`status: 'completed'`, the runtime is claiming that its final text is the
schema-validated JSON value. A separate `structuredOutputValidated` flag is not
added to `TurnSettledSignal` or `CompletionEnvelope`; it would duplicate a fact
already required by `AgentRuntimeTextInput.outputSchema`. Both built-in adapters
must honor this claim: Claude Code must keep rejecting a completed turn without
native `structured_output`, and Codex must settle the JSON text returned by its
native `outputSchema` turn.

After a runtime reports successful structured output, Dreamux parses the final
text. Invalid JSON from a runtime that claimed successful schema completion is a
provider-contract violation. Dreamux marks that agent record `failed` and reuses
the existing `agent_result.error` IPC path. A directly awaited `agent()` then
rejects and can fail the run; inside `parallel()` or `pipeline()` the existing
helper containment converts that item failure to `null`. No new error DTO,
runner protocol branch, or unconditional run-abort path is added. An unsupported
`outputSchema` remains a structural fail-loud error.

## Limits

The workflow limits become:

- default `max_concurrency`: 16;
- maximum `max_concurrency`: 16;
- minimum `max_concurrency`: 1;
- lifetime agent-call limit per run: 1000;
- maximum inputs to one `parallel()` call: 4096;
- maximum inputs to one `pipeline()` call: 4096.

Workflow-service owns one private `max_concurrency` parser and the server-side
semaphore remains the execution authority. MCP imports the same owner constants
for its schema, while MCP, admin, and direct service calls all use the same
parser. Omitted values default to 16; non-integer or out-of-range values are
rejected before durable run creation rather than clamped. The parser and
constants are internal implementation capabilities, not public or barrel ABI.

The 1000-call limit counts calls accepted from the runner, including calls that
later fail or are stopped. A rejected 1001st call reports the explicit lifecycle
limit and does not spawn a TeamMate.

## Acceptance

- Both full scripts in the issue #318 acceptance comment execute unmodified.
- Top-level early returns, top-level helpers, loops, promise chaining, and
  repeated `phase()` calls in those scripts work.
- Existing default-export scripts continue to execute without source changes.
- `script_hash` remains the hash of the unmodified submitted source.
- Metadata accepts string phases and object phases, validates `whenToUse`, and
  rejects malformed known fields before any `agent()` call.
- A syntax, entry-shape, or metadata error still returns a run receipt and then
  persists and delivers a failed run; it does not synchronously reject
  `workflow_run`.
- `whenToUse`, phase detail, and phase model are not added to durable run state
  or status/list DTOs.
- Object phase `model` is accepted but never affects runtime selection.
- Pipeline tests prove the exact three arguments for the first and later stages,
  including stable original item and zero-based index.
- `parallel()` and `pipeline()` reject 4097 inputs before any work starts and
  accept 4096.
- Service tests prove the default and accepted upper concurrency are 16,
  invalid direct inputs are rejected before run creation, the lifetime call
  limit is 1000, and call 1001 is rejected.
- MCP schema and mapping tests prove `max_concurrency: 16` reaches the service.
  MCP and admin tests prove non-integer and out-of-range values use the same
  service-owned validation contract and are rejected before run creation.
- Workflow-owned TeamMate creation supplies the workflow-role system prompt and
  schema through separate neutral fields for both built-in runtime capability
  shapes.
- Built-in runtime contract tests prove the schema is applied through each
  native structured-output mechanism. WorkflowRun integration coverage proves
  one native turn submission settles one valid result or one failure while the
  run observes one agent call. Tests must not mirror an adapter's hidden native
  schema-retry state machine.
- Runtime tests prove the existing implicit validation claim: after
  `outputSchema` is requested, a completed built-in-runtime turn exposes the
  schema-validated value as JSON text; Claude Code still rejects a result that
  lacks native `structured_output`.
- Tests prove invalid JSON after a reported schema success fails loudly, while
  runtime-native schema handling does not create extra workflow agent calls or
  turns.
- Invalid successful schema text follows `agent_result.error`: a direct
  `agent()` rejects, while `parallel()` and `pipeline()` retain per-item `null`
  containment.
- The model-facing workflow skill and `.agents` usage reference document both
  entry forms, metadata, pipeline arguments, structured-output behavior, and
  all three limits.
- `.agents/reference/current-architecture.md` documents the operation-owned
  system-prompt source and the single `TeammateCollection` append-composition
  boundary instead of claiming that caller identity is its only prompt source.
- The dispatcher `dreamux-maintenance` skill routes Workflow run-state questions
  to its owning reference. That reference documents workflow `record.json` and
  `journal.jsonl` as fully server-owned state that must not be edited directly,
  including the current `max_concurrency` default and valid range.
- The two acceptance scripts are checked in as test fixtures or equivalent
  compile-and-run coverage so later dialect drift is detected without spending
  model tokens.
- Live smoke runs execute the two unmodified fixtures across the operator-
  selected runtime matrix. Because the fixtures intentionally omit
  `agentType`, each run uses its configured default runtime; mixing runtimes
  inside one unmodified run is not part of this contract. Arguments may
  deliberately bound rounds and source counts so the smoke proves dialect and
  runtime integration without paying for a maximal research run. Native schema
  rejection/retry is evidenced only here or by the runtime project's own
  contract tests when the adapter does not expose intermediate rejected
  attempts.
- Focused build, lint, typecheck, and workflow tests pass, followed by the
  repository validation required by the touched packages and `.agents`.
- A Rush change file records the user-visible `@excitedjs/dreamux` feature. Its
  comment starts with `BREAKING:` because a directly awaited schema call whose
  runtime reports completed non-JSON changes from returning `null` to rejecting;
  no `Rebuild:` note is needed because persisted state and config remain
  compatible.

## Out of scope

- Resume or cached-prefix execution.
- Nested workflows.
- A global token budget.
- Per-agent model or effort overrides.
- Worktree isolation.
- New script persistence behavior beyond the existing `scriptPath` input.
- Changes to `script` versus `scriptPath` precedence.
- Mapping `meta.phases[].model` to any runtime setting.
- A public workflow metadata registry or workflow-list redesign.
- Any widening of the public Agent Runtime ABI for workflow-specific policy.
