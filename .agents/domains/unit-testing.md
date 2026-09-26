# Unit testing

This repo had no standing guidance on which unit tests to write, and its test
suite accumulated a large body of tests that read a source file's text and
pattern-match it instead of exercising real behavior — cheap to write, but
they pin implementation shape rather than a contract: they break on a refactor
that preserves behavior and stay green through a refactor that breaks it. This
page is that guidance: what to write instead, why the text-matching kind is
banned, and the one case where an absence check is the legitimate answer.

## What a real behavior test looks like here

Construct the real owning object — a Collection, a Service, a runtime, or the
smallest real seam available — exercise it through its public interface, and
assert on the observable outcome: a returned value, a call made on a
collaborator, a state change visible through another public method. Never
assert on source text, file paths, or a slice of a method body.

`/packages/dreamux/tests/completion-delivery.test.ts`'s
`'renders identically whether or not a deliverCompletion callback is attached'`
case is the template: it builds a real `TeammateSubmitInput`, calls the real
`renderSubmission`, and asserts the returned string — proving
`COMPLETION_SOURCE` actually reaches the rendered output, not that some call
site's text mentions the constant. The same file also still carries two of
the source-text cases described below (its
`'the actual delivery call site renders under COMPLETION_SOURCE...'` and
`'never reintroduces an isChannelInvocation-style adapter branch...'` cases),
so it is a template for one case in it, not a file to copy wholesale.

If constructing the real owning object looks impractical — "too heavy to
construct here" — that is the design defect, not a license to fall back to a
text scan. `/packages/dreamux/tests/core-event-catalog.test.ts`'s
`'the Dispatcher and its dispatcher-scoped TeamMates are wired to the real
publisher with role read from team_id, not asserted'` case documents exactly
this: unable to construct a full `DispatcherService` (config, registry,
catalog, admin socket), the test reads `dispatcher-service/index.ts` as text
instead. The fix belongs on the production side — extract a lighter,
independently constructible seam for the fact under test (here, the
`publishAgentState` call) — not on the test.

## What a source-text/structure test looks like, and why it's banned

A source-text/structure test reads a file's text (`readFileSync` + regex, or
an AST walk over a method body) and checks for the presence or absence of a
call, an import, or an identifier — a mirror of the implementation, not an
exercise of it. This is the repo-specific application of the operator's
standing taste in
[engineering whitepaper §7, Naming and tests](/.agents/skills/engineering-whitepaper/SKILL.md):
a test that mirrors source text, whether by string match or by AST extraction
of a private method body, is a structure assertion and gets deleted, never
propped up with a tsconfig tweak or a re-export. Two examples from this
refactor's own audit:

- **A "direction" case, superseded by a dependency-cruiser rule.**
  `/packages/dreamux/tests/mcp-delegate-catalog.test.ts` proves
  `channelMcpDelegates()` is imported only from
  `service/dispatcher-service/mcp-delegates.ts` with a hand-rolled recursive
  `findImportersOf()` helper that walks `src/` and greps every file's
  imports. That is exactly an import-direction fact, and dependency-cruiser
  has native visibility into the same import graph without hand-rolling a
  source walker: the `channel-service-mcp-delegates-single-importer` rule in
  `/packages/dreamux/.dependency-cruiser.cjs` states the identical fact as a
  `from`/`to` pair and runs on every `rush lint`. That gate is warn-only while
  this refactor is in progress (see `/packages/dreamux/CLAUDE.md`'s
  "Layering" bullet for the current severity), so the hand-rolled test is
  still present today — it becomes redundant, and is dropped, once the final
  test completion on PR #453 confirms the cruiser rule covers it.
- **A "behavior" case that still needs a real test.**
  `/packages/dreamux/tests/team-dissolve-contract.test.ts` proves "dissolve
  never drains a running turn" by reading `closing.ts`, `team/service.ts`,
  and two other files as text and asserting none of them contain the
  identifiers `waitIdle` or `isIdle`. The real fact — dissolve stops and
  reclaims a Team immediately, it never waits for an in-flight turn to finish
  — has no dependency-cruiser or compiler equivalent, because it is a runtime
  timing fact, not an import fact. The replacement is a real test: start a
  fake long-running turn, call dissolve, and assert dissolve returns (and the
  member is reclaimed) without waiting for that turn to complete — proving the
  behavior by observing it, instead of by grepping for the identifiers a
  waiting implementation would have used.

## The one legitimate exception

A source-text scan is accepted, narrowly, when the fact itself is an absence
with no positive alternative to construct and observe, and no compiler or
import-graph mechanism can express it either.
`/packages/dreamux-types/tests/deleted-surfaces-absence.test.ts`
is the live example: it greps `src/*.ts` for a closed list of retired
Command names, persisted filenames, and removed methods that must never
reappear. There is no owning object to construct that would "exercise" a
deleted surface's absence, most of these tokens were never exported so an
unused-export check has no visibility into them, and dependency-cruiser only
sees imports, not arbitrary string literals. This is the narrow case, not a
default fallback for whenever a behavior test is inconvenient to write — if a
real object and a real call sequence exist to prove the fact, use them
instead, even when the source-text version would be cheaper to write.

## Lookup table

| What the test does | What it's really checking | Replacement gate |
|---|---|---|
| Regexes or AST-walks a file to see whether it imports (or never imports) another file, including a hand-rolled "who imports this symbol" search | An import-direction or layering fact | A dependency-cruiser rule (`/packages/dreamux/.dependency-cruiser.cjs`) |
| Regexes a type-only barrel (e.g. `@excitedjs/dreamux-types`' `src/index.ts`) to pin its exact export name set | A type export-surface completeness fact | A compiler shape — an exhaustive re-export such as `export type * from` |
| Regexes a runtime barrel to pin its exact export name set | A runtime export-surface completeness fact | An unused-export check (knip), scoped per package |
| Regexes or slices a method body or call site to assert an ownership, sequencing, or call-count fact ("only X calls Y", "A happens before B", "the cache is single-flight") | A real behavior invariant | A real behavior test: construct the owning object(s), exercise the public interface, observe the outcome |
| Greps `src/**` for a closed list of retired names/tokens that must never reappear | An absence with no positive alternative and no compiler/import-graph handle | Accept it as a legitimate absence check — narrow, not a default |

History: [/.agents/tasks/architecture/code-organization-refactor/](/.agents/tasks/architecture/code-organization-refactor/)
— R4 records the operator's request for this page. The audit
(`artifacts/audit.md` §3.2, §8, §9) flags which tests are source-text/structure
tests; the per-test classification behind this page's examples was worked out
in this task's scratch planning and is not itself a committed KB or
task-record file — read the tests cited above directly to verify a claim
against current source, the same way this page's examples were verified.
