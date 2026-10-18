# Final solution: proactive ordinary-member messaging

> Prior approved solution retained for comparison. On 2026-10-13 the operator
> requested a hold and further discussion of neutral-runtime interfaces.
> [Reassessment input](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/interface-reassessment.md)
> records the current consultation boundary; this file does not authorize code
> changes or workflow advancement during that hold.

- Input: [requirement revision 2](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md), finalized after Q4 on 2026-10-13.
- Evidence: revision-2 independent proposals and single cross-review appendices in [DeepSeek](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/deepseek.md), [MiMo](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/mimo.md), and [Trae Seed](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/trae-seed.md).
- Supersedes the [archived Team-only solution](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/revision-1.md).
- Reconciled for operator review. Development authorization is separate in the task README; no implementation or live validation is claimed.

## Outcome and implementation boundary

Ordinary members of both a Team and a Dispatcher's root collection get one
shared `teammate.send`/`list` capability. They contact their actual owner or
same-collection peers, identify member senders, and explicitly reply across
turns. Every provider-observed normal or failed native result reports once to
the actual owner, including autonomous continuations with no submission.
Separate results remain separate reports; a turn end does not prove goal success.

The change spans `dreamux-types`, Core's agent and both owner composition sites,
both in-tree runtime adapters, tests, and owning documentation. It adds no
cross-collection reach, member lifecycle authority, mailbox, aggregation,
timer, persisted category, config migration, Core native-turn registry, or
second delivery policy. Active Workflow members remain excluded. Owner roles,
tools, native-result coverage, existing submission obligations, and Dispatcher
Team management retain their current scope.

## 1. Shared ownership boundary

| Component | Owns |
| --- | --- |
| `TeamService` / `DispatcherService` | Actual owner identity/status, conversational inbox and admission fence, child collection. |
| `TeammateCollection` | Member construction, peer resolution, ordinary send/reopen, explicit Workflow construction distinction. |
| `service/agent/mcp.ts` | Existing `teammate` server, one member catalog, argument parsing, owner-versus-peer dispatch, host sender, admission receipts. |
| Runtime adapter | Native terminal classification, result validation/extraction, ordered publication. |
| `RuntimeGeneration` / `AgentService` | Generation lease, report eligibility, convergence of started delivery work. |
| `CompletionDeliveryPolicy` | Existing completion-identity fold, recipient FIFO, bounded attempts and teardown fences. |

Both collections receive required MCP primitives and a narrow structural view
of their **actual owner service**, matching current Dispatcher/TeamLeader MCP
composition in [`mcp.ts`](/packages/dreamux/src/service/agent/mcp.ts). Do not
construct per-verb closure bags, forwarding adapters, or a messaging service.
The view exposes:

- The existing `teammates` collection, consumed for `send`/`list` only.
- A lazy owner descriptor: concrete agent name, role label for copy, and
  compact current status for the roster. The owner reads its record/contained
  agent when the descriptor is requested. Team constructs its collection
  before allocating `leader_name`, so eager name capture is invalid.
- The fenced `submitInput` operation, viewed with input omitting
  `completionRecipient`. Team already supplies it. Rename Dispatcher's
  internal `submitToAgent` to `submitInput`, retaining its existing fence and
  recipient-free type, and update its internal command/test callers. This
  removes the differing verb rather than adding two forwarding methods. No
  public command or plugin interface is renamed.

The handler compares the target to the concrete owner name and otherwise uses
the owner's collection. It never switches on owner kind. The existing
`completionOwner` still determines reports: Team service for Team members,
contained Dispatcher agent for root members. Preserve submitted work's original
recipient query points and stable recipient identity when arming native reports;
do not defer a required prepared-Dispatcher lookup to result delivery.

| Real difference | Team | Dispatcher root |
| --- | --- | --- |
| Owner identity/status | Record's leader name and contained leader | Reserved `dispatcher` name and contained agent |
| Inbox fence/target | Team admission and leader | Dispatcher admission and agent |
| Peers | This Team's collection | This Dispatcher's root collection |
| Report recipient | Existing Team completion recipient | Existing Dispatcher-agent completion recipient |
| Role word | `TeamLeader` | `Dispatcher agent` |

