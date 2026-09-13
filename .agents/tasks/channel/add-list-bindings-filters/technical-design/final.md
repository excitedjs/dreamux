# Final Solution — minimal-change fast path

Operator decision, 2026-09-13 (question card): minimal-change fast path. No
solution-review seats and no public solution-review Issue.

## Shape

The four parameters are equality filters over the rows `list_bindings` already
returns, so they live where the tool contract lives:
`packages/channel/feishu-channel/src/tools/routing-tools.ts`. The handler keeps
asking `ctx.session.listBindings()` for the table and filters the
`FeishuBindingView` rows it gets back.

`FeishuRouting.listBindings(query)` was considered and rejected. The view rows
are already snake_case tool vocabulary; pushing the query down would add a
second camelCase query type plus a translation between them, and buy nothing
while `space_name` stays out of scope. Routing keeps answering "where does a
message go"; the tool keeps answering "what does the table say".

## Change list

1. `src/tools/schema.ts` — add `optionalLiteral(obj, key, allowed)`, the enum
   counterpart of the existing `optionalString`. A value outside `allowed`
   raises `PublicInvokeFailure` naming the accepted values, like every other
   validator in that file.
2. `src/tools/routing-tools.ts`
   - `QUERYABLE_TARGET_KINDS = ['group', 'topic'] as const`. `p2p` is not
     offered because a direct chat cannot be bound to a Team; the two paths that
     install a binding keep that rule, in `selectorTarget` and in
     `FeishuRouting.plan`.
   - `listBindingsDef.inputSchema` gains four optional properties —
     `team_name`, `chat_id`, `thread_id` (non-empty strings) and `target_kind`
     (enum) — and still requires none.
   - `parse` reads them with `optionalString` / `optionalLiteral` into a
     `ListBindingsQuery` whose absent members are `null`.
   - `handle` filters rows with one predicate: each non-null member must equal
     its row field. No member supplied means today's whole table.
   - The description states that filters are optional, combine with AND, and
     that no argument returns everything.
3. `tests/feishu-routing-tools.test.ts` — a `list_bindings` block over a
   four-row fixture (a chat's own row plus two topic rows under it, and a
   second chat's row, across two Teams).

Nothing else changes: no session-seam signature, no routing service, no
persisted document, no other tool, no TeamLeader-facing surface.

## Verification

- Unit tests covering every acceptance criterion in the requirement: no-argument
  parity, each filter alone, an AND combination, an empty match, and a rejected
  `target_kind`.
- `node common/scripts/install-run-rush.js build`, `lint`, `test`, and
  `typecheck:tests` all green.
- A Rush change file for `@excitedjs/feishu-channel`, type `minor`, as an
  ordinary change note: this is an additive MCP tool-contract change, it blocks
  no upgrade, and it reads every existing routing document unchanged, so no
  `BREAKING:` and no `Rebuild:`.

## Knowledge closeout

Check and update only what states this tool's contract: `.agents/domains/channel.md`,
`packages/dreamux/README.md`, and `.agents/domains/dispatcher-skill.md`. The
`dreamux-maintenance` skill documents the routing document's shape and ownership,
which this change does not touch.
