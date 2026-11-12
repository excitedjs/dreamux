# Complete-change review

Status: assigned complete-diff reviews received; R1-R4 corrected and verified.
R5 validation was deferred by the operator. On 2026-11-12 the operator approved
knowledge-closeout with that explicit coverage limitation retained.

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
