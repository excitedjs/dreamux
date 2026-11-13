# Complete-change review

## Follow-up formal review, 2026-11-13

The operator approved entry into review at 11:59 (UTC+08:00). The frozen target
was the source published by [the alpha release run](https://github.com/excitedjs/dreamux/actions/runs/43210501365)
through the complete worktree at review: staged, unstaged and untracked
deliverable files. It includes
both installation corrections and cooperative shutdown. The earlier baseline
review remains recorded below; this review does not silently substitute the
last small patch for the full follow-up delta.

Independent assignments cover all 35 changed/new deliverable files:

- Service reviewer: six host production files covering CLI shutdown, Windows
  control, Server and command wiring, plus five command/control/exit tests.
- Native reviewer: both changed utility owners, their two test files and the
  utility README. This reviewer did not author those changes.
- Installation/documentation reviewer: the credential script and Task tests,
  the host-to-CoT integration test, all twelve remaining documentation files
  and four Rush notes. This reviewer did not author those changes.

All three independent reports were received and adjudicated at 12:06
(UTC+08:00). No new actionable correctness or security defect, or new blocking
coverage gap, was identified in the complete follow-up delta. No accepted
blocking finding remains unresolved. The implementation stayed frozen; this
review did not run tests or operate the installed service.

Actual coverage was:

| Review seat | Changed files and supporting checks | Result |
| --- | --- | --- |
| Service lifecycle | Host `cli/server.ts`, `daemon/windows.ts`, `server-commands.ts`, `server.ts`, `server/command-host.ts`, `server/shutdown.ts`; tests `core-command-adapters`, `core-command-registry`, `daemon-windows-control`, `daemon-windows` and `server-shutdown`. Cross-checked admin transport, command admission/drain, entry and Job/SupervisedChild contracts. | No new actionable defect or blocker in the 11 assigned files. |
| Native ownership and permissions | Utils `windows-job.ts`, `windows-security.ts`, `os.test.ts`, `windows-job.test.ts` and README; all changed hunks, query/control access, retained member identity and finite wait, native setter authorization and failure cleanup. | No actionable blocking defect in the five assigned files. The reviewer did not audit every unchanged historical test line. |
| Credentials, CoT and documentation | Host `windows-credentials.ts`, `windows-task.test.ts` and `feishu-extension-input-delivery.test.ts`; all 12 remaining changed/new documentation files and all four host/utils change notes. Cross-checked credential resource lifetime, test substitutes, the real host-to-CoT producer and documentation claims against their owners. | No new actionable defect or blocking coverage gap in the 19 assigned files. |

The complete-change review covers the follow-up diff and relevant contracts,
not a new line-by-line audit of every unchanged repository file. Reviewers did
not certify their own authored implementation. Previously executed verification
remains recorded separately in [verification](verification.md); no new test
execution is implied by these static conclusions.

The documentation reviewer noted minor closeout housekeeping: identify older
implementation/KB statements as facts at their recorded checkpoints, and update
the knowledge-owner summary from forced stop to cooperative shutdown followed
by forced cleanup. These are temporal/summary clarifications, not new product
defects or a rewrite of historical gate outcomes. The operator-approved
knowledge closeout corrected those checkpoint descriptions and the summary.
It also updated two architecture owners for the shared exit owner and command
admission. Independent review of those two additional documentation files and
the three task records found no blocker or scope change. These five closeout
document checks are separate from the 35-file implementation review above;
production and tests remained frozen.

Ordinary-permission adoption, real fixed-account UI and Password behavior,
cross-session operation, existing registered Task ACL preservation, and R5
retain their recorded acceptance gaps and deferrals. The historical Job error 5
cause and R6 workflow defect remain unchanged. Layered isolated tests do not
establish real Windows-service-to-Feishu terminal delivery. Review completion
does not waive these boundaries or authorize deployment or merging. The task
entered `knowledge-closeout` after the operator selected "Enter closeout" at
12:07 (UTC+08:00), retaining those acceptance limits and deferrals.

## Cooperative-stop implementation checks, 2026-11-13

The operator approved cooperative Windows stop/restart and isolated regression
verification. Independent static checks covered retained member identity, the
shared request/wait deadline, force/Task/Enabled cleanup, the process shutdown
owner, command acceptance without self-drain, startup sequencing, and real
host-to-CoT close ordering with a fake transport.

Two implementation-review findings were corrected: an already-gone status PID
must continue cleanup rather than be classified as a live outsider, and test
gate release must remain inside finally protection for controller join and
fixture cleanup. The test-only listener/logger type correction and current-state
documentation corrections also received narrow review. No remaining static
blocker was identified in those inspected paths. See [verification](verification.md)
for executed gates. At that checkpoint the formal complete-delta review was
pending; these scoped checks did not replace it or certify real service/remote-card
delivery. The completed formal review is recorded above.

## Installation follow-up implementation checks, 2026-11-13

At this checkpoint the task had returned to implementation for the installation
follow-up. The earlier complete-change review below did not certify that new delta.
Independent static checks covered owner admission and native setter boundaries,
the fixed-account credential script and declaration-compiling tests, the three
Job query callers and retained control path, and the native Job regression.
Unexpected-success handle leaks in the new Job test were corrected; test-local
COM account canonicalization was restored without restoring product alias
input. No remaining static blocker was found in those inspected paths.

The custom restricted-token fixture never reached the product call. Separate
private-desktop and process/thread-descriptor changes did not remove its
initialization failure. Review supported removing that unproved mechanism and
retaining direct native permission/content assertions. This is not a waiver of
the original non-administrator acceptance requirement, which remains open.
Credential declaration compilation and intercepted prompt/registration tests
also do not establish real dialog behavior or Password persistence. The
historical Job access-denied cause remains unlocated. See [verification](verification.md)
for executed checks. Formal complete-delta review and its stage decision were
pending at that checkpoint. No service, live credentials, or deferred R5 operation
was performed.

## Prior review status

Assigned complete-diff reviews were received; R1-R4 corrected and verified.
R5 validation was deferred by the operator. On 2026-11-12 the operator approved
knowledge-closeout with that explicit coverage limitation retained.
After the operator approved `done`, delivery CI exposed R6. The operator chose
a new branch and replacement PR instead of the proposed workflow correction.
The old failure remains recorded; fresh delivery CI is required. The prior
completed review does not certify the failed push event.

## Target and evidence

The review covered the local working tree prepared for
[PR #476](https://github.com/excitedjs/dreamux/pull/476), including untracked
implementation files, after rebasing onto `next` following
[PR #485](https://github.com/excitedjs/dreamux/pull/485). It covered the whole
proposed change, not only the most recent Task-permission correction.
Implementation was frozen during review except for the corrections explicitly
ratified below; their resulting changes received independent follow-up review.

Review against the [requirement](requirement.md), [final design](technical-design/final.md),
[approved entry revision](technical-design/service-entry-revision.md), and
[verification record](verification.md). Existing narrow implementation reviews
and passing tests are evidence, not a substitute for complete-diff review.

## Coverage assignments

- Service reviewer: Windows registration, credentials, entry and control;
  install/status/removal callers, CLI, root/path contracts and their tests.
- Native/runtime reviewer: shared process/filesystem/native capabilities,
  provider runtime integration and affected channel attachment behavior.
- Tooling reviewer: repository scripts, hooks, CI/release changes, shared test
  isolation, package configuration and changesets.
- TeamLeader: remaining host source/tests, public and knowledge documentation,
  integration between owners, and coverage reconciliation.

Each reviewer reports inspected coverage, concrete findings with a triggering
scenario and source location, and evidence limits. Reviews are read-only; they
do not run tests, alter Tasks, prompt for credentials or change the installation.

## Findings and adjudication

All assigned review reports have been received. R1-R4 are resolved. R5 remains
an unverified coverage gap under the operator's deferral; it is not a reproduced
failure or a passed check. The operator approved proceeding to knowledge-closeout
with that stated limitation on 2026-11-12.

| Finding | Disposition | Evidence and reason | Operator ruling |
| --- | --- | --- | --- |
| R1: current package guidance and a pending release note still describe the removed generated launcher | Accepted and resolved | The three current descriptions in `packages/dreamux/README.md`, maintenance `SKILL.md`, and the pending feature changefile now describe the packaged entry and Task Data. Scoped diff/JSON checks and independent source-based review pass. Historical migration evidence and production behavior are preserved; no runtime tests were repeated for this documentation-only correction. | Operator selected "Correct documentation" on 2026-11-12 for these three locations; correction stayed within that scope |
| R2: the CI policy table contradicts the restored author-email check | Accepted and resolved | The table now identifies Git commit author email and states that GitHub noreply addresses pass directly, matching `.github/workflows/ci.yml` and the same document's local-hook/CI distinction. Scoped diff check and independent source-based review pass. The CI, hook and email policy are unchanged. | Operator requested correction on 2026-11-12 and separately supplied the intended future Git author identity |
| R3 (P1): Windows uninstall protection compares paths case-sensitively | Accepted and resolved | The pre-correction comparisons at `onboard/uninstall.ts:181` and `:239-240` allowed case aliases on Windows to bypass protection. Comparison keys now normalize Windows case without changing filesystem targets or Unix behavior. Eight isolated regressions and the complete uninstall file pass; independent review and all integrated gates pass. See the R3 verification section. | Operator selected "Correct and verify" on 2026-11-12 at 13:34 (UTC+08:00); correction stayed within that scope |
| R4 (P2): service-owned installation drops the restart handoff result | Accepted and resolved | The pre-correction register/install chain discarded the control result and inferred `started: true` from the request. It now preserves `handedOff`, reports `started: false` for self-install handoff and states unconfirmed completion in daemon/onboard output. Eight focused cases, independent review and all integrated gates pass. Unix and dry-run behavior and the control mechanism are unchanged; see the R4 verification section. | Operator selected "Correct and verify" on 2026-11-12; correction stayed within that scope |
| R5: stopping a service entry before it joins the Job lacks lifecycle evidence | Validation deferred by the operator; coverage gap remains open | `windows-entry.ts:26-29` opens stderr before asynchronous Job creation/assignment. Stop can reserve an empty Job during this interval, then relies on Task completion checks. Existing control fixtures wait for ready first. Entry exit and file release in this window remain unverified; passing ready-state tests do not cover it. No failure is claimed and no experiment was prepared or executed. | Operator selected "Defer this item" on 2026-11-12; suspend this validation and retain the review-closeout boundary |

## Delivery finding R6: unavailable push-before commit

The [first rebased push run](https://github.com/excitedjs/dreamux/actions/runs/43207356712)
failed its commit-metadata job while calculating the old/new revision range:
`git log` reported `Invalid revision range` and exited 128 before evaluating
author email. The checkout fetched current heads and tags with full depth, but
the force-push's previous tip was no longer reachable through those refs.
The new head checked out successfully. The PR metadata job's success does not
resolve this push-event failure.

Independent source/log review confirmed the workflow gap. A narrow fetch of
the missing old commit, followed by the unchanged range check, was proposed.
In response to the correction card on 2026-11-12, the operator instead requested
closing the old PR and opening a new one. PR #488 now targets `next` from a new
branch; PR #476 is closed with a replacement link. No workflow correction or
isolated Git regression was executed, and noreply, ERE and denylist policy are
unchanged. The original force-push boundary remains uncorrected; new-branch
delivery must pass its own CI and is not evidence that the old failure was fixed.

## Completed coverage

The tooling reviewer inspected all `common/` changes against the fixed baseline,
including 20 changefiles, lockfile, hook and Node scripts; all three workflows;
the knowledge checker and affected workflow references; root configuration;
all changed package manifests and four Vitest configurations; and the host's
test-isolation fixtures and internal-content tests. The review found R1's release
note mismatch and independently confirmed R2. No runtime blocker or removed
security gate was found in that scope. Permission-oracle internals remain with
the native/runtime reviewer.

The TeamLeader inspected the remaining host launch, admin IPC, logger, journal,
worktree and MCP source changes and their changed tests, together with current
public and knowledge documentation and the approved entry revision. R1's two
package-documentation references were confirmed against current service source.
The cross-owner dispositions are recorded above.

The service reviewer inspected all ten daemon source files, including the three
new modules; path and command-runner contracts; daemon CLI, doctor and onboard
callers; and changed service, registration, command, uninstall and provider-path
tests. The TeamLeader independently checked R3 and R4 against the call paths.
R5 is retained as missing evidence, not as a demonstrated historical failure.
The possible custom MCP executable issue was not established by a concrete
production path and is not adopted as a finding.

The native/runtime reviewer inspected all 11 changed utils source modules and
nine changed tests, their README/package, all Codex and Claude source/test
differences including upstream integration, affected Feishu attachment and
budget tests, the two permission-oracle files, and native dependency entries.
No actionable additional defect or undisclosed significant coverage gap was
confirmed in that scope. The later-pipe-instance DACL concern was not supported
by the shared-security-descriptor contract or current source; it is not adopted
as a finding. Existing repeated-connection ACL tests were inspected, not rerun.

Coverage refers to all changed hunks/new modules and the relevant call chains,
not a line-by-line audit of every unchanged historical file. Combined assignments
cover the proposed change from the fixed baseline, including untracked files.

The independent reviews themselves were read-only. Following the R3 ruling,
the TeamLeader ran its isolated regressions and integrated gates, recorded in
the verification document. The separately approved R4 correction also passed
independent review, isolated regressions and integrated gates. Neither correction
exercised credentials, changed Tasks or operated the installed service. The verification record remains the
source of executed evidence and its native-acceptance limits.
