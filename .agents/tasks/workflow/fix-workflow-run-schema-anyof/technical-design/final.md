# Final solution — fast path

## Change

One descriptor in
`packages/dreamux/src/service/workflow-service/mcp.ts`:

- Drop the `inputConstraints: { anyOf: ... }` option from the
  `workflow_run` `tool(...)` call.
- State the cross-field rule in the tool description text: one of
  `script` / `scriptPath` is required and supplying neither is rejected.
  Supplying both was always accepted (the server prefers `script`), so the
  wording must not claim an exclusive one-of that the server does not
  enforce. Keep the existing sentence structure; both property descriptions
  already say what each one is.

Nothing else changes: properties, `required: []`, output schema,
annotations, handlers, and server-side `resolveWorkflowScript` validation
stay as they are. Enforcement remains server-side (`RuleViolation`), which
is unchanged behavior for callers.

## Why this shape

- The schema combinator is the only fact Anthropic rejects; description text
  carries the same guidance through every client.
- Removing `inputConstraints` here does not remove the generic utility in
  `tool-metadata.ts`: it stays available and its unit test stays. Future
  tools that do not cross the Anthropic boundary could still use it; today
  none do.
- Considered and rejected: making `validateMcpJsonSchema` reject top-level
  combinators for every catalog delegate. That is a runtime contract change
  for external channel delegates too, beyond this repair's boundary. The
  static regression test below captures the interop rule where the
  descriptors are authored.

## Regression test

Extend `packages/dreamux/tests/mcp-tool-descriptions.test.ts` (the test that
already walks every advertised tool in both built catalogs) with one
assertion: no tool's top-level `inputSchema` may carry `anyOf`, `oneOf`, or
`allOf`. A catalog-wide rule rather than a `workflow_run`-special case:
the Anthropic constraint attaches to every tool, and this is the form that
would have failed CI on #453.

## Verification

- `node common/scripts/install-run-rush.js build`
- `node common/scripts/install-run-rush.js lint`
- `node common/scripts/install-run-rush.js test`
- `node common/scripts/install-run-rush.js typecheck:tests`
- Confirm by inspection that the advertised descriptor's `inputSchema` is
  the plain closed object schema and its description carries the
  exactly-one-of rule.

## Out of boundary

- No source change outside `workflow-service/mcp.ts` and the one test file.
- Add one `rush change` file for `@excitedjs/dreamux`, type `patch`, a plain
  bug-fix note (the tool is restored to Anthropic-compatible clients). No
  `BREAKING:` / `Rebuild:`: nothing persisted or on disk is affected, and
  the advertised contract callers use stays the same.
