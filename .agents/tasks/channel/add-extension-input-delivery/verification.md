# Verification

## Implementation boundary

The developer changed six Feishu source files, package guidance, the package README
and a minor Rush release note, and added one Feishu contract test file and one Core
integration test file. No new source module, lifecycle state, persisted record,
dependency or Core admission mechanism was added. Task and knowledge records remain
TeamLeader-owned. Downstream adaptation is outside this task.

## Developer gate evidence

The developer ran upstream Rush build, lint, test and `typecheck:tests` for the
affected closure, plus formatting checks and `git diff --check`. The TeamLeader
inspected both new test files, the source diff and the final local Rush test logs:
Feishu recorded 35 passing files / 736 passing tests; Core recorded 89 passing
files / 1128 passing tests and six pre-existing live-model tests skipped in three
files. The unconfigured live-model gate is an explicit exclusion.

The initial evidence-hardening round changed only the two new test files. The
post-review correction changed the attrs constructor and both new test files.
Neither round changed the public API, approved submission semantics or solution.

## TeamLeader pre-review

Pre-review passed on 2026-10-10. The TeamLeader independently ran:

| Check | Actual result |
| --- | --- |
| Rush build to Core | Exit 0; nine operations were already up to date, not freshly compiled. |
| Rush lint to Core | Exit 0; nine successful operations. |
| Rush `typecheck:tests` to Core | Exit 0; eight successful operations and one package with no work. |
| Rushx focused Feishu contract test | 26 / 26 passed. |
| Rushx focused real-Core integration test | 4 / 4 passed. |
| `git diff --check` | Exit 0. |

The initial simultaneous Rush lint/typecheck attempt hit Rush's repository lock;
typechecking was then run after lint finished and passed. This was command
orchestration, not a product or typechecking failure.

The implementation matches the approved bound-Team check, direct typed command
call, existing lifecycle tracking, distinct refusal, canonical provenance and
reminder replacement. Existing presentation and routing paths are not edited.
The Core arm uses real configuration, plugin publication, provider/session and
Core admission, with the bot and runtime controlled.

All four first-handoff evidence gaps are closed:

1. Two real Feishu instances reaching one Team share Core's recipient-scoped
   source-ID ledger: the second call is a real duplicate and produces no second
   runtime input. Core configuration allows one channel per provider reference
   per Dispatcher, so the secondary instance is constructed from the real
   contributed provider with a real Core port; Core does not construct it from
   the configured channel list. This proves the ledger scope, not support for
   two configured Feishu channels.
2. A new session loading a persisted binding has no standing anchor. Its input
   event invents no presentation or outgoing card. A positive control in the
   same session establishes another Team's anchor and observes actual COT
   rendering; that control waits for the asynchronous binding announcement.
3. The controlled runtime observes Core-rendered default, custom and empty
   reminders: respectively one, one and zero reminder siblings. A custom note
   replaces the default rather than adding another slot.
4. Extension-owned intervals actually fire in both contract and real-Core arms,
   without a click or sibling transport. Binding gates delivery, repeated IDs
   deduplicate in real Core, and shutdown freezes timer and input counts.

## Review and coverage limits

One xhigh implementation-review workflow started on 2026-10-10 after pre-review.
It includes the five shared correctness angles, the combined cleanup finder,
the Dreamux requirement-fidelity finder, per-location independent verification
and the bounded second-tier sweep. It completed with full coverage and four consolidated findings. The
[round-1 adjudication](/.agents/tasks/channel/add-extension-input-delivery/implementation-review/round-1.md)
records the verified premises and historical-ruling reconciliation. After that
lookup, the operator instructed continuation; the same writer is correcting
R1/R2/R4 within the approved source/test boundary. The corrections passed TeamLeader pre-review and bounded independent
fixed-point verification; all four findings are closed.
The first design reviews were read-only and are not implementation acceptance.
No live bot, WS transport, daemon, platform or tenant operation was run. Core
deduplication remains process-local and bounded; these tests do not establish
crash-safe exactly-once delivery. Actual downstream code deletion belongs to the
later adaptation task.

