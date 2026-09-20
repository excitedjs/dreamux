# Technical solution — Codex keyword alignment (requirement behavior 7)

Brief repair solution for one slice of the final requirement, written after the
operator asked for that slice first: "把那个 Ultrathink 的改动先做一下".

Requirement input: [requirement.md](/.agents/tasks/architecture/promote-runtime-model-and-effort/requirement.md),
behavior 7, acceptance criteria 9 and 10.

## 1. Scope

In scope, and nothing else:

- A Codex submission that matches the keyword also carries Claude Code's
  sentence, verbatim, as its own input item beside the submission text.
- Matching narrows from the bare substring `/ultrathink/i` to the word-boundary
  `/\bultrathink\b/i`.
- The three documents that state today's promise, and one ordinary change note.

Explicitly out of scope, and unchanged by this slice:

- Behaviors 1 to 6 of the requirement: `defaultModel` / `defaultEffort`, the
  `/model` and `/effort` commands, the identity fields, the neutral capability,
  and removing `agents[].config.model`. Their solution path is still unchosen.
- Ordinary effort stays exactly what it is today — the `thread/start` value, or
  effective configuration on cold resume. Acceptance criterion 9's clause about
  "the level recorded in the identity" belongs to behaviors 1 to 4 and is not
  implemented here.
- Nothing is added for Claude Code (requirement behavior 6).
- Which submission sources are matched, and the rule against scanning history,
  files and tool results, stay as issue #430 set them.

## 2. Facts this rests on

Read from source and from the installed Claude Code binary on 2026-09-20.

- `packages/agent-runtime/codex/src/reasoning-effort.ts` holds the whole rule:
  `effortFor(text)` tests the keyword, resolves ordinary effort once, and
  resolves the model maximum once. It returns the effort or `undefined`.
- `packages/agent-runtime/codex/src/turn-manager.ts` calls `effortFor`, then
  `submitTurnStart`, and turns a thrown selection error into a failed
  admission.
- `packages/agent-runtime/codex/src/events.ts` builds the wire input:
  `submitTurnStart` assembles exactly one `{ type: 'text' }` item from its
  `prompt` parameter. It has two call sites: the turn manager and the
  one-shot helper in the same file.
- Codex's `UserInput` has seven variants — Text, Image, LocalImage, Audio,
  LocalAudio, Skill, Mention. There is no reminder or system channel, so an
  injected sentence can only be another `Text` item.
- Claude Code emits the sentence as a bare meta message:
  `ultrathink_effort:()=>fi([Te({content:'The user included the keyword
  "ultrathink", requesting deeper reasoning on this turn. Reason as thoroughly
  as the task warrants.',isMeta:!0})])`. Neighbouring reminders in the same
  table wrap their content in the `<system-reminder>` helper; this one does
  not. So the bare sentence, with no wrapper, is what "照抄 claude 的原句"
  copies, and it is also the only shape Codex could accept.

## 3. The change

### 3.1 `reasoning-effort.ts` owns both facts

The keyword is matched once, in the class whose stated job is submission-local
selection. It returns what the submission asks for instead of only the effort:

```ts
export interface SubmissionEffort {
  effort?: string;
  hint?: string;
}

async effortFor(text: string): Promise<SubmissionEffort>
```

`hint` is the sentence, present only when the submission matched; `effort` is
today's value with today's meaning, including `undefined` for "leave it to
Codex". The regex and the sentence constant sit next to each other in this
file, so the keyword concept has one home.

The alternative — exporting a predicate the turn manager also calls — was
rejected: it spreads the keyword over two files and evaluates the rule twice
to answer one question about one submission.

### 3.2 `events.ts` takes the input items

`submitTurnStart`'s `prompt: string` becomes `input: string[]`, mapped to one
text item each, in order. The turn manager passes `[text]` or `[text, hint]`;
the one-shot helper passes `[prompt]`. This keeps the parameter count where it
is and says plainly that a turn carries a list of items.

The hint goes after the submission text: the operator's task is what the model
should read first, and the sentence is an instruction about how to read it.

### 3.3 Nothing else moves

The turn manager keeps its current shape: one `effortFor` call, the same error
handling, the same admission bookkeeping. No new state, no new failure path —
a submission that matches either resolves both values or fails exactly as it
fails today.

## 4. Tests

`packages/agent-runtime/codex/tests/codex-ultrathink.test.ts` asserts the wire
input with `toMatchObject({ input: [{ text }] })`, which is length-strict on
arrays, so every marked-submission assertion is updated to the two-item shape
and every ordinary-submission assertion keeps the one-item shape. Added:

- a marked submission sends `[submission, sentence]`, with the submission text
  identical to what was submitted and the sentence identical to the constant;
- `请ultrathink一下` still matches (a CJK character is a non-word character);
- `ultrathinking` and `x_ultrathink_y` no longer match — no effort parameter
  and no second item.

One existing case changes verdict. `it.each([... 'prefixULTRATHINKsuffix' ...])`
asserts that an embedded occurrence matches; under word-boundary matching it
does not. This is a requirement change, not a test weakened to make a change
pass: the operator ruled "改成词边界，和 claude 一致" on 2026-09-20, which
supersedes the substring choice issue #430 made deliberately. The case moves to
the non-matching list rather than being deleted, so the narrowing stays
covered.

`packages/dreamux/tests/codex-live.test.ts` asserts efforts only, never the
input array, so the live gate needs no change.

## 5. Documents

All three state today's promise and all three are rewritten in the same change:

- `.agents/product/README.md`, "Codex reasoning effort": substring becomes
  word boundary; "byte for byte as it was assembled, with no explanation
  appended" becomes the submission unchanged plus one added item carrying the
  sentence. The entry keeps pointing at issue #430 and names what this change
  supersedes.
- `.agents/domains/provider-runtime.md`, "Codex reasoning effort": same two
  facts, from the implementation side.
- `packages/agent-runtime/codex/README.md`, "Ultrathink": same two facts, in
  the package's own words.

One ordinary change note for `@excitedjs/agent-runtime-codex`, type `minor`
(0.x). Not `BREAKING:` — no persisted file, config shape or path changes, and
an upgraded daemon starts unchanged.

## 6. Verification

- `node common/scripts/install-run-rush.js build`, `lint`, `test`,
  `typecheck:tests` — all four, as the repository requires.
- `.agents/scripts/check.sh` for the knowledge and task-record changes.
- The narrowing is checked by the test cases above, not by argument.

## 7. Task state on landing

This slice does not finish the task. Before the pull request opens, the task
README returns to `blocked` — behaviors 1 to 6 still have no chosen solution
path — with the delivered slice named in the record. In-flight states stay
local.

## 8. Path classification

By the letter of the fast-path test this change is not eligible: it narrows
released behavior that the product catalog promises. What is absent is the
thing the reviewed paths exist to supply — both behavior decisions are the
operator's own rulings, quoted in the requirement, and the surface is one
class, one function, one test file and three documents. The operator chooses
the path on the development-authorization card; if they pick a reviewed path
this file becomes the draft for it.