These facts do not require copied tool/routing policies or merging Team
record/worktree lifecycle with Dispatcher configuration, channels, restart,
and Team management.

Thread one explicit ordinary-versus-locked construction decision from the
entry points into `teammateOptions`. Ordinary spawn/materialization/reopen in
both collections installs messaging and a native-report recipient; `createLocked`
installs neither. Both paths can currently pass `{}`, so neither options
shape, prompt text, nor output schema distinguishes them.
[`WorkflowRun.finalize`](/packages/dreamux/src/service/workflow-service/run.ts)
closes held members before unlocking. Script results, run-level reporting and
ordinary lock refusal remain. Later ordinary reopen re-arms; no lineage flag
or live unlock probe is needed.

## 2. Member tools and delivery

The existing `teammate` server gains a `member` scope with the real caller
identity and structural owner. Exactly two tools are advertised:

| Tool | Input | Result |
| --- | --- | --- |
| `send` | `{ name, prompt }`, existing name/text limits; no `intent`, sender, source, or attributes argument | Target name and existing admission status/error projection; does not await execution or reply. |
| `list` | `{}` | `{ owner: { name, status }, teammates: [...] }`; compact collection rows, self excluded, closed peers discoverable. |

The owner is an address and separate row, not a child member. Address its
concrete name; no `leader` alias, new server, or alternate tool vocabulary.
Refuse self-addressing; unknown/wrong-collection names use existing scoped refusal.

Bind `from` from the calling entity at construction. Member messages reuse
`AGENT_TASK_SOURCE` and `<task from="member-name">…</task>`. Thread optional
host-supplied attributes through the existing collection send input. Its source
remains `task`; a variable source field/new constant has no consumer. Model
arguments cannot set the sender. Existing owner `send`/`spawn` envelopes stay
unchanged; the prompt names the owner without claiming every untagged input
is an owner reply.

- Owner target: actual owner's fenced inbox, without `completionRecipient`.
  No automatic reply to the member or new upstream obligation; other folded
  owner submissions retain their own obligations.
- Peer target: collection's existing send/reopen path and completion recipient.
  The explicit message reaches only the peer; its result goes to its owner.
  Replies require explicit send.
- Explicit send retains ordinary-input wake; busy admission remains runtime-owned
  (existing Codex steering/Claude queuing). Q2 uses the same closed record/session
  and concurrent-reopen join. Owner/entity fences and active locks still apply.

Member receipt reminder:

> This is an admission receipt, not a response or completion. A reply arrives
> only if the recipient explicitly sends one. The recipient's applicable turn
> results are reported to its owner.

Keep the catalog in the existing agent MCP owner. Split a named member module
only if the actual 700-code-line gate requires it; 627 physical lines are not
that count. Do not add an operations wrapper or exile helper closures for line count.

## 3. Neutral native-result capability

Add required `results: AgentRuntimeResultSink` beside `state`/`activity` in
`AgentRuntimeCreateContext`:

```ts
export type AgentRuntimeResultSink = (completion: RuntimeCompletion) => void;
```

Core supplies it. In-tree providers publish once per observed normally completed
or failed native terminal, bound or unbound, synchronously in terminal-finalization
order. The sink is non-throwing and carries no backpressure. Use the existing
immutable completion, not a sequence number, event envelope or Core turn identity.
The sink and all settlements for the same result receive the **same object**.
Existing WeakMap folding combines them into one owner delivery. Clones violate
the contract and can duplicate; they are not a harmless compatibility fallback.

Interrupted terminals do not publish through this new seam; their existing
bound settlement semantics, including Codex partial output, remain. Refusal,
transport loss, child exit, and teardown do not manufacture native results.
Tokenless submitted failures/stops remain reportable by `EntityTurn`.

- **Claude:** [`rpc.ts`](/packages/agent-runtime/claude-code/src/rpc.ts) calls
  existing `completionFromTurnOutcome` for every non-interrupted `result`, including
  `answered.length === 0`. Preserve session pinning/schema validation/failure mapping,
  publish once on the result stack, and settle answered requests with that object.
  Wire provider/runtime/session/RPC construction and document the result contract.