## Post-review correction evidence

On 2026-10-11 the same developer completed R1/R2/R4. The TeamLeader inspected
the actual corrected source/tests and independently reran both focused test
files: 26 contract tests and five real-Core tests passed. Rush build to Core
exited 0 with nine cached/up-to-date operations; `git diff --check` passed.
The developer's serial full closure build, lint, `typecheck:tests` and test runs
all succeeded; the TeamLeader inspected the final test logs containing 736
Feishu tests and 1128 Core tests, with only the previously recorded skips.

- R1 preserves open own string-key metadata via `Object.fromEntries`, without
  adding validation or prototype guards. Contract assertions inspect the own
  property; the real-Core arm observes it in rendered runtime input. The
  developer temporarily restored the old constructor and observed the contract
  assertion fail, then restored the fix.
- R2 observes each actual timer outcome and counts only admitted ticks as Core
  submissions. A developer-only forced delayed-binding probe produced two
  correct refusals followed by admission and passed; the probe was removed.
- R4 registers created sessions before initialization and closes them from
  unconditional teardown before restoring mocks or removing storage. The
  developer injected an assertion failure with a live interval and observed
  teardown clear it; the probe was removed.

The discriminating probes above are developer-reported experiments, not
TeamLeader reruns. Two existing independent verifier seats now inspect the
complete corrected areas and their tests without repeating runtime gates.

### Remaining R4 fixture resource

The fixed-point verifier identified a test-held deferred command that could
prevent unconditional close from draining after an assertion failure. The same
writer registered all four held-command sites and settles them before session
cleanup. The TeamLeader inspected the complete corrected fixture and confirmed
there is no unregistered use of the deferred command primitive. The developer
reported discriminating injected-failure runs: ordinary assertion failures with
the release loop, hook timeouts without it, and removal of all probes afterwards.
The focused contract file remains 26/26; full Feishu tests remain 736 passed, and
Feishu closure lint/typechecking pass. Product source and Core tests were unchanged
in this follow-up. The original independent verifier inspected all four held-command sites,
release-before-drain ordering and the unchanged success-path answers, and closed
R4 without a remaining in-scope finding.

The TeamLeader also independently reran closure lint (nine successful operations)
and `typecheck:tests` (eight successful operations, one no-op) after the first
correction; the final fixture-only follow-up has developer static evidence.

## Knowledge reconciliation

The TeamLeader has updated the channel-domain extension contract and public
product catalog, replacing the contradictory no-delivery statement. Package
guidance and the release note remain part of the reviewed implementation. The
channel owner also records the property-preservation regression trap from the
historical ruling; it requires data-property construction, not a prototype guard.
The original documentation verifier checked the actual API, routing, lifecycle,
result, deduplication, presentation and property-construction sources, and closed
R3 without an inconsistency.

## Final review closure

R1 and R2 retain their independent closed verdicts. R4 is closed after its
held-command follow-up; R3 is closed by reconciliation of its two owning pages.
The final focused contract rerun passed 26/26 on 2026-10-11. Independent
fixed-point reviewers performed static checks, not duplicate runtime runs.
The actual change still matches the approved implementation boundary. No
source/test writer remains active, and no downstream adaptation was performed.

## Before-PR gates

On 2026-10-11 the unified knowledge check passed: 53 task records checked and
352 knowledge files reachable. The focused task check passed with the stable
`done` state, and `git diff --check` passed. No knowledge script changed, so no
script-focused test is required. Maintenance/glossary/root-routing changes are
N/A for the reasons recorded in the task README.

Release declarations include the Feishu capability's minor note and a Core
`none` note for its integration-test-only delta. The TeamLeader and independent
metadata verifier inspected both notes and confirmed no additional shipped Core
change. Rush declaration verification is performed on the completed commit before
push, because the declaration files are part of that commit.

The completed-commit Rush change verification passed against `origin/next`,
finding both declaration files. The mandatory staged ESLint, author identity,
gitleaks and internal-content commit gates passed; no bypass was used. The
post-commit knowledge check also passed and the working tree was clean.
