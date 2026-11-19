# Support native Windows execution

## Current state

- Goal: Run Dreamux natively on Windows, then deliver a PR and publish an alpha from its branch.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/native-windows-support/requirement.md)
- Final solution: [Native process and filesystem boundaries](technical-design/final.md)
- Verification: [Checks and coverage](verification.md)
- Review: [Complete-change review and rulings](review.md)
- Blockers: Non-administrator adoption of legacy BA-owned logs remains unverified: the custom restricted-token fixture failed before product code, and this runner has no linked Limited token. Real fixed-account UI and Password registration also remain unverified. The reported Job access-denied call site and cause remain unknown. R5 remains explicitly deferred and unverified; R6's force-push metadata range defect remains unchanged.
- Next action: Deliver the verified Windows media/publication correction to the existing PR, reply to the accepted wording threads and evaluate fresh-head CI. GitHub owns delivery results; no release, installed-service operation or merge is included.
- Coverage limit: The earlier installation failure is distinct from the later successful upgrade and recovery-callback retry. The operator reported an interrupted CoT card on that retry; it does not certify this subsequent source correction. Native credential storage, dialog behavior and general cross-session service operation still need independent acceptance; earlier CI results do not cover this revision.
- Pull request: [Native Windows support](https://github.com/excitedjs/dreamux/pull/488); replaces [the closed original PR](https://github.com/excitedjs/dreamux/pull/476).
- Related tasks: None.

## Development approval

- On 2026-11-19 at 16:56 (UTC+08:00), the operator instructed: "修一下推上去好不好？为什么每次都需要我说？你看到这个评论之后，不就应该去调查一下是什么原因？然后如果是需要修复的问题，就直接修复吗？" (English translation: "Fix it and push it. Why do I have to say it every time? After seeing the comment, should you not investigate the cause and directly fix it if it is a real problem?") This explicitly authorizes investigation, correction, verification, independent review and delivery of the confirmed PR findings without repeated routine stage confirmations. The scope is Windows reply-media paths, concurrent Claude skill publication and the two wording corrections; it preserves existing capabilities and native acceptance limits. The prior merge pause remains in force.

- On 2026-11-16 at 14:40 (UTC+08:00), the operator instructed: "rebase 一下，然后判断下 评论内容，如果是问题就修掉，不是问题就回复并关掉。" (English translation: "Rebase, then evaluate the comments; fix actual problems, otherwise reply and close them.") This authorizes rebasing PR #488 onto current `next`, evidence-based adjudication of its review comments, necessary corrections and verification, and public replies/resolution of nonissues. Existing delivery authority covers the resulting branch update; merging, release, installed-service changes and deferred native experiments remain outside this follow-up.

- On 2026-11-13 at 16:17 (UTC+08:00), after receiving the adjudicated DeepSeek and MiMo simplify findings, the operator explicitly instructed: "该修的就修一下吧。" (English translation: "Make the necessary fixes.") This renews implementation authority for the four reported findings and their regression verification and independent review. The chosen scope removes duplicate launch-failure notification, avoids temporary publication for existing logs, shares the PID query while preserving distinct Job checks, and aligns SystemRoot duplicate-key precedence. Suggestions to remove existing-file permissions checks, PID validation or Job control capability, or cache native descriptors, are excluded. No live-service operation, new release or merge is included.

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

The November 19 correction implements native Windows reply-media paths and
process-local Claude publication coordination, with the two accepted wording
corrections. The complete eight-file source/test/instruction delta and seven
current-owner documents have received independent static review. Build, lint,
test-aware typechecking and the complete suite passed: 3,365 cases with 26
explicit skips. The affected owners and task records are reconciled; four
package patch notes describe the correction. `done` records submission readiness
under the explicit November 19 fix-and-push instruction; mandatory commit gates,
fresh-head CI and public comment replies belong to delivery. This does not
authorize merging, release or installed-service changes.
The full KB check passed without exceptions: 66 task records and 428 reachable
files. The initial update's retained disposable cache and subsequent successful
isolation checks are distinguished in the verification record.

The November 16 correction was submission-ready under the operator's explicit
rebase/fix/reply instruction and the existing delivery authority. Independent
review covered the complete thirteen-file code/test delta, affected knowledge
owners, two patch notes and fourteen proposed replies. Build, lint, test
typechecking and the unfiltered suite passed; the suite contains 3,254 passed
and 26 skipped cases. Current product, state/config, maintenance and utils
owners record explicit-platform lookup and captured Windows overrides while
preserving Scheduler inheritance, Job identity and existing capabilities.
Task requirement/design/review/verification records are reconciled. Unchanged
architecture, provider, glossary and global operating rules need no update.
Full KB validation passed without exceptions: 64 task records and 420 reachable
files. Mandatory commit gates precede branch delivery; CI and thread status
remain owned by GitHub. No merge, release or service operation is included in
this follow-up.

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
| [Product catalog](/.agents/product/README.md) | Updated: native reply-media paths and protocol-relative URL exclusion, plus the earlier installation, shutdown, handoff and uninstall boundaries. |
| [Current architecture](/.agents/domains/current-architecture.md) and [service topology](/.agents/domains/service-topology.md) | Updated: shared signal/admin process-exit owner, server command namespace, command admission and startup/shutdown sequencing. No new service tier or package was introduced. |
| [Provider runtime](/.agents/domains/provider-runtime.md) and Claude package README | Updated: process-local per-root publication coordination, same-inventory winner reuse and stable-path refresh; no interprocess or transactional freshness guarantee. |
| [Channel](/.agents/domains/channel.md), channel/transport package READMEs and [built-in Feishu maintenance](/packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-feishu.md) | Updated: native media path recognition, matching artifact schema/parser, Markdown escaping and `//` exclusion. Upload ordering and failure behavior remain unchanged. |
| [State/config/files](/.agents/domains/state-config-and-files.md) | Updated: fixed-account credentials, BA-owner adoption subject to OS authorization, query/control access, retained member identity and bounded cooperative shutdown. Task Data/root ownership and non-file TaskPath rules remain intact. |
| [Repository operations](/.agents/domains/repository-operations-and-release.md) and [unit testing](/.agents/domains/unit-testing.md) | N/A for the follow-up: existing Node gates, email policy, Vitest isolation and permission-oracle ownership remain applicable. The failed launcher experiment adds no delivered testing mechanism. |
| [Maintenance skill](/packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md) and [service lifecycle](/packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md) | Updated owning reference: fixed-account password input, OS authorization, cooperative shutdown and acceptance/handoff versus completion. Skill routing is unchanged. Release-specific old-alpha migration remains in public upgrade docs and the change note. |
| Public getting-started/operations and utils README | Earlier updates remain accurate: installation, permission failures, query/control separation and cooperative cleanup. November 19 needs no additional change to these owners. |
| Root and host `CLAUDE.md` | Root launcher instruction now describes Node realpath resolution. Host's existing shutdown-owner map remains accurate; build, security, layering and approval policies are unchanged. |
| [KB routing](/.agents/root.md), [contribution guide](/.agents/CONTRIBUTING.md), [domain index](/.agents/domains/README.md) | N/A for the follow-up: existing routes and checker guidance cover the changed owners; no new domain or task was introduced. |
| [Glossary](/.agents/glossary.md) | N/A: no new overloaded Dreamux product term; Job and Task Data are platform concepts documented by their owners. |

Independent follow-up owner reconciliation confirmed this mapping. The
106 unrelated historical records restored during reassessment remain identical
to the rebased upstream baseline; current command updates do not rewrite their
past evidence. The verification document distinguishes code checks, native
Interactive lifecycle evidence and unverified Password/cross-session behavior.
