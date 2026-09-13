# Requirement

## Initial request

Operator, 2026-09-13: "帮我给 feishu channel 的 list binding 增加几个查询参数，看下
可以扩展哪些查询参数用来精确查询某些绑定关系"

The TeamLeader answered with a survey of every query dimension the current
`FeishuBindingView` fields make expressible. The operator then chose:
"就把值得加的那几个加上吧" — the four parameters the survey listed under
"值得加": `team_name`, `chat_id`, `thread_id`, `target_kind`.

## Confirmed current behavior

- `list_bindings` is advertised with `inputSchema: closedObjectSchema({})` —
  no arguments at all — and its handler returns `channel_id` plus every row of
  `FeishuRouting.listBindings()`
  (`packages/channel/feishu-channel/src/tools/routing-tools.ts`).
- It is a Dispatcher-only definition; a TeamLeader is never offered it.
- A row is a `FeishuBindingView`: `target_kind`, `chat_id`, `thread_id`,
  `display`, `team_name`, `origin`, `space_name`, `created_at`, `updated_at`
  (`packages/channel/feishu-channel/src/routing/index.ts`).
- A direct chat cannot be bound to a Team (`isBindableTarget`,
  `packages/channel/feishu-channel/src/routing/target.ts`), and both paths that
  install a binding keep that rule. The bind tool definitions build their target
  through `selectorTarget`, which maps a selector without `thread_id` to `group`
  and one with it to `topic` and can spell nothing else
  (`packages/channel/feishu-channel/src/feishu-session-bindings.ts`). Automatic
  provisioning passes an inbound target straight through
  (`packages/channel/feishu-channel/src/feishu-provisioning.ts`), but it is
  reached only from `FeishuRouting.plan`, which answers `dispatcher` for a
  direct chat before a provision plan exists
  (`packages/channel/feishu-channel/src/routing/index.ts`).
  `FeishuTargetRecord.kind` still types `p2p`, so this is a rule both writers
  keep rather than a shape the document enforces.
- Collaboration-space provisioning installs one binding per provisioned topic,
  so the table grows with the number of topics a space has answered in. A
  question about one Team, one chat, or one topic is answered today by reading
  the whole table.

## Desired behavior

`list_bindings` accepts four optional query parameters and returns only the
rows that match all of the ones supplied:

| Parameter | Matches | Question it answers |
| --- | --- | --- |
| `team_name` | `FeishuBindingView.team_name` | Which conversations does this Team answer in? |
| `chat_id` | `FeishuBindingView.chat_id` | What is bound in this chat — the chat row and every topic row under it? |
| `thread_id` | `FeishuBindingView.thread_id` | Which Team answers in exactly this topic row? |
| `target_kind` | `FeishuBindingView.target_kind` | Whole-chat rows only, or topic rows only? |

Agreed conventions, proposed to and accepted by the operator with the parameter
list:

- every parameter is optional and matched by exact equality;
- supplied parameters combine with AND;
- no cross-field validation — `thread_id` alone is a legitimate query;
- an empty result is a normal answer, never an error;
- the output shape is unchanged, and `{}` still returns the whole table;
- `target_kind` accepts `group` or `topic` only. `p2p` is not offered because
  a direct chat cannot be bound to a Team.

`target_kind` earns its place because exact equality on `thread_id` cannot
express "`thread_id` is null": without it, "only the whole-chat bindings" is
unreachable.

## Scope

- `list_bindings`' input schema, argument parsing, and result filtering in the
  Feishu channel package, plus its tool description and unit tests.

## Non-goals

Declined by the operator when he chose "值得加的那几个":

- an `origin` (`manual`/`space`) filter;
- a `space_name` filter, and any consequent reduction of
  `get_collaboration_space`'s `targets` array;
- resolving which Team *effectively* answers in a topic (the
  `resolutionChain` parent-chat fallback). This is route resolution rather
  than a table read, and would be a separate tool if it is ever wanted;
- pagination or a result cap;
- fuzzy or substring matching on `display`.

Out of scope and deliberately untouched:

- the unreachable `isBindableTarget` guard inside
  `FeishuBindingOperations.bindChannel`. `selectorTarget` cannot produce a
  `p2p` target, so that refusal cannot fire, and the reachable enforcement of
  the same rule already sits in `FeishuRouting.plan`, which is what keeps an
  inbound direct chat out of provisioning. Recorded here as a cleanup trail;
  removing it is a separate decision.
- `FeishuRouting.listBindings()` and its in-process callers
  (`get_collaboration_space`, the running-teams card).

## Constraints and invariants

- The tool stays Dispatcher-only; no TeamLeader-facing counterpart appears.
- No persisted state, routing behavior, or binding document shape changes.
- A rejected argument raises `PublicInvokeFailure`, so the model reads the
  sentence and can correct its next attempt.

## Acceptance criteria

1. `list_bindings` with no arguments returns exactly what it returns today.
2. `team_name` returns only that Team's rows; a Team with no rows returns an
   empty array and no error.
3. `chat_id` returns that chat's own row together with every topic row under
   it, and nothing from another chat.
4. `thread_id` returns only the row for that topic.
5. `target_kind: 'group'` returns only rows whose `thread_id` is null;
   `target_kind: 'topic'` returns only rows that have one.
6. Two or more parameters intersect; a combination that matches nothing
   returns an empty array.
7. A `target_kind` outside `group`/`topic` is rejected with a public failure
   sentence naming the accepted values.
8. The advertised input schema lists exactly these four optional properties
   and requires none of them.
9. A filtered call placed through the registered Dispatcher catalog returns the
   narrowed rows, so the schema that is advertised is the one that runs.

## Decisions and unknowns

- Operator decision, 2026-09-13: "就把值得加的那几个加上吧" — the four
  parameters above, and none of the declined dimensions.
- Operator decision, 2026-09-13: new task rather than an extension of an
  existing channel lineage (question card).
- Operator decision, 2026-09-13: minimal-change fast path for the technical
  solution (question card), after the TeamLeader stated that the change edits
  an MCP tool contract and is therefore not fast-path eligible by the skill's
  own criteria.
- Blocking unknowns: none.
