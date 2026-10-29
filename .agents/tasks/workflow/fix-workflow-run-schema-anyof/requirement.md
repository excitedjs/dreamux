# Requirement

## Current alignment

- Status: Final.
- Confirmed current behavior and evidence:
  - `workflow-service/mcp.ts` builds the `workflow_run` descriptor with
    `inputConstraints: { anyOf: [{ required: ['script'] }, { required:
    ['scriptPath'] }] }`, and `tool-metadata.ts` spreads those constraints at
    the top level of the tool's `inputSchema`. It is the only tool in the
    repository whose advertised input schema carries a top-level combinator.
  - The Anthropic API rejects tool input schemas with a top-level `anyOf`.
    Claude Code (observed on 2.1.303) logs
    `Skipping tool "workflow_run": its input schema uses top-level anyOf` at
    every startup and drops the tool from its catalog, so every Claude
    runtime acting as Dispatcher Agent or TeamLeader loses `workflow_run`
    entirely. Other runtimes (for example Codex) are unaffected.
  - The constraint was introduced by #453 (`75fc1ca0`).
  - Server-side authority already exists: `resolveWorkflowScript` in
    `workflow-service/index.ts` raises `RuleViolation` when neither `script`
    nor `scriptPath` is provided, and `workflowRunInput` in `requests.ts`
    reads both as optional non-blank strings. Invalid input is rejected at
    call time regardless of the schema.
- Desired outcome: `workflow_run` is visible and callable again from
  Anthropic-compatible clients, while the at-least-one `script`/`scriptPath`
  requirement is still communicated to the model and still enforced by the
  server.
- Desired behavior:
  - The advertised `workflow_run` input schema is a plain closed object
    schema with no top-level `anyOf`/`oneOf`/`allOf`.
  - The tool description states that one of `script` and `scriptPath` is
    required; supplying both stays legal (server prefers `script`),
    supplying neither is rejected.
  - A call supplying neither keeps failing with the existing
    `RuleViolation`; calls supplying either keep working unchanged.

## Scope

- In scope:
  - `packages/dreamux/src/service/workflow-service/mcp.ts`: remove the
    `inputConstraints` option from the `workflow_run` descriptor and put the
    one-of requirement into its description text.
  - A regression test asserting the advertised `workflow_run` input schema
    has no top-level schema combinators, so the failure mode cannot return
    unnoticed.
- Out of scope:
  - Any change to `tool-metadata.ts` / the generic `inputConstraints`
    mechanism. The `mcp-delegate-catalog.test.ts` coverage for it stays;
    it is an available generic utility and nothing else uses it today.
  - Server-side validation, request readers, workflow execution semantics,
    other tools.
  - Client-side workarounds in any runtime package.

## Non-goals

- Redesigning how Dreamux expresses cross-field constraints to models.
- Changing the `workflow_run` call contract or its server-side error shape.

## Constraints and invariants

- No persisted state, config shape, CLI surface, or protocol contract change.
- Server remains the enforcement authority for the one-of rule; description
  text is guidance, not enforcement.
- Public-repository safeguards: no internal identifiers in repo content.

## Acceptance criteria

1. The `workflow_run` descriptor advertised over MCP has a top-level
   `inputSchema` without `anyOf`/`oneOf`/`allOf`, and is otherwise unchanged
   (properties, required set, output schema, annotations).
2. Its description tells the model that exactly one of `script` and
   `scriptPath` is required.
3. A new test fails on the pre-fix descriptor and passes after it.
4. Existing tests for generic `inputConstraints` merging remain intact.
5. `rush build`, `rush lint`, `rush test`, and `rush typecheck:tests` pass.

## Decisions and unknowns

- Confirmed operator decisions:
  - Task recorded under the Workflow domain.
  - Minimal-change fast path; one independent review seat (external Devbox
    review permitted per the channel's dev-workflow ruling).
  - Keep the generic `inputConstraints` utility and its test.
- Assumptions: none.
- Blocking unknowns: none.
