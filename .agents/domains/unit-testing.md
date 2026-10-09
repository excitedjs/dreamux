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

An admission-race test must observe both sides of its boundary. A resolved
delivery promise and zero calls for the late request do not prove that a
request queued before close was delivered. Record and assert the admitted
request's actual preparation, submission and payload outside the owner's
error handling, as well as refusal of the post-close request.

`completion-delivery.test.ts`'s
`'renders identically whether or not a deliverCompletion callback is attached'`
case was the template: it built a real `TeammateSubmitInput`, called the real
`renderSubmission`, and asserted the returned string — proving
`COMPLETION_SOURCE` actually reached the rendered output, not that some call
site's text mentions the constant. The same file also carried two of
the source-text cases described below (its
`'the actual delivery call site renders under COMPLETION_SOURCE...'` and
`'never reintroduces an isChannelInvocation-style adapter branch...'` cases),
so it was a template for one case in it, not a file to copy wholesale. The
whole file was deleted under R43 in the code-organization refactor's Stage 9
(an unrelated earlier-stage directory move — `teammate-service/` into
`service/agent/` — broke its import, not a fault in the cases themselves);
its contract is logged in the
[deleted tests ledger](/.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md)
for final-parent accounting. The surviving rendering protection is restored in
`/packages/dreamux/tests/completion-delivery.test.ts` as
`renders identically whether or not a Core completion recipient is attached`;
the former source-text checks remain retired.

If constructing the real owning object looks impractical — "too heavy to
construct here" — that is the design defect, not a license to fall back to a
text scan. `core-event-catalog.test.ts`'s
`'the Dispatcher and its dispatcher-scoped TeamMates are wired to the real
publisher with role read from team_id, not asserted'` case documented exactly
this: unable to construct a full `DispatcherService` (config, registry,
catalog, admin socket), the test read `dispatcher-service/index.ts` as text
instead. The replacement must observe actual publication; a source scan does
not become behavioral evidence because construction is inconvenient. Current
`/packages/dreamux/tests/core-event-owners.test.ts` constructs the real identity
store, factory, bus and Team owners and checks committed events and source
revocation, without adding a production abstraction solely for test setup.
The old file was likewise deleted
under R43 in Stage 9 (same ledger: an unrelated earlier-stage directory
move — `team-collection/` into `service/team/` — broke its import).

## Behavioral lint fixtures and coverage accounting

Calling the real ESLint config with lintText and asserting emitted rule ids
and error severity is a behavior test. The fixture path selects the source or
test contract; it is not a scan that pins repository source spelling or layout.
The source-text prohibition does not retire this contract. For the code-line
cap, a 701-comment fixture tests no counted code lines, so it cannot prove the
hard error above 700 code lines. Use actual non-comment, nonblank code and
assert the positive error; retain separate boundary/counting-mode assertions.

When a coverage ledger mixes such cases with literal source scans, classify
each case by what it executes and observes. A generic R46/R55 or compiler-gate
citation cannot cancel a surviving behavioral obligation. Map it to the named
current assertion or the exact decision that changes that specific contract.
The code-organization ledger's Stage 1 explicitly retains the source line-cap
behavior; its physical-line counting assumption is the superseded part.

## Regression traps: isolated hooks and local mirrors

A hook that isolates plugin failures also isolates a failed assertion inside
its callback. Capture the callback's observed result or error and assert in
the test body after the hook returns. Recording one observation before an
in-hook assertion is not enough: a reentrant lookup can fail while the later
ordinary lookup succeeds, leaving that test green. A missing callback result
must fail the outside assertion rather than disappear into fixture logging.

Exercise the production parser or smallest real owning seam, not a private
test-local implementation that only its own tests call. A passing local
version classifier says nothing about the provider version gate. Likewise,
an ignored fixture argument creates no distinct event: command arrays dropped
by a result adapter cannot prove real multi-submit folding. Remove the dead
dimension, retain the result projection and point the folding obligation to
the test that actually submits multiple inputs and observes their native end.

## Real Codex execution boundaries

`/packages/dreamux/tests/codex-live.test.ts` checks the installed version and
initializes a real app-server/thread in a disposable home without operator
config or authentication. Missing or unsupported Codex fails this check.
`DREAMUX_SKIP_LIVE_CODEX=1` is an explicit exclusion for an environment that
intentionally lacks Codex; it does not certify provider compatibility.

