# Workflow Top-Level Scripts And JSON Args

- **Status:** Proposed
- **Date:** 2026-08-11
- **Affects:** Dynamic Workflow script dialect, `workflow_run` MCP schema,
  Workflow runner/compiler, bundled workflow skill, current Workflow references

## Intent

Make Dreamux Dynamic Workflow use one script dialect aligned with the native
Claude Code Workflow contract:

- one literal `export const meta = ...` declaration at the start;
- the executable Workflow body directly at top level;
- top-level `await` and `return`;
- `workflow_run.args` supplied as a structured JSON value and exposed unchanged
  as the script-global JavaScript value.

The feature is pre-adoption. This is a deliberate breaking cutover with no
compatibility path for default-export entry functions or JSON-encoded object
arguments.

## Observed Failure

The current MCP schema advertises `args` with an empty schema. The active
tool-projection layer consequently exposed it as a string, so a call carrying:

```json
{"question":"..."}
```

reached the script as the JSON text instead of an object. A native-form script
using `args.question` therefore returned its missing-argument error before
starting any agent.

The service, admin, runner IPC, and VM context already pass their received value
unchanged. The defect is the underspecified MCP argument schema, not JSON
serialization inside Workflow service.

## Script Contract

### One user-visible entry form

A Workflow script must have this shape:

```js
export const meta = {
  name: 'review-and-summarize',
  description: 'Review known areas and combine the findings',
  whenToUse: 'Use when review targets are known before execution.',
  phases: [
    { title: 'review', detail: 'Independent review passes' },
    { title: 'summary', detail: 'One synthesized result' },
  ],
};

phase('review');
const reviews = await parallel([
  () => agent('Review the API.', { phase: 'review' }),
  () => agent('Review the lifecycle.', { phase: 'review' }),
]);

phase('summary');
return agent(`Summarize:\n${JSON.stringify(reviews)}`, {
  phase: 'summary',
});
```

The first parsed statement must be exactly one `export const meta = <literal>`
declaration. Comments and whitespace may precede it. Imports and every other
export form fail loudly, including:

- `export default ...`;
- `export { value as default }`;
- any additional named export;
- `export *`;
- static imports.

The executable body is every statement after `meta`. It runs in an async
context and supports top-level `await`, early `return`, helper functions, loops,
and promise chaining. The returned value is the Workflow result.

There is no user-authored or model-visible `run()` entry function and no
default-export execution path.

### Metadata

`meta` is a recursively plain literal object:

- required string `name`;
- required string `description`;
- optional string `whenToUse`;
- optional `phases`, containing only objects shaped as
  `{ title, detail?, model? }`.

`title` is required and the other known fields are optional strings. `model`
remains documentary metadata and does not select an Agent Runtime. String phase
entries are removed so the public dialect matches the native object form.

The compiler materializes the literal metadata directly from the parsed AST and
validates it before Workflow primitives are installed. Invalid metadata,
imports, or exports cannot start agents.

## Runner Design

The existing compatibility normalizer becomes a single-dialect compiler:

1. Parse with Acorn using module syntax plus allowed top-level `await` and
   `return`.
2. Require the first statement to be the sole literal `meta` export.
3. Reject imports and every other export.
4. Materialize and validate metadata before exposing `agent`, `parallel`,
   `pipeline`, `phase`, or `log`.
5. Execute the remaining source inside one private async VM closure and await
   its value.

The private closure is an implementation detail required to give top-level
`return` its native script semantics. It is not an ES module export, is not
visible to script authors, and is not an alternate entry form.

The submitted source and `script_hash` remain unchanged. The compiler does not
rewrite the persisted source or add a default export.

## Args Contract

`workflow_run.args` is optional. When present it is a direct JSON value:

- object;
- array;
- string;
- finite number;
- boolean;
- `null`.

The MCP tool schema explicitly describes these JSON types instead of using an
untyped empty schema. Its description tells callers to pass objects and arrays
directly and not to apply `JSON.stringify`.

The MCP, admin, service, runner IPC, and VM context preserve the value. An
object arrives as a JavaScript object, an array as a JavaScript array, and an
omitted argument as `undefined`. Dreamux does not parse JSON-looking strings;
such a string remains a string.

Direct service input is validated as JSON-compatible before durable run
creation so non-finite numbers, unsupported JavaScript values, cycles, or
non-plain objects fail synchronously without creating a run.

## Failure Semantics

The dialect and args cutover does not change helper failure behavior:

- an ordinary failed `agent()` resolves `null`;
- `parallel()` and `pipeline()` contain item failures as positional `null`;
- unsupported structured output or a runtime-reported successful schema result
  containing empty/invalid JSON rejects the direct `agent()` call;
- helper limits, bad argument types, invalid script syntax/dialect, and invalid
  metadata fail loudly.

The structured-output rejection behavior is an explicit retained Dreamux
deviation from native Claude Code Workflow. Dreamux delegates structured output
to provider runtimes and cannot assume native same-turn validation/retry. This
change does not combine the entry/args cutover with a provider failure-semantics
redesign.

## Delete List

- The default-export detection and byte-for-byte legacy-module pass-through.
- The module-form runner lookup/invocation of `namespace.default`.
- All model-facing examples and guidance using
  `export default async function run()`.
- Tests whose purpose is preserving default-export or named-default entry
  compatibility.
- Current KB claims that two Workflow entry forms are supported.
- String-form `meta.phases` examples, validation, and tests.

Acorn remains the syntax-aware owner for literal metadata validation, import /
export rejection, and source-range extraction.

## Acceptance

- `workflow_run` tool metadata exposes `args` as a structured JSON-value union,
  with direct object/array guidance.
- MCP mapping proves nested object and array arguments reach
  `workflow.run` unchanged.
- Admin and direct Workflow service tests prove object/array values reach the
  runner unchanged.
- Runner tests prove `args.question`, array iteration, `null`, primitives, and
  omitted args have their direct JavaScript meanings.
- JSON-looking strings remain strings; no compatibility `JSON.parse` path is
  added.
- Direct service calls reject non-JSON-compatible args before durable run
  creation.
- The two checked-in native acceptance fixtures and the shared
  `deep-research.mjs` shape execute as top-level scripts without source
  modification.
- Top-level `await`, early `return`, helpers, loops, promise chaining, repeated
  `phase()`, deterministic-intrinsic failures, abort, and forced-stop behavior
  remain covered.
- Default exports, named default exports, other named exports, export-all,
  imports, pre-meta executable statements, non-literal metadata, and string
  phase entries fail before any agent starts.
- The runner no longer reads or invokes `module.namespace.default`.
- The compiler generates no ES module entry export.
- Current skill and KB docs describe only the top-level dialect and structured
  JSON args. Historical two-dialect rationale remains under `.agents/archive/`
  and is not presented as current behavior.
- The dispatcher maintenance Workflow state guidance remains accurate; no
  persisted state or config schema changes.
- Focused runner, MCP, admin, service, skill, build, source/test typecheck, lint,
  full test, Rush change, KB, diff, and public secret gates pass.
- A breaking `@excitedjs/dreamux` Rush change leads with `BREAKING:`, tells
  operators to remove default-export entry functions and pass object/array args
  directly, and explicitly says no rebuild is required.

## Out Of Scope

- Changing structured-output failure/retry semantics.
- Adding `model`, `effort`, `isolation`, budgets, nested workflows, or resume.
- Persisting args or compiled script bodies beyond the existing live runner IPC.
- Changing `script` / `scriptPath` precedence or the submitted `script_hash`.
- Adding TypeScript syntax, imports, filesystem access, Node APIs, or
  nondeterministic time/random APIs.
