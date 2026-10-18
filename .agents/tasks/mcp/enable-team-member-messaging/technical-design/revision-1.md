# Archived revision 1 solution: proactive Team member messaging

> Prior revision 1 solution, superseded by requirement revision 2 on 2026-10-13.
> Both Team-owned and Dispatcher-root ordinary members are now explicitly in
> scope. The operator acknowledged the MCP/owner placement and requires concise
> reusable mechanisms without excessive owner-specific branching. The solution
> below is the prior Team-only proposal, not implementation authority. Reconcile
> a new final through the same three-seat consultation from revision 2.

- Requirement authority: [finalized revision 1](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md).
- Consultation: three independent proposals and one cross-review per seat on
  2026-10-13: [DeepSeek](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/deepseek.md),
  [MiMo](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/mimo.md),
  and [Trae Seed](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/trae-seed.md).
- This is the TeamLeader's reconciled solution for operator review. Development
  authorization is recorded separately in the [task README](/.agents/tasks/mcp/enable-team-member-messaging/README.md).

## Outcome and implementation boundary

Ordinary members of one Team can contact their TeamLeader and peers with
`teammate.send`, identify the actual sender, and explicitly reply across turns.
Every provider-observed normal or failed native result from these members
reports to their TeamLeader once, including results with no Dreamux submission.
An explicit message and an automatic result have separate recipients.

The implementation spans `dreamux-types`, Core's agent/Team composition, both
in-tree runtime adapters, their tests, and owning documentation. It introduces
no persisted member category, config change, mailbox, task entity, native-turn
registry in Core, aggregation, timer, or new completion-delivery policy.
Dispatcher-scoped members, the TeamLeader's own native-result coverage, and
members controlled by a running Workflow are outside the new capability.
Native interruption and owner-stop behavior retain their existing boundaries.

## 1. Ownership and construction

| Owner | Responsibility |
| --- | --- |
| `TeamService` | Supplies the actual Team's member-facing structural scope, leader identity, leader submission entry, and MCP infrastructure. Remains the stable completion recipient. |
| `TeammateCollection` | Constructs a member's scope with its real identity; resolves same-Team peers; reuses ordinary send, closed-record reopen, and owner fences. |
| Agent MCP delegate | Parses `send`/`list`, binds the sender, chooses leader versus peer addressing, and returns an admission receipt. |
| Runtime adapter | Produces a native completion from an observed terminal using its existing result validation/extraction; owns native scheduling and interruption classification. |
| `RuntimeGeneration` | Leases the new result sink to that generation and drops revoked writes. |
| `AgentService` | Decides whether this entity owes its owner a report; builds the Core fact and owns convergence of delivery work it starts. |
| `CompletionDeliveryPolicy` | Existing object-identity fold, recipient FIFO, bounded delivery attempts, and teardown fences. |

The collection receives one optional Team-member context together with existing
MCP primitives. Pass the actual Team through a narrow structural interface,
as the existing leader delegate does; do not add a wrapper service or independent
per-verb callback bundle. The context exposes only leader identity/submission
and the existing scoped peer operations needed by the member catalog.

One explicit construction decision arms both tools and native-result reporting:
ordinary Team-member spawn/materialization/reopen enables them; `createLocked`
disables them. Use that entry-point decision, not prompt text, output-schema
presence, or a persisted Workflow label. The dispatcher-root collection does
not supply the Team context. Leader and dispatcher-agent options do not acquire
the ordinary-member reporting recipient.

Workflow ownership is verified in
[`WorkflowRun.finalize`](/packages/dreamux/src/service/workflow-service/run.ts):
it closes all held members before unlocking. An armed ordinary member is not
later acquired by that path. No extra live-lock probe or lineage state is
needed. A later explicit send can reopen a formerly Workflow-created closed
record as an ordinary member, while an actively held lock still rejects input.

## 2. Member tools and message delivery

Extend the existing `teammate` server with a `team_member` scope advertising
exactly these tools:

| Tool | Input | Result and meaning |
| --- | --- | --- |
| `send` | `{ name: string, prompt: string }`; existing name/text limits; no `intent`, sender, source, or attributes argument | Existing admission projection `{ status, error? }`. Does not wait for execution, a response, or turn completion. |
| `list` | `{}` | `{ leader: { name, status }, teammates: [...] }`, using the TeamLeader's concrete identity and existing compact same-Team member rows, excluding self. Closed rows remain discoverable through the existing roster projection. |

