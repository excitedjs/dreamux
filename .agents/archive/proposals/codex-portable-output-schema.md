# Codex portable output schema adapter

- **Status:** Implemented historical proposal; current behavior is documented in
  [Provider Runtime](../../domains/provider-runtime.md#codex-portable-output-schema)
  and the
  [Codex package README](../../../packages/agent-runtime/codex/README.md#portable-structured-output)
- **Date:** 2026-08-09
- **Affects:** `@excitedjs/agent-runtime-codex`, Workflow schema portability,
  Codex `turn/start.outputSchema`, runtime contract tests

## Intent

Allow provider-neutral Workflow JSON Schemas with ordinary optional object
properties to run through Codex strict structured output without requiring
script authors to rewrite every optional field as required.

The fix belongs to `@excitedjs/agent-runtime-codex`. Dreamux core continues to
pass the neutral `outputSchema` unchanged and trust a runtime's completed
structured-output claim.

## Observed failure

A live `codex-medium` Workflow accepted a strict scoping schema, then rejected
all four search turns before model execution:

```text
400 invalid_json_schema:
properties.sources.items.required must include every property;
missing "why"
```

OpenAI strict structured output requires every declared object property to
appear in `required`. The neutral Workflow schema intentionally allowed `why`
to be absent. Manually adding `why` and the later `quote` field to `required`
made the same top-level ultracode Workflow complete 48/48 Codex turns with
`max_concurrency: 8`.

## Ownership and boundaries

- `@excitedjs/agent-runtime-codex` owns the Codex-specific schema compiler and
  result restoration.
- `@excitedjs/dreamux-types` keeps the existing provider-neutral
  `AgentRuntimeTextInput.outputSchema` ABI.
- Dreamux Workflow core does not gain a Codex schema validator, retry loop, or
  provider-specific branch.
- Other runtimes receive the original schema unchanged.
- Codex app-server remains the owner of native constrained decoding and
  schema-mismatch retry after it accepts the compiled strict schema.

## Compilation contract

Before `turn/start`, the Codex adapter compiles the neutral schema into the
strict subset accepted by Codex:

1. Require one closed root object schema, then recursively validate and clone
   its supported object, array, and primitive child schemas.
2. Every object must be closed with `additionalProperties: false`. An open
   object cannot be made strict without changing its accepted values and is
   rejected locally.
3. Every property is added to the wire `required` array.
4. A property that was optional in the neutral schema is made nullable in the
   wire schema. Its existing type is extended with `"null"`; an enum also gains
   `null`.
5. Required properties retain their original type and constraints.
6. Nested objects and array items follow the same rules.

The first implementation supports the schema vocabulary already used by
Dreamux Workflow examples and fixtures and accepted by the Codex strict
structured-output surface:

- a root with `type: "object"`, an object-valued `properties`, and
  `additionalProperties: false`;
- `type` with one supported JSON primitive/object/array type; or exactly two
  distinct members where one is `"null"` and the other is one supported type;
- `description`;
- `properties`, `required`, `additionalProperties: false`;
- one schema-valued `items`;
- primitive-value `enum`;
- numeric `minimum` and `maximum`, which the current Codex app-server live
  boundary accepts and existing Workflow score schemas use.

Unsupported or ambiguous shapes fail locally before `turn/start`, including:

- open objects or schema-valued `additionalProperties`;
- root nullable, array, or primitive schemas;
- optional properties whose original schema already accepts `null`, because
  `null` cannot distinguish "absent" from an explicit value during restoration;
- missing/ambiguous property types and every non-null type union;
- tuple arrays;
- `$ref`, `$defs`, `definitions`, `allOf`, `anyOf`, `oneOf`, `not`,
  conditionals, unsupported string/number/array bound keywords, and other
  unimplemented keywords.

The error identifies the schema path and unsupported reason. The adapter does
not silently drop constraints or pass a known-incompatible schema to Codex.
Schema compilation and active-slot compatibility rejection return a structural
`UnsupportedAgentRuntimeFeatureError` with `feature: 'outputSchema'`. This
reuses the neutral unsupported-capability path: a directly awaited Workflow
`agent()` rejects, while helper containment remains explicit at the script
layer.

## Result restoration

The compiler returns one private per-turn codec:

- `wireSchema`: the strict schema sent to Codex;
- `fingerprint`: a canonical structural identity covering both the wire schema
  and the restoration plan;
- `restore(text)`: parse the schema-validated JSON text, recursively remove
  `null` placeholders only for properties that were optional and non-nullable
  in the neutral schema, and serialize the restored value.

Required fields and originally nullable fields are never stripped.

The codec is first owned by the claimed `ActiveTurnSlot`. After Codex accepts
`turn/start`, `activateTurnSlot()` binds that slot and codec to the exact native
`turnId` returned by Codex. `trackTurn()` captures that turn id plus codec;
restoration runs only when the collected turn carries the same id.

For structured turns, restoration runs before `onTurnCompleted` is called.
`CodexRuntime.recordCollectedTurn()` therefore sees only restored text. It
updates `lastResult` and publishes the completed `onTurnSettled` signal only
after restoration succeeds.

Parsing or restoration failure:

- does not call `onTurnCompleted`;
- does not change `lastResult`;
- emits one `onTurnSettled` signal with `status: 'failed'`, `text: null`, and
  the restoration error;
- releases the existing slot/pending-turn state through the same terminal path
  as another collected-turn failure.

This is an ordinary runtime turn failure, not an unsupported-capability error.
The current teammate completion envelope intentionally does not project runtime
errors, so Workflow observes its existing ordinary failed-turn result (`null`,
including helper containment). This slice does not widen the neutral completion
ABI solely to turn post-execution restoration failure into a direct
`agent()` rejection.

The codec is in-memory execution state only. It is never persisted.

## Codec lifecycle

- Compilation or compatibility-check failure happens before
  `pendingSubmissions` is incremented and before `turn/start`.
- If `turn/start` submission fails, the submission owns no native turn. Its
  candidate codec is discarded immediately. If it was the primary submission
  and no compatible candidate turn can activate the shared slot, the slot codec
  is discarded when `recordTurnStartFailure()` releases that slot.
- `stop()` settles pending native turns as stopped and clears their slots/codecs.
  A late completion is dropped by the existing pending-turn mutual-exclusion
  guard; restoration is not attempted and the turn is not settled twice.
- Runtime teardown/restart discards all in-memory codecs together with the old
  `TurnManager`. Interrupted turns settle stopped through the existing teardown
  path. A new process never restores a result from the old client.

## Active-turn folding

Codex may fold concurrent `turn/start` submissions into one active turn. One
native final result cannot satisfy multiple distinct output schemas.

- The primary submission that claims a fresh slot stores its codec on the slot.
- A follower compiles a candidate codec only to validate its schema and compare
  compatibility. The slot's primary codec remains authoritative and the
  follower candidate is discarded after the check.
- While that slot is active, another structured input is accepted only when
  its codec fingerprint is identical to the slot fingerprint. Comparing only
  the wire schema is insufficient: an optional non-nullable string and a
  required nullable string can compile to the same wire schema but require
  different restoration.
- A structured input cannot join an active unstructured slot, and an
  unstructured input cannot join an active structured slot.
- Incompatible folding fails locally before incrementing `pendingSubmissions`,
  before awaiting the shared `turnIdPromise`, and before another `turn/start`.

Compatible submissions receive the same accepted native turn-id receipt through
the existing shared slot. Restoration runs exactly once on the single collected
native result before the existing single `onTurnCompleted` / `onTurnSettled`
publication. Workflow-owned TeamMates normally submit one turn, but this rule
keeps the general runtime contract deterministic.

## Acceptance

- The live failure schema with optional `why` and nested optional `quote`
  compiles to a Codex strict schema whose object `required` arrays include all
  properties.
- A Codex result containing `why: null` / `quote: null` is restored to the
  neutral result with those keys absent.
- Optional nested objects and array-item objects restore recursively.
- Required nullable fields remain present as `null`.
- A non-null type union fails before `turn/start` with its schema path.
- A non-object root fails before `turn/start` with the root schema path.
- Open objects, optional-nullable fields, tuple arrays, unsupported composition
  keywords, and unknown schema keywords fail before `turn/start` with a path.
- Existing already-strict schemas are passed as equivalent clones and their
  results are unchanged.
- Plain text turns remain unchanged.
- A `turn/start` submission failure leaves no codec that can affect a later
  turn.
- Stop/restart discards codecs and never restores or double-settles a late
  completion.
- Restoration precedes `lastResult` mutation and completed settlement; a
  restoration failure preserves the prior last result and settles failed.
- Compatible active-turn folding (same wire schema and restoration plan)
  restores and settles once; incompatible structured folding submits no second
  `turn/start`.
- Codex adapter tests cover compiler, restoration, submission, settlement,
  dedupe/stop behavior, and failure containment without weakening existing
  lifecycle assertions.
- The opt-in live Codex model gate submits the optional-field schema through the
  real Codex app-server and covers the compiled nullable wire form, enum, and
  numeric `minimum` / `maximum`; missing Codex still follows the repository's
  fail-loud rule.
- `@excitedjs/agent-runtime-codex` receives a patch Rush change and its README
  documents the supported portable subset and fail-loud boundary.
- `.agents/domains/provider-runtime.md` is the single current KB owner for the
  Codex schema compilation/restoration/folding contract. Other current docs
  link to that owner rather than duplicating the subset.

## Out of scope

- Changing OpenAI/Codex's strict JSON Schema subset.
- Adding a generic JSON Schema compiler to Dreamux core or
  `@excitedjs/dreamux-types`.
- Emulating model retry in Dreamux.
- Changing another provider's structured-output behavior.
- Supporting every JSON Schema draft keyword in this slice.
