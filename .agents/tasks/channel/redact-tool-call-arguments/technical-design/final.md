# Final technical design

The operator waived the solution stage (「省掉方案阶段，直接改」, 2026-09-11).
This page is the archive record of what was changed and how it was verified, not
a proposal that was reviewed before implementation.

## Change

One projection branch owns the whole behavior.
`projectedActivity()`'s `tool.call` case in
`packages/dreamux/src/channel/conversation-projection.ts` ran three of its five
payload members through `redactText` and handed `invocation` and
`arguments_json` to the Channel untouched. The exemption is deleted: the branch
now redacts all five through one local `redact(text: string | null)` helper, and
`redacted` is the OR over every member instead of the three that used to count.

Nothing else moves. The five secret patterns, the path-prefix renaming, and
`redactText` itself are unchanged — this task widens who is redacted, not what
redaction means. `RuntimeActivity`, `TeammateActivity`, and the Channel's
rendering keep their shapes, so no persisted file, protocol frame, or config is
affected.

## Why the exemption could go

It existed to keep a command judgeable: a masked command is a command nobody can
evaluate. The operator withdrew that trade on 2026-09-11 (「全量脱敏，跟其它成员
一视同仁」) after seeing the cost stated — a secret pasted into a shell command
or a tool's arguments reaches a chat surface with no gate in front of it, and
that is the same surface the result members were already being protected from.

## Parsability of `arguments_json`

`jsonText`'s contract already says the serialization is whole but parsability is
not guaranteed, because a replacement landing inside a JSON string can leave
text no parser accepts. That was written for `result_json`; it now covers
`arguments_json` too. The consumer already degrades correctly:
`feishu-cot-presentation.ts`'s `prettyJson` parses in a `try`/`catch` and falls
back to `{ language: 'text', code: args }`, which is what a display does with
any payload it cannot read as JSON. `INLINE_SECRET_RE` also preserves a quoted
secret's quotes, so the common case stays valid JSON.

## Records rewritten in the same change

- `packages/dreamux-types/src/teammate.ts` — the `TeammateActivity` doc and the
  `tool.call` variant's three member docs stated the exemption as the contract.
- `.agents/product/README.md`, `.agents/domains/channel.md` — the user-visible
  behavior catalog and the domain page, both of which quoted the 2026-09-09
  ruling as current.
- The 2026-09-09 task record is left as it is: it is the history of a decision
  that was true when made, and this task's README links to it as superseded.

## Verification

- `packages/dreamux/tests/cot-projection-privacy.test.ts` — three cases locked
  the exemption and are rewritten against the acceptance criteria: paths renamed
  in every member, a secret-shaped `invocation` and `arguments_json` redacted,
  `redacted: true` when the only hit was inside `invocation`, and a clean call
  still byte-identical.
- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`.
- Independent implementation review before the PR.