Address the leader by its concrete, dispatcher-unique name. No reserved
`"leader"` alias or second tool vocabulary is introduced. Refuse self-addressing;
other unknown or wrong-Team names fail through existing scoped resolution.

The host binds `from` to the calling entity at delegate construction. Reuse
`AGENT_TASK_SOURCE` and the existing rendered attributes:
`<task from="member-name">message</task>`. Thread optional host-supplied
attributes through `SendTeamMateInput` into the ordinary submission. The model
cannot supply these attributes; existing leader/dispatcher sends and their
envelopes are unchanged. No new provenance source or source-based routing is
needed.

- Peer target: use `TeammateCollection.send` and its existing reopen path.
  Keep the collection's Team completion recipient. The explicit message goes
  only to that peer; the peer's result goes automatically to the TeamLeader.
- Leader target: use `TeamService.submitInput` with the same host-bound sender
  and **no** `completionRecipient`. This creates no automatic reply to the
  member or new Dispatcher obligation. Any Dispatcher obligation belonging
  to another submission folded into the leader's turn remains intact.
- Explicit send retains ordinary-input wake behavior. Busy input follows the
  adapter's existing admission behavior; Core does not implement a scheduling
  branch. Tool text documents Codex steering and Claude queuing where applicable.
- Q2 reuses the same closed member's recorded-session recovery, not replacement
  creation. Q3 retains the ordinary-input lock refusal. Team dissolve and entity
  teardown retain their existing fences.

The member receipt reminder is distinct from the leader dispatch reminder:
"This is an admission receipt, not a response or completion. A reply arrives
only if the recipient explicitly sends one. The recipient's applicable turn
results are reported to its TeamLeader."

## 3. Neutral native-result capability

Add `AgentRuntimeResultSink` and the required
`results: AgentRuntimeResultSink` field to `AgentRuntimeCreateContext`, beside
`state` and `activity`:

```ts
export type AgentRuntimeResultSink = (completion: RuntimeCompletion) => void;
```

Core always supplies the sink. Each in-tree adapter emits once for every
provider-observed normally completed or failed native terminal, whether bound
or unbound. The sink is synchronous, non-throwing, and carries no backpressure;
providers do not wait for leader processing. It carries the existing immutable
`RuntimeCompletion`, not a new event envelope, sequence number, or turn ID.

For a bound result, the sink and all submission settlements receive the
**same object**. A clone is a different completion identity and violates the
contract. The existing router's WeakMap then folds native observation and
N-submission settlement into one delivery to the same Team recipient.

Interrupted native terminals do not emit a result through this sink. Keep
their existing bound settlement semantics, including Codex's current treatment
of partial output on interrupted bound turns. Refused admission, transport
loss, child exit, and teardown do not manufacture a native completion.
Existing tokenless submission-associated failures/stops remain reportable by
`EntityTurn`. In particular, a Codex connection-level unscoped error is not
converted into an invented per-turn native terminal.

### Provider implementation

- **Claude Code:** in the `result` frame handler in
  [`rpc.ts`](/packages/agent-runtime/claude-code/src/rpc.ts), call the existing
  `completionFromTurnOutcome` for every non-interrupted result, including
  `answered.length === 0`. Preserve session pinning, structured-output
  validation, and failure mapping. Emit that object once and use it for all
  answered requests. Wire the sink through provider/runtime/session/RPC
  construction, including the public custom-session extension contract.
- **Codex:** in
  [`turn-manager.ts`](/packages/agent-runtime/codex/src/turn-manager.ts), use one
  terminal-to-completion conversion for bound finalization and the existing
  unbound terminal queue head. Preserve its pending-admission wait so a racing
  `turn/start` can bind before the record is released. Restore the output codec
  and extract text exactly as for bound results; a scoped failed terminal or
  codec failure produces a failed completion. Emit in terminal-queue order,
  skip interrupted terminals, settle bound members with that same object, and
  retain existing collector/record release rules.

Codex's unbound observation/release path exists in source. Its frequency in
real traffic is unproven; implement it rather than declaring the provider a
no-op. The contract promises provider-observed results, not discovery of all
native background work.