- **Codex:** [`turn-manager.ts`](/packages/agent-runtime/codex/src/turn-manager.ts)
  shares terminal conversion between bound finalization and the unbound queue head.
  Preserve the pending-admission wait, codec restoration, extraction and release.
  Publish in terminal queue order, skip interruption, settle with the same object.
  Scoped fatal terminal or codec failure maps to failed. Connection-level
  `onUnscopedFailure`/`failProtocol`/`failRecord` publishes no invented per-record
  completion: [`events.ts`](/packages/agent-runtime/codex/src/events.ts) explicitly
  distinguishes that failure from a turn terminal.

Codex has an unbound path; its real-traffic frequency is unproven. Implement
the observed path in both providers without claiming discovery of all background work.

`RuntimeGeneration` creates the leased result closure and invokes its actual
owning entity through a structural observer, not parent-created callback wiring.
Revoked writes drop; activity stays display-only. An armed `AgentService` checks
`owesCompletion()` and immediately calls `deliverRuntime` with the stable owner
recipient. Share a small fact mapping with `EntityTurn`; preserve result text
and failed `result: null`, plus existing tokenless-outcome mapping.

Track its delivery promise with existing `InFlightWork`; host stop/close joins
started native-report work after runtime stop/generation revocation. Named
scenario: a result accepted just before close while recipient submission is pending.
Retained bound turns cannot join unbound work, and durable closure must not
leave owned delivery unjoined. No result ledger/retry loop is added. Automatic
reports retain live-runtime push-back (`wake:false`); unavailable owners can
reject/drop. Explicit messages retain ordinary wake.

## 4. Ordering, stop timing, and copy

Claude processes multi-line result batches synchronously, while bound `EntityTurn`
reporting runs through promise continuations. An immediate unbound-only sink
could enqueue a later result first. Publish **all** normal/failed native results
synchronously: router arrivals equal terminal order, and later settlement folds
into the queued token. Codex uses its existing terminal drain. No microtask-depth
coupling or new ordering queue is needed.

For completion-bearing results, eligibility is read at terminal publication.
A stop before it suppresses the report; a result already observed/queued before
stop is started work and is not retracted. This moves the bound eligibility
check earlier than today's settlement continuation. Explicitly test terminal,
then stop before the microtask; do not call this byte-identical stop timing.
Existing preparation/dispatcher fences still apply to queued work.

Completion-less interrupted/transport-failed settlements retain their existing
path and do not share the new ordering guarantee. An interrupted Claude frame
followed by a completed unbound frame in one batch can deliver its stopped
notice after the completion report. Parser batching enforces no intervening
turn time. Document this residual; add neither a sequence field nor wider
interruption coverage.

Status copy with existing role subjects:

- `TeamMate X completed a turn.`
- `TeamMate X's turn failed.`
- `TeamMate X's turn was stopped.`

Use factual copy also for leader/Dispatcher-agent subjects without expanding
coverage. Workflow terminal copy stays. Armed prompts name owner/collection,
describe send/list, admission-only receipts, explicit replies and automatic
normal/failed result delivery with availability/interruption limits. Preserve
Workflow/plugin/standing-identity instruction order; do not promise goal success
or guaranteed receipt by an unavailable owner.

## 5. Source-based adjudication

These are TeamLeader design decisions, not additional operator rulings or votes.

