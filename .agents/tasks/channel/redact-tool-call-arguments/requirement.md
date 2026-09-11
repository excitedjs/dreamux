# Requirement

## Initial request

- Optimize Dreamux Core's redaction of live runtime Activity. The operator's
  opening framing was a library survey: 「优化一下 dreamux 内部的 Activity脱敏逻辑。
  不再自己手写了，看看有没有什么开源库可以直接拿来用。」 That survey returned a
  negative result (see *Rejected direction* below) and the operator redirected to
  the real target: 「不是仓库的脱敏，是 dreamux core 对 模型实时输出的 toolcall 之类的
  脱敏」.

## Confirmed current behavior

Verified against current source, not from description.

`createConversationProjection` in
`packages/dreamux/src/channel/conversation-projection.ts` is the single place
Core redacts live runtime Activity. The feed is
`runtime-owner.ts` `generationActivitySink` → `projectActivity` →
`projectedActivity`. Every other redaction in the repository is key-name based
and does not touch Activity: `platform/logger.ts`, the Feishu transport's
`diagnostics.ts`, and `config/config-helpers.ts`.

Inside `projectedActivity`'s `tool.call` branch, three members pass
`redactText` — `summary`, `items`, `result_json` — and two do not:
`invocation` is copied verbatim and `arguments_json` is only serialized. The
two exempt members also do not contribute to the event's `redacted` flag.

Consequence: a secret inside a command or its arguments reaches the chat
surface verbatim. `packages/dreamux/tests/cot-projection-privacy.test.ts:406`
asserts exactly that, with `Bearer abcDEF123.ghiJKL456-_9` and
`{"token":"abc123secret"}` surviving and `redacted` reported as `false`.

## Superseded prior ruling

This requirement reverses a decision the operator made on 2026-09-09 in
[Refine COT tool details and notification display](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/README.md).
There, review finding R1 ("Escaped quoted secrets survive argument redaction")
was closed by the operator's ruling 「你把参数给我展示出来吧，先不做脱敏了」,
clarified as 「参数全给我放开，不要做脱敏了」. That ruling reached
`.agents/product/README.md` and `.agents/domains/channel.md` as current
behavior.

The original rationale was legibility: the redactor of the day both missed
secrets and damaged the arguments it rewrote (escaped quoted strings were cut),
so raw display was the readable option. What changed is the operator's weighing
of the remaining exposure, not a defect in that reasoning.

The prior task's records are historical decision archives and are not rewritten.
This task carries the `supersedes` relationship; the two current-state knowledge
pages are updated here.

## Desired behavior

Every member of a projected `tool.call` passes the same redactor. `invocation`
and `arguments_json` lose their exemption and are treated exactly as `summary`,
`items`, and `result_json` already are, including their contribution to the
`redacted` flag.

The operator chose this from three offered options, and the option he chose was
labelled with its cost: path rewriting applies to commands too, so a displayed
command can no longer be copied and re-run verbatim. His choice, verbatim:
「全量脱敏，跟其它成员一视同仁」.

## Scope

- `packages/dreamux/src/channel/conversation-projection.ts`: remove the
  two-member exemption in `projectedActivity`; both members contribute to
  `redacted`.
- `packages/dreamux/tests/cot-projection-privacy.test.ts`: the two cases that
  lock the exemption encode the superseded contract and are rewritten to the new
  one.
- `.agents/product/README.md` and `.agents/domains/channel.md`: current-state
  pages that state the raw-argument rule.
- One Rush change file.

## Non-goals

- No change to the redaction rules themselves. The five secret patterns and the
  path-prefix rewriter are untouched; this task only changes which members they
  run over.
- No new provider-branded token detectors. That gap is recorded below as an open
  question, not scope.
- No change to which member the Channel displays first: nonempty `invocation`
  still wins over `arguments_json`.
- No change to any other redaction site.

## Constraints and invariants

- The two rewritten test cases are a contract change ordered by the operator,
  not a test weakened to make a change pass. The repository rule against
  weakening a load-bearing test still holds for every other assertion in that
  file; the rewrite is recorded here so a green run is not mistaken for the old
  contract still holding.
- Core redacts and never truncates. Surface-side limits stay where they are.
- The change is behavior-only and leaves every persisted file readable as it is,
  so its change file is an ordinary note — not `BREAKING:`, no `Rebuild:`.

## Acceptance criteria

1. A secret-shaped value in `invocation` is redacted in the projected event.
2. A secret-shaped value inside `arguments_json` is redacted in the projected
   event.
3. A workspace or host-home path in either member is rewritten the same way it
   is in `summary`, `items`, and `result_json`.
4. A `tool.call` whose only redaction fired inside `invocation` or
   `arguments_json` reports `redacted: true`.
5. A `tool.call` with nothing secret- or path-shaped anywhere is byte-identical
   to its input in every member.
6. `rush build`, `rush lint`, `rush test`, and `rush typecheck:tests` all pass.

## Decisions and unknowns

### Confirmed operator decisions

| Date | Decision | Operator's words |
| --- | --- | --- |
| 2026-09-11 | Close the argument/invocation redaction gap, reversing the 2026-09-09 ruling | 「B」, selected from an enumerated menu whose B read "toolcall 的 invocation / arguments 裸奔想收口" |
| 2026-09-11 | Full redaction, not the offered secrets-only variant that would have preserved literal paths | 「全量脱敏，跟其它成员一视同仁」 |
| 2026-09-11 | Record as a new task superseding the prior ruling rather than reopening the prior task | 「新建任务，supersedes 旧裁定」 |
| 2026-09-11 | Skip the solution phase and implement directly | 「省掉方案阶段，直接改」 |

The last decision overrides the workflow's own rule that a change to a security
boundary is not eligible for the direct path. The option the operator selected
stated that consequence explicitly. Recorded here because the override is the
operator's, not the TeamLeader's.

### Rejected direction

The opening request was to replace the hand-written redaction with an
open-source library. Measured, not read from documentation:

- `@secretlint/core` with `preset-recommend@13.0.5` (28 rules) misses all four
  generic `key: value` shapes, `Bearer`, JWT, and bare AWS access key IDs
  (`enableIDScanRule ?? false`). Adopting it as a replacement would be a
  privacy regression. Its API is also async, while this projection is
  synchronous.
- gitleaks carries the right rule shapes but is a Go binary; a per-Activity
  process spawn is not viable, and its TOML uses RE2 inline flags that JS
  `RegExp` rejects, so a port means writing a rule compiler.
- `@visulima/secret-scanner@2.0.1` is that rule set via NAPI: eight
  per-platform native bindings with no JS fallback, and 21.5 ms per 8 KB call
  against 0.195 ms for the current regexes.

No library replaces the current redactor. Separately, roughly two thirds of the
function is workspace/home path rewriting, which is legibility rather than
secret removal and has no library equivalent at all.

### Open question, not in scope

Provider-branded tokens (`ghp_`, `xoxb-`, `npm_`, `sk-ant-`, `sk-proj-`) match
none of the five current patterns and still pass through every member.
Reachable scenario: an agent runs `gh auth status` or reads a `.env`, and the
result lands on a chat card. Closing it is a new requirement and awaits an
operator decision.