### Core delivery and convergence

`RuntimeGeneration` constructs the generation-leased result closure alongside
its activity sink. It forwards current-generation completions to its owning
`AgentService`; it does not infer results from display activity.

For an armed ordinary member, `AgentService` checks `owesCompletion()` before
starting a delivery, resolves the existing Team owner, and calls
`CompletionDeliveryPolicy.deliverRuntime` with the native completion identity.
Keep the policy's dispatcher fence, Team fence, retry/drop limits, and
never-retract rule. Automatic reports remain live-runtime-only push-back
(`wake:false`), not ordinary-input wake.

Use one small Core completion-to-fact function for native observation and
`EntityTurn`'s completion arm. It keeps the same producer/role/status and
successful result text; a failure retains `result: null`, matching existing
failure notices. This makes a folded result independent of which observation
reaches the router first. Tokenless failed/stopped settlements retain their
existing outcome mapping and lifecycle behavior.

The native sink queues delivery immediately in native-result receipt order.
It must not await leader admission or delivery on the provider's stack. Track
the resulting delivery promise with existing `InFlightWork`, release it on
settlement, and join started native-report work during host-stop/close
convergence after the runtime has been stopped and its generation revoked.
Named scenario: a result is accepted just before close, while its recipient
submission is still in flight; close must not publish durable completion and
drop the producing service while that owned delivery remains unjoined.
No new per-result ledger, cap, retry loop, or durable queue is introduced.

## 4. Notification and prompt copy

Use the existing role subject with these status lines:

- Completed: `TeamMate X completed a turn.`
- Failed: `TeamMate X's turn failed.`
- Stopped: `TeamMate X's turn was stopped.`

The shared renderer applies the same factual wording to leader/dispatcher-agent
subjects; their reporting coverage is unchanged. Workflow status wording stays
unchanged. Failure-body enrichment is not part of this solution.

An armed member's role prompt names its actual TeamLeader and describes
`teammate.send`/`list`, explicit replies, and automatic normal/failed native
result reporting under the existing delivery fences. It must not promise that
every output necessarily reaches an offline leader, equate a turn result with
goal achievement, or expand interrupted-turn reporting. Workflow instructions
retain their separate script-result contract.

## 5. Consultation adjudication

The TeamLeader verified the arguments against source; the result is not a vote.

| Dispute | Final decision and reason |
| --- | --- |
| Full-result sink versus unbound-only | Select the full native-result sink from the independent first-round alternatives. The cross-review favored unbound-only, but did not examine mixed bound/unbound synchronous result batches. Claude `Rpc.onStdoutChunk` handles every line synchronously; `EntityTurn` consumes `runtime.settled.then` and further defers the router call. A bound result followed by an unbound result in one stdout chunk can therefore enqueue the later report first under immediate unbound-only observation. A full sink queues both in the provider's native-result order; settlement folds into that delivery. This avoids promise-depth guessing, another ordering queue, or waiting on unrelated unfinished turns. |
| Two builders could change the folded payload | Keep one fact conversion and unchanged failure bodies. Existing folding already combines multiple `EntityTurn` reporters for one completion; its invariant is one recipient per object, not one caller per object. Adding the native observer does not require a new deduplication mechanism. |
| New source/server/alias vocabulary | Reuse `task`, the `teammate` server, `send`/`list`, and concrete names. No current consumer requires another source name; the real sender is an attribute. |
| Optional context field | Make the Core-supplied field required, consistent with state/activity; document older-provider runtime compatibility separately from new host/fixture source compilation. |
| Post-Workflow unlock or lineage problem | Reject it: finalize closes before unlock. Ordinary reopen re-arms the member; no live lock probe or permanent Workflow category is added. |
| Failure-body text or Dispatcher scope needs confirmation | Keep failed bodies unchanged and the recorded Team-only scope. These are not unresolved product decisions. |
| Preemptively split `mcp.ts` | Add the member catalog to the existing agent MCP owner. Only split a genuinely named member-catalog module if the actual code-line lint gate requires it; total file lines are not code lines. Keep one server/delegate surface. |
| Unscoped protocol failure as a native result | Reject synthetic per-turn completions. Native scoped failures are covered; existing submission failures keep their own path. |

