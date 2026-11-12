# Final technical design

The operator waived the solution stage (「省掉方案阶段，直接改」, 2026-09-11).
This page is the archive record of what was built and how it was verified, not
a proposal that was reviewed before implementation. The design below is the one
he chose during implementation (「好，按照B 来做」) after the direct path
exposed what the exemption had been hiding.

## Change

Three things, in dependency order.

1. **The redaction capability moves to `@excitedjs/dreamux-utils`**
   (「给整个脱敏能力抽到 utils 包里去，不要放在 core 包了」). It is pure, so core
   no longer owns rules it only consumes; `conversation-projection.ts` drops
   from 387 lines to 227. The move also settled what utils may depend on: it now
   depends on no Dreamux package at all, because `@excitedjs/dreamux-types` is
   the contract *external providers* compile against and utils sits below that
   seam. The JSON value shape and the settled-invoke shape are declared locally
   and structurally, so a caller holding the contract's version still passes one
   without a cast.
2. **Secret key names are written once — in the three places this change can
   reach.** They had been written out in the inline text pattern, in
   `config-helpers.ts`'s `isSecretConfigKey`, and in `logger.ts`'s
   `SECRET_KEY_RE`, and the copies had drifted: the logger's was missing
   `api_key`, `private_key`, and `client_secret`, so those three were never
   hidden in a host log. One list now compiles into both the text pattern and
   `isSecretKeyName`, and that gap closes with it.

   A fourth copy survives, out of reach here:
   `/packages/channel/feishu-transport/src/transport/diagnostics.ts` has the
   same short, drifted list and the same three missing names. Unifying it would
   add a `feishu-transport` → `dreamux-utils` dependency edge, which is a
   package-boundary decision and not this task's to make. Recorded rather than
   silently left: see the open questions below.
3. **A tool call's structured payloads are redacted by walking the structure.**
   `arguments` and `result` arrive as `JsonValue`, so `redactJson` walks them
   before serialization: a field whose *name* says secret has its value
   destroyed, every string leaf goes through `redactText`, and numbers and
   booleans travel as they are. `invocation`, `summary`, and `items` are
   genuinely text and keep text redaction. `jsonText` now runs after redaction
   rather than before.

The projection branch itself is the original change: the `invocation` /
`arguments_json` exemption is deleted, and `redacted` is the OR over every
member instead of the three that used to count.

## Why walking, and not a better pattern

Widening redaction to `arguments_json` put the text pattern in front of a shape
it had never been shown: a JSON string nested inside another. It failed, and
each fix exposed the next failure — the value of `TOKEN=\"abc\"`, then every
line of a multi-line `.env` but the first, then a redacted line swallowing the
lines below it, then a serialized backslash read as a boundary, then a nested
JSON *object* whose key no longer sits beside its separator, then a nested value
containing an escaped quote. Six symptoms of one cause.

The cause is level, not coverage. The same payload that leaks when serialized is
redacted correctly when raw:

```
{"content":"{\"client_secret\":\"shhSECRET\"}"}   → passes through
{"client_secret":"shhSECRET"}                      → {"client_secret":"<redacted>"}
```

A regex cannot count nesting depth, so every patch buys one shape and leaves the
next. Walking removes the problem rather than chasing it: whatever parsed the
structure has already peeled one level of escaping, so every string the walk
reaches is ordinary text — the one thing the pattern is good at. Depth stops
mattering.

Two consequences follow for free. A payload that arrived as JSON is still JSON
after redaction, because the structure was never flattened, so the parsability
caveat this design once needed is gone. And a key that *names* a secret is now
answered by its name, which covers the low-entropy and oddly-punctuated values
no pattern would have matched.

Because the walk hands over raw text, `INLINE_SECRET_RE` needed no change at
all. It is `next`'s pattern, recomposed from the shared name list and otherwise
untouched; the extension made while chasing the symptoms is reverted.

## Records rewritten in the same change

- `packages/dreamux-types/src/teammate.ts` — the `TeammateActivity` doc and the
  `tool.call` variant's member docs stated the exemption as the contract.
- `.agents/product/README.md`, `.agents/domains/channel.md` — the behavior
  catalog and the domain page both quoted the 2026-09-09 ruling as current.
- `.agents/domains/current-architecture.md` — the utils package now owns the
  redaction capability.
- The 2026-09-09 task record is left as it is: it is the history of a decision
  that was true when made, and this task's README links to it as superseded.

## Verification

- `packages/dreamux-utils/tests/redaction.test.ts` — the rules' own cases, moved
  out of the projection suite, plus `redactJson` coverage for every shape named
  above: nested object, escaped quote, multi-line `.env`, backslash-bearing
  value, key-name destruction, arrays, path renaming, a clean payload left
  byte-identical, and a redacted payload that still serializes.
- `packages/dreamux/tests/cot-projection-privacy.test.ts` — every
  projection-level case, with the three that locked the old exemption rewritten
  against the acceptance criteria.
- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
  `.agents/scripts/check.sh`.
- Independent review by Devbox, which found the last two of the six symptoms
  above; both are covered by the walk.