The model cases in `codex-native-contracts-live.test.ts`,
`codex-activity-live.test.ts` and `codex-inbound-live.test.ts` additionally require
`DREAMUX_RUN_LIVE_MODEL_GATE=1` and usable model authentication. This explicit
execution boundary lets normal hosted CI check installed/protocol compatibility
without model credentials. An excluded model case is reported as excluded;
installation, protocol startup or a default green run cannot substitute for
the six native model contracts or the issue #63 gate. Record the default run
and the explicitly enabled model run separately when certifying those contracts.

Use public provider/config exports where they already exist. The integration
fixtures also observe native RPC acknowledgement and terminal messages and
intercept Feishu platform IO; those test-only observations currently need
package internals that have no public equivalent. Internal module movement
therefore requires updating these probes with the provider change. This is a
named fixture coupling, not a production dependency or a reason to expose new
production APIs solely for tests or replace actual native evidence with a fake.

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

- **A "direction" case, retired along with the fact it pinned.**
  `mcp-delegate-catalog.test.ts` used to prove the
  free function `channelMcpDelegates()` was imported only from
  `service/dispatcher-service/mcp-delegates.ts`, with a hand-rolled recursive
  `findImportersOf()` helper that walked `src/` and grepped every file's
  imports — an import-direction fact dependency-cruiser could state instead,
  without hand-rolling a source walker, as the
  `channel-service-mcp-delegates-single-importer` `from`/`to` rule in
  `/packages/dreamux/.dependency-cruiser.cjs`. Code-organization refactor
  Stage 6e folded `channelMcpDelegates()` into a `ChannelService` method, so
  there is no longer a free function with importers to enumerate — the fact
  itself is gone, not merely covered by a better gate, so the cruiser rule was
  deleted in the same stage. This refactor's own R43 rule deletes a broken
  test case as soon as it is found — never repairs, re-points, or edits one
  to pass — and R53 stopped running `vitest`/`typecheck:tests` per stage
  from stage 2b onward, so a case's failure now surfaces only when something
  actually runs it. Nothing ran this file between Stage 6e and Stage 9: an
  earlier stage (Stage 5) had already moved `mcp/catalog.ts` to
  `service/mcp/catalog.ts`, a change unrelated to `channelMcpDelegates()`,
  and this file's own `import ... from '../src/mcp/catalog.js'` broke as a
  result, but nothing surfaced it until Stage 9's item 8 ran a targeted
  `npx vitest run` sweep over this file (a lighter, per-file check item 8's
  own plan permits; the repo-wide `rush test` sweep is the separate, later
  "final test completion on PR #453"). That sweep found the whole file
  failing to load, so R43's "a test file that no longer compiles is deleted"
  applied immediately, in Stage 9, not deferred to that later pass. The
  cruiser rule and the test are still both gone, just not in the same stage
  and not for the same reason; the case is logged in the
  [deleted tests ledger](/.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md)
  for restoration. A future analogous case (a source-text importer scan
  for a fact dependency-cruiser can express natively) gets the same treatment:
  add the cruiser rule, delete the hand-rolled test.
- **A behavioral protection a structure scan cannot prove.**
  `team-dissolve-contract.test.ts` proved "dissolve
  never drains a running turn" by reading `closing.ts`, `team/service.ts`,
  and two other files as text and asserting none of them contain the
  identifiers `waitIdle` or `isIdle`. The real fact — dissolve stops and
  reclaims a Team immediately, it never waits for an in-flight turn to finish
  — has no dependency-cruiser or compiler equivalent, because it is a runtime
  timing fact, not an import fact. The replacement is a real test: start a
  fake long-running turn, call dissolve, and assert dissolve returns (and the
  member is reclaimed) without waiting for that turn to complete — proving the
  behavior by observing it, instead of by grepping for the identifiers a
  waiting implementation would have used. This file was also deleted under
  R43 in Stage 9 (an unrelated earlier-stage fold — `TeamWorktreeCleanup`
  merged into `TeamCollection` under Stage 6b — broke its import); its
  contract is logged in the same ledger. Current behavior assertions live in
  `/packages/dreamux/tests/team-dissolve-behavior.test.ts` and
  `/packages/dreamux/tests/team-dissolve-additional.test.ts`; the
  [repair coverage accounting](/.agents/tasks/architecture/code-organization-refactor/technical-design/review-453-fixes/coverage.md)
  distinguishes surviving protections from R62/R67's changed teardown order.

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
task-record file. Several example files above were themselves deleted
mid-refactor under R43 (an unrelated earlier-stage move, rename, or fold
broke their import, not a fault in the cited case) — for those, read the
[deleted tests ledger](/.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md)
entry instead of the source file, and verify a still-live citation directly
against current source the same way this page's examples were verified.