| Dispute | Decision and evidence |
| --- | --- |
| Actual owner versus closure bundle | Actual service structural view, as current `mcp.ts`. Reject literal per-verb closure bags: the [data-flow ownership continuation](/.agents/tasks/architecture/code-organization-refactor/artifacts/data-flow-follow-up.md) rejected private-owner closure plumbing. Harmonize internal inbox vocabulary instead of wrapping two surviving entries. |
| Lazy name / nullable owner | Lazy descriptor, required collection capability. Team collection precedes record allocation; both collections are covered by Q4. |
| Implicit locked disarm | Explicit construction decision; ordinary and locked paths can both pass `{}` (`agent/index.ts`). |
| All-result publication / folded payload | Synchronous all-normal/failed sink, identical object and shared fact map; Claude line loop and `turn.ts` promise boundary prove the mixed-order hazard. |
| Codex unscoped failure is a turn result | Reject proposed per-record emission despite MiMo/DeepSeek's position; `events.ts` defines connection-level failure. Trae's cross-review correctly withdrew it. Bound failure settlement remains. |
| Fire-and-forget native reports at close | Reject: `service.ts` already joins owned work before closure; use `InFlightWork` for unbound delivery too. FIFO is not convergence. |
| Owner-envelope `from` extension is required | Preserve existing owner envelopes. New member sends identify their sender; owner address is in roster/prompt. No additional product choice blocks the selected scope. |
| New source / fields / flat roster / preemptive split | Reuse task/from, name/prompt, grouped owner/member roster and MCP home. No consumer or measured code-line gate requires the alternatives. |
| Completion-less notices cannot interleave | Reject stronger claim; parser and continuation boundaries permit the named residual. |
| Failure body or copy needs another question | Preserve failure body; align copy to selected turn facts. Resolve these ordinary final-solution choices here. |

## 6. Verification and manifest

| Boundary | Evidence required after development approval |
| --- | --- |
| Two owners, one member implementation | Both composition/delegate paths: owner addressing/roster, host sender, recipient-free owner input, no owner-kind routing or closure adapter. |
| Peer exchange/Q2 | Explicit cross-turn reply, owner-directed results, recipient-only message, same closed record/session, reopen join and fences. |
| Native coverage/fold | Both adapters' normal/observed-failed bound/unbound results; sink and all settlements reference-identical; one owner prepare/submit per result. |
| Native order | Claude multi-line batches in both bound/unbound orders, folded submissions and third bound result; Codex mixed queue heads/admission wait. Assert delivered report order, not just sink calls. |
| Stop/convergence | Revoked write drop, stop-before-terminal, terminal-then-stop-before-continuation, pending native delivery joined by close/host stop, queued-work fences. |
| Interrupted/connection failure | No invented native emission; preserve existing bound settlement/report assertions and document ordering residual. |
| Q3 | Locked builds in both collections have no new tools/reporting; ordinary lock refusal, script result/run terminal, ordinary reopen re-arms. |
| Runtime behavior | Both scopes through both runtimes; record busy-input differences, observed unbound coverage and live limitations. Missing required live Codex fails loudly; documented skip only for intentional absence. |

Homes: `dreamux-types/src/agent-runtime.ts`; Core agent MCP/collection/types,
entity/generation/turn/prompt/renderer; Team/Dispatcher composition and the one
internal Dispatcher command caller; both provider/runtime/session or turn-manager
paths; relevant tests/fixtures. Run monorepo Rush build, lint, test and
`typecheck:tests`. None has run for an implementation here. Extend load-bearing
tests without weakening owner-stop/Workflow/folding assertions to obtain green.

Implementing-PR knowledge: product entries for both scopes, background results,
peer reopening, terminal-publication stop timing and offline-owner asymmetry;
provider/service/architecture and role/tool/session contract notes. Run
`.agents/scripts/check.mjs` at closeout. Ordinary minor Rush notes for Core,
types and both adapters; no state/config/path migration or BREAKING note.

## 7. Compatibility, accounting, and risk

Required context fields require in-tree host/fixture source updates. Older
provider binaries may ignore the extra property and keep bound-only reporting,
but do not meet the new unbound-coverage contract. Document this without a
negotiation mechanism. Cloned completion emission violates folding and can
duplicate; do not claim noncompliance is harmless.

Reuse real owners/collections, submission/reopen/locks, MCP/generation leases,
fold/FIFO and `InFlightWork`. Remove the no-member-tools invariant, root-member
prompt omission, unbound-result discard, task-finished overclaim and internal
inbox verb mismatch. Add one narrow member catalog and one neutral result seam,
paid for by Q1/Q1a/Q4. Team-only nullable wiring was a superseded proposal, not
shipped functionality deleted by this task.

Principal risk: cross-package same-object/ordered-publication discipline,
pinned by identity and delivery-order tests. Q1 notification volume also applies
to root members; automatic reports can still drop for unavailable owners.
Completion-less notice interleaving and unseen background transport failure
remain limitations. No unresolved product/architecture fork blocks this solution;
development still requires explicit authorization.
