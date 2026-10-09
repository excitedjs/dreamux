# Data-flow implementation review and adjudication

## Scope and coverage

The 2026-09-29 heterogeneous review examined the complete uncommitted R71
continuation after [PR #457](https://github.com/excitedjs/dreamux/pull/457),
including new files, source comments, current-state knowledge, and the selected
[solution](../technical-design/data-flow/final.md). Claude, MiMo, and DeepSeek
covered seven finder angles. The four Rush gates passed before review, with
64 test files and 710 tests; no tests changed and no live validation was claimed.

The first report contained 47 candidates in 28 location groups and synthesized
11 findings. It reported partial coverage: three verifier responses and the
bounded sweep failed structured-output parsing. Three other responses omitted
their verdict field. These were coverage gaps, not passes.

MiMo and Claude independently recovered all six affected verifier groups.
The original DeepSeek sweep returned its completed output without another
sweep: one duplicate plugin-KB finding and one new shared-clock accounting
finding. A separate Claude verifier confirmed the latter as a documentation
gap, not a runtime defect. All missing verdicts and the bounded sweep are now
accounted for. This completes coverage of the reviewed input. The accepted
corrections have since passed all four Rush gates; the correction verification
is recorded separately below. No missing response is inferred from another
reviewer's agreement.

The decisions below are the TeamLeader's source-based adjudication under the
existing R69/R71 implementation authority. Routine corrections preserve the
selected capabilities; none authorizes a deferred product change. Review
verdicts alone do not make hypothetical future failures current regressions.

## Finding decisions

| ID | Finding and evidence | Decision and reason | Ruling conflict |
| --- | --- | --- | --- |
| D1 | Public override contractions lack ordinary minor Rush notes; `provider-runtime.md` prematurely says they are recorded. | Accept. Generate the exact package notes through Rush before delivery. The selected compatibility contraction remains explicit. | None |
| D2 | `TeamCollection.admit` lost its last caller when `runForLeader` was removed (`team/index.ts`). | Accept deletion of the dead entrance. Its hypothetical future shutdown race is not a current defect and does not justify repairing the unused gate. | None |
| D3 | Codex `TurnManagerOptions.log` and Claude session/RPC `log` still transport positional logging callbacks around an available `DreamuxLogger`. | Accept. Use the actual logger through these internal collaborations; preserve logging content, structured error fields, and the separately justified native teardown boundary. | None |
| D4 | `TeammateCollectionOptions.completionOwner` remains nullable although both constructions supply an owner; `WorkflowServiceOptions.runnerEntryPath` has no current supplier. | Accept removal of unsupported variability. Correct the design's mistaken recipient-less collection example. A Workflow run's nullable owed recipient is a different, real state and remains. Trace deleted-test restoration obligations before removing any additional seam. | R43 remains binding |
| D5 | `dissolveReceiptSchema` was copied into `leader-mcp.ts` and remains in `team/mcp.ts`. | Accept one definition in the existing Team projection layer. Both advertise the same output receipt; distinct role input schemas and authorization text must remain distinct. No new shared entity is needed. | None |
| D6 | Lifecycle, scheduler, Team, Agent close, and leader-construction comments describe deleted callbacks or methods. Several module descriptions were displaced by imports. | Accept current-source explanations and mechanical header placement. Remove stale `closeUnbuilt`, `leaderCompletionInitiator`, lazy scheduler, and lifecycle-owned admission claims. | None |
| D7 | Claude plugin documentation still advertises its deleted options type and factory seams. | Accept; audit the corresponding Codex plugin explanation as well. This is source documentation drift, not a provider runtime failure. | None |
| D8 | Public concrete WorkFence and FeishuCoreCommands invoker methods are said to permit misuse. | Reject the asserted defect. Actual holders use narrow views; no current caller misuses close/drain or invokes an unintended command. Additional wrappers or mirrored fields solely to prevent an invented caller add mechanisms. | None |
| D9 | TeamService accepts both `initiator` and `completionRecipient` and overwrites the latter (`team/service.ts:submitInput`). | Accept internal contract convergence. Existing callers use the old alias, so no dropped notification is proven. Remove the alias and preserve current recipient-query timing, Team-only admission, and notification behavior. | None |
| D10 | TeamService assembles leader MCP options while `teamLeaderOptions` owns the rest of the same role's options. | Accept bounded consolidation in the existing leader construction module if it removes the split without introducing a wrapper or reversing dependencies. Keep aggregate lifecycle, roster observation, and completion responsibility with TeamService. File size alone is not the reason. | None |
| D11 | Maintenance references gained internal wiring descriptions unrelated to their diagnostic headings. | Accept a narrow documentation correction: keep actionable current shutdown/state facts; remove internal class-by-class event wiring and relative-change wording. Reject a blanket prohibition on mechanism names, which the existing skill never imposed. | None |
| D12 | `Dispatchers.dispatcherOptions` creates the channel logger before `ChannelService.build`; addressing a disabled dispatcher now creates its channel log. | Accept as a real behavior regression and preserve the old allocation boundary. Only channel logging moved: Workflow logging was already eager. Keep the real CLI logger extension; do not substitute a boolean, fabricate a logger owner, or introduce a lazy proxy merely to retain the earlier design sentence. | Must preserve configured-but-disabled behavior |
| D13 | `plugins.md` still attributes Team announcement to `announceTeam` and launch options to both branches of `openTeamLeader`. | Accept. Current hooks are actual objects called by TeamService; record open/alignment and leader option construction separately. The sweep's same finding is a duplicate. | None |
| D14 | The channel MCP adapter is said to own an incorrect Dispatcher-before-Team gate composition. | Reject. The adapter only sequences two actual owners; the baseline and selected gate table require that order. It contains neither Team policy nor a second fence state. Restoring a captured gate closure or adding a combinator would undo the cleanup. | Preserve existing gate precedence |
| D15 | `nodeProbe` is said to be a dead retained seam. | Reject that premise: the parent deleted-test ledger explicitly preserves its supplier. Accept the accounting correction: name the retained seam, and update obsolete literal-restoration guidance for the removed `execDirProbe` without changing tests in this child. | R43 remains binding |
| D16 | Shared `createScanBudget.now` has live deterministic test suppliers but is absent from the retention accounting. | Accept the confirmed accounting gap. Document the shared clock and its test suppliers; keep it and omit the unused provider adapter clocks. The baseline inventory explicitly excluded anonymous input types, so its original omission is not a separate defect. | Existing supplying tests must remain |
| D17 | Removing leader lookups also removed their access policy: Dispatcher admission and committed Team-closed refusal, including the lookup inside leader dissolve. | Accept the source-reachable preservation correction for the entire family. The leader lease survives the closed-record write while earlier children stop, and dispatcher startup rollback can close admission while the server still accepts requests. Preserve each entry's parsing order and admission span: lookup-only for child tools, the complete dissolve request for dissolve. No new shutdown policy or per-entry compensating owner. | Preserve existing gate precedence |

## Other reviewed claims

| Claim | Decision and evidence | Ruling conflict |
| --- | --- | --- |
| Record-only close compares a different previous identity from the store and can split paired events. | Reject. `UnbuiltAgent.identity` and the transactional store's loaded current identity are the same before-value. The proposed divergence is not reachable. | No replay or compensating state |
| Event order is merely an unsupported listener convention. | Reject. The factory registers publication before its store escapes; the built Agent subscribes later. Initial and record-only aggregate publication also follows the authoritative identity commit. | No new tests in this child |
| The retained Feishu COT clock has no supplier. | Reject. The retained clock is in Feishu transport and has deterministic test consumers; it is not the removed bounded-operation clock. | Preserve supplying tests |
| Passing DispatcherService to the early DispatcherAgent reads undefined child fields. | Reject. Its constructor only holds the aggregate; tool reads occur in `build` after aggregate construction and channel initialization. There is no current early read. | No new setup state |

The review also exposed two directly adjacent accounting details: the
completion policy still passes one object twice under `recipientKey` and
`initiator`, and TeamService's hook type includes the collection-only
`createTeam` capability. Remove the duplicate policy parameter; keep actual
hook objects and describe/narrow the Team's consumed hook view without a new
callback bag.

## Correction result

The same source developer applied executable and package-documentation
corrections. The TeamLeader handles `.agents`, release notes, GitHub, and
delivery. The last executable revision passed build, lint, test, and
typecheck:tests: 64 test files and 710 tests, with an empty test diff.
`git diff --check` passed. No assertion was weakened and no live validation
was performed.

For D12, the selected early logger-value resolution must be corrected because
creating a logger performs IO. A justified retained external factory boundary
is preferable to new lazy state or a wrapper with no behavior. Keep the public
CLI extension and original channel allocation timing; report any design
conflict before changing those semantics.

The cron observation is D17 above. `McpLeaseRegistry.entry` checks the token
and runtime generation, not dispatcher admission or the Team record.
`TeamService.runDissolve` writes closed, awaits Workflow/scheduler/member
teardown, then closes the leader; only that later runtime close releases its
MCP leases. Dispatcher startup rollback likewise closes admission while the
admin socket can remain open. These paths disprove the premise that lease or
global Server shutdown makes the old access checks unreachable.

`TeamService.admitLeaderTools(operation)` restores Dispatcher admission then
the committed closed fact. It deliberately does not test `dissolveTask`.
Child retrieval remains a short admitted operation; each child then keeps its
existing later Team-then-dispatcher check. Dissolve and channel calls instead
admit their full request, and the channel checks closing after committed
closed. The same method serves the entire actual Team's leader-tool family.
There is no missing-record fallback because supported operations never remove
that live leader's Team record. A focused MiMo pass verified child-tool parsing,
access ordering, and channel logger timing, and found one stale Team MCP header.
However, its report also described a late leader dissolve changing from
TeamClosedError to an accepted receipt, then called that change permitted by
the design's "joinable" wording. The TeamLeader rejected this justification:
the baseline collection lookup refused the committed closed record before
service-level joining, and no operator ruling widens that entry. The design's
preservation requirement takes precedence over its incomplete gate-table row.
The reviewer withdrew that justification after rechecking the baseline.
The developer and reviewer independently selected the same complete model:
`admitLeaderTools(operation)` on the actual Team, with a short child lookup or
a full dissolve/channel operation as appropriate. The channel path also needs
the former lookup's committed-closed refusal before its Team closing check;
matching only the error class while changing "closed" to "closing" is not
preservation. One owner operation replaces the incomplete void check and the
leader dissolve delegate's separately assembled dispatcher admission. No
additional method, state, wrapper owner, or stored callback is required.

The same pass confirmed that leader tool construction moved ahead of the
launch hook. No current consumer difference was demonstrated, but that order
change was unnecessary for ownership cleanup. The final correction restores
hook-first construction, fixes the stale MCP header, and passes all four Rush
gates with the unchanged 710-test inventory. MiMo's final bounded verification
compared all nine executable correction files to the baseline and confirmed
lookup-only versus full-operation spans, parsing order, identical closed and
closing refusals, one dispatcher admission for channel calls, and hook-first
assembly. It retained prior findings for the already-reviewed staged source;
this was a correction verification, not another full sweep. No behavior finding
remains. A non-blocking comment wording suggestion does not change the explicit
per-entry contract or require another code change.

The parent PR's final product decisions and test restoration remain separate.
This review does not establish live Feishu/Codex behavior or authorize merging
PR #453 into `next`.
