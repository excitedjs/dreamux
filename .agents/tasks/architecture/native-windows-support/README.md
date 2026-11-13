# Support native Windows execution

## Current state

- Goal: Run Dreamux natively on Windows, then deliver a PR and publish an alpha from its branch.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/native-windows-support/requirement.md)
- Final solution: [Native process and filesystem boundaries](technical-design/final.md)
- Verification: [Checks and coverage](verification.md)
- Review: [Complete-change review and rulings](review.md)
- Blockers: Non-administrator adoption of legacy BA-owned logs remains unverified: the custom restricted-token fixture failed before product code, and this runner has no linked Limited token. Real fixed-account UI and Password registration also remain unverified. The reported Job access-denied call site and cause remain unknown. R5 remains explicitly deferred and unverified; R6's force-push metadata range defect remains unchanged.
- Next action: Continue the operator-approved PR delivery after R7's test correction, isolated verification and independent review. The corrected assertion and complete local gates pass; fresh exact-head CI is still required and the earlier failed run remains evidence. Ordinary non-elevated validation remains deferred, native acceptance gaps are not waived, and R5 must not be prepared or executed. Local update and merging remain paused.
- Coverage limit: The operator's reported restart failure has not been reproduced. WMI process creation and Scheduler command completion do not establish a new responding server. Native credential storage, dialog behavior and cross-session service operation still need independent acceptance; earlier CI results do not cover this revision.
- Pull request: [Native Windows support](https://github.com/excitedjs/dreamux/pull/488); replaces [the closed original PR](https://github.com/excitedjs/dreamux/pull/476).
- Related tasks: None.

## Development approval

- On 2026-11-13 at 12:33 (UTC+08:00), the operator selected "Correct and continue" for R7. Approval covers the Job test's held-object post-exit assertions, a separate native error-87 mapping assertion, evidence updates, isolated verification, independent review and continued PR/CI delivery. Production behavior, live services, deferred validation and merging remain outside this correction.

- On 2026-11-13 at 12:14 (UTC+08:00), the operator selected "Enter delivery", confirming knowledge closeout and `done` as this follow-up's submission readiness. The approved next work is to pass the complete KB and mandatory commit gates, update PR #488 and verify its exact-head CI. The recorded native acceptance gaps remain open; local update and merging remain paused.

- On 2026-11-13 at 12:07 (UTC+08:00), the operator selected "Enter closeout" with the unresolved native acceptance and R5 deferral explicitly retained. This authorizes knowledge-owner reconciliation, historical checkpoint clarification and task-record validation. It does not authorize live service operations, resuming deferred validation, publishing or merging.

- On 2026-11-13 at 11:59 (UTC+08:00), the operator selected "Enter review" after receiving the complete implementation and verification summary. This opens formal independent review of all installation and cooperative-stop follow-up changes relative to the published revision. It does not authorize publishing, changing the running installation, resuming deferred native acceptance, or merging.

- On 2026-11-13 the operator reported that CoT did not become interrupted on restart and suspected Windows stop/restart left Node no cleanup time. Read-only inspection confirmed immediate Job termination bypassed the existing application shutdown path in the installed version and pre-correction source. The operator then selected "Fix and verify" in the cooperative-stop card, approving the [cooperative-stop solution](technical-design/graceful-windows-stop.md) and isolated regressions. This authorizes bounded application shutdown before forced cleanup, not operations on the running service or a claim that the live incident was reproduced. Existing deferred validation boundaries remain unchanged.

- On 2026-11-13 the operator selected "Verify later" when asked to open an ordinary PowerShell terminal for a temporary-directory-only permission check. This defers that non-elevated validation; it does not waive acceptance or certify ordinary-user installation. Existing source changes and verification evidence were retained, and the task remained in implementation at that checkpoint.

- On 2026-11-13 the operator requested: "Installation is not going smoothly; make it smoother." This renews the existing Windows installation correction scope after the local upgrade incident. Implementation addresses legacy Administrators-owned logs with sufficient object permissions, fixed-current-account password input, and unnecessarily broad Job observation access. These are corrective implementation choices, not a claim that the operator selected particular Windows APIs. Verification uses disposable fixtures; the running service, installed package, real credentials and deferred R5 experiment remain untouched. The local incident record distinguishes the failed automated upgrade from later manual recovery; that recovery does not certify the installer.

- On 2026-10-18 the operator selected native Windows source support in the runtime-choice card, then explicitly instructed implementation.
- Approved boundary: Native CLI, local IPC, provider processes, managed service, and Windows test infrastructure. The operator separately required Windows test failures to be repaired in the test infrastructure.
- Delivery authority: The operator explicitly requested a PR first, then an alpha built from that PR branch. This authorizes publishing the branch and alpha, not merging into `next`.
- The operator prioritized completing this repository after a test-isolation incident. Recovery of unrelated operator state is outside this public change; regression prevention belongs here.
- On 2026-10-19 the operator required Dreamux-provided capabilities to be independent of the platform, explicitly allowing platform command lines for installing and controlling the persistent platform service. The implementation uses Node APIs where available and native bindings behind shared capability boundaries otherwise; this instruction also covers avoidable Bash usage in development and test tools.
- On 2026-10-19 the operator explicitly approved six authenticated model tests through the interactive card. Those tests passed against the final native implementation using disposable homes and locally intercepted channel IO.
- On 2026-10-19 at 13:18 (UTC+08:00), after re-review, the operator explicitly instructed correction of the three reported findings: provider log ownership, Windows PATH precedence, and large Job termination. This authorizes their implementation and regression verification within the existing PR; it does not authorize a merge or another release/install operation.
- On 2026-10-19 at 15:33 (UTC+08:00), the operator explicitly requested the non-blocking failure-injection tests suggested in the [PR review](https://github.com/excitedjs/dreamux/pull/476#pullrequestreview-5568105760): interrupted or mismatched bootstrap identity verification and candidate-process exit before Job termination. This extends test coverage within the existing PR without authorizing a merge or release.
- On 2026-10-19 at 16:24 (UTC+08:00), the operator explicitly instructed correction of the [eager Koffi loading comment](https://github.com/excitedjs/dreamux/pull/476#discussion_r4311329746). This authorizes lazy initialization within the native owners, behavioral regressions and delivery to the existing PR.
- On 2026-10-19 at 16:56 (UTC+08:00), the operator required investigation of the actual CI failure causes before reporting completion. A successful rerun alone is not causal evidence. This follow-up remains within the previously authorized Windows failure corrections.
- On 2026-10-19 at 20:18 (UTC+08:00), the operator paused the previously requested merge to review the test-script changes.
- On 2026-10-19 at 21:45 (UTC+08:00), the operator explicitly instructed using Vitest's native capabilities after reviewing the proposed replacement of the custom launcher. This authorizes configuration, lifecycle setup, regression verification and delivery to the existing PR; it does not resume the paused merge.
- On 2026-10-19 at 21:49 (UTC+08:00), the operator required small-scope isolation verification before broader test execution to protect existing Dreamux and Codex configuration. The initial verification must itself use disposable account/application homes and sentinel files, with cleanup targets reviewed before execution.
- On 2026-10-19 at 23:30 (UTC+08:00), the operator reported a persistent console window from the installed logon task and said they had changed it to run whether logged on or not. The implementation initially interpreted this as preserving an existing task's manually selected Password mode. That interpretation was insufficient and is superseded by the explicit clarification below.
- On 2026-10-20 at 21:36 (UTC+08:00), the operator clarified: "For the earlier black window issue, I meant installation should use Password mode, not continue installing in the original mode." This authorizes correcting the installation default to Password within the existing PR. It supersedes the Interactive default and the proposed console-hiding workaround. Credentials must be entered locally, never requested in chat or persisted by Dreamux; verification must not modify the operator's running task. The statement does not request a different trigger or resume merging.

## Delivery

On 2026-11-12, in response to the R6 correction card, the operator requested
closing the old PR and opening a new one. Delivery therefore uses the new
`fix/pr-476-review-20261019` branch and PR #488 targeting `next`; PR #476 was
closed after the replacement existed and now links to it. No workflow or email
policy correction was authorized or applied. The original force-push failure
remains evidence of that workflow boundary, and fresh delivery checks are
required; replacing the PR does not turn the old failed run into a pass.

On 2026-11-12 the operator selected "Enter delivery" in the closeout-completion
card; this approval was recorded at 19:12 (UTC+08:00). At that point the task
entered `done`, meaning submission readiness after independent review and knowledge closeout.
The full KB check and mandatory commit gates must pass before submission. The
existing authorization covers the branch alpha and local update, while R5
remains deferred, native acceptance limits remain recorded, and merging is
still paused.

On 2026-11-12 the operator selected "Enter closeout" with the R5 deferral stated
explicitly. This authorizes knowledge-closeout while retaining the unverified
early-entry stop boundary; it does not authorize the deferred experiment or
represent that it passed. The conditional branch alpha and local update request
continues after closeout and submission readiness.

On 2026-11-12 the operator requested correction of R2 after asking whether the
email check refers to Git commit authors, and supplied the intended Git identity.
The documentation correction is limited to the CI table's existing noreply
exemption. Apply the specified identity to repository-local Git configuration
for future commits; do not rewrite existing commits or change email policy.

On 2026-11-12 the operator selected "Correct documentation" for R1. The approved
scope is the current package README, maintenance routing sentence, and pending
feature change note: describe the packaged service entry and Task Data instead
of the removed generated launcher. Preserve historical migration records and
production behavior; verify the documentation delta independently.

On 2026-11-12 the operator selected "Defer this item" for the R5 early-entry
stop validation card. Do not prepare or execute that experiment. The lifecycle
coverage gap is retained, not marked passed. At that ruling, review closeout
remained pending.
This ruling does not cancel the conditional alpha publication and local update
request or authorize corrections for the other findings.

On 2026-11-12 the operator selected "Correct and verify" for review finding R4.
This authorizes preserving installation handoff in the result and CLI/onboard
output, with isolated regression verification. It does not change the restart
mechanism or authorize corrections for R1, R2 or R5.

On 2026-11-12 at 13:38 (UTC+08:00), the operator requested an alpha workflow
run from the current development branch and an update of the local installation
once no unresolved problems remain. This authorizes branch alpha publication
and local update after review and verification closeout, not merging into next.
The approved old-alpha service migration and credential-input boundaries still
apply; the running installation has not yet been changed.

On 2026-11-12 at 13:34 (UTC+08:00), the operator selected "Correct and verify"
for review finding R3. Approval is limited to Windows uninstall path comparison
and isolated regressions for protected case aliases, with independent review.
Other review findings remained unapproved at that ruling; R4 was approved
separately as recorded above.

On 2026-11-12 the operator selected "Enter review" in the complete-review card.
This authorizes the transition from implementation to independent review of the
entire current change. It does not authorize merging or modifying the running
installation. The review started at 13:24 (UTC+08:00).

On 2026-11-12 the operator selected "Adopt the new entry" in the service-format
decision card. This approves deleting the generated launcher format and its
parser, with the one-time old-version service uninstall/reinstall requirement
specified in the service-entry revision. The approval covers branch
implementation and isolated verification, not changing the running installation,
rewriting the published branch or resuming the paused merge.

The operator reopened this implementation on 2026-11-12: rebase the local branch
onto `next`, reconsider which additions are necessary, repair Windows stop and
restart, and collect the Password-mode credential through a local popup window.
This continues the existing correction authority. The old branch is preserved
locally; rewriting the published branch, merging, another release, and changing
the operator's running installation have not been performed.

- Deliver the approved corrections to the existing PR targeting `next`. GitHub owns delivery status; merging remains paused by the operator.
- Knowledge closeout: Follow-up owner reconciliation and independent documentation review completed on 2026-11-13; the operator confirmed submission readiness that day. The subsequent full KB check passed without exceptions: 63 task records and 415 reachable files. Current facts remain separate from historical verification evidence.

## Knowledge owners

| Owner | Disposition and reason |
| --- | --- |
| Task requirement, final design, entry revision, review and verification | Updated: installation corrections, cooperative shutdown, complete follow-up review and executed evidence are reconciled with prior Task Data/entry migration, handoff and uninstall decisions. Native acceptance limits and deferred R5 remain explicit; past checkpoints are identified as historical. Review cites the release run that owns its exact baseline. |
| [Product catalog](/.agents/product/README.md) | Updated: fixed-account installation, Task ownership, cooperative shutdown followed by forced cleanup, handoff reporting and uninstall boundaries. |
| [Current architecture](/.agents/domains/current-architecture.md) and [service topology](/.agents/domains/service-topology.md) | Updated: shared signal/admin process-exit owner, server command namespace, command admission and startup/shutdown sequencing. No new service tier or package was introduced. |
| [Provider runtime](/.agents/domains/provider-runtime.md) | N/A for the follow-up: the runtime stop contract and neutral provider boundaries are unchanged. Existing native capability documentation remains applicable. |
| [State/config/files](/.agents/domains/state-config-and-files.md) | Updated: fixed-account credentials, BA-owner adoption subject to OS authorization, query/control access, retained member identity and bounded cooperative shutdown. Task Data/root ownership and non-file TaskPath rules remain intact. |
| [Repository operations](/.agents/domains/repository-operations-and-release.md) and [unit testing](/.agents/domains/unit-testing.md) | N/A for the follow-up: existing Node gates, email policy, Vitest isolation and permission-oracle ownership remain applicable. The failed launcher experiment adds no delivered testing mechanism. |
| [Maintenance skill](/packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md) and [service lifecycle](/packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md) | Updated owning reference: fixed-account password input, OS authorization, cooperative shutdown and acceptance/handoff versus completion. Skill routing is unchanged. Release-specific old-alpha migration remains in public upgrade docs and the change note. |
| Public getting-started/operations and utils README | Updated: fixed-account installation, permission failures, query/control separation, cooperative cleanup and real-acceptance limits. Getting-started delegates stop details to operations. Public development and other package READMEs need no follow-up change because their contracts are unchanged. |
| Root and host `CLAUDE.md` | Host map updated for `server/shutdown.ts`. Root and other directory rules are N/A: no global build, security, layering or persistence invariant changed. |
| [KB routing](/.agents/root.md), [contribution guide](/.agents/CONTRIBUTING.md), [domain index](/.agents/domains/README.md) | N/A for the follow-up: existing routes and checker guidance cover the changed owners; no new domain or task was introduced. |
| [Glossary](/.agents/glossary.md) | N/A: no new overloaded Dreamux product term; Job and Task Data are platform concepts documented by their owners. |

Independent follow-up owner reconciliation confirmed this mapping. The
106 unrelated historical records restored during reassessment remain identical
to the rebased upstream baseline; current command updates do not rewrite their
past evidence. The verification document distinguishes code checks, native
Interactive lifecycle evidence and unverified Password/cross-session behavior.
