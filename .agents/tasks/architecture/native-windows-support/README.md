# Support native Windows execution

## Current state

- Goal: Run Dreamux natively on Windows, then deliver a PR and publish an alpha from its branch.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/native-windows-support/requirement.md)
- Final solution: [Native process and filesystem boundaries](technical-design/final.md)
- Verification: [Checks and coverage](verification.md)
- Review: [Complete-change review and rulings](review.md)
- Blockers: No unresolved accepted correction. R1 through R4 are resolved and verified. The operator approved knowledge-closeout with R5 explicitly deferred and unverified; native credential and cross-session limits also remain recorded.
- Next action: Pass the full KB and mandatory commit gates, deliver the reviewed change to the PR, verify CI, publish the branch alpha and update the local installation under the existing authorization. Do not prepare or execute R5. The latest code gates remain R4's build, lint, test-aware checks and default suite (3,193 passed, 26 skipped). Merge remains paused; GitHub owns CI and delivery status.
- Coverage limit: The operator's reported restart failure has not been reproduced. WMI process creation and Scheduler command completion do not establish a new responding server. Native credential storage, dialog behavior and cross-session service operation still need independent acceptance; earlier CI results do not cover this revision.
- Pull request: [Native Windows support](https://github.com/excitedjs/dreamux/pull/476)
- Related tasks: None.

## Development approval

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

On 2026-11-12 the operator selected "Enter delivery" in the closeout-completion
card; this approval was recorded at 19:12 (UTC+08:00). The task is now `done`,
meaning submission readiness after independent review and knowledge closeout.
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
- Knowledge closeout: The owner reconciliation below records current facts separately from historical verification evidence.

## Knowledge owners

| Owner | Disposition and reason |
| --- | --- |
| Task requirement, final design, entry revision, review and verification | Updated: approved Task Data/entry migration, install handoff, uninstall case protection, executed evidence, operator rulings and deferred R5 are reconciled. Review references the delivery PR and upstream PR rather than temporary commit identifiers. |
| [Product catalog](/.agents/product/README.md) | Updated: native Windows behavior, Task service ownership, forced stop, install handoff reporting and uninstall boundaries. |
| [Current architecture](/.agents/domains/current-architecture.md), [provider runtime](/.agents/domains/provider-runtime.md), [service topology](/.agents/domains/service-topology.md) | Updated: shared native capability ownership, local IPC, provider boundaries and current checker entry. No new service tier or package was introduced for test helpers. |
| [State/config/files](/.agents/domains/state-config-and-files.md) | Updated: Task Data and WorkingDirectory ownership, Task paths excluded from file operations, native permissions and control completion. |
| [Repository operations](/.agents/domains/repository-operations-and-release.md), [unit testing](/.agents/domains/unit-testing.md) | Updated: Node tool entries, retained shell email check, CI noreply exemption, inline release gates, Vitest isolation and direct shared permission-oracle imports. |
| [Maintenance skill](/packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md) and [service lifecycle](/packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md) | Updated: current entry, Task Data, native credential dialog and handoff semantics. Release-specific old-alpha migration remains in public upgrade docs and the change note, not the maintenance contract. |
| Public development/getting-started/operations and package READMEs | Updated: Windows launch, service operation, native/runtime capability boundaries and the approved upgrade sequence. Unaffected channel/types/bootstrap package descriptions need no service-owner additions. |
| Root and host `CLAUDE.md` | Updated: current tool entry points and host IPC/module ownership. Other directory invariants are unchanged; no additional local rule is needed. |
| [KB routing](/.agents/root.md), [contribution guide](/.agents/CONTRIBUTING.md), [domain index](/.agents/domains/README.md) | Updated: current Node checker and existing owner routes; the task README links its complete review. |
| [Glossary](/.agents/glossary.md) | N/A: no new overloaded Dreamux product term; Job and Task Data are platform concepts documented by their owners. |

Independent native/service and tooling-owner audits confirmed this mapping. The
106 unrelated historical records restored during reassessment remain identical
to the rebased upstream baseline; current command updates do not rewrite their
past evidence. The verification document distinguishes code checks, native
Interactive lifecycle evidence and unverified Password/cross-session behavior.