The changed sink choice was already an independently proposed and cross-reviewed
alternative. The mixed-batch ordering concern is source-derived and must be
verified by the implementation tests below; no runtime experiment is claimed.

## 6. Compatibility, documentation, and capability accounting

The runtime context addition is required in new Core/host/test constructors.
An existing binary third-party provider can ignore the extra field and retain
submission-associated reports; it does not gain full unbound coverage until it
implements the result contract. Custom Claude session factories must forward
results with the same object identity as settlement. Do not add a capability
flag or fail otherwise-working older providers solely for ignoring the sink.

Record ordinary `minor` changes for `@excitedjs/dreamux-types`,
`@excitedjs/dreamux`, `@excitedjs/agent-runtime-claude-code`, and
`@excitedjs/agent-runtime-codex`. No persisted config/state/path change is
proposed, so no `BREAKING:`, `Rebuild:`, or maintenance-schema migration applies.

Update the product catalog's member communication, background result/failure,
peer reopen, and Workflow exclusion entries in the implementing change.
Update provider-runtime/current-architecture guidance, load-bearing service
comments, runtime package extension docs, role prompts, and tool copy. State the
live-only automatic-report versus waking explicit-message asymmetry. Run the
knowledge check with the implementation PR.

Reused mechanisms: scoped collection send/reopen, Team leader submission, input
locks and fences, rendered provenance, MCP catalogs/leases, runtime generation
lease, `RuntimeCompletion` identity folding, delivery policy, and `InFlightWork`.
New capabilities: a member tool scope and a leased native-result sink with its
Core observer. Small supporting changes bind sender attributes, construction
scope, and a common fact conversion. No user-visible capability is removed;
the earlier unbound-report silence is deliberately replaced under Q1/Q1a.

## 7. Verification and residual risks

No implementation or live acceptance evidence is claimed by this consultation.
After approval, sync the implementation baseline with `next` and run the
monorepo's build, lint, test, and `typecheck:tests` gates. Run
`.agents/scripts/check.mjs` at knowledge closeout.

| Scenario | Required evidence |
| --- | --- |
| Member sends progress to leader; peers exchange and explicitly reply across turns | Real host-bound sender in recipient input; admission-only receipt; no peer-message copy or automatic reply to sender. |
| Idle/busy/closed/locked/wrong-Team targets | Existing wake/native scheduling; same closed record/session reopen; held-lock and teardown refusals; member catalog contains only send/list. |
| Bound result plus native observation; multiple folded submissions | Same object in both adapter paths; one TeamLeader report with identical fact, regardless of which path reaches the router first. |
| Distinct completed/failed unbound results | Separate ordered reports; unchanged failed body; no peer recipient. |
| Bound result immediately followed by unbound result in one Claude stdout chunk | Earlier native result reports first, exactly once; provider admission remains non-blocking. Also cover Codex mixed terminal/binding order. |
| Interrupted, refused, unscoped transport failure, owner-close/host-stop, revoked generation | Preserve bound settlement behavior; no expanded unbound interruption or invented terminal; no late unauthorized report. |
| Result accepted just before close with delayed recipient admission | Already-started delivery is joined during convergence without waiting for native work to finish naturally. |
| Workflow creation and later ordinary reopen | No tools/native ordinary reports while script-controlled; script receives results; terminal run reporting stays intact; reopened ordinary member receives its scope. |
| Both in-tree runtimes and older/custom providers | Adapter fixtures cover result conversion, reference identity, and genuine unbound terminals; live communication/reopen/busy behavior is tested on both. Record any unobserved live unbound case as a coverage limit. Older-provider submitted reports still work. |

Preserve load-bearing tests, especially the non-blocking inbound contract,
completion folding, owner-stop suppression, and Workflow locks. A green run
after weakening those assertions does not establish acceptance. Required live
Codex gates fail loudly if Codex is absent; use the repository's explicit skip
only when the environment intentionally lacks it.

Residual risks: per-turn notification volume is the accepted Q1 cost; automatic
reports can still be dropped when the leader runtime is not live; transport
failure without a scoped native terminal remains outside new unbound reporting;
external providers may retain narrower coverage; real Codex unbound frequency is
not established. None authorizes aggregation, content filtering, polling,
synthetic terminals, or a new delivery guarantee.
