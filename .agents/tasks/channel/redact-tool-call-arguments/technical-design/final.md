# Final technical design

The operator waived the solution stage (「省掉方案阶段，直接改」, 2026-09-11).
This page is the archive record of what was changed and how it was verified, not
a proposal that was reviewed before implementation.

## Change

Two places: the projection branch that decided who gets redacted, and the
secret pattern that had never been shown a tool argument.
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

## What the exemption had been hiding

`arguments_json` had never been through the redactor, so `INLINE_SECRET_RE` had
never been asked to handle the shape a tool argument actually carries: a JSON
string nested inside another. Three defects surfaced the moment it was, and all
three are fixed in the same change — leaving them would have met the letter of
the ruling and not its point.

1. **`TOKEN=\"abc\"` leaked its value.** The value alternatives expected a bare
   quote; a nested JSON string opens with the two characters `\"`, so the
   quoted branch failed and the bare word stopped on the backslash — covering
   the `=` and nothing else. `.env` text and `export FOO="bar"` are exactly this
   shape. A nested-string alternative now matches it as a unit.
2. **Every line of a multi-line payload but the first was invisible.** A key
   must start on a word boundary; a serialized newline is `\n`, whose `n` is a
   word character, so `\nTOKEN=` had no boundary for `\b` to find. A JSON
   escape now counts as a boundary of its own.
3. **A redacted line swallowed the lines below it.** Symmetrically, a bare word
   ran straight through `\r\n` and took the rest of the payload with it. A
   bare word now stops at `\"`, `\n`, `\r`, and `\t` — the escapes that end a
   value — while any other backslash continues it, so a serialized
   `C:\\Users\\x` is still covered whole rather than truncated to `C:`.

One narrow cost is accepted and documented at the regex: in raw, non-JSON text,
a secret whose value contains a backslash immediately followed by `n`, `r`, or
`t` is cut there and its tail stays visible. That buys the three fixes above,
each of which is a whole secret rather than a tail.

With those, a payload that arrived as JSON is still JSON after redaction.
`jsonText`'s contract is unchanged and still the authority — the serialization
is whole, parsability is not promised — and the consumer already degrades
correctly either way: `feishu-cot-presentation.ts`'s `prettyJson` parses in a
`try`/`catch` and falls back to `{ language: 'text', code: args }`.

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
