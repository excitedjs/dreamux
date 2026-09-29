# Data-flow ownership: final technical solution

## Status and authority

Selected by the TeamLeader on 2026-09-29 after [PR #457](https://github.com/excitedjs/dreamux/pull/457), following three
independent proposals and one append-only cross-review round. This is the
implementation authority for the [R71 continuation](../../artifacts/data-flow-follow-up.md).
The [source audit](source-audit.md) records the facts used to adjudicate the
[Claude](proposals/claude.md), [MiMo](proposals/mimo.md), and
[DeepSeek](proposals/deepseek.md) proposals. Their first-round designs are not
additional requirements; their appendices also disagree in places.

R69 authorizes architecture implementation with product decisions deferred.
R71 requires completing the data-flow cleanup, including the publicly exposed
process/session factories discussed immediately before that instruction.
Removing those unused construction overrides is the TeamLeader's scoped
implementation decision, not a new quoted operator ruling and not evidence
that no outside caller exists. Their compatibility impact is recorded below.
No new product decision is necessary for the selected design: startup refusal,
admission, completion retention, and Feishu submission ordering are preserved.

## Selected ownership model

The object that owns a changing fact answers queries about it. The object that
commits a fact emits it; its holders subscribe. Construction fixes ordinary
values once they are known. A submission carries its recipient, not a function
describing delivery. An operation stays with the owner of its concurrency and
failure boundary.

These changes remove the old callback paths, rather than placing interfaces
around the same closures. Local operations, protocol handlers, codecs, and
actual extension contracts remain functions where that is their meaning.
The [baseline inventory](../../artifacts/data-flow-inventory.md) is a coverage
index, not a list of functions to delete blindly.

### 1. Closing fences and construction order

Move the dispatcher's existing `closed` and admitted-work state out of
`DispatcherLifecycle` into one early-created work fence. Its holder view has
`admit` and `isClosing`; its owner view also has `close`, `drain`, and
`assertOpen`. There is no reopen, additional phase, mirrored flag, or second
drain. The lifecycle still owns startup/shutdown orchestration and receives
the owner view. A platform-level primitive is appropriate for this existing
in-flight-work mechanism; do not create a generic gate-composition framework.

Construction becomes: fence, delivery policy and fixed services, agent
factory, channels, dispatcher-agent holder, scheduler, member and Team
collections, Workflow service, then lifecycle. The dispatcher-agent holder
receives the actual aggregate and channel objects, but reads tool inputs only
inside `build()`, after channel initialization. Creating MCP delegates in the
constructor would snapshot an empty channel tool set.

`TeamService` supplies the child fence itself: Team check, then dispatcher
admission. Its own leader submission, interrupt, and completion methods use
the Team-only check. These are distinct entry points, not interchangeable
implementations of a universal gate.

| Entry | Required fence order |
| --- | --- |
| Team members, Workflow, cron work | Team, then dispatcher |
| Admin Team submit/interrupt | Dispatcher, then Team |
| Leader channel tools | Dispatcher, committed Team-closed check, then Team closing check; admission covers the channel operation |
| Leader cron/member/Workflow access | Dispatcher, then committed Team closed check at the former lookup point; the child operation keeps its own Team-then-dispatcher check |
| Leader completion prepare/prepared submit | Team only; no new dispatcher check after queueing |
| Leader dissolve tool | Dispatcher admission covers committed Team-closed refusal and the dissolve request; only requests passing that access check may join the in-flight dissolve |
| Completion policy | Dispatcher acceptance before queueing; queued delivery is not retracted |
| Dispatcher Workflow `createLocked` | Existing outer dispatcher wrapper remains |
| Team Workflow `createLocked` | Existing raw collection path remains |

The last two rows preserve the deferred admission asymmetry. Delete the
other repeated admission/acceptance forwarding closures and the empty
`DispatcherService.admitOperation` forwarding method. Preserve current error
classes and messages at externally reachable entry points; changing the owner
of a check is not permission to change its precedence.

`TeamService.admitLeaderTools(operation)` owns the former leader lookup's
access policy and executes one call-scoped operation inside that admission.
The leader's MCP lease can still be live after the Team closed write while
Workflow/member teardown waits, or after dispatcher admission closes. Lease
validity alone therefore does not replace this check. It reads the committed
closed fact, not the earlier dissolve promise; argument parsing stays on the
same side of this access operation as before. This preserves refusal order
without restoring Team-id lookup suppliers or changing child admission.
The same policy applies to leader dissolve, with admission covering its entire
request as the collection entry did. "Joinable" describes the operation after
access succeeds; it does not authorize accepting a new request after the
closed-record write.
Child adapters retrieve their existing child in this short admitted operation
and invoke it afterward. The leader dissolve adapter admits the whole request
through the same owner and needs no separate dispatcher-fence parameter.
Leader channel calls use the same admission, then the existing Team closing
check, covering the entire channel call once. This preserves closed-before-
closing refusal from the old lookup. These are ordinary call-scoped operations,
not stored construction callbacks or a generic gate-composition framework.

### 2. Completion recipients and scheduled input

The existing owners expose `completionRecipient(): CompletionInitiator`.
`DispatcherAgent` returns its current `mustAgent()` result. `TeamService`
returns itself and implements the existing completion contract with its
Team-only refusal and unavailable mapping. It does not add a readiness check
when queried.

Call this query at exactly the former supplier point: member spawn after
creation inside its cleanup `try`; send after reopen and before submission;
Workflow after its accepting check and before the run record write; Team
initial prompt and explicit dispatcher pushback at their current lookup
points. A configured but disabled dispatcher never builds its Agent: spawn
must still fail and clean up there, rather than run with undeliverable results.

Bind the dispatcher delivery policy once in the agent factory. Agent
submissions and turns carry a recipient value. `EntityTurn` reads
`owesCompletion()` on its actual `AgentService` owner at the same settlement
point as today's predicate, and calls the policy itself. Workflow retains a
nullable owed recipient instead of a nullable delivery closure. Clearing an
unstarted delivery stays permanent; started delivery, FIFO, dedupe, retries,
and the differing Workflow stop reservation rule stay unchanged.

Delete recipient supplier fields, `resolveCompletionDelivery`, per-turn
delivery closures, the Team's per-call recipient wrapper, and its separate
`recipientKey`. The stable Team object is the key; dispatcher recipients remain
the actual built Agent objects. Both member collections have a completion
owner. There is no recipient-less Workflow-only collection: a Workflow creates
locked members through the same collection and separately owns whether its
run still owes a terminal delivery.

The scheduler constructs its own `SCHEDULED_SOURCE` submission and invokes
the existing `submitInput` contract on `DispatcherAgent` or `TeamService`.
The dispatcher holder's forwarding method is justified by the real lazy
Agent lifetime; it resolves the Agent at invocation just as today. Do not add
a new scheduler-sink wrapper or move the source marker into another callback.

### 3. Identity facts and initial construction

`AgentIdentityStore` owns a typed `committed` EventEmitter. Create and upsert
emit after a successful write unconditionally; update emits only after a
status change, evaluated inside the existing transactional after-commit hook.
Reads emit nothing. Preserve the different create/upsert and update write
boundaries; this is not a change to transactional serialization.

The factory binds the role as a value and installs the first listener, which
publishes the existing `teammate.state` event. This deletes the Dispatcher and
Team copies of that publication and the entire `onPersisted` parameter chain,
including runtime-state forwarding and record-only close. The store knows
identity persistence; the factory knows role and the dispatcher projection.

Separate identity preparation from role-option construction. Factory
create/upsert return an `UnbuiltAgent`, and open returns one or null. This
small agent-module construction handle privately owns the already-bound store
and role; it exposes the committed identity, build with plain options and
sibling context, and record-only close. It introduces no persisted state,
phase flag, replay, registry, or exposed store. It replaces the factory's
`options(identity)` and `align(identity)` callback protocol. Reconciliation
inside upsert remains a call-scoped policy over the actual stored record.

The caller consumes a successful create result before computing launch
options. A member collection emits that initial identity before any launch
hook; a Team seeds and publishes its new leader at the same boundary. Open
and restore seed silently. `AgentService` observes its store and emits state;
the member collection observes its held Agents and emits member facts; the
Team observes its collection and its leader. Attach listeners synchronously
before any Agent starts. These are existing ownership boundaries, with no
global event router or callback emitter injected down from a Team.

The factory publisher is first, so `teammate.state` precedes derived
`team.state`. Create and record-only-close aggregate publication moves from
the store callback to the immediate awaited result; it remains before launch
hooks or return to the operation's caller. This promise-continuation scheduling
difference is explicit, not a claim of identical instruction timing. Status
updates retain synchronous store-to-holder observation. Review must verify
per-entity event order, intermediate roster contents, and teardown without
inventing a replay or compensating state mechanism.

Emitter lifetime follows the bound store/Agent/collection graph. Ensure a
retired instance is not retained by a shared emitter and rematerialization
does not accumulate listeners. No subscription touches channel demand,
channel leases, or `DispatcherCoreEventBus.hasSources`.

The proposals' rejecting-launch-hook failure example is invalid: launch taps
are isolated. Do not use it as justification or coverage evidence. Actual
failed writes emit nothing; `startCreated` failures close the built leader
through the same state path. Recovery and unmaterialized member close must
retain their record-only operation and final projection.

### 4. Workspace queries, hooks, and role tools

Move the live managed-worktree sibling query to the existing agent collection
store, bound to its collection root. Agents receive that actual read-only
owner, not a closure over a collection's private options. Retain live reads,
name exclusion, all identity filters, and the Team workspace loan rule. This
does not create a dispatcher-wide occupancy registry or give members Team
checkout ownership.

Pass existing `createTeam`, `team`, and `teammateLaunch` hook objects together
instead of forwarding functions. Hook isolation and launch merge order stay
with the hook implementation.

The dispatcher Agent assembles its tools at build time from its actual
collaborators. The Team assembles its leader's tools from its own members,
Workflow service, scheduler, and dissolve operation. Channel delegates cross
the layer through a neutral structural view implemented by `ChannelService`
itself. The existing `team/leader.ts` module's `teamLeaderOptions` assembles
tools and the other role options together; TeamService retains create/rebuild,
roster observation, completion, and teardown. Move tool code to its real layer
rather than weakening dependency rules to import a collection-tier module into
a service. Complete the leader launch hook before building its delegates,
matching the baseline and DispatcherAgent order.

Remove `leaderMcp` forwarding, resolve-back-by-Team-id suppliers, and the
leader-scope/run-for-leader port methods that lose their last consumers.
Schedulers and Team member operations are direct values. A closed Team is
never rebuilt; its leader tools cannot belong to a replacement with that id.
Preserve the gate table above, including dispatcher-first channel tools and
joinable dissolve. Preserve the admin scheduler lookup, which still has a
real per-command target.

### 5. Commands and process composition

`Server` itself implements the structural command-host view. Its existing
`dispatchers` accessor owns the necessary late edge: the catalog exists
before `start()` constructs `Dispatchers`. Pass the actual host to domain
factories through narrow structural views; remove the four host closures and
catalog resolver bags. Command `parse` and `execute` remain protocol callbacks.

Keep addressed/configured-dispatcher resolution on the actual `Server`, which
owns both live config and the late collection accessor. Its
`addressedDispatcher` validates the id and configured entry before accessing
`dispatchers`; `configuredDispatcher` supplies the same first check for status.
This corrects the selected placement after implementation exposed the public
pre-start embedding path: `host.dispatchers.addressed(context)` would touch
the late accessor before validation and replace argument/not-found errors
with a generic startup error. The TeamLeader accepted the narrower placement
on source evidence. A cached service still cannot bypass current configuration.
Domain modules must not import server composition to express these views.
Pass the logger directly to `RestartIntentConsumer` instead of a warn wrapper.

Keep the three real `ServerOptions` extension points: channel logger factory,
Workflow logger factory, and runtime socket sweep. The CLI supplies all three.
Resolve the Workflow logger once where the concrete dispatcher id is known,
then pass that value down, preserving its default of the actual dispatcher
logger. Channel logger construction performs IO and must remain at channel
build: materializing a configured but disabled dispatcher must not allocate
its channel log. The initial early-value design missed this side effect;
review D12 in the [adjudication](../../artifacts/data-flow-review.md) corrects
that placement. Preserve this actual external factory rather than inventing
a lazy logger proxy. The sweep remains a one-boundary startup operation.
Replacing these public capabilities with booleans would remove an actual
supplier's abstraction and is unnecessary for the internal cleanup.

### 6. Feishu operation owners

The session composes and closes collaborators. Two real owners take the
existing operation bodies out of it:

- The Team submitter owns liveness, COT anchor claim, Core Command submission,
  and anchor retirement/release. Provisioning, document comments, and inbound
  routing hold it directly.
- The inbound router implements delivery and slash-command routing using
  routing, bindings, provisioning, the submitter, commands, and the bot. The
  pipeline and card actions hold it directly.

Provisioning still owns `inFlight`, `run`, and `guarded`; its first submission
stays inside all three. A waiter waits for that entire submission before
rereading the binding. A rejected first submit still becomes `unsubmitted`
inside the existing catch. Neither returning a provisioning plan early nor
passing the old submit closure as a per-call argument satisfies this boundary.

Move topic-root suppression and tracked notification sending to existing
outbound ownership; bindings hold outbound. Slash commands hold bindings and
the bot. COT holds the constructed client's value and the existing lifecycle
object; eliminate `cotClient()` and `start(isLive)` plumbing. No external COT
entry is reachable before session initialization; verify this when moving
construction and retain close behavior for an uninitialized session.

Core Commands hold their invoker after `initialize`, eliminating the session
invoker field and forwarding closure. The ask-user registry emits expiry;
card actions own asking and expiry settlement with the registry, bot, and
outbound. Its observation lifetime follows the session.

Build the tool-session view once from actual owners rather than forwarding
methods. Tools retain result mapping. Apply the existing tool fence in the
MCP adapter to both built-in and extension tools, removing the separate
extension wrapper. Bot inbound routes remain actual transport registrations.
Do not change pairing, binding, COT product rules, or the first-bind issue.

### 7. Provider values and dormant overrides

Codex allocates its socket directly from its existing paths collaborator at
each runtime start/restart; no construction-time snapshot of that resource.
Remove public process/client factory overrides and call the concrete
constructors. Claude removes its binary resolver, session factory, and session
id generator overrides, using its configured binary and normal constructors.
Feishu removes provider/session `botFactory` and internal `createTransport`.
These overrides have no current repository suppliers; package export alone
does not establish one. Remove empty options types only after their remaining
fields are examined. Keep numeric restart/backoff/deadline settings.

Remove unused construction clocks, suffix/id generators, runner factories,
module-import overrides, `chmodFn`, and executable-directory probe overrides
only after tracing every production and test supplier. No API is called dead
merely from its name. Preserve actual deterministic seams listed below.

| Public contraction | Upgrade accounting |
| --- | --- |
| Codex process/client overrides | Ordinary `minor` note; custom embedding overrides cease to be supported |
| Claude binary/session/id overrides | Ordinary `minor` note; custom embedding overrides cease to be supported |
| Feishu bot override | Ordinary `minor` note under the Dreamux-internal package policy |
| Claude session/RPC diagnostic `log` inputs | Replace positional callbacks with optional `DreamuxLogger` values; include this source-contract change in the ordinary Claude package note |
| Other removed exported overrides, if confirmed unused | Enumerate exact exports and real effect in the completion report and ordinary package change note |

Outside usage is unknown. This is an intentional API contraction, not a
promise of external source compatibility. No selected change alters persisted
formats, paths, accepted config shapes, or requires a manual rebuild. Do not
write `BREAKING:`, `Rebuild:`, or a 0.x `major` note for this work.

## Retained functional contracts

| Contract | Reason and consumer |
| --- | --- |
| Dispatcher Workflow `createLocked` wrapper | Sole current dispatcher gate; product asymmetry deferred |
| Upsert reconciliation and transactional change callbacks | Per-operation policy over the authoritative current record |
| `RuntimeStateFence.terminate`/`log` | Shared once-only native teardown, observed by both runtime stop paths and existing tests |
| Transactional store load/encode | Store-owned codecs, not parent-state routing |
| Runtime protocol subscriptions and RPC handlers | Actual native protocol boundaries |
| Neutral runtime activity/path contracts | Real provider-facing capabilities; no provider-specific knowledge moves into core |
| Bot inbound routes | Transport event registration with lifecycle admission |
| Bounded-operation callbacks and inbound work context methods | Behavior of one owned call, not session backreferences |
| Restart `runControl`, provider-contract failure callback | One operation at a real layering boundary |
| Command parse/execute and local admit/track operations | Call-scoped protocol/functional operations |
| Feishu COT clock, OS getuid, admin isPidAlive | Existing supplying tests; preserve verified consumers |
| Shared `createScanBudget.now` | `dreamux-utils/tests/activity-scan.test.ts` supplies a fixed clock for entry-budget assertions and a mutable test clock for deadline expiry; `activity-scan.ts` computes and checks the deadline. Production uses Date.now. This deterministic test capability is not an owner-state transport; provider adapter clocks have no suppliers and are removed. |
| `ServiceNodeProbe.realpath` / `isExecutable` | Onboarding/service-Node selection and doctor consume simulated filesystem facts. The parent deleted-test ledger records the onboard supplier to restore; the OS owner cannot supply those synthetic layouts. This is distinct from the removed executable-directory probe override. |
| MCP server/shim log sinks | Process boundary; log output must remain off stdout |
| Server logger factories and socket sweep | Real CLI supplier; only the public composition boundary remains |
| Workflow runner IPC handlers | WorkflowRun supplies message/exit/error handlers bound to that run; these are child-process notifications, not a construction override. |
| Provider loader specifications and contract-failure handlers | Runtime/channel adapters supply kind-specific validation and error construction to the neutral loader; foreign provider contracts cannot be replaced by a core owner. |
| Plugin/extension hooks and lifecycle functions | Foreign implementations supply their actual behavior; hook isolation and extension-session lifetime remain with the host. |
| Daemon/onboard command runner and prompts | CLI supplies host IO; the parent deleted-test ledger retains command/answer fixtures. Consumers perform process/UI operations rather than query parent state. |
| Allocation predicates and slash-card name resolution | One allocation or rendering call supplies its own collision/publication or optional bot lookup operation; no construction policy or parent fact is threaded. |

The shared scan clock's test supplier captures a mutable clock in the elapsed
expiry case and no changing state in the three fixed-clock cases. Its consumer
cannot substitute the real clock without losing deterministic elapsed-time
coverage. Identity/expiry listeners capture their actual subscriber and fixed
role; they are subscriptions owned by the local object graph, not callbacks
injected into the publisher's construction contract.

Prepared completion handles belong to the selected Agent or Team for one
queued delivery and its retries. TeamRecordHandle belongs to its TeamStore
transactional record. LockedTeammate belongs to one Workflow run and Agent lock
until finalization. Channel event-source and runtime publication leases belong
to their generation and reject retired writers; MCP delegates are bound to one
role generation until lease release. Inbound contexts and ask-user activation
handles are limited to one operation or round. These returned capabilities do
not inject parent-state queries. A row here is not a blanket exemption for
adjacent closures.
Any additional retained constructor callback must name its supplier, consumer,
capture, and why the actual owner cannot replace its transport.

## Adjudication

Adopt Claude's revised owner-query, command-host, Feishu operation ownership,
Team-owned tools, and store-owned events. Adopt DeepSeek's retention of the
actual CLI extension boundary and early Workflow logger-value resolution.
Channel logger creation remains at build because it allocates a file. MiMo's
cross-review supports the local event ownership and tool movement, but its
readiness method would add a Team check and is not selected.

Reject the global bus router, parent-supplied scope emitter, MCP assembly
wrapper, gate combinator made of closures, stable dispatcher recipient that
defers `mustAgent`, early-return provisioning, and numeric-option removal.
The construction handle is accepted because it also deletes factory option
and alignment callbacks and keeps role computation outside persistence. It
must remain a small private-store owner, not a new recovery state machine.
Do not reproduce first-round claims that later source checks disproved.
The implementation's Server address-resolution placement is accepted for the
pre-start error-order reason in section 5; it adds no owner or resolver bag.

## Preservation and verification

The feature-loss ledger is the explicit public override contraction above.
Internal creation/record-close aggregate notification changes its promise
continuation, but not its order relative to identity publication, launch hooks,
or operation completion. No other behavior delta is selected. In particular,
preserve configured-but-disabled dispatcher behavior, completion suppression,
queued delivery, all gate precedence, worktree cleanup authority, runtime
restart resource allocation, Feishu waiter order, and send-before-save.

All previously deferred product questions remain deferred; add the policy for
admin commands to disabled dispatchers to that later discussion. Final parent
coverage remains separate under R43. No test incompatibility has been
demonstrated by consultation; report one if implementation finds it. Do not
repair tests or delete one to conceal a changed contract.

One source writer implements the whole selected solution. The TeamLeader owns
`.agents`, GitHub, commits, and delivery. Required evidence: all four Rush
gates, exact test inventory changes, whole-diff structural accounting (deleted
mechanisms, new owners, remaining callback paths), large-file responsibility
counts, event/lifecycle ordering traces, and independent heterogeneous review.
No test run alone proves live Feishu/Codex behavior; state that coverage limit.
If source contradicts a preservation claim, report the concrete path before
adding compensating state or changing a product rule.

Knowledge closeout updates the affected service, completion, channel, plugin,
runtime, and maintenance owners to current code, then runs the KB checker.
Delivery is another reviewed child PR into #453, not a merge of #453 to `next`.
