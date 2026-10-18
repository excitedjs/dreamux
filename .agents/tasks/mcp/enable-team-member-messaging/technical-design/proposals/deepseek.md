# DeepSeek independent solution proposal

Input: [Requirement revision 1](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md),
finalized 2026-10-13 (Q1, Q1a, Q2, Q3). This is the assigned seat's proposal. It
is not an accepted technical solution and grants no development approval. All
source references are to the current tree at this proposal's writing.

## 0. What this proposal delivers

Two capabilities, one requirement task:

1. **Ordinary-member proactive messaging** — an ordinary TeamMate can send to
   its TeamLeader and to same-Team peers, and reply across completed turns.
   This is the #471 core.
2. **Automatic TeamLeader reporting of provider-observed native results** —
   every normally completed native turn (Q1) and every observed failed native
   turn (Q1a) from an ordinary Team member reports its result to that Team's
   TeamLeader, whether or not a Dreamux submission is associated with it,
   delivered once even when submission settlement and native observation
   describe the same result.

The two share one prerequisite the current architecture lacks: an ordinary
member has today *no Agent-facing tool surface of its own* and *no way for Core
to learn of a native turn that answered no submission*.

## 1. Owning components and boundaries

| Component | Owns | Why it is the owner |
|---|---|---|
| `agent/mcp.ts` (`createMemberMessagingMcpDelegate`) | The member tool catalog (`send`, `list`) and its request parsing | One protocol implementation; each role's callable surface is a delegate. New sibling of the existing dispatcher/leader delegates. |
| `agent/index.ts` (`TeammateCollection`) | Attaching that delegate to each ordinary member's launch options, and delivering a peer message with host-bound provenance | The collection already owns ordinary-member construction and `SendTeamMateInput` delivery (`teammateOptions`, `index.ts:823-846`). |
| `team/service.ts` (`TeamService`) | The leader-addressing port (leader name, leader send) and the roster | The Team owns its leader and its record's `leader_name`; the leader-submission entry is `TeamService.submitInput` (`service.ts:834`). |
| `agent/service.ts` (`AgentService`) | Reporting an unbound native result to the member's owner-resolved recipient | It already owns one entity's turns, `owesCompletion()`, and the delivery policy call (`service.ts:391-416`). |
| `agent/runtime-generation.ts` | Leasing the new native-result sink to one runtime generation | It mints every per-generation sink (activity, state) and drops writes from a revoked generation (`runtime-generation.ts:304-322, 393-419`). |
| `@excitedjs/dreamux-types` (`agent-runtime.ts`) | The neutral result sink contract | The neutral seam lives here; Core never names a provider. |
| `@excitedjs/dreamux-agent-runtime-claude-code` | Emitting native results it observes | The provider is the only party that sees a native turn end. |

No provider-specific concept enters Core; no Core concept enters a provider.

## 2. The ordinary-member messaging capability

### 2.1 One bundle, one owner

The member capability is supplied as a **Collaborator bundle at entity
construction**, not as a role branch in shared code:

- `TeammateCollectionOptions` gains an optional `memberMessaging?: MemberMessagingPort`
  and the MCP primitives it needs (`Pick<TeammateAgentMcp, 'leases' | 'adminSocketPath'>`).
- `TeamService` supplies both when it constructs its member collection
  (`team/service.ts:208-221`); the dispatcher-scoped collection supplies neither.
- `teammateOptions` attaches the member delegate and the unbound-result
  recipient **only when the bundle is present and the entity is not created
  under a Workflow lock** (see §2.5, §3.4).

Presence of the collaborator *is* the policy, exactly as the repo prefers a
nullable dependency over a boolean plus a branch. The consequence is deliberate
and matches the requirement scope: **ordinary members of a Team get the feature;
dispatcher-scoped ordinary members do not** (requirement, Scope: "Cross-Team and
Dispatcher-scoped member messaging have not been requested"; Q1: "ordinary Team
member").

### 2.2 Tool surface

A new `MemberMessagingScope` (structural, so the collection-tier delegate never
imports the team tier):

```
interface MemberMessagingScope {
  readonly self: string;                       // host-bound sender identity
  roster(): Promise<MemberRosterRow[]>;        // leader + same-Team peers, self excluded
  sendToPeer(name: string, text: string): Promise<AgentEntitySendResult>;
  sendToLeader(text: string): Promise<TurnAdmission>;
}
```

Two tools, matching the candidate catalog and the minimum a peer conversation
needs:

- `send { to, message }` — `to` is a concrete name from `list`. Resolution:
  the leader name routes to `sendToLeader`; a member row routes to
  `sendToPeer`; the sender's own name or an unknown name is refused with an
  actionable error. Returns the existing admission receipt
  (`submissionReceipt`, `mcp.ts:565-572`).
- `list {}` — rows `{ name, role: 'leader' | 'member', status, intent? }` for
  the TeamLeader and this Team's members, excluding self. Reuses the existing
  member `list()` projection (`index.ts` `TeammateOps.list`) plus the leader row
  from the port.

`spawn`, `close`, `history`, `status`, `last`, `get_capabilities` are **not**
exposed to a member: the requirement states member spawn/close/dissolve
authority is not implied, and reading a peer's activity was not requested.

### 2.3 Sender binding and scope (host-owned)

- `self` is bound once, at delegate construction, from the entity's own
  `identity.name` (`teammateOptions`). The `send` schema has **no** sender
  parameter, so the model cannot substitute a sender identity.
- The message envelope is built by one Core producer:
  `source: TEAMMATE_MESSAGE_SOURCE` (`'teammate-message'`, added to
  `service/submission-sources.ts`), `attrs: { from: self }`, `text: message`.
  `renderSubmission` (`agent/submission.ts:95-110`) renders sender identity as
  an escaped attribute the recipient reads; it is host-authored, never model
  input.
- Addressing is bounded by construction: the delegate reaches only its own
  Team's collection and its own Team's leader port, so a name from another Team
  cannot resolve. This satisfies "the model cannot address another Team's
  member" without an allowlist.

### 2.4 Routing and recipient semantics (unchanged Team ownership)

- **Peer → peer**: `sendToPeer` submits the message envelope through the
  member's own collection with the collection's existing recipient. The peer's
  turn is a normal submission whose `completionRecipient` is the Team, so its
  completion reports to the TeamLeader (confirmed baseline: "A peer-triggered
  completion goes to the TeamLeader"). The initiating peer receives nothing
  automatically; it must be answered by an explicit send.
- **Member → leader**: `sendToLeader` calls `TeamService.submitInput` with the
  same envelope and **no `completionRecipient`**, so the leader's turn pushes no
  completion back to the sender (confirmed baseline: "A message to the
  TeamLeader does not create an automatic completion reply to the sending
  member"), and TeamLeader-to-Dispatcher obligations are untouched (the leader's
  own `deliverCompletionToDispatcher` decisions live where they already do,
  `service.ts:345-347`).
- **Admission**: the receipt returns as soon as the submission is admitted; it
  proves neither execution nor model receipt (confirmed baseline).

### 2.5 Idle wake, busy input, reopen, Workflow exclusion

- **Idle/busy** are the runtime's, not Core's: `send` uses the existing
  `submitInput` → `ensureRuntimeStarted()` path (`service.ts:288-314`), which
  wakes a stopped member and hands busy input to `runtime.submit`, whose merge
  behavior is each provider's own (`codex` and `claude-code`). No Core special
  case, satisfying "documented rather than hidden by a Core special case."
- **Q2 reopen**: peer send reuses the existing `TeammateCollection.send` →
  `sendReopened`/`reopenFrom` path (`index.ts:250-325`). A durably closed
  same-Team member is reopened from its recorded session and then receives the
  message. Reopening a closed/dissolving **Team** stays refused by the existing
  Team/entity fences.
- **Q3 Workflow exclusion**: `createLocked` (Workflow) passes
  `CreateLockedTeammateOptions.locked = true`; `teammateOptions` omits the
  member messaging delegate and the unbound-result recipient for a locked
  member. A Workflow-controlled member therefore exposes no new tools and its
  turns produce no ordinary-member report (script-consumed results stay the
  Workflow's). A closed record that a Workflow once created is an ordinary
  member on reopen, per Q3.

### 2.6 Architecture note (deliberate change)

`service-types.ts:105-107` states "an ordinary TeamMate has no Agent-facing tool
surface of its own." This proposal **changes that invariant to "ordinary Team
members have exactly one narrow surface: peer/leader messaging."** That is the
point of #471 and is paid for by a stated requirement, but it is a real shape
change: every ordinary member now launches one more MCP server (a stdio shim
lease), where before none did. It is named here rather than allowed to appear as
a side effect.

## 3. The provider-neutral native-result capability

### 3.1 The gap

`EntityTurn` exists only for an admitted `RuntimeSubmission` and is the only
carrier of an automatic report (`turn.ts:55-93, 141-150`; `service.ts:340-344`).
A provider-observed native turn that answers no submission creates no Core turn
and no report (requirement, "Current source behavior"). No runtime fact proves
native background work drained: `requests.size` is unanswered Dreamux inputs and
zeroes at the first result; `AgentRuntimeStatus` is lifecycle only (requirement,
"Current source behavior"; confirmed during consultation).

### 3.2 The neutral seam

Add one **leased, push-only sink** to the runtime create context, beside `state`
and `activity`:

```
/** Native results that answered no Dreamux submission, pushed by the provider. */
export type AgentRuntimeResultSink = (result: RuntimeCompletion) => void;

// AgentRuntimeCreateContext:
readonly results: AgentRuntimeResultSink;
```

Contract (`packages/dreamux-types/src/agent-runtime.ts`):

- The provider emits **only results that answered no submission**; a result that
  settled a submission is reported through that settlement and is **not** also
  pushed here.
- When (in some future provider) both describe the same result, the provider
  **must pass the same `RuntimeCompletion` object** to the sink and the
  settlement, so Core delivers once.
- An **interrupted** result must never be pushed here (Q1a is failure-only;
  interruption coverage is unchanged).
- Like `activity`, the sink never throws and the provider writes it bare; Core
  drops writes from a revoked generation.

Naming and placement follow the white paper: the sink is named for the promise
("here is a native result no request is waiting for"), not the technique, and it
carries no source taxonomy, dispatcher id, or Team.

### 3.3 Core handling and shared-result identity

`runtime-generation.generationResultSink(lease)` mirrors
`generationActivitySink` (`runtime-generation.ts:304-322`): it validates the
generation lease and forwards to `AgentService`, which:

1. resolves the member's owner recipient from the bundle
   (`completionOwner.completionRecipient()`, present only when the bundle is
   present and unlocked);
2. applies the same suppression as `EntityTurn` — `owesCompletion()`
   (`service.ts:391-394`) and the delivery policy's dispatcher fence
   (`completion-router/index.ts:126-136`);
3. builds a `PreparedCompletionFact` — `{ kind: 'teammate', source: name,
   role, status: completion.status, result }` — and calls
   `delivery.deliverRuntime(recipient, completion, fact)`.

**Identity/folding needs no new mechanism.** `CompletionDeliveryPolicy` already
folds on the `RuntimeCompletion` object (`completions: WeakMap<RuntimeCompletion,
Promise<void>>`, `completion-router/index.ts:63-67, 121-146`). Sharing the
object between the sink and a settlement therefore yields exactly one report;
per-recipient FIFO order and the never-retract rule are inherited. In the
current adapters the two sets are disjoint, so folding is a guard, not the
normal path.

### 3.4 Provider adapters

- **claude-code (`rpc.ts`)**: on a non-interrupted `result`, compute the
  completion **unconditionally** (today `completionFromTurnOutcome` is called
  only when `answered.length > 0`, `rpc.ts:307-314`). Settle the answered
  requests with that object as today, and, when `answered.length === 0`, push
  the same object to the results sink. Interrupted results keep settling
  `stopped` and push nothing.
- **codex**: whether it observes a native turn that answers no submission is
  **not evidenced** in this tree and is a named unresolved fact (§9). If it does
  not, it simply never calls the sink and no behavior changes; if it does, it
  follows the same contract. This is the one place the two runtimes may differ
  in coverage, and the difference must be documented, not hidden.

## 4. Notification wording alignment

Authorized by Q1's recorded wording instruction ("Host-generated notification
wording must state the observed fact"). Two texts currently overclaim:

- `agent/completion-renderer.ts:52-53` renders a completed submission as
  `"<subject> has finished its task."` Change the completed line to state the
  observed fact (a turn ended and returned a result), not goal achievement.
- `agent/system-prompt.ts:32` promises "Your TeamLeader receives what you output
  when your turn ends," which omits the background case. Reword to the actual
  contract: the TeamLeader receives the member's completed-turn results, and the
  member may also explicitly send.

Both are user-visible text: the product catalog's "Background work and
completion delivery" entry and role instructions are updated in the same change
(an acceptance criterion). Neither wording change expands coverage.

## 5. Capabilities: reused, removed, new

- **Reused**: `renderSubmission`; the submission/admission/receipt path;
  `EntityTurn` and `CompletionDeliveryPolicy` (including folding); the
  `TeammateCollection` reopen path; `TeamService.submitInput`; the MCP
  delegate/lease/shim infrastructure; the activity/state sinks' shape.
- **Removed**: nothing. The feature is additive; the only edits to existing
  user-visible behavior are the two wording corrections (§4), which Q1
  authorized.
- **New** (each paid for by the requirement):
  1. `MemberMessagingScope` delegate + `send`/`list` tools (#471 core).
  2. `TEAMMATE_MESSAGE_SOURCE` provenance name.
  3. `TeammateCollectionOptions.memberMessaging` port + MCP-primitive pass-through.
  4. `AgentRuntimeResultSink` on the create context (Q1/Q1a).
  5. `generationResultSink` + the `AgentService` unbound-result handler (Q1/Q1a).

No work-drain fact, no aggregation state, no result-holding buffer, no new
persisted state, and no completion-recipient entity is introduced — the deferred
aggregation candidate needs a quiet-point fact that does not exist and is
correctly not built.

## 6. Public contract and provider compatibility

- `@excitedjs/dreamux-types` gains the `AgentRuntimeResultSink` type and a
  **required** `results` member on `AgentRuntimeCreateContext`. Required matches
  the existing `state`/`activity` treatment and forces in-tree providers to
  handle it deliberately.
- Semver/changelog: an added create-context member is an API change, not an
  upgrade blocker — an existing external provider receives the extra field and
  ignores it; the daemon still starts. Record it as an ordinary note (no
  `BREAKING:`/`Rebuild:`), type `minor` on the 0.x line for
  `@excitedjs/dreamux-types` and the two provider packages. An external provider
  that does not adapt silently observes no unbound results — a documented
  limitation, not a crash.
- The MCP tool catalog is additive; existing role catalogs are unchanged.
- No state/config file shape changes; `dreamux-maintenance` is not affected by
  §1–§3. The product catalog and role instructions are updated per §4 and the
  acceptance criteria.

## 7. Lifecycle, concurrency, shared identity

- **Recipient resolution** is per-entity and owner-supplied; a dissolving Team
  or closed dispatcher reports `unsupported`/drops through the existing
  `prepareCompletion` fence (`team/service.ts:1060-1096`).
- **Owner-stop suppression**: an unbound result uses the same `owesCompletion()`
  gate as a settled turn, so closing a member, stopping the service, or an
  owner-requested stop still suppresses the report (`turn.ts:127-152`).
- **Generation safety**: the sink is leased per runtime generation; a replaced
  generation's late result is dropped, exactly as activity is
  (`runtime-generation.ts:304-322`).
- **Dedup**: identical-envelope submissions still dedupe on `sourceId`; the
  member `send` supplies none (a peer may legitimately send the same text
  twice), matching "admission does not prove execution."
- **Once-only delivery** is the shared-object invariant of §3.2–3.3.

## 8. Acceptance / verification mapping

| Acceptance criterion (requirement) | Mechanism | Verification |
|---|---|---|
| Member proactively reports progress/blocker to the Leader, sender visible | `send` → `sendToLeader`; `attrs.from` | agent-tier delegate test: envelope carries `from`; renderer escapes it |
| Two peers send/reply directly across turns, no Leader relay | `send` → `sendToPeer`; peer's recipient stays Team | collection test: peer submission recipient is the Team, not the sender |
| Idle send starts processing; busy follows runtime | `submitInput` wake path | provider tests in each runtime package; differences documented |
| Every distinct applicable completion reaches the Leader; peer gets only explicit replies; folds do not duplicate | `EntityTurn` + `CompletionDeliveryPolicy` folding | completion-router test: same token delivered once |
| Unbound normal native turn follows the same contract; not delivered twice | `AgentRuntimeResultSink` + shared object + fold | claude-code adapter test: unbound `result` pushes one object; core test folds sink+settlement |
| Unbound failed native turn reports failure once | same sink, `status: 'failed'` | adapter test; no report for owner-ended work |
| Leader receipt creates no reply loop to the member | leader send has no `completionRecipient` | test: leader turn delivers nothing to sender |
| Sender binding/scope host-owned | bound `self`; Team-scoped ports | test: no sender param; cross-Team name unresolved |
| Peer send reopens closed member; fences hold | `sendReopened` reuse | collection reopen test; Team-closed refusal test |
| Workflow members get no new tools, no duplicate report | `locked` gate; lock refuses ordinary input | locked-member test: empty member catalog; lock refusal |
| Validate both runtimes; document busy differences | provider-package tests | codex + claude-code suites; live codex gated |
| Update role instructions, tool descriptions, product behavior, architecture docs | §4 + delegate descriptions | docs diff in the same change |

## 9. Named risks and unresolved facts

1. **Dispatcher-scoped ordinary members are excluded** from both messaging and
   unbound-result reporting (the bundle is Team-only). This matches the recorded
   scope, but it is a narrowing the operator should confirm; if uniform
   owner-reporting for dispatcher-scoped members is wanted, it is a material
   product change and must return for confirmation.
2. **Codex native-result coverage is unproven.** No unbound native turn is
   evidenced for codex; Q1/Q1a may be Claude-only in practice. Must be verified
   in the codex adapter and documented, not assumed.
3. **Provider shared-object discipline.** If a provider ever pushes a *different*
   object than the one it settled, the leader gets a duplicate. This is a
   provider-contract invariant with a cross-package test.
4. **Lock-at-creation assumption.** Q3 exclusion is enforced by gating the
   bundle at construction. If any future path locks an already-launched member,
   the gate must move; today `createLocked` is the only locking path.
5. **New per-member MCP server.** Every ordinary member now launches an MCP shim
   lease (§2.6); the launch-count and lease consequences should be checked in
   the runtime-generation and mcp-lease tests.
6. **Wording change is user-visible text** and must land with the product
   catalog/role-instruction updates in the same change.

## 10. Trade-off and blocker

**Strongest trade-off.** The messaging feature is cheap and reuses everything
(routing, reopen, admission, MCP infra). The expensive part is Q1/Q1a: a new
provider-level sink whose correctness rests on a cross-package invariant (one
shared `RuntimeCompletion` object, unbound results only, never interrupted).
The design deliberately avoids the deferred aggregation candidate's
work-drain/quiet-point fact, which does not exist. If a reviewer prefers to
avoid touching the provider seam, the only alternative is candidate B
(submission-bound only), which the operator explicitly did not select.

**Blocker / first decision:** whether codex observes an unbound native
completion at all (§9.2) determines whether Q1/Q1a are a two-runtime contract or
a Claude-only one with a documented gap. Until that is verified, the provider
capability's exact shape (a required sink implemented by both adapters, versus a
sink implemented by one and accepted-but-unused by the other) is unresolved.

---

# Cross-review (round 7)

Sections above are the preserved independent first-round proposal. This section
is written after reading `mimo.md` and `trae-seed.md`. Adjudication is against
current owning source and `requirement.md` revision 1; findings are not decided
by which seat agreed with which. Recorded operator decisions (Q1, Q1a, Q2, Q3,
and the #471 baseline) are quoted authority; anything else below is a fact to
verify or a technical choice.

## CR1. Source-verified corrections to my own first round

1. **Codex does have an unbound native-turn observation point — my §3.4/§9.2
   was too cautious.** `packages/agent-runtime/codex/src/turn-manager.ts`
   maintains `unboundObservedTurnIds` (line 62) and a native-turn record whose
   `representative` is `null`; `drainTerminalOrder` releases such a queue head
   with "nothing to settle and no completion to describe" (lines 285-294) and
   `finalize` returns early for it (line 309). So the *category exists in
   source*: the Codex adapter can be given a sink emission at that point. What
   remains unproven is only the **frequency** of such turns from real Codex
   traffic (Dreamux-originated turns are bound). "Codex coverage may be
   Claude-only" is wrong as a statement about the adapter; "real Q1 traffic may
   be mostly Claude-observed" is what the evidence supports. I accept
   `trae-seed.md` §4.3 and `mimo.md` §7.2 on this point and withdraw my
   stronger claim.
2. **`answered.length === 0` is exactly "answered no Dreamux submission."** In
   `claude-code/src/rpc.ts:279-314`, `answered` is drawn from `this.consumed`
   plus the result's own `userMessageUuid`, filtered to ids present in
   `this.requests` — and `requests` holds only Dreamux submissions
   (`rpc.ts:104`). So an unbound result is precisely a non-interrupted result
   frame with zero answered requests. My "emit only unbound" rule is
   implementable exactly, not approximately.
3. **A failed native report today carries no error text.** `EntityTurn` builds
   the fact with `result: outcome.status === 'completed' ? outcome.resultText :
   null` (`turn.ts:141-147`) and the notice is `${possessive} task failed.`
   (`completion-renderer.ts:54-55`). Any proposal that puts `error.message`
   into the report body changes existing user-visible failure reporting.

## CR2. Accepted and rejected arguments, with evidence

### CR2.1 Provenance: no new source constant (accept MiMo; reject myself and Trae Seed)

I reject **my own** `TEAMMATE_MESSAGE_SOURCE = 'teammate-message'` and
`trae-seed.md`'s `MEMBER_MESSAGE_SOURCE = 'team-message'`, and accept
`mimo.md` §5.4 (stamp `attrs: { from: <host-bound caller> }` on
`AGENT_TASK_SOURCE`).

Evidence: `submission-sources.ts:1-15` states the names are an open,
owner-chosen vocabulary and that "the renderer never imports this file and
renders whatever name it is handed"; nothing branches on a source.
`AGENT_TASK_SOURCE` is documented as "Work an Agent handed to another Agent: an
MCP spawn or submit, a Team's creation prompt, and a Workflow step"
(`submission-sources.ts:30-34`) — a peer/leader message *is* an MCP submit by
one Agent to another, so it is already in scope of that constant's stated
meaning. A new name would encode one bit (`from`) the envelope already carries,
which is exactly the "a new mechanism that removes nothing" shape the
engineering whitepaper bans. The recipient's model reads
`<task from="alice">body</task>`, uniformly with the leader's existing sends.

Trade-off kept explicit: no source-based filtering is possible for a future
Channel/display that wants to distinguish a member message from a delegated
task. No recorded requirement asks for that, so it is not paid for.

### CR2.2 Emission scope: provider emits only unbound results (reject both other seats)

Reject `mimo.md` §7.2 and `trae-seed.md` §4.2/§4.3 "emit the completion for
**every** non-interrupted result frame, bound and unbound, and let the fold
dedupe." Keep my §3.2 "the provider emits only results that answered no
submission."

Two independent reasons, both grounded:

- **It keeps today's bound-report fact byte-identical.** If the sink emits a
  bound result, the sink-authored `PreparedCompletionFact` and the
  `EntityTurn`-authored fact race for the fold, and whichever calls
  `deliverRuntime` first wins (`completion-router/index.ts:140-145`). That
  makes the delivered wording/body for the common, today-working bound case a
  function of two code paths instead of one — a behavior surface the
  requirement did not authorize ("Preserve existing ... completion folding ...
  semantics"). Unbound-only leaves the bound path untouched.
- **It makes the fold a guard, not the load-bearing normal path.** With
  disjoint sets the identity WeakMap only protects a provider that violates its
  contract; with overlapping sets the fold is on the normal path for every
  bound turn, so a single provider mistake silently double-delivers or silently
  rewrites a report.

This also removes the constraint both other seats cite as *forcing* a shared
fact mapping for fold-correctness (MiMo §7.4): with disjoint sets there is no
first-writer race to equalize, so the failure-body decision below becomes an
optional product question rather than an implementation necessity. The shared
mapping is still worth extracting (`turn.ts` inline → one function) so both
paths word a result identically, but it is no longer load-bearing for dedup.

### CR2.3 Context field required, provider emission optional (accept MiMo; reject Trae Seed's `optional`)

Accept `mimo.md` §7.1 (`readonly results: AgentRuntimeResultSink`, required on
`AgentRuntimeCreateContext`). Reject `trae-seed.md` §4.1's `nativeResult?`.

Evidence: `agent-runtime.ts:300-303` shows `state` and `activity` are required
members of the same context; a third required sink is the consistent shape, and
"required" here means only that **Core always supplies it**. Trae Seed's
"optional" conflates the context field with the provider's *emission*: a
provider may always choose not to call the sink (that is inherently optional),
but Core must always hand it one, and the required type is what makes both
in-tree providers handle it deliberately. `trae-seed.md` §4.1's compatibility
claim ("existing third-party/test providers compile unchanged") still holds for
a required *consumer-only* field: a provider compiled against older types reads
the context structurally and simply ignores the extra property at runtime.

### CR2.4 Failed-report body: keep `result: null` (reject MiMo's §7.4 change)

Reject adding `error.message` to the report body. Evidence above (CR1.3).
Q1a's verbatim decision ("失败也自动报") requires reporting the failure; it says
nothing about adding the cause text, and the existing submission-associated
failure report deliberately omits it. Adding it to *only* the new unbound path
would make two identically-worded failures carry different amounts of detail;
adding it to both is a user-visible change to shipped behavior that no recorded
decision authorizes. Keep `result: null` uniformly; the failure notice remains
`TeamMate X's task failed.`

### CR2.5 Member tool schemas (accept MiMo/catalog; reject Trae Seed's divergent names)

Keep `send` / `list` (my §2.2, `mimo.md` §5.2 deposit via the `team_member`
scope), reject `trae-seed.md` §5.2's `send_message` / `list_members`.
Evidence: the TeamLeader's existing member verb is `send`
(`agent/mcp.ts` `send` handler); the delegate is one protocol implementation
per domain, and a second name for the same verb is a concept the model must
learn with no requirement behind it. Naming a member verb differently from the
leader's identical verb is pure vocabulary growth.

Addressing: accept `mimo.md` §5.3 — the roster carries the TeamLeader's
**concrete host name** and members address it by name; reject `trae-seed.md`
§5.2's reserved literal `"leader"`. Evidence: member names are dispatcher-global
and never reused (`service/CLAUDE.md` "Names stay dispatcher-global"), so the
leader's concrete name cannot collide, and one flat namespace needs no reserved
pseudo-name. `send` to one's own name is refused before dispatch in every
proposal; accepted.

Delegate home: prefer the scope arm inside the existing `agent/mcp.ts`
(MiMo and mine) over `trae-seed.md` §5.1's new `member-mcp.ts`. The module's own
contract is "each domain owns its tools through an in-server delegate"
(`packages/dreamux/CLAUDE.md`), and member messaging is the same teammate
domain; a new file for one scope is an avoidable second delegate module. This is
a low-stakes divergence, not a blocker.

`intent` is omitted from a member send (MiMo §5.2): correct — a peer must not
rewrite a recipient's durable recovery subject, and none of the three
requirements needs it.

### CR2.6 Construction gate and Workflow lifecycle

Accept the shared shape: a nullable Team-supplied collaborator bundle arms
ordinary members, and a locked construction disarms Workflow members. Prefer an
**explicit ordinary-vs-locked construction flag** over inferring it from
`CreateLockedTeammateOptions` shape (`mimo.md` §6) — same outcome, and it names
the decision at the entry point.

`trae-seed.md` §7.2 flags a post-unlock gap; source narrows it. A Workflow
closes every locked member at run terminal (`workflow-service/run.ts:696-708`,
closing all handles not already in `unlockedHandles`; the disarmed launch cannot
gain tools because MCP catalogs are launch-frozen, matching `mimo.md` §6). So a
Workflow-born member does not linger disarmed: it is closed, and a later reopen
takes the ordinary path and is armed (Q3: "historical creation by a Workflow is
not a new permanent member category"). The one residual edge — a peer send that
slips in during an *unlocked* inter-step window of a still-running Workflow — is
already governed by the existing lock gate and by Q3's literal wording ("while
they are controlled by a running Workflow"); it is not a new fact the design
must invent state for. Record it; do not add lineage state.

### CR2.7 Interruption boundary, generation, ordering, stop

All three agree and are source-correct: interrupted results emit nothing and
settle as today (`rpc.ts:297-329`; the codex interrupted terminal is classified
at `turn-manager.ts:241-243`); revocation drops stale writes (mirror
`generationActivitySink`, `runtime-generation.ts:304-322`); `owesCompletion()`
suppression is read at the delivery boundary as `EntityTurn` reads it
(`turn.ts:127-138`, `service.ts:391-394`); per-recipient FIFO and
never-retract are inherited from `completion-router/index.ts:148-158`. My
`reportNativeResult` queries `completionOwner.completionRecipient()` at
delivery time, matching all three proposals.

## CR3. Contract compatibility, delivery, and verification review

- **Contract compatibility.** All three land the sink as an additive neutral
  field and touch no persisted state, so no `BREAKING:`/`Rebuild:` and no
  `dreamux-maintenance` schema change; ordinary `minor` notes on the 0.x line.
  Agreement.
- **Shared completion identity.** All three rest once-only delivery on the
  provider passing the *same* `RuntimeCompletion` object to settlement and
  sink. This is a cross-package invariant; it deserves a reference-identity
  test in each adapter (accept `trae-seed.md` §13) because a structural clone
  would silently double-deliver. With unbound-only emission (CR2.2) this
  invariant is a guard rather than the normal path — strictly safer.
- **Verification.** Accept `trae-seed.md` §12's decision-matrix breadth
  (bound-once, unbound-completed, unbound-failed, interrupted-dropped,
  locked-suppressed, `owesCompletion`-negative, owner-absent, ordering,
  revoked-generation, dissolve→`unsupported`). The core rows this design must
  add: unbound result delivered once with turn output; leader receipt delivers
  nothing to a member sender; peer submission's recipient is the Team, not the
  sender; `from` cannot be model-supplied; a locked build advertises no member
  server. All four gates including `typecheck:tests`.

## CR4. Revised complete position (supersedes §2-§3 where they differ)

Everything in §0-§10 stands except the four points revised here:

1. **Member messaging.** A member scope arm inside `agent/mcp.ts` exposing
   exactly `send` and `list`; `send` addresses the TeamLeader or a same-Team
   peer by concrete host name; sender `from` is host-bound at delegate
   construction and never a schema parameter; provenance reuses
   `AGENT_TASK_SOURCE` with an `attrs.from` (no new source constant); peer
   sends ride `TeammateCollection.send` (Team remains the completion recipient;
   Q2 reopen unchanged); leader sends ride `TeamService.submitInput` with no
   `completionRecipient`; `intent` is not settable. Armed by a nullable
   collaborator bundle supplied only by `TeamService`, plus an explicit
   ordinary/locked construction flag; the dispatcher-scoped collection supplies
   neither, so cross-Team and Dispatcher-scoped messaging stay unrepresentable.
2. **Native-result capability.** One **required** `AgentRuntimeResultSink` on
   `AgentRuntimeCreateContext`, emitted by a provider **only** for a
   non-interrupted native result that answered no Dreamux submission
   (completed or failed), carrying the same frozen object a settlement would
   use. Core reports it through `AgentService` under the existing
   `owesCompletion` gate, the dispatcher fence, and the generation lease,
   folding on object identity as a guard. Both in-tree adapters get the
   emission point (Claude `rpc.ts` zero-answered frame; Codex
   `turn-manager.ts` unbound queue-head release). A submitted result is never
   also pushed.
3. **Failure body.** The report states the observed fact with `result: null`,
   unchanged from today; no error text is added without operator confirmation.
4. **Wording.** `completion-renderer.ts:52-53` and `system-prompt.ts:32` are
   corrected to state the observed fact (a turn ended and produced this output)
   and to name the messaging channel — agreed by all three seats, operator-
   visible.

Net new concepts against today: one neutral sink, one member scope arm with two
verbs, one nullable collaborator bundle, one construction flag, one host-bound
`from` attribute. No new source name, no new persisted state, no aggregation,
no work-drain fact, no mailbox.

## CR5. Recorded decisions vs facts still needing verification

- **Recorded (operator, verbatim):** Q1 每个完成回合自动报; Q1a 失败也自动报;
  Q2 允许 send 重新打开; Q3 只覆盖普通成员. These bind the design and are not
  reopened here.
- **Facts needing verification (not decisions):**
  1. Real-world frequency of Codex unbound completions (existence is now
     source-verified at `turn-manager.ts:285-294`); determines how much of Q1
     traffic Codex actually covers.
  2. Whether dispatcher-scoped ordinary members should also message/report —
     my §9.1 narrowing; the recorded scope says "not requested," so it stays
     excluded unless the operator says otherwise.
  3. Whether the failure notice should carry the cause text — CR2.4 keeps
     today's silence; changing it is a product decision.

## CR6. Remaining disagreements and blocker

- **Disagreement with MiMo and Trae Seed:** both emit the result for bound
  turns as well (relying on the fold); I keep unbound-only (CR2.2). I regard
  this as the one substantive correctness-surface difference in the round.
- **Disagreement with Trae Seed:** new source constant (CR2.1), divergent tool
  names (CR2.5), reserved `"leader"` address and separate `member-mcp.ts`
  (CR2.5), and `optional` context field (CR2.3).
- **Disagreement with MiMo:** the failed-report body change (CR2.4).
- **Genuine blocker (one):** the failure-report body and the dispatcher-scoped
  member scope are product-visible choices the design can implement either way;
  they need operator confirmation, not a technical adjudication. They do not
  block the messaging capability or the Q1/Q1a mechanism.

---

# Requirement revision 2 — independent revised proposal (DeepSeek)

- Authority: [requirement revision 2](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md),
  finalized 2026-10-13 after Q4 and the accepted MCP/owner placement. Revision 1
  sections above (`# DeepSeek independent solution proposal` and
  `# Cross-review (round 7)`) are preserved history; their conclusions are
  evidence, not accepted choices. Where this section differs from them, this
  section is my current position and states why.
- Status: independent proposal for the renewed consultation. Not a final
  solution and not development approval. Source references are to this tree.

## R2.1 What revision 2 changes

Q4 extends the same enhanced capability from Team members only to **both**
ordinary-member categories — Team-owned and Dispatcher-root — with one concise
reusable mechanism and no copied Team/Dispatcher implementation. Three deltas
matter to the design:

1. **Coverage.** The Dispatcher-root `TeammateCollection` (built by
   `DispatcherService` with `teamScope: null`, `completionOwner:
   this.dispatcherAgent`, `dispatcher-service/index.ts:235-250`) now arms its
   members exactly like a Team's collection arms its own. My revision-1 §9.1
   exclusion of dispatcher-scoped members is withdrawn — Q4 supersedes it.
2. **Owner-neutral capability.** The owner of a member is no longer always a
   TeamLeader. The capability's owner-facing inputs (the owner's name and the
   fenced inbox that submits to it) come from the actual owner through one
   structural bundle, so the agent/collection layer holds **zero** Team-vs-
   Dispatcher branch.
3. **A new acceptance criterion on ordering** (requirement, "Observable
   acceptance criteria"): mixed bound/unbound result ordering and delivery
   convergence must be explained and verified, because Claude's RPC parser
   settles bound submissions synchronously while Core's bound reporting runs
   through Promise continuations. This is a genuine new constraint that changes
   my native-result design (R2.7), not a restatement of the router's FIFO.

## R2.2 End-to-end behavior (identical in both scopes)

Only two facts differ by scope: *who the owner is* and *which members share a
peer scope*. Everything else is the same mechanism.

- **Member → owner.** Member `m` (in a Team or at the Dispatcher root) calls
  `send { to: "<owner name>", message: "blocked on X" }`. The delegate resolves
  `to` against the owner name supplied by its bundle, submits
  `{ source: AGENT_TASK_SOURCE, attrs: { from: m }, text: message }` to the
  owner's fenced inbox with **no** `completionRecipient`, and returns an
  admission receipt. The owner reads `<task from="m">…</task>` and replies with
  its own existing `send`.
- **Peer ↔ peer.** `m` calls `send { to: "peer", message }`; the delegate routes
  to its own collection's `send` (the same verb the owner uses), which resolves
  the peer, reopens a durably closed one under existing recovery (Q2), and
  submits with `attrs.from = m`. The peer's completion still reports to the
  actual owner because the collection stamps its owner's recipient
  (`agent/index.ts:318` for a Team, and the same line for the root collection
  whose `completionOwner` is the dispatcher agent). The peer answers `m` only by
  an explicit `send` back.
- **Automatic result reporting.** Every non-interrupted native result of an
  ordinary member — the turn that answers a submission and any provider-observed
  later turn that answers none — reports once to the actual owner (Q1 normal,
  Q1a failed). Work the owner itself ended stays silent. Peers receive only
  explicit replies.
- **Workflow exclusion (Q3).** A member built by a Workflow via `createLocked`
  is disarmed for that build: no member server, no unbound reporting; the
  Workflow closes it at terminal (`workflow-service/run.ts:696-708`). A later
  reopen is an ordinary build and is armed.

## R2.3 Owning components and boundaries

| Component | Owns | Change |
| --- | --- | --- |
| `service/agent/mcp.ts` | The `teammate` server and every scope | Add the third scope arm `member` with `send`/`list` and their receipt copy. Imports no Team or Dispatcher service. |
| `service/agent/index.ts` (`TeammateCollection`) | Mounting the member delegate and the reporting arm on each entity it builds; peer resolution, ordinary send, reopen | Consume one nullable owner bundle; set the member delegate + reporting owner in `teammateOptions` for ordinary builds only. |
| `service/team/service.ts` (`TeamService`) | Team-scoped owner addressing and the Team access boundary | Supply the bundle as `{ ownerName: () => mustRecord().leader_name, submitToOwner: (i) => this.submitInput(i) }`; pass MCP primitives to its member collection. |
| `service/dispatcher-service/index.ts` (`DispatcherService`) | Dispatcher-root owner addressing and the dispatcher fence | Supply the bundle as `{ ownerName: () => DISPATCHER_AGENT_NAME, submitToOwner: (i) => this.submitToAgent(i) }`; pass MCP primitives to its root collection. |
| `service/agent/service.ts` (`AgentService`) | One entity's turns, `owesCompletion()`, delivery convergence | Add `observeNativeResult(completion)` behind the same gates `EntityTurn` uses; pass the generation result sink from `RuntimeGeneration`. |
| `service/agent/runtime-generation.ts` | Per-generation leased sinks | Build `results: generationResultSink(lease)` beside `activity`, same lease gate. |
| `service/agent/turn.ts` | Outcome → fact mapping | Extract the shared `RuntimeCompletion`/outcome → `PreparedCompletionFact` mapping so the sink and `EntityTurn` word one result identically. |
| `service/agent/system-prompt.ts` | Member role prompt | Take a nullable owner descriptor instead of keying membership on `team_id`, so both scopes are told their owner and the channel. |
| `service/agent/completion-renderer.ts` | Push-notice wording | State the observed fact (a turn ended), not goal achievement. |
| `@excitedjs/dreamux-types` | Neutral runtime ABI | Add `AgentRuntimeResultSink` and the required `results` context member. |
| `claude-code` / `codex` packages | Native terminal observation | Emit each non-interrupted native result to the sink in terminal order. |

Boundaries hold: Core keeps zero provider vocabulary; the sink is a third
neutral fact channel beside `state` and `activity`, and the display seam is not
repurposed; no channel code is touched; no new routing service, mailbox, or
persisted state appears. `mcp.ts` stays above neither owner: it reaches both
through the same structural bundle.

## R2.4 The shared member-messaging capability

### R2.4.1 The owner bundle (one structural interface, two producers)

```ts
/** Supplied by the actual owner; consumed by the collection and the delegate. */
export interface MemberMessagingOwner {
  /** The owner's concrete, dispatcher-global name (TeamLeader name, or the
   *  Dispatcher agent's name). Read at build time, after the owner exists. */
  ownerName(): string;
  /** The owner's already-fenced ordinary-input entry. Both owners already
   *  expose one: TeamService.submitInput / DispatcherService.submitToAgent. */
  submitToOwner(input: Omit<TeammateSubmitInput, 'completionRecipient'>): Promise<TurnAdmission>;
}
```

`TeammateCollectionOptions` gains `memberMessaging: MemberMessagingOwner | null`
and `mcp: Pick<TeammateAgentMcp, 'leases' | 'adminSocketPath'> | null`. The
collection is *the same class* in both scopes (`agent/index.ts:131`); today it
carries `completionOwner` and `fence` and is told the Team scope, so a nullable
owner bundle is the same nullable-dependency shape the repo already prefers over
a boolean plus a branch. Peers are the collection itself, which already
implements `TeammateOps` (`types.ts:86`), so no second peer object exists.

Both producers are two lines:

- Team: `{ ownerName: () => this.mustRecord().leader_name, submitToOwner: (i) => this.submitInput(i) }`. `leader_name` is the record's stable name (`team/service.ts:282`); `submitInput` is already the Team-fenced leader entry (`team/service.ts:834-836`).
- Dispatcher root: `{ ownerName: () => DISPATCHER_AGENT_NAME, submitToOwner: (i) => this.submitToAgent(i) }`. `DISPATCHER_AGENT_NAME = 'dispatcher'` (`agent/identity.ts:17`); `submitToAgent` is the already-fenced dispatcher-agent entry without a completion recipient (`dispatcher-service/index.ts:352-359`).

This is the whole owner difference. Everything the delegate does with it is
owner-neutral.

### R2.4.2 The member MCP scope (third arm, not a merge)

`createTeamMateMcpDelegate` (`mcp.ts:109`) keeps serving the leader and
dispatcher catalogs unchanged and gains a third arm:

```ts
| { readonly kind: 'member'; readonly member: MemberMessagingScope }

interface MemberMessagingScope {
  readonly self: string;            // host-bound caller name
  readonly owner: MemberMessagingOwner;
  readonly peers: TeammateOps;      // the owning collection itself
}
```

I explicitly reject the alternative of *merging* the three scopes into one
generic scope: the leader/dispatcher catalogs (spawn/close/history/workflow/…)
and the member catalog (two verbs) are genuinely different surfaces, so a merge
would grow one N-valued discriminant without removing a concept (whitepaper §3).
The third arm is the minimal addition; the shared `teammate` server is the
mechanism it reuses.

Catalog (exactly two tools, advertised only on the member arm):

- `send { to, message }`, `to` 1..64, `message` 1..20000.
  - `to === self` → business refusal (a self-send would fold into the sender's
    own busy turn; no requirement reaches it).
  - `to === owner.ownerName()` → `owner.submitToOwner({ source: AGENT_TASK_SOURCE, attrs: { from: self }, text: message })`, **no** `completionRecipient`, so the owner's turn generates no reply loop and no new Dispatcher obligation.
  - otherwise → `peers.send({ name: to, prompt: message, attrs: { from: self } })`; unknown or cross-collection names resolve as "does not exist" through the existing scope check (`agent/index.ts:875` `assertInCollection`), and a locked recipient refuses through the existing ordinary-mutation fence.
  - Output: the existing admission projection (`submitted | duplicate | stopped | failed | ambiguous`) with a member-specific reminder stating that admission proves neither model receipt nor execution, that a reply arrives only via an explicit `send`, and that the recipient's completed turns report to **its** owner, not to the sender. The existing `TEAMMATE_DISPATCH_SUCCESS_REMINDER` promises a later pushed completion the member sender never gets, so the member arm must not reuse it.
- `list {}` → `{ owner: { name, status }, peers: [...] }`: the owner name (the only name from outside the collection) plus the collection's own compact rows from `peers.list()` with `self` filtered out. This is the whole addressing story; the owner is not a member and is never a `peers` row (Q2/Q4: "The owner actor is not added as an ordinary member of its own child collection").

### R2.4.3 Sender binding and provenance

`self` is bound once from `identity.name` when `teammateOptions` builds the
delegate; `send` has no sender parameter, so the model cannot spoof it.
Provenance stays `AGENT_TASK_SOURCE` with an `attrs.from` (no new source
constant): `submission-sources.ts` documents the names as an open, owner-chosen
vocabulary the renderer never branches on (`submission-sources.ts:1-15`), and
`AGENT_TASK_SOURCE` already means "work an Agent handed to another Agent"
(`submission-sources.ts:30-34`). A new name would encode one bit the envelope
already carries. `SendTeamMateInput` gains optional `attrs`, threaded through
`sendResolved` (`agent/index.ts:310-319`); source and attribute names are
validated by `renderSubmission`/`isSafeTagName` (`submission.ts:80-110`).

One named consequence: to let a member recognize a reply from its owner as
distinct from a peer, the **owner's reply must also carry `from`**. That means
stamping `attrs.from = <host-bound caller name>` on the existing leader/dispatcher
`send` delegate too, so the envelope from owner to member becomes
`<task from="<owner>">…</task>` instead of `<task>…</task>`. This is a
user-visible envelope change to shipped leader→member sends. I recommend it
because it makes one uniform rule ("every teammate send carries its sender") and
lets any recipient address its sender without an implicit "no `from` means the
owner" convention; it must be named for operator confirmation (R2.12). `spawn`'s
first prompt is left unchanged (out of scope).

### R2.4.4 Role prompt (owner-neutral)

`teammateSystemPromptOptions` (`system-prompt.ts:21`) currently keys the
membership sentence on `identity.team_id === null` and hardcodes "Your
TeamLeader". That key no longer matches how arming works: a Dispatcher-root
member has `team_id === null` yet now has an owner and needs the sentence, and a
Workflow member has a `team_id` yet is disarmed. Change the input to a nullable
owner descriptor supplied by the collection (present iff armed), worded once:
the member's Team/owner name, the now-true delivery promise (Q1/Q1a removed the
background exception that justified the old omission), that `send` reaches the
owner or a same-collection peer, that `list` shows whom, and that a reply
returns only via an explicit `send`. The single worded noun (TeamLeader vs
Dispatcher agent) is the one legitimate owner-specific branch and carries no
logic.

## R2.5 Justified owner-specific differences (and what is not branched)

| Concern | Team | Dispatcher root | Branched? |
| --- | --- | --- | --- |
| Owner name | `record.leader_name` | `DISPATCHER_AGENT_NAME` | Supplied by the bundle; **not** branched in the delegate or collection |
| Owner inbox | `TeamService.submitInput` | `DispatcherService.submitToAgent` | Supplied by the bundle; **not** branched |
| Peer scope | the Team collection | the root collection | Same class; **not** branched |
| Release recipient | Team leader (`completionRecipient()`) | dispatcher agent (`completionRecipient()`) | Same `completionOwner` field; **not** branched |
| Access fence | Team-then-dispatcher | dispatcher | Already composed by each owner's existing fenced entry; **not** re-implemented |
| Prompt noun | "TeamLeader <name>" | "your Dispatcher agent" | One worded branch, no logic |

## R2.6 Native-result capability

### R2.6.1 Neutral contract

Add to `packages/dreamux-types/src/agent-runtime.ts`, beside `state` and
`activity` (which are required members of the same context,
`agent-runtime.ts:300-303`), a required sink:

```ts
/**
 * Reports the provider-observed RESULT of each non-interrupted native turn.
 * Emitted once per such terminal, in terminal order, synchronously and
 * non-throwing like AgentRuntimeActivitySink. When the turn answered Dreamux
 * submissions, the value MUST be the same frozen RuntimeCompletion object
 * their settlements resolve with — object identity is the fold key. A provider
 * that never emits leaves bound reporting exactly as today.
 */
export interface AgentRuntimeResultSink { (completion: RuntimeCompletion): void; }
```

`AgentRuntimeCreateContext` gains `readonly results: AgentRuntimeResultSink`.
The field is required (Core always supplies it, matching `state`/`activity`);
*emission* is a provider coverage decision, so an external provider that ignores
it degrades to today's bound-only behavior and never double-delivers.

**Revised from revision 1 (§3.2, and my CR2.2):** the provider now emits **every**
non-interrupted result, bound or unbound, not unbound-only. Two reasons, both
new or re-examined:

1. The revision-2 acceptance criterion demands correct mixed bound/unbound
   ordering. With two delivery initiators racing on microtask timing, order is
   not guaranteed (R2.7); a single synchronous emission point per result frame
   *is* the ordering authority. Emitting unbound-only leaves the race.
2. With a shared fact mapping (R2.6.3) the bound payload is byte-identical
   whichever path reaches the router first, so my CR2.2 concern (a second,
   divergent bound fact) is removed; and exercising the fold on every bound turn
   makes it well-tested rather than a rarely-hit guard.

### R2.6.2 Provider emission points (terminal order)

- **Claude** (`rpc.ts:276-330`): for a non-interrupted `result` frame, compute
  the completion unconditionally (today only when `answered.length > 0`,
  `rpc.ts:307-314`), call `options.onNativeResult(completion)` once, and settle
  the answered requests with the same object. Interrupted frames settle `stopped`
  and emit nothing. A discarded/refused command is not a native turn
  (`rpc.ts:249-274`) and emits nothing.
- **Codex** (`turn-manager.ts`): emit at every non-interrupted terminal — in
  `finalize` for bound turns (`turn-manager.ts:300-340`) and in
  `drainTerminalOrder`'s release branch for unbound ones (`:285-294`), plus
  `failRecord` for unscoped failures (`:358-369`). Extract the completion
  construction into one `completionFromTerminal` helper reused by `finalize` and
  the unbound branch. Interrupted terminals (`:241-243`) emit nothing; the
  manager's own `stop()` emits nothing.

The unbound category exists in Codex source (`unboundObservedTurnIds`,
`turn-manager.ts:62`), so this is symmetric rather than Claude-only; only the
real-world frequency of Codex unbound turns is unproven.

### R2.6.3 Core consumer and the one fact mapping

Extract the outcome/completion → `PreparedCompletionFact` mapping currently
inline in `EntityTurn` (`turn.ts:141-147`) into one function used by **both**
`EntityTurn` and `AgentService.observeNativeResult`, so a bound completion is
worded identically no matter which path reaches the router first. The mapping
keeps today's payload exactly: `result` is `resultText` for `completed` and
`null` for `failed`/`stopped` (no error text is added — see R2.12).

`AgentService.observeNativeResult(completion)` applies, in order:

1. `options.nativeResultOwner === undefined` → return (the leader, the
   dispatcher agent, a Workflow-locked member, and any entity outside a
   TeammateCollection — unchanged behavior).
2. `!this.owesCompletion()` → return (the existing owner-stop/teardown rule,
   `service.ts:392-394`, read at the same delivery boundary `EntityTurn` reads).
3. `deliverRuntime(owner.completionRecipient(), completion, fact)` — the same
   recipient query `EntityTurn`'s submissions carry, so one completion has one
   recipient and the router's single-recipient-per-token invariant holds.

`RuntimeGeneration` builds `results: generationResultSink(lease)` beside
`activity` with the identical revoked-generation drop (`runtime-generation.ts:304-322`),
forwarding to the owning `AgentService`. The arming flag rides the entity's
construction: `teammateOptions` sets `nativeResultOwner = this.opts.completionOwner`
for **ordinary** builds and omits it for `createLocked`. Because
`createLocked` passes `{}` like `spawn` does, the discriminator is an explicit
construction kind threaded from `createLocked` (locked) versus
`spawn`/`reopen`/`materialize` (ordinary) — never inferred from options shape
(`agent/index.ts:647-752`, `:796-808`).

## R2.7 Ordering and delivery convergence (the new acceptance criterion)

The requirement states the precise hazard: Claude's `rpc.ts` `onLine` handles
multiple result lines **synchronously**, while a bound turn's Core reporting
runs through Promise continuations (`EntityTurn.settled → settle() →
Promise.resolve().then(deliverRuntime)`), so reporting order is not the terminal
order by construction.

**Why the design orders correctly.** With the sink emitted synchronously per
result frame and `AgentService.observeNativeResult` delivering from it, every
native completion enters `CompletionDeliveryPolicy` from the same synchronous
point, in terminal order:

- For a bound result, the sink's `deliverRuntime` runs synchronously inside the
  frame, before any microtask. `EntityTurn`'s later settlement delivery carries
  the *same* `RuntimeCompletion` object, so the router's `completions` WeakMap
  fold (`completion-router/index.ts:140-145`) turns it into a no-op. The sink's
  enqueue is therefore the only delivery and it happened in terminal order.
- For an unbound result there is no settlement; only the sink delivers.
- Both kinds enqueue on the same per-recipient tail
  (`completion-router/index.ts:148-158`), so recipient FIFO equals terminal
  order.

Codex preserves the same property: `drainTerminalOrder` processes
`terminalOrder` in arrival order and `finalize`/release emit synchronously
within that loop.

**Convergence and its edges** (all unchanged from today's policy, now also
spanning the sink): the dispatcher fence is read before queueing
(`completion-router/index.ts:126-136`); a revoked generation's late sink write
is dropped by the lease check; `owesCompletion()` is read when delivery would
start; a delivery already queued is never retracted; owner-stop suppression and
the "one report per token" fold stand. A bound failure carries one failed
completion object, so settlement and observation fold to one failure report
(Q1a).

**Verification (must be a real test, not a citation):** drive the Claude parser
with a chunk containing a bound result then an unbound result for the same
recipient and assert the owner receives the bound report first; separately,
assert a bound result delivered by both the sink and `EntityTurn` yields exactly
one delivery; assert a codex bound-then-unbound terminal pair preserves order.

## R2.8 Reused / removed / new

- **Reused:** `createTeamMateMcpDelegate` + the `teammate` server + MCP
  lease/mint; `TeammateOps.send`/`list` (peer resolution, Q2 reopen, release
  recipient); `TeamService.submitInput` and `DispatcherService.submitToAgent`
  (owner inboxes); `CompletionDeliveryPolicy` fold + per-recipient FIFO;
  `EntityTurn`; `owesCompletion`; the ordinary-mutation/Workflow lock; the
  generation lease pattern; `renderSubmission` + `attrs`; `AGENT_TASK_SOURCE`.
- **Removed:** the `service-types.ts:105-107` invariant "an ordinary TeamMate
  has no Agent-facing tool surface of its own" — replaced by "an ordinary member
  has exactly one narrow surface: owner/peer messaging." Named because every
  ordinary member now launches one more stdio MCP lease. No user-visible
  capability is deleted.
- **New (each paid for by a stated requirement):** `AgentRuntimeResultSink` +
  required `results`; `generationResultSink` + `observeNativeResult`;
  the `member` MCP scope arm with `send`/`list`; the nullable
  `MemberMessagingOwner` bundle on `TeammateCollectionOptions`; `mcp` primitives
  passed to the collection; `SendTeamMateInput.attrs`; the `nativeResultOwner`
  construction option; the owner-descriptor prompt input; the shared
  completion→fact mapping; the receipt/prompt/status-line wording.

## R2.9 Public / MCP / runtime contracts and compatibility

- `AgentRuntimeResultSink`/`results` is additive; a provider compiled against
  older types ignores the extra context property at runtime, and a provider that
  never emits keeps bound-only reporting. Plain `minor` note.
- The member `send`/`list` tools are additive on the existing `teammate`
  server; leader/dispatcher catalogs are unchanged.
- One product-visible change is proposed and flagged (R2.12): the `attrs.from`
  attribute on owner→member `send` envelopes, plus the corrected status-line and
  prompt wording.
- No persisted config/state/cache/run/log shape changes → no `BREAKING:`/
  `Rebuild:`, no `dreamux-maintenance` schema change. Change files:
  `@excitedjs/dreamux-types`, `@excitedjs/dreamux`, and both runtime packages,
  ordinary `minor` notes on the 0.x line.
- Knowledge delta: product catalog rows for member messaging and the revised
  background-work/completion entry in both scopes; `provider-runtime.md` for the
  result sink per provider; the architecture notes and `service-types.ts`
  comment asserting "no Agent-facing tool surface"; role/skill text and tool
  descriptions. `.agents/scripts/check.mjs` in the implementing PR.

## R2.10 Lifecycle, concurrency, identity

| Situation | Behavior |
| --- | --- |
| Idle recipient, explicit send | Existing `wake: true` path starts it |
| Busy recipient | Runtime-native admission (Codex steers, Claude queues); documented in the tool description, no Core branch |
| Self-send / unknown name / wrong-collection name | Refused; "does not exist" via the existing scope check |
| Closed peer (Q2) | Existing `sendReopened`/`reopenFrom`; concurrent sends join one reopen |
| Workflow-locked member (Q3) | Not armed: no member server, no unbound report; ordinary input refused by the held lock |
| Team/Dispatcher teardown | Existing fences refuse the send or the reopen; delivery crosses `prepareCompletion`/dispatcher fence and drops as today |
| Result racing a stop | Sink is generation-leased; `owesCompletion` read at delivery start; a queued delivery is never retracted |
| Owner receipt of a member message | No `completionRecipient` on that submission → no reply loop to the member |

No new persisted state; every mechanism reuses an existing owner or is one
named addition.

## R2.11 Acceptance / verification mapping

| Acceptance criterion (revision 2) | Mechanism | Verification |
| --- | --- | --- |
| Member in either category reports to its actual owner, sender visible | `send` → `submitToOwner`; `attrs.from` | Delegate test per scope: owner-name routing, `from`, no completion recipient |
| Same-collection peers send/reply across turns, no owner relay | `send` → `peers.send`; release recipient unchanged | Test: peer submission recipient is the owner, not the sender; reply reaches the original sender; wrong-collection name not found |
| Idle starts processing; busy follows runtime | existing `wake: true` | Both runtimes; differences documented |
| Every distinct completion reaches the owner; folds do not duplicate; peer gets only explicit replies | sink + `EntityTurn` fold | Bound-once, unbound-once, mixed-order (R2.7) tests |
| Unbound normal/failed native turns report once in both scopes | `observeNativeResult` + shared mapping + `owesCompletion` | Unbound completed/failed → one report; after owner stop → none |
| Owner receipt creates no reply loop | no `completionRecipient` on owner submits | Test: owner turn delivers nothing to the member |
| Host-owned sender/scope | bound `self`; collection-scoped peers | No sender schema param; cross-collection name unresolved |
| Peer send reopens a closed member; fences hold | existing reopen + owner fences | Reopen test in both scopes; teardown refusal |
| Workflow members: no tools, locked input refused, no duplicate report | explicit locked construction flag + existing lock | Locked entity advertises no member server and reports nothing |
| One reusable capability, minimal owner branching; each branch justified | R2.4/R2.5 | Review: the only owner-specific code is the two-line bundle and one prompt noun |
| Mixed bound/unbound ordering and convergence explained and verified | R2.7 | Parser-level ordering test + fold test in both adapters |
| Both owning scopes validated through both in-tree runtimes | both adapters emit | Four gates including `rush typecheck:tests`; live Codex gated |

## R2.12 Named risks and unresolved decisions

1. **Operator confirmation required — `from` on owner→member sends.** Making a
   member able to distinguish an owner reply from a peer requires stamping
   `attrs.from` on the existing leader/dispatcher `send` (R2.4.3). This adds an
   attribute to shipped member-facing envelopes. Recommendation: adopt the
   uniform rule. If the operator declines, members cannot reliably identify the
   owner's reply and the feature is materially weaker — this should not be
   decided silently by the implementation.
2. **Operator confirmation — failure report body.** I keep today's
   `result: null` / "task failed" wording for failed turns (bound and unbound)
   so the shared mapping is byte-identical to today; adding the error text is a
   product change, not required by Q1a.
3. **Emission-every-result makes the fold the normal path.** Once-only delivery
   for bound turns now rests on the provider passing the same `RuntimeCompletion`
   object to the sink and to settlement. This must have a reference-identity
   assertion in each adapter; a structural clone would double-deliver.
4. **Codex unbound frequency is unproven.** The category exists
   (`turn-manager.ts:285-294`); how often real Codex traffic produces one is
   unknown, so Q1/Q1a live coverage may be mostly Claude-observed.
5. **`ownerName()` timing.** For a Team, the owner name is read from the record;
   `teammateOptions` only builds delegates after the Team exists, so this is
   safe, but the bundle must be read lazily (a function), never captured at
   collection construction (which precedes the record for a fresh Team).
6. **Status-line and receipt copy are operator-visible.** The wording moves in
   R2.4.2/R2.6.3/R2.4.4 should be read at review as product copy.

## R2.13 Alternatives I explicitly reject

- **Unbound-only sink emission** (my revision 1): leaves the mixed-order race
  the acceptance criteria now forbid.
- **Merging the three MCP scopes** into one N-valued scope: grows a
  discriminant, removes no concept (whitepaper §3).
- **A new provenance source name** (`teammate-message`): one bit already carried
  by `from`.
- **Inferring the locked/ordinary arm from `CreateLockedTeammateOptions` shape**:
  both paths pass `{}`; the discriminator must be explicit.
- **A second Team/Dispatcher messaging service or wrapper**: Q4 asks for one
  reusable capability; a wrapper would remove nothing.

## R2.14 Strongest trade-off and blocker

**Strongest trade-off.** The messaging half is cheap and fully shared across
both owners (one scope arm, one bundle, one server). The expensive half remains
Q1/Q1a: a new required provider sink, now carrying *every* native result so the
delivery order is the terminal order the requirement demands. That choice buys
correct ordering and a constantly-exercised fold at the cost of a cross-package
identity invariant (one shared `RuntimeCompletion` object per result).

**Genuine blocker (one, product):** whether owner→member replies carry a
`from` sender attribute (R2.12.1). It decides whether a member can tell its
owner from a peer, and it changes a shipped envelope, so it is the operator's
call, not a technical adjudication. The failure-body wording (R2.12.2) is a
smaller, independent confirmation.

---

# Requirement revision 2 — cross-review and revised position (DeepSeek)

- Inputs: the revision-2 sections of [deepseek.md](#requirement-revision-2--independent-revised-proposal-deepseek)
  (mine), [mimo.md](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/mimo.md) §2.1–2.15,
  and [trae-seed.md](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/trae-seed.md) V2.1–V2.12.
  Authority: requirement revision 2 and current source. No historical TeamLeader
  adjudication is treated as authority; every claim below is re-derived.
- This section supersedes my earlier R2 section where it differs. All prior
  sections are preserved history.
- Labels used throughout: **[fact]** source-verified here; **[decision]**
  operator-recorded; **[inference]** design judgment.

## CX.1 Where the three revision-2 proposals already converge

One mechanism, and it is the same one in all three files:

1. **Messaging.** The existing `teammate` server in `service/agent/mcp.ts`
   gains a third scope arm with exactly `send`/`list`; the caller name is
   host-bound at build; there is no sender parameter and no `intent`; a name
   equal to the owner routes to the owner's fenced inbox with no completion
   recipient; any other name routes to the same collection's existing send
   (resolve → reopen-if-closed under Q2 → `sendResolved`); `list` returns the
   owner name plus the collection's own rows, self-excluded. All three reject
   merging the three scopes and reject a second server or a Team/Dispatcher
   service merger.
2. **Native-result reporting.** A required neutral `results` sink on
   `AgentRuntimeCreateContext`, emitted **synchronously once per
   non-interrupted native terminal (bound or unbound)**, carrying the identical
   frozen `RuntimeCompletion` that settlements resolve with; the shared
   completion→fact mapping is extracted from `EntityTurn` (`turn.ts:141-147`) so
   the folded second delivery is payload-identical; the sink is generation-leased
   exactly like `generationActivitySink`. This is the change all three made
   against their own revision-1 positions, driven by the mixed-order criterion.
3. **Arming** is a construction-time decision (ordinary vs `createLocked`),
   and the member arm is not mounted on locked builds.
4. **Owner inbox reuse:** `TeamService.submitInput` and
   `DispatcherService.submitToAgent` — both already fenced and structurally
   recipient-free (`dispatcher-service/index.ts:352-359`). **[fact]**
5. **Failed report body stays `result: null`**; wording states the observed
   fact. All three reversed their revision-1 status-line overclaim.
6. No aggregation, no mailbox, no persisted state, no new wake semantics;
   notification volume is the accepted Q1 cost; the owner-unavailable
   asymmetry (automatic reports are live push-back, explicit messages wake) is
   documented, not "fixed".

I accept all six as the converged core and adopt them.

## CX.2 Accepted arguments (with owning-source evidence)

- **A1 — Required owner port, not a nullable bundle (MiMo §2.4, §2.11).**
  With Q4 both owners supply the owner surface, so a nullable option keeps a
  second, dead state. I accept: the port is required on
  `TeammateCollectionOptions`; the only disarm is the construction kind. This
  removes my R2 `memberMessaging: … | null` and `mcp: … | null`.
- **A2 — The port needs an owner *status* accessor (MiMo `ownerRow`, Trae
  `ownerStatus`).** My R2.4.1 defined `list` → `{ owner: { name, status }, … }`
  but the port carried only `ownerName`/`submitToOwner`, so the status had no
  producer. **[fact: my own gap]** `list` cannot read the owner from the
  collection — the owner is not a collection member (requirement: "The owner
  actor is not added as an ordinary member of its own child collection"). I
  accept adding an owner status reader to the port; this closes my gap.
- **A3 — Owner-neutral port with a label *value*, and no `ownerKind`
  discriminant.** MiMo passes `ownerLabel: string`; the delegate compares
  `name === owner.ownerName` only. **[inference]** A discriminant
  (`'team_leader' | 'dispatcher'`) is a value that invites `if (kind === …)`
  branching and buys nothing the label does not — the whitepaper's "an N-valued
  discriminant is not a boundary reduction." Accept MiMo's data-shaped label;
  the *name* is load-bearing, the label is copy.
- **A4 — The residual ordering case is real and must be named (MiMo §2.8).**
  I accept MiMo's characterization and reject Trae's justification (CX.3 R3):
  a non-native outcome (`stopped`, transport `failed`) settles with
  `selectedCompletion === null` (`turn.ts:84-88`) and its delivery is deferred
  to a microtask (`turn.ts:148-150`), so within one synchronous parse batch it
  can report *after* a later unbound frame's synchronous sink report. It is
  pre-existing behavior outside Q1/Q1a's result contract (which cover
  normal/failed native results), and closing it would need microtask discipline
  or a sequence field — both rejected with named scenarios. Document, do not
  design.
- **A5 — Same-object discipline is the keystone (MiMo §2.7, Trae V2.5).**
  Once every bound result also emits, once-only delivery rests on provider
  identity discipline; a reference-identity assertion in each adapter is
  required, and external/custom session factories are the realistic violator.
  Accept.
- **A6 — `mcp.ts` 700-code-line gate is real [fact].**
  `packages/eslint-config/index.js:320-322` sets `max-lines: { max: 700,
  skipBlankLines: true, skipComments: true }` on `src/**/*.ts`. `mcp.ts` is 627
  physical / **539 code lines** now, so headroom is ~161 code lines. **[fact]**
  A two-tool arm likely fits; I do **not** mandate Trae's preemptive
  `member-messaging.ts` extraction (a new module with no triggered need), but if
  the added arm trips the gate, a named sibling module for the member scope is
  the sanctioned response (whitepaper §7). Verification-bound; both outcomes
  keep the server home in `mcp.ts`.

## CX.3 Rejected arguments (with owning-source evidence)

- **R1 — Trae V2.4 item 4: "the locked caller leaves messaging unset, so no new
  disarm flag is needed." Rejected. [fact]** No existing path distinguishes an
  ordinary build from a locked one at `teammateOptions` time. `spawnAdmitted`
  calls `this.createFreshEntity(input)` (`agent/index.ts:192`); `createLocked`
  calls `this.createFreshEntity(input, options, cb)` with `options` defaulting
  to `{}` (`agent/index.ts:212,227`); a reopen/materialize calls
  `this.teammateOptions(unbuilt.identity, {})` (`agent/index.ts:803`). Every path
  reaches `teammateOptions(identity, options)` (`agent/index.ts:823`) — whose
  only varying input is `CreateLockedTeammateOptions = {systemPromptAppend?,
  outputSchema?}` — with `{}`. A per-build "messaging unset" cannot exist unless
  messaging were itself a per-build option, and then `spawn` would be unarmed
  too, breaking the feature. A discriminator must be threaded explicitly
  (ordinary vs `createLocked`). MiMo's "one construction flag" is correct.
- **R2 — Trae's port `ownerKind: 'team_leader' | 'dispatcher'`. Rejected.**
  See A3: a copy discriminant is neither needed nor lower-entropy than a label
  value; it actively invites the branching Q4 asks to avoid.
- **R3 — Trae V2.6 item 3: non-native outcomes "cannot precede a later native
  result in the same live session." Rejected as a justification. [fact]** The
  claim rests on "a transport death ends the session." A multi-line `result`
  batch is exactly the residual's case: an interrupted frame settles `stopped`
  (`turn.ts:87`) with no completion object, its delivery deferred
  (`turn.ts:148-150`), while a later frame's unbound completion reports
  synchronously — so the earlier frame reports second, in a live session. The
  *conclusion* (out of Q1/Q1a scope, documented) is right; the reasoning is not,
  and MiMo's named residual (A4) is the correct treatment.
- **R4 — Trae's new source constant `MEMBER_MESSAGE_SOURCE = 'member-message'`.
  Rejected in favor of reuse. [fact + inference]** `submission-sources.ts`
  documents provenance as an open, unvalidated, un-branched vocabulary
  ("nothing validates or branches against it"; the renderer never imports it),
  and `AGENT_TASK_SOURCE` already means "work an Agent handed to another Agent."
  A new name encodes one bit the envelope's host-stamped `from` already
  carries, and no consumer distinguishes it (the Channel CoT projection
  consumes the input generically). **[fact]** Adding an unread name is
  speculative; reuse `AGENT_TASK_SOURCE` + `attrs.from`. This is a cheap,
  reversible, non-material reconciliation item, not a blocker — flagged in
  CX.6.
- **R5 — My own R2.12.1 / R2.14 blocker: "owner→member replies must carry
  `from`, else a member cannot tell its owner from a peer." Withdrawn.**
  Re-reading the acceptance criteria, the requirement asks the **owner** to see
  the member's sender identity (line 361, member→owner) and asks **peers** to see
  each other (both tagged, since both use the member delegate); it states no
  symmetric "the member must identify the owner's reply." **[decision scope]** A
  member's owner reply arrives untagged, and that is unambiguous: only the
  leader/dispatcher `send` delegate lacks `from`, so an untagged envelope is the
  owner. No shipped envelope changes for the owner direction. The page's
  `send`/`list` copy names the owner by name, which is all the addressing the
  criteria require. I therefore retract this as a requirement-derived blocker;
  it was a design inference, not requirement evidence.
- **R6 — My own R2 nullable bundle and my R2 "explicit kind" phrasing.** R2's
  *mechanism* (thread a construction discriminator rather than infer it from
  options shape) is correct and is now A1's accepted model; what changes is that
  the port is **required**, and the discriminator is the *single* arming input
  for both the MCP mount and `nativeResultOwner` (MiMo §2.1). I adopt that.

## CX.4 My revised position (deltas from R2)

The end-to-end design of my R2 section stands, with these corrections folded in:

1. **Owner port is required** on `TeammateCollectionOptions` (both owners
   supply), and carries exactly: `ownerName` (the concrete address),
   `ownerStatus()` (for `list`), `submitToOwner(input)` (the fenced, recipient-
   free inbox), and an optional `ownerLabel` *value* for copy. Team supplies
   `{ ownerName: () => mustRecord().leader_name, ownerStatus: () => admitTeam(()
   => mustLeader().status()), submitToOwner: (i) => this.submitInput(i),
   ownerLabel: 'TeamLeader' }`; Dispatcher supplies the analogous bundle over
   `submitToAgent` and `dispatcherAgent`. Two lines each; no `ownerKind` branch.
2. **One construction discriminator** — an explicit ordinary-vs-locked kind
   threaded from `createLocked` versus `spawn`/`openEntity`/`materializeEntity`
   into `teammateOptions` — gates **both** the member MCP mount and
   `nativeResultOwner`. Never inferred from options shape (R1 evidence). The
   reopen path is ordinary and therefore armed (Q3: a reopened former-Workflow
   member is an ordinary member).
3. **No `from` on owner→member sends**; member→owner and member→member sends
   carry host-bound `attrs.from`; provenance reuses `AGENT_TASK_SOURCE`.
4. **`observeNativeResult` must call `deliverRuntime` synchronously** (no
   `await`, no `Promise.resolve().then`) so the sink is the ordering authority;
   it keeps my R2.6.3 gate order (`nativeResultOwner` absent → return;
   `!owesCompletion()` → return; otherwise deliver). `deliverRuntime`'s
   synchronous tail insertion (`completion-router/index.ts:140-158`) preserves
   terminal order; the fold (`:140-145`) makes the bound `EntityTurn` delivery
   a no-op.
5. **Residual named, not closed** (A4): non-native outcomes still report via
   `EntityTurn` continuations and may interleave; out of Q1/Q1a scope.
6. **Ordering verification** = my R2.7 tests plus MiMo's third-bound case and a
   reference-identity assertion; plus Trae's revoked-generation drop assertion.

Everything else in R2 (MCP arm shape, `self` binding, receipt copy distinct
from `TEAMMATE_DISPATCH_SUCCESS_REMINDER`, owner-neutral prompt, the
reused/removed/new accounting, compatibility, the acceptance mapping) is
unchanged; the prompt input keys on the arming descriptor, not `team_id`.

## CX.5 Material disagreements remaining after this round

| # | Dispute | Who holds it | Status |
| --- | --- | --- | --- |
| 1 | Provenance: new `member-message` constant vs reuse `task`+`from` | Trae vs MiMo+me | Unresolved, non-material (no consumer branches); I recommend reuse; CX.6 |
| 2 | Member scope in `mcp.ts` vs a preemptive sibling module | Trae (preemptive) vs MiMo+me (conditional) | Resolved as verification-bound (A6); extract only if the 700-code-line gate trips |
| 3 | Non-native ordering residual: document vs closed | MiMo+me (document) vs Trae (claimed impossible) | Resolved in favor of "document" (R3); out of scope |
| 4 | Port shape details: `ownerRow` returning a full row vs `ownerStatus` returning a status | MiMo vs Trae | Immaterial; a status reader suffices |

None of these is an ownership or contract fork; all four are placeable by the
reconciler without a new requirement.

## CX.6 Unresolved items for the reconciler / operator

- **Reconciliation (technical, cheap):** provenance name for member sends
  (reuse `task`+`from` recommended) — no behavior differs.
- **Operator-visible copy [decision]:** the exact status-line wording, the
  member prompt sentence, and the member receipt text. These are product text,
  not design.
- **Live-verification facts, not design forks [fact]:** real Codex unbound-turn
  frequency and the real protocol event reaching Codex's unscoped-failure path;
  whether the added member arm trips the 700-code-line gate.
- **Cross-package discipline [fact]:** external/custom Claude session factories
  must emit the same frozen object and never emit on interruption; the package
  README states this and non-compliance degrades only unbound coverage, never
  duplicates.

## CX.7 Blocker

**None.** With R5 withdrawn, no requirement-derived product decision blocks the
mechanism. The only operator inputs left are wording/copy (CX.6) and the
non-material provenance-name reconciliation — neither changes behavior or
ownership, and both are the reconciler's to close. The riskiest element is the
cross-package same-object/terminal-order sink discipline, which the ordering
suite makes falsifiable rather than assumed.

## CX.8 Classification ledger

- **Code facts verified this round:** `spawn`/`createLocked`/`openEntity`
  all reach `teammateOptions` with `{}`, so no options-shape discriminator
  exists (R1); `EntityTurn` settles `stopped` with a null completion and defers
  delivery a microtask (R3, A4); `deliverRuntime` folds on the completion
  object and inserts FIFO synchronously (A5, revised position item 4);
  `submission-sources.ts` is open/unbranched (R4); the 700-code-line gate and
  `mcp.ts` headroom (A6); `submitToAgent` omits `completionRecipient`
  structurally.
- **Operator decisions in force [decision]:** Q1 normal, Q1a failed, Q2 reopen,
  Q3 ordinary-only + Workflow exclusion, Q4 both categories with one abstract
  reusable mechanism; acceptance criteria including the mixed bound/unbound
  ordering clause; "The owner actor is not added as an ordinary member of its
  own child collection."
- **Design inferences (mine, labeled) [inference]:** reuse `task`+`from`;
  label-as-value over an `ownerKind` discriminant; document rather than close
  the non-native ordering residual; the untagged owner reply is unambiguous.
  None is presented as an operator ruling.

---

# Neutral runtime interface reassessment — independent proposal (DeepSeek)

- Input: [interface-reassessment.md](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/interface-reassessment.md);
  product authority [requirement revision 2](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md).
- Evidence basis, read separately and neither reverted nor edited: **baseline**
  = `git show HEAD:packages/dreamux-types/src/agent-runtime.ts` (the pre-feature
  `next` tree, #473/#469/#467); **candidate** = the current worktree, whose new
  required `AgentRuntimeCreateContext.results`, `RuntimeGeneration` lease,
  `AgentService.observeRuntimeResult`, shared `turnCompletionFact`, and both
  adapters' emission are the object under challenge — evidence, not a verdict.
- Written independently; no other seat's reassessment has been read.
- Labels: **[fact]** verified in this tree; **[inference]** design judgment;
  **[decision]** operator-recorded. The operator's verbatim caution ("任何中立
  interface 的变更都要慎重") is honored as a demand for justification, not
  stretched into a ruling; requirement revision 2 still supplies the behavior.

## RZ.1 Separate the unavoidable capability from the chosen shape

The reassessment asks for this split first, so everything else hangs on it.

**Unavoidable capability [fact + inference].** Requirement revision 2, Q1/Q1a,
and the acceptance criteria demand that a provider-observed native terminal
with **no Dreamux submission** reach the member's owner — a normal or failed
turn that Core never submitted. Today ([baseline]) Core learns of a turn only
through `RuntimeSubmission.settled` (`agent-runtime.ts:171-190` in HEAD); an
unbound native turn has no `RuntimeSubmission`, so **no existing contract
carries it**. The only other channel, `AgentRuntimeActivitySink`, is
documented as presentation ([baseline] `agent-runtime.ts:190-205`, "its absence
changes only presentation"; `activity.ts` module header). So *some* provider→
Core fact channel for unsolicited, completion-identified native results is
required by the accepted product behavior. This is the deliberate change the
operator asked about; it is not optional.

**Two sub-requirements the capability must satisfy, both [fact]:**

1. **Settlement-shared identity.** The requirement states a result "can share
   its identity with submission settlement to avoid duplicate delivery," and
   `CompletionDeliveryPolicy` folds on the `RuntimeCompletion` object via a
   `WeakMap` (`completion-router/index.ts:140-145`). A channel that cannot hand
   Core the *same* object a settlement resolves with cannot fold — it would
   double-report every bound turn.
2. **Terminal-ordered, synchronous, non-throwing publication.** The revision-2
   ordering criterion requires report order = native terminal order; the
   provider's parser handles multiple `result` frames synchronously while bound
   Core reporting runs on Promise continuations.

**Chosen shape [inference].** A required function-typed field
`results: AgentRuntimeResultSink` on `AgentRuntimeCreateContext`, beside the
existing required `state`/`activity`. The rest of this section tests whether a
smaller or different shape satisfies all of RZ.1.

## RZ.2 The candidate, as fact

- Neutral: `AgentRuntimeResultSink = (completion: RuntimeCompletion) => void`,
  a **required** member of `AgentRuntimeCreateContext` (delivered
  `agent-runtime.ts`, +13 lines; the field is new, `state`/`activity` are
  pre-existing and unchanged).
- Core: `RuntimeGeneration.generationResultSink(lease)` gates on
  `lease.isCurrent()` then calls its injected owner synchronously
  (`runtime-generation.ts`); `AgentService.observeRuntimeResult(completion)`
  returns unless `nativeResultRecipient` is set **and** `owesCompletion()`, then
  calls `deliverRuntime(recipient, completion, turnCompletionFact(...))`
  **synchronously**, tracking the delivery in a new `nativeReports`
  `InFlightWork` drained by both close and host-stop convergence.
- Shared fact: `turnCompletionFact` (`turn.ts`) is used by both
  `observeRuntimeResult` and `EntityTurn`, so a bound report is byte-identical
  whichever path arrives first.
- Claude (`rpc.ts`): builds the completion on every non-interrupted `result`
  frame (previously only when `answered.length > 0`), calls
  `this.options.results(completion)` **before** the settlement loop, settles
  answered requests with that same object.
- Codex (`turn-manager.ts`): one `completionFromTerminal` helper; `finalize`
  emits unless the terminal is an accepted interrupt; the old
  `unboundObservedTurnIds` / `releaseOrphanTurnsIfIdle` machinery is **deleted**
  (unbound turns now ride `finalize`).

## RZ.3 Alternatives against the required report

Each option is scored on the reassessment's contract: provider burden; whether a
neutral contract changes; owner of answers vs unsolicited facts vs model-directed
reporting; identity/order/interruption/owner-stop/generation/convergence;
compatibility; removals/coexistence; counterexample; verification.

### O1 — Required `results` sink on the create context (candidate)

- **Provider author must:** at each non-interrupted native terminal, construct
  the one frozen `RuntimeCompletion` (the same value settlements use), call
  `context.results(completion)` synchronously in terminal order, and never emit
  for interruptions or transport loss. Two call sites per adapter; the object is
  already built for settlements, so the added work is *calling*, not *computing*.
- **Neutral change:** one additive required field + one type alias. Justified
  because no existing contract carries an unbound result (RZ.1).
- **Ownership/consumers.** Submission answers are owned by
  `RuntimeSubmission.settled` (provider) → `EntityTurn` (Core) →
  `CompletionDeliveryPolicy` → the submitter's `completionRecipient` (Team /
  dispatcher agent / Workflow). Unsolicited native results are owned by the
  provider's terminal observation → `results` → `AgentService.observeRuntimeResult`
  → the same policy → `nativeResultRecipient` (the collection's
  `completionOwner`; only armed ordinary members). Model-directed reporting
  (member `send`) is a *separate* capability: it becomes an ordinary submission
  (input), consumed by the addressed agent — it never touches this seam. The
  three are cleanly separate owners.
- **Identity/order/boundaries.** Once-only = completion object identity through
  the router's `WeakMap`; order = synchronous sink emission in terminal order,
  with the bound `EntityTurn` delivery folding to a no-op; interruption = no
  emission (both adapters) matching "interruptions do not manufacture results";
  owner-stop = `owesCompletion()` at publication; generation replacement =
  `lease.isCurrent()` drop; shutdown = `nativeReports` drained by close and
  host-stop.
- **Compatibility — three separate claims [fact], as the input demands:**
  - *Binary:* an older provider simply ignores the extra context property; it
    still loads. True, and meaningless for coverage.
  - *TypeScript source:* the field is on a context **Core constructs**, not one
    a provider implements. A provider *consumes* `AgentRuntimeCreateContext`;
    making a consumed field required is **not** a source break for provider
    authors — they gain an unconditional `context.results(...)` call with no
    guard. The only source impact is on in-tree test fakes that construct a
    context, caught by `rush typecheck:tests`. **[fact]** (This corrects the
    common framing that "required breaks external providers"; it does not.)
  - *Behavioral:* an in-tree provider now also emits bound results, which the
    fold collapses to one delivery — net behavior unchanged. An external
    provider that never calls `results` keeps today's bound-only behavior;
    non-armed roles (leader, dispatcher agent, locked Workflow members) are
    unchanged because `nativeResultRecipient` is unset.
- **Removals/coexistence:** the seam gains one field and removes nothing;
  submission-settlement reporting coexists (tokenless stopped/failed outcomes
  still flow through `EntityTurn`). In Core the codex orphan-turn tracking is
  removed and the `EntityTurn` fact mapper is de-duplicated — real entropy
  reductions that this shape enables.
- **Strongest counterexample:** a provider (or a custom `ClaudeCodeSession`
  factory) that never calls `results`, or that emits a structural *clone*
  instead of the same object. The first silently loses unbound coverage — the
  required field cannot enforce behavior (the same limit `state` already has);
  the second breaks both folding and ordering and would double-report.
- **Verification:** reference-identity assertion in each adapter (emit value ===
  settlement value); a batch containing bound-then-unbound and
  unbound-then-bound frames asserting terminal order and exactly-once; revoked
  generation drops; interrupted emits nothing; owner-stop suppresses; close and
  host-stop converge an in-flight native report.
- **Product decision:** none. Required-vs-optional follows from "Core is the only
  constructor," so required matches `state`/`activity` and is free for providers.

### O2 — Optional `results?: AgentRuntimeResultSink`

- Identical mechanics, weaker contract. **Provider burden:** every provider must
  guard `context.results?.(...)`, and the optionality signals "this guarantee is
  negotiable," which it is not (Core always supplies the sink).
- **Compatibility:** no additional benefit — the required field already costs
  provider authors nothing (O1 type-source analysis). It only *removes* the
  compile-time signal that in-tree providers must wire the sink.
- **Verdict: rejected [inference]** — strictly dominated by O1: same runtime
  tolerance, less enforcement, a guard on every call site. The reassessment's
  own warning applies: an ignoring provider gains no coverage either way, so
  optionality buys no honesty.

### O3 — Reuse/extend the existing `activity` seam (no new field)

- **Idea:** Core derives completions from `RuntimeActivity` — which already
  carries `turn.ended { status: 'completed' | 'failed' | 'interrupted' }`
  reported from the native terminal ([baseline] `activity.ts:126-149`) — plus
  `assistant.message` text, and reports them itself.
- **Provider burden:** none new (activity is already emitted).
- **Decisive counterexamples (all three must be answered; none can be) [fact]:**
  1. **No shared identity.** Activity carries no `RuntimeCompletion`; there is
     nothing to fold against `RuntimeSubmission.settled`. Every bound turn would
     report twice (once from settlement, once from synthesized activity) — the
     exact duplication Q1 forbids.
  2. **Wrong `resultText`.** The completion text is produced by
     `completionFromTurnOutcome` / `extractAssistantText` under session-pin and
     structured-output mapping; `turn.ended` carries **no** text, and
     `assistant.message` is raw, agent-keyed, and folds many submissions into
     one native turn — it cannot be attributed to the terminal.
  3. **Contract inversion.** Activity is explicitly *presentation*, optional
     ("its absence changes only presentation"), and includes best-effort
     duplicates (teardown `turn.ended`, `turn.interrupted`). Elevating it to a
     load-bearing exactly-once delivery contract changes what the field *means*
     and makes a display seam mandatory — precisely the "neutral interface change
     needs extraordinary care" the operator raised, in the worst direction.
- **Verdict: rejected [inference].** This is the strongest "smaller change"
  candidate and it fails on identity and fidelity, not on taste.

### O4 — Extend `AgentRuntimeStateSink` with a `result` update kind

- **Idea:** no new field; add `{ kind: 'result'; completion }` to
  `AgentRuntimeStateUpdate`.
- **Counterexample [fact]:** the state sink's contract is durable,
  authoritative, and *rejecting* — `publish` "resolves only after the
  authoritative state write is durable" and rejects with
  `AgentRuntimeStateLeaseRevokedError` on revoke ([baseline]
  `agent-runtime.ts:145-169`). A result is a non-durable, non-throwing,
  non-backpressuring event. Overloading forces result reporting through a
  durable-write path (latency, and an unhandled-rejection hazard the result sink
  must not have) and changes the meaning of an existing neutral type.
- **Verdict: rejected [inference]** — conflates durability with delivery and
  edits an existing contract rather than adding a justified one.

### O5 — Model unbound native turns as extra settlements

- **Idea:** provider mints a submission-like handle for native-only turns so
  Core learns via `settled`.
- **Counterexample [fact]:** unbound turns have no submission, and the seam
  states a provider "has no source identity to deduplicate with" and "Core, not
  a Provider, deduplicates" ([baseline] `agent-runtime.ts:217-245`). Minting
  handles invents provider-side submission identity for turns Core never
  submitted — a new neutral concept with no consumer beyond Core, and a reversal
  of the dedup ownership rule.
- **Verdict: rejected [inference].**

### O6 — A provider capability/pull API for native results

- **Idea:** a capability bit or a `readRecentResult`-style pull.
- **Counterexample:** unbound results are asynchronous events; there is no
  event to poll, and a capability bit only lets a provider announce it ignores a
  channel Core always supplies. No concrete failure scenario is prevented.
- **Verdict: rejected [inference]** (whitepaper: no mechanism without a named
  failure scenario).

## RZ.4 Recommendation

**Keep the candidate's shape (O1): a required, synchronous, non-throwing
`results` sink on the create context, implemented by both in-tree adapters,
folded with settlement identity through the existing router.** Evidence, not
votes:

1. It is the *smallest seam change that satisfies RZ.1* — one function-typed
   property, no existing contract redefined, no new persisted state or entity.
2. Every "no new field" alternative (O3/O4/O5/O6) fails a concrete counterexample
   (identity, fidelity, durability conflation, or invented identity), so the
   added surface *removes the need* for a worse one.
3. It reuses the seam's existing idioms exactly: required leased sink beside
   `state`/`activity`, generation-lease revocation, synchronous non-throwing
   call — so a provider author learns one rule ("publish the terminal's
   completion; a settlement with it folds"), not a new protocol.
4. It is the only shape that lets Core *remove* machinery: the codex
   orphan-turn tracking and the duplicated fact mapping are gone.

This is a local optimum under the stated evidence, not a claim of global
optimality: a provider that never emits silently lacks unbound coverage (O1's
counterexample), and that limit is inherent to any provider-authored guarantee.

## RZ.5 Strongest counterexamples and their honest resolution

| Option | Strongest concrete counterexample | Resolution |
| --- | --- | --- |
| O1 (candidate) | Non-emitting provider / clone-instead-of-same-object | Enforce by reference-identity tests + README discipline; coverage is provider-authored, like `state`. Named, not hidden. |
| O2 | Guarded call sites + no enforcement signal | Rejected: dominated by O1 |
| O3 | Double report (no shared identity) and wrong `resultText` | Rejected: unsatisfiable |
| O4 | Durable/rejecting sink used for a non-durable event | Rejected |
| O5 | Invented provider-side submission identity | Rejected |

## RZ.6 Load-bearing unknowns and genuine decisions

- **No genuine product decision blocks the interface.** The capability is
  required by accepted behavior (RZ.1); the shape is a transport choice with a
  clear minimum. The operator's caution is answered by *why* the change is
  needed and *why it is minimal*, not by a preference.
- **[fact] Unknowns to verify, not design forks:** real-world frequency of codex
  unbound terminals (the category now rides `finalize`; how often real traffic
  produces one is unproven); whether any external provider authors against and
  *constructs* a create context (none found in-tree — if one exists, requiredness
  is a source break for it, and optional would be the fallback); whether the
  delivered codex `failProtocol`/`failRecord` path should also emit a failed
  result (the candidate deliberately does **not**, matching "transport failures
  do not manufacture results" — confirm this is the intended boundary).
- **Verification burden this shape concentrates:** reference-identity + ordering
  tests in both adapters; a revoked-generation drop test; interrupted-emits-
  nothing; owner-stop suppression; close/host-stop convergence of `nativeReports`.
  These are falsifiable, which is the point.
- **One thing this round should NOT decide:** whether the *messaging* surface's
  provenance constant is `task`+`from` or a new name (CX.5) — independent of the
  runtime seam and still non-material.

## RZ.7 Classification ledger

- **Unavoidable capability [decision-derived]:** a neutral provider→Core channel
  for unsolicited native results carrying settlement-shared identity and
  terminal-order semantics (Q1/Q1a + the ordering criterion).
- **Chosen shape [inference]:** a required synchronous non-throwing function
  field on the create context; the alternatives and their rejections are
  enumerated above.
- **Removed by the candidate [fact]:** codex `unboundObservedTurnIds` /
  `releaseOrphanTurnsIfIdle`; the duplicated `EntityTurn` fact mapping.
- **Coexisting [fact]:** submission-settlement reporting for tokenless
  stopped/failed outcomes; the untouched `activity` presentation seam.
- **Operator caution honored [decision, quoted]:** "任何中立 interface 的变更都要慎重"
  — addressed by RZ.1 (necessity) and RZ.3 (minimality), not by an asserted
  ruling.

# Neutral runtime interface reassessment — cross-review and revised position

Scope: this is consultation under the implementation hold recorded in
[interface-reassessment.md](../interface-reassessment.md), not implementation
review. All earlier sections are preserved history. Inputs read this round: the
"Neutral runtime interface reassessment — independent proposal" sections of
[MiMo](mimo.md) §4.1–4.8 and [Trae Seed](trae-seed.md) N.1–N.8, plus the
reassessment input, requirement revision 2, and [final.md](../final.md) as
comparison evidence under hold (recorded prior approval/playback, not current
authority). The delivered worktree implementation and `git show HEAD` baseline
remain the code facts. Deliverable: accepted/rejected arguments, a revised
complete position, and the genuinely unresolved decisions — organized under the
five report questions, whose premises I reject where source contradicts them.

## RZX.1 Q1 — both skew directions, and constructors vs consumers vs implementors

The premise is correct and the three roles have to be separated, because the two
seats name different cells and the house pattern differs per role.

Source-verified roles for `AgentRuntimeCreateContext`:

- **Constructor (source-affected).** The sole in-production construction site is
  `packages/dreamux/src/service/agent/runtime-generation.ts:353-372`, which
  already supplies `state` and `activity` and now `results`. The only other
  constructors are in-tree test fixtures
  (`packages/agent-runtime/*/tests/*`). Because `tsconfig.json` excludes
  `tests/`, `typecheck:tests` — not build/lint/test — is the gate that forces
  those fixtures to add the field. This is exactly Trae N.2's "providers consume,
  never construct" and MiMo 4.4's "in-tree context *constructors* must add the
  field" — accepted.
- **Consumer (source-unaffected).** Providers receive the context; the external
  loader forwards a Core-built context to third-party code as a parameter
  (`packages/dreamux/src/agent-runtime/external-provider.ts:129-134`,
  `candidate.createRuntime(runtimeContext)`, loaded from provider packages via
  `../registry/provider-loader.ts`, issue #209). A *consumer* is unaffected by
  required-vs-optional.
- **Implementor (source-unaffected).** `CodexRuntime implements AgentRuntime`
  (`codex/src/runtime.ts:82`) and `ClaudeCodeRuntime implements AgentRuntime`
  (`claude-code/src/runtime.ts:41`), plus test doubles. A context *field* does
  not touch `AgentRuntime`; a pull *method* would break every implementor. This
  is the structural difference between the chosen shape and MiMo S4 / Trae
  Option D, and MiMo 4.4's compatibility table captures it — accepted.

Directional behavior, with the honest split the reassessment input demands
("binary tolerance, TS source compatibility, and fulfillment of the semantic
guarantee are separate claims"):

- **New host / old provider** (old provider package under a new Core): the extra
  property is ignored; the binary loads and runs; bound reporting keeps working;
  **unbound coverage is silently absent**. No type, required or optional, closes
  this — coverage is *provider-authored*, the same as `state`. MiMo 4.4 and Trae
  N.4 and final.md §7 all state it. Accepted; the README must say it (all three
  seats agree).
- **Old host / new provider** (a new provider package against a Core that
  supplied no `results`): Trae N.4 names this cell and my RZ round did not.
  **The cell is accepted as real**, and it is reachable *only* for externally
  loaded providers — in-tree providers and Core release in lockstep in this
  Rush monorepo, so no in-tree path reaches it. When reachable,
  `context.results(...)` on `undefined` throws at terminal finalization.

Disagreement — remedy for the old-host/new-provider cell. Trae N.4 offers an
optional *call site* (`context.results?.(...)`) as "the compatible variant." I
**reject that as the in-tree remedy [design inference, whitepaper §1]**: a
silent guard converts a required contract into a silent no-op and reproduces the
exact failure the semantic column forbids, mirrored — the provider looks healthy
while delivering nothing — with no scenario inside the shipped packages that
reaches it. A guard is therefore defense without a named in-tree failure
scenario. The house remedy for host/provider version skew is loud and named:
the codex minimum-version gate fails loudly at the provider boundary
(`packages/agent-runtime/codex/src/version.ts:13`, and CLAUDE.md "older versions
fail loudly at the provider's version gate"). So the correct handling is
*policy, not code*: document the minimum Core / require external runtime
packages to declare conformance (Trae N.7.4), and add no guard to in-tree
providers. If the operator prefers belt-and-braces, a *loud* `typeof
context.results !== 'function'` assertion with a named error is the acceptable
in-tree-shaped option; the silent `?.` is not.

Required vs optional falls out of this and is **not** a compatibility question:
construction is the only source impact (fixtures, `typecheck:tests`), and
consumers are unaffected either way — MiMo S2/4.4 and Trae A′/N.4 agree. My
position stays **required**, on deliberation/honesty grounds (MiMo 4.3, Trae
N.6) — with the sharpening that "required" buys no *runtime* enforcement over an
old binary either; its only value is compile-time deliberation and an honest
declaration. MiMo S7's capability flag stays rejected (no behavioral consumer;
both seats concur).

## RZX.2 Q2 — Core report ownership is independent of the transport shape

The premise is correct, and separating the owners is what lets the operator
accept the semantics already recorded while still re-choosing the carrier. Three
distinct owners:

1. **Provider observation/transport** — constructs and classifies a native
   terminal and publishes it (or not). Owning source: both adapters' terminal
   paths (`claude-code/src/rpc.ts`, `codex/src/turn-manager.ts`).
2. **Core report ownership** — *what makes a turn reportable*, *to whom*, and
   *once*. Owning source, all Core and all untouched by any of the compared
   shapes: eligibility `AgentService.owesCompletion()`, recipient via
   `nativeResultRecipient` (= `completionOwner.completionRecipient()`),
   `observeRuntimeResult` (`service/agent/service.ts`), the by-identity fold and
   per-recipient FIFO/fences in
   `service/completion-router/index.ts`, and `InFlightWork` convergence at
   close/host-stop.
3. **Model-directed reporting** — the member `send` tool
   (`service/agent/mcp.ts`), a separate mechanism with no relation to the
   neutral result seam.

Consequence: the transport choice (function field vs activity member vs pull
method) *carries* a fact; it does **not** relocate report ownership. But it is
not cosmetic either — it determines whether the fact reaches Core at all, so the
carrier is a real decision even though its consumer-side policy is fixed. MiMo
4.1 and Trae N.2 both draw this line; accepted. Practical upshot: the recorded
Core-side semantics (fold-once, recipient, convergence, fences) survive any of
the viable shapes, so the operator's interface re-decision can be made against a
stable behavioral target.

## RZX.3 Q3 — which identity/order requirements are fundamental vs consequential

The premise is correct, and it is the sharpest axis in this round. Two seats
(MiMo S5, Trae Option E) independently isolate it; I adopt their framing.

Fundamental (demanded by requirement revision 2, independent of any shape):
once-only delivery to the actual owner (acceptance: "A native result reported
through submission settlement and native observation is not delivered twice");
mixed bound/unbound *terminal order* (the ordering clause,
[requirement.md](../../requirement-revision-2.md)); interruption and transport-failure
exclusion; the owner-stop boundary; generation-replacement safety; shutdown
convergence of started deliveries.

Consequential (specific to the *chosen* dual-report path): the settlement-shared
**object identity** carrying the fold key, and the fold being exercised on every
bound result rather than only unbound ones. Under the alternative single-report
path (unbound-only emission), identity is **not** needed and an **order key**
(a sequence field on `RuntimeCompletion`/the settlement union) becomes
necessary *instead*, together with router hold/reorder state.

The honest statement of the fundamental: given Q1/Q1a coverage and the order
criterion, either **dual-report + shared identity** or **unbound-only + sequence**
is forced; plain unbound-only with no key reorders (MiMo 4.3's hazard;
final.md:187-192) and is insufficient. So *order and exactly-once are
fundamental; the identity discipline is not inherent to the interface — it is
inherent to the chosen path.* This falsifies any claim that "same-object
identity" is a property the neutral interface must have; it is one of two ways
to reconcile two observers, and the choice is priced (identity + a synchronous
publication convention vs. a neutral ordinal + router machinery). MiMo S5 and
Trae E reject the sequence path on mechanism cost, and I agree; accepted.

## RZX.4 Q4 — the activity contract must be evaluated as an explicit redesign

The premise is a valid criticism of my RZ.3/O3. My round evaluated activity as
*as-is reuse* — correct that `turn.ended` carries no result
(`dreamux-types/src/activity.ts`) and the sink is documented presentation — which
makes the rejection trivial. The fair comparison is the **redesign** both other
seats evaluated: a new result-bearing activity member (MiMo S3 "a result-bearing
`RuntimeActivity` member") or fields on `turn.ended` plus a Core-side
pre-projection tap with a strip rule (Trae Option B). **I accept the criticism,
revise O3 to the redesign, and adopt their rejections**, which are decisive and
source-backed:

1. It re-merges the display and push-back channels across an operator-ruled
   boundary — the `split-streaming-display-from-pushback` task (verified to
   exist at `.agents/tasks/architecture/split-streaming-display-from-pushback/`)
   created the activity namespace precisely so display facts would not hang off
   submissions (Trae N.1).
2. A failed `RuntimeCompletion` carries a live `Error`; activity flows onto the
   Channel bus through a sanitized JSON projection
   (`service/../conversation-projection.ts:114-130`), and failure text is
   deliberately kept out of the notice body today (`result: null`). Routing the
   Error through that bus either leaks into Channel serialization or forces a
   delivery special case into the display pipeline (Trae N.2 rejection 2).
3. Cold-read `AgentActivityRecord`s exclude settlement by design → live activity
   would be richer than cold activity on the same channel, needing a
   "delivery-only, never replayed" carve-out: two contracts in one channel — a
   merged discriminant that removes no concept (whitepaper §3; MiMo S3).
4. Best-effort display drop (revoked lease / projection failure caught and
   logged) is acceptable for presentation and becomes *lost owner news* on a
   delivery fact (MiMo S3).

Verdict: **reject the redesign**, consistently with both seats — one context
field with no channel blast radius beats a repurposed documented contract plus a
filter rule in every display consumer. Point (4) of the report contract is thus
answered on its own terms, not by assuming the baseline payload is unchanged.

## RZX.5 Q5 — the recorded approval/playback and the hold are not to be reopened

The premise is correct and it corrects both other seats on one item. MiMo 4.7 and
Trae N.7.3 both list the **owner-stop timing in the terminal→settlement window**
as a "genuine decision needed (product, not preference)" / "genuine decision for
the operator." [final.md](../revision-2.md) already records that exact
behavior as a **deliberate, tested consequence**, with the instruction verbatim:
"For completion-bearing results, eligibility is read at terminal publication.
… This moves the bound eligibility check earlier than today's settlement
continuation. Explicitly test terminal, then stop before the microtask; do not
call this byte-identical stop timing." So the point is *recorded*, not open; the
operator's hold ([interface-reassessment.md](../interface-reassessment.md))
targets interface optimality, not this behavior. **I reject the "unresolved"
framing** and keep it as a re-verification obligation under whichever transport
survives — not a fork to re-litigate. If the operator nonetheless chose to
reopen it, the only cheaper alternative is unbound-only + sequence (RZX.3,
already rejected on cost), so reopening is expensive and must be explicit.

Two further items the seats might read as open are also already recorded and
should not be reopened merely because a proposal lists them:

- **Codex connection-level failure emits nothing.** MiMo 4.5.1 reverses its own
  earlier position and Trae CR2.2-C corrects its V2.5; both now agree the
  exclusion is right, and final.md §5 (line 231) already adjudicated it on
  `codex/src/events.ts`'s connection-vs-turn distinction. Settled — accepted,
  not a new decision.
- **Provenance** (`AGENT_TASK_SOURCE` + host-stamped `from`; no new constant) is
  the messaging surface, orthogonal to the neutral seam, and recorded in
  final.md §5 (line 233). It stays out of this interface round, as my RZ.6 said
  and CX.5 withdrew my earlier blocker over.

The reassessment input also forecloses the one "open" choice Trae N.7.1 raises —
whether to accept any new provider channel at all, versus reopening Q1/Q1a
toward model-directed reporting (Option 0). The input records: "No new decision
removes its normal/failed native-result coverage." Option 0 is the true
zero-contract-cost baseline and should be *named* as such (Trae does), but it is
a product revision outside this hold, not an available interface option.

## RZX.6 Accepted arguments

- **Capability-vs-shape classification** (MiMo 4.1, Trae N.2) — matches RZ.1.
  The capability (provider→Core fact for an unsolicited terminal result) is
  unavoidable under the selected behavior; name, requiredness, payload,
  placement, and bound-emission are shape.
- **Role separation and the skew matrix** (MiMo 4.4, Trae N.4) — accepted in
  full, including the old-host/new-provider cell my RZ round omitted (RZX.1).
- **Required-vs-optional is normative, not mechanical** (MiMo S2, Trae A′/N.2) —
  accepted, with the sharpening that required buys no runtime enforcement.
- **Connection failure is not a turn result** (MiMo 4.5.1, Trae CR2.2-C) —
  accepted; recorded in final.md §5.
- **Activity redesign rejection** (MiMo S3, Trae Option B) — accepted, and their
  explicit-redesign framing replaces my under-specified O3 (RZX.4).
- **The identity-vs-sequence axis** (MiMo S5, Trae Option E) — accepted and
  promoted into the answer to Q3 (RZX.3); both correctly reject the sequence path
  on mechanism cost.
- **Dual-report's residual is a cross-package convention enforced by tests and
  README only** (MiMo 4.6, Trae N.5.2) — accepted as the honest limit; a
  structural/id-based fold would need new neutral identity fields, which no seat
  adds speculatively.
- **Rejections of pull (Option D), provider-originated submission (Option C),
  and the capability flag (S7)** — accepted; my O4/O5 reached the same verdicts
  independently.

## RZX.7 Rejected or revised arguments

- **[design inference, rejected]** Trae N.4's optional *call site*
  (`context.results?.(...)`) as the compatible remedy for old-host/new-provider.
  Silent guard converts a required contract into a silent no-op with no in-tree
  scenario; the house remedy is loud, named version gating
  (`codex/src/version.ts`) plus documented minimum-Core. No in-tree guard;
  a *loud* assertion is the acceptable alternative (RZX.1).
- **[recorded-decision conflict, rejected]** MiMo 4.7 / Trae N.7.3 treating the
  stop-timing move as an open product decision. It is recorded and test-pinned
  in final.md:194-199 (RZX.5).
- **[product revision, foreclosed]** Trae N.7.1's "accept any new provider
  channel at all" — the reassessment input records that no decision removes
  Q1/Q1a coverage; Option 0 is out of scope under this hold.
- **[self-revision]** My own RZ.3/O3 evaluated activity *as-is*; the fair
  comparison is the redesign both seats analyzed, and their rejection is
  adopted (RZX.4).

## RZX.8 Revised complete recommendation

Retain the delivered transport shape — **Option A / S1 / O1** — with these
corrections folded in:

- Required `AgentRuntimeResultSink` on `AgentRuntimeCreateContext`, carrying the
  existing frozen `RuntimeCompletion`; in-tree providers publish once per
  observed normally-completed or observed-failed native terminal, bound or
  unbound, synchronously in terminal order, with the *same object* every
  settlement resolves with; interrupted and transport-failed terminals publish
  nothing.
- **Core owns all report semantics** (eligibility, recipient, by-identity fold,
  per-recipient FIFO, fences, `InFlightWork` convergence); `EntityTurn` is
  retained for tokenless outcomes and non-emitting/non-armed roles (RZX.2).
- **Scope is the two semantic moves, not the field count** (RZX.3, RZX.5):
  bound-result publication moving to terminal time, and dual publication resting
  on cross-package object identity. Both are recorded and must stay test-pinned
  (per-adapter reference identity; delivered-order on multi-line Claude batches
  and mixed Codex queue heads; the terminal-then-stop race).
- **Version skew is governed by documentation, not code** (RZX.1): the new-host/
  old-provider semantic gap is stated in the README; the old-host/new-provider
  cell is handled by documented minimum-Core / provider conformance, with no
  silent `?.` guard.
- **Removals that stay removed**: codex `unboundObservedTurnIds` /
  `releaseOrphanTurnsIfIdle`, Claude's answered-only completion conditional, the
  duplicated fact mapping.

This is the least-change shape that satisfies the accepted behavior: it leaves
`RuntimeCompletion` identity, the router fold, the recipient model, and the
settlement chain intact; adds 13 neutral lines reusing pre-feature vocabulary;
and removes real provider bookkeeping. It is a local optimum under the stated
evidence, not a global-optimality claim (RZ.4).

## RZX.9 Genuinely unresolved decisions

Both other seats' candidate "decisions" resolve to recorded behavior
(stop-timing, connection failure, provenance) or to mechanism rejections
(S2/S3/S4/S5/C/D/S7). What genuinely remains:

1. **[operator-facing, small — release/doc policy, not architecture] Provider↔host
   version-skew wording.** How an external `AgentRuntimeProvider` declares
   conformance / a minimum Core for the new required field, and whether external
   runtime packages must state it. Owning source: the field has no
   version-negotiation consumer; the house precedent is the codex version gate
   (`packages/agent-runtime/codex/src/version.ts`) and provider-README contract
   text. MiMo S7 correctly rejects a code mechanism for it; Trae N.7.4 raises the
   policy. This is the one decision the operator may still want to set, and it
   does not block the interface shape.
2. **[fact to verify, not a design fork] Real Codex unbound-terminal frequency
   and the live fatal `error` protocol shape** (Trae N.8). The path exists in
   source; its real-traffic frequency is a live-verification fact, and no design
   decision should be premised on it.

No interface-shape decision blocks this solution. The operator's caution is
answered structurally: the capability is forced by accepted behavior, the shape
changes the least, and the two behaviors that actually move are named, bounded,
and test-pinned rather than absorbed silently.

## RZX.10 Classification ledger (cross-review round)

- **Unavoidable capability [decision-derived]:** one neutral provider→Core fact
  for an unsolicited native terminal result, once-only, in mixed bound/unbound
  terminal order (Q1/Q1a + the ordering clause).
- **Chosen shape [inference]:** a *required* synchronous non-throwing function
  field on the create context; evaluated against, and preferred over, an
  optional field, an activity redesign, pull, provider-originated submission, and
  unbound-only + sequence.
- **Fundamental vs consequential [analysis]:** once-only and order are
  fundamental; shared-object identity and fold-on-every-bound-result follow from
  the chosen dual-report path, not from the interface itself (RZX.3).
- **Report ownership [fact]:** Core, independent of the carrier; provider
  observation and model-directed `send` are separate owners (RZX.2).
- **Removed by the candidate [fact]:** codex orphan-turn bookkeeping; the
  duplicated fact mapping; the answered-only Claude completion conditional.
- **Recorded, not reopened [decision + playback]:** owner-stop terminal-time
  eligibility, the codex connection-failure exclusion, and provenance — all
  already in final.md and re-verified here rather than re-litigated (RZX.5).
- **Operator caution honored [decision, quoted]:** "任何中立 interface 的变更都要慎重"
  — answered by necessity + minimality + the named scope of the two semantic
  moves, not by an asserted ruling.

# Greenfield design from requirement revision 3 — independent proposal

Method: derive the ideal from the product stories first
([requirement.md](../../requirement.md), revision 3), then compare it to `HEAD`
and the delivered worktree. I did not read the other seats' greenfield
sections. My own earlier recommendations are treated as history, not
constraints. Held actions respected: no code/tests/config/scripts, no
experiments, no Git/Channel/GitHub.

## G1. What the stories actually require (minimum facts)

Stripping class names and existing fields, the requirement asks for exactly
four facts and two actions:

| # | Fact / action | Authoritative producer | Consumers |
| --- | --- | --- | --- |
| F1 | A native turn reached a normal/failed terminal, with its result | the runtime provider (it alone observes the native terminal) | Core delivery → the member's owner |
| F2 | Who a member's *owner* is (name, role, status) | the owning service (`TeamService` / `DispatcherService`) | the member's prompt, `list`, `send` routing, and F1's delivery target |
| F3 | A submission's requester and its answer (including tokenless outcomes) | Core's submission path | the requester (a Workflow script, or a Dispatcher-initiated `team` request), and the owner for tokenless member outcomes |
| A1 | "send this text to my owner or a same-collection peer, as me" | the member's model, via MCP | the addressed recipient |
| A2 | "discover my owner and peers" | the member's model, via MCP | the member |

Everything else in the delivered code is a reconciliation strategy, not a
product fact. The whole design question is **how F1 and F3 coexist**.

There is no fact for "this member belongs to a management hierarchy that
should forward upward." Q5 forbids deriving one. Reporting is therefore a
*per-collection owner* fact (F2), never a parent-chain fact — which is what
makes the managed-Team boundary fall out instead of needing enforcement.

## G2. The ideal design

### G2.1 One owner view per member collection

The delivered shape gives a collection two owner options — `completionOwner`
(a result recipient, `service/completion-router/index.ts:49`) and
`messagingOwner` (an address + fenced input,
`service/agent/mcp.ts:108-119`). On the Team side both happen to be the same
`TeamService`; on the Dispatcher side they are split (`completionOwner:
this.dispatcherAgent`, `messagingOwner: this`,
`service/dispatcher-service/index.ts:246-247`) even though `DispatcherAgent`
*already* implements `completionRecipient()` and `submitInput()`
(`service/dispatcher-service/agent.ts:184-188`) and `DispatcherService.submitInput`
merely forwards to it (`index.ts:355-361`). Two options, two objects, one
forwarding hop, for one concept.

Ideal: **one `owner` per collection**, the conversational agent its members
belong to, exposing exactly the three things the mechanism needs:

```ts
interface MemberCollectionOwner extends CompletionOwner {
  describe(): { name: string; role: string; status: string };
  /** Fenced inbox; the member never supplies its own completionRecipient. */
  submitInput(input: Omit<TeammateSubmitInput, 'completionRecipient'>): Promise<TurnAdmission>;
}
```

- Team: `TeamService` (already this).
- Dispatcher: the `DispatcherAgent` (it already satisfies two of three;
  `describe()` replaces `DispatcherService.memberOwner`, and the forwarding
  `DispatcherService.submitInput` hop is deleted).

`TeammateCollectionOptions` then carries one `owner` field instead of
`completionOwner` + `messagingOwner`. This is Q4's "sufficiently abstract and
reusable" read literally: the two collections differ only in *which* owner
object they hold, never in the mechanism.

Follows/supersedes: I supersede the delivered `completionOwner` +
`messagingOwner` split, which the delivered code itself shows is one concept
with two names. I follow the R71 data-flow decision that report delivery
queries the actual owner at the ownership boundary (no recipient suppliers,
no registries) — this keeps that decision and removes the second owner port.

### G2.2 The two facts must be partitioned, not overlapped

Delivered design reconciles F1 and F3 by **emitting on both** and folding on
the shared `RuntimeCompletion` object
(`service/completion-router/index.ts:88-113`, `turn.ts` `selectedCompletion`).
The fold's purpose is to collapse the overlap. But that overlap is not a
requirement — it is an artifact of two channels carrying the *same* fact
(a completed turn) to the *same* recipient for an owner-reported member.

Observe the source: for ordinary members, every completion recipient is the
collection owner — `spawn` (`index.ts:202`), `sendResolved` (`index.ts:327`),
and the armed native recipient (`index.ts:859`) all read
`completionOwner.completionRecipient()`, i.e. the same object. So for an
owner-reported member, F1 and F3-completions are always a duplicate.

Ideal: **partition the payloads so no fact travels two channels.**

- **F1 — completions** (`status: completed | failed`) travel *only* the
  provider→Core native channel, to the member's owner. Emitted once per
  observed terminal, bound or unbound.
- **F3 — tokenless answers** (`kind: stopped | failed` with a transport/
  pre-admission `Error`, and interruptions) travel *only* the submission
  settlement, to the requester.

When the requester is the owner (a member's own turn) the tokenless outcomes
still reach the owner; the completion reaches the owner by F1; **no result
is ever eligible for both.** The reconciliation becomes an invariant, not a
fold.

This is the design's central claim and its main difference from the
delivered shape. Its consequences:

1. **The member-report guarantee stops resting on a cross-package object
   convention.** Today the provider must hand the sink and `settled` the
   *same frozen object* (`agent-runtime.ts` result-sink doc), and both
   trailing rounds' strongest counterexample is a provider that constructs
   two objects. Under the partition, the member path never reads the
   settlement's completion, so that convention is no longer load-bearing for
   the product guarantee.
2. **The completion-identity fold is no longer part of member reporting.**
   It may still have non-member consumers; those must be re-derived and kept
   only if a real caller remains (see G5).
3. **The provider obligation shrinks** to "publish each observed
   normal/failed terminal once, in terminal order" — no identity discipline.

### G2.3 The neutral provider contract (ideal)

Unchanged in essence from the delivered seam, because the seam is already the
house shape (push-only leased sink beside `state`/`activity`):

```ts
/** One provider-observed native result. Pre-existing vocabulary. */
export type AgentRuntimeResultSink = (completion: RuntimeCompletion) => void;
// AgentRuntimeCreateContext gains: readonly results: AgentRuntimeResultSink;
```

What the next provider author must implement, in full:

- Construct one `RuntimeCompletion` per normally-completed or observed-failed
  native terminal and hand it to `context.results(...)` synchronously at
  terminal finalization, whichever turn it was — bound or autonomous.
- Emit nothing for interruptions, refused/discarded commands, or
  connection/transport failures (they are not terminals; `codex/src/events.ts`
  draws that line).
- Never throw; the sink does not apply backpressure.

Note the **removed** obligation: the author no longer has to reuse the same
object on the settlement. Passing the completion to `submit`'s settlement is
still how a *requester* learns an answer, but the member guarantee does not
depend on the two being identical.

**Intrinsic vs transport-following guarantees** (the report asks for this
split):

- *Intrinsic product requirements*: every observed normal/failed terminal is
  reported to the member's owner exactly once; distinct results report
  separately; owner-stop/dissolve/shutdown retains suppression; interruption
  and transport failure never fabricate a terminal; unbound coverage.
- *Follow only from this transport/representation*: synchronous terminal-order
  publication (the mechanism that makes mixed bound/unbound ordering hold
  without a sequence queue); the single `RuntimeCompletion` payload; the
  `results` field name and requiredness. A different transport could keep the
  same product guarantees with a different ordering mechanism — that is the
  honest boundary of the claim.

### G2.4 Core: one report rule, no recursive tree, no owner-kind forks

Core's delivery is one rule: **a member entity that has an owner-recipient
reports each `RuntimeCompletion` from the native channel to that recipient,
if it still owes its owner news.** Concretely, keep `observeRuntimeResult`
(`service/agent/service.ts:407-416`) as the single native consumer and the
existing per-recipient FIFO / fence / bounded attempts in the router. The
recipient is F2's `owner.completionRecipient()`, captured at construction —
never a derived parent.

- No owner-kind branch: the handler compares the target name to the owner
  name and otherwise uses the collection; the two services differ only in the
  owner object they supply (G2.1).
- No recursive forwarding: the router submits to the recipient it was given
  (`completion-router`), and a member's owner is a leaf conversational agent
  for this purpose. A TeamLeader is simply not owner-armed, so its turns
  produce no automatic report — the managed-Team boundary (Q5) is the
  *absence* of an arming fact, not a filter.
- F3 delivery: `EntityTurn` keeps reporting tokenless outcomes to its
  recipient (`turn.ts` `startDeliveryIfReady`); for an owner-reported entity
  it does not report completions, because F1 owns them.

### G2.5 Member tool surface

Minimal and unchanged from the delivered acknowledgement: on the existing
`teammate` MCP server, a `member` scope advertising exactly two tools —
`send {name, prompt}` (host-bound sender; self refused; owner addressed
through the owner inbox, peers through the collection's send/reopen path) and
`list {}` (owner row + peer rows, self excluded, closed peers discoverable).
The `dispatcher | team_leader | member` scope union is justified: the arms
advertise genuinely different tool sets, so it is a real boundary, not an
N-valued discriminant the callee ignores.

Sender binding: the handler stamps `from: <caller name>` into the submission
`attrs`, which `submission.ts` renders into the `task` envelope; the model
cannot set it. This is the minimum: one attribute on an existing envelope, no
new source constant (`AGENT_TASK_SOURCE` is reused).

### G2.6 Managed-Team boundary, from the same rule

| Producer | Owner-armed? | Result |
| --- | --- | --- |
| Ordinary member (Team or root) | yes | every native terminal reported to F2's owner |
| TeamLeader | no | only the settlement answer to an explicit `team.create`/`team.send` request (`deliverCompletionToDispatcher`) |
| Workflow member | no | script consumes `settled`; no member tools |

Q5 needs no mechanism: reporting is per-collection-owner, so a managed Team's
members report to *their* leader, and the leader — not being a root member —
reports to the Dispatcher only for a request it actually answered.

## G3. Report-contract walk-through

- **One-result delivery / folded inputs**: one terminal → one native
  publication → one owner report. N submissions answered by it (folded
  inputs) each settle; on an owner-reported member those settlements do not
  report, so the owner sees exactly one report. Satisfies "multiple
  submissions … produce one owner report" and "native observation and
  submission settlement … do not produce duplicate reports" by partition, not
  by dedup.
- **Mixed native-result ordering**: all normal/failed completions enqueue at
  terminal publication in terminal order (Claude's synchronous line loop,
  Codex's terminal drain), before any settlement continuation. Bound and
  unbound completions therefore interleave in true terminal order with no
  sequence field.
- **Workflow answers**: `createLocked` members are not owner-armed; the
  script consumes `settled` directly. Unchanged.
- **Native vs transport failure**: a provider-proven failed terminal is a
  completion (F1). A connection-level error is a connection event
  (`events.ts`), never a completion; the bound tokenless `kind:'failed'`
  settlement still answers its requester (F3). No fabrication.
- **Interruption**: interrupted terminals emit no completion; the tokenless
  `kind:'stopped'`/`failed` settlement answers the requester. Unbound
  interruption stays out of scope.
- **Sender binding**: host-stamped `from`, as G2.5.
- **Wake / reopen / lock**: explicit `send` uses the collection's existing
  send path (wake on idle, runtime-owned busy behavior, reopen a closed
  peer, respect Workflow locks). Automatic reports push back to a live
  runtime only (`wake:false` semantics) — they never start an unavailable
  owner. Unchanged.
- **Stop eligibility**: read once at report time; a stop before a completion
  is published suppresses it; a report already started is not retracted. The
  delivered solution's named terminal-time reading is preserved as the
  partition's reading too (G6, product choice recorded).
- **Generation replacement**: the leased result closure drops writes from a
  revoked generation, exactly like `state`/`activity`.
- **Convergence**: started native deliveries are tracked in the existing
  `InFlightWork` and joined at close and host-stop
  (`service.ts:588-590, 794-796`). F3 already converges through
  `convergeRetainedTurns`.

## G4. Ideal vs delivered vs HEAD — adaptation/replacement

| Module | HEAD | Delivered | Ideal classification |
| --- | --- | --- | --- |
| `dreamux-types` result seam | absent | `results` sink | **adaptation** — same field, obligation narrowed (no same-object clause) |
| Provider emission (Claude/Codex) | discard unbound | publish once, same object | **adaptation** — publish once; drop the identity clause |
| `completion-router` fold | folds N settlements | folds observation vs settlement | **replacement of role** — no longer reconciles member reports; keep only if a non-member consumer remains |
| `EntityTurn` | delivers all outcomes | delivers all outcomes, carries `selectedCompletion` | **replacement** — delivers tokenless only for owner-reported entities; `selectedCompletion` drops from the member path |
| `TeammateCollectionOptions` | `completionOwner` | `completionOwner` + `messagingOwner` | **replacement** — one `owner` view |
| Dispatcher owner wiring | — | agent + service split, forwarding hop | **replacement** — `DispatcherAgent` is the owner |
| Member MCP scope | absent | `kind:'member'` + 2 tools | **adaptation** — kept |
| Codex orphan bookkeeping | present | deleted | **retained deletion** |

## G5. Exact removals, retained, additions

**Removed (name them):**

1. The cross-package "same frozen object" obligation on providers — the
   member guarantee no longer reads it.
2. The completion-identity fold **as part of member reporting**. Its residual
   consumers must be re-derived; if none exists outside folded non-member
   submissions, `CompletionDeliveryPolicy.completions` WeakMap and
   `EntityTurn.selectedCompletion` are deleted, not kept because they exist
   (whitepaper §4).
3. `TeammateCollectionOptions.messagingOwner` (merged into `owner`).
4. `DispatcherService.memberOwner()` and the forwarding
   `DispatcherService.submitInput` hop (owner is the `DispatcherAgent`).
5. Codex `unboundObservedTurnIds` / `releaseOrphanTurnsIfIdle`; Claude's
   answered-only completion conditional (already removed; stay removed).

**Retained (with reason):** `RuntimeSubmission.settled` +
`RuntimeSubmissionSettlement` (they answer a requester — a real, distinct
fact, F3; the Workflow script and the Dispatcher request path depend on
them); `RuntimeCompletion` (pre-existing vocabulary); the per-recipient FIFO,
fence, bounded attempts; `InFlightWork`; every state/config/lifecycle
contract.

**Added (and paid for):** one neutral context sink (`results`, paid by
Q1/Q1a); one `member` MCP scope with two tools (paid by the explicit-messaging
stories); one partition rule in `EntityTurn` (paid by the folding criterion).
Additions do not outnumber removals.

**What a maintainer / next provider must hold:** "a member's turns report to
its collection owner; a provider publishes terminals; tokenless answers go to
the requester." Three sentences, no identity convention, no owner-kind fork,
no hierarchy.

## G6. Counterexamples and falsifying verification

- **Partition counterexample (my design's weak point).** If some future path
  attaches a *non-owner* completion recipient to an ordinary member's
  submission, the partition suppresses the settlement delivery and that
  non-owner requester learns nothing. Today no such path exists — every
  member completion recipient is the collection owner (G2.2) — but it is an
  assumption, not a proof. Falsify: assert that for every submit to a
  member, any attached completion recipient is that member's owner. If the
  assumption is rejected as too fragile, fall back to the delivered
  identity-fold (G7 blocker).
- **Identity-fold counterexample (delivered's weak point).** A provider that
  constructs a distinct result object for the sink and the settlement
  double-reports; no type error, no Core detection. The partition removes
  this failure mode entirely.
- **Ordering residual (both designs).** A tokenless interrupted frame
  followed by a completed unbound frame in one Claude batch can deliver the
  stopped notice after the completion report. Pre-existing tokenless path,
  documented; neither design adds a sequence field.
- **Non-emitting provider (both).** An older provider that ignores the sink
  still loads and keeps bound-only reporting. Loading is not coverage; the
  README states it.
- **Managed-Team leak (must be tested).** Many Teams producing member/leader
  results must yield *zero* unsolicited Dispatcher input, while an explicit
  `team.send` still returns exactly one folded answer. Assert on delivered
  input to the Dispatcher, not on internal calls.

Falsifying verification (post-hold, not run now): per-adapter "one native
publication per terminal"; delivered-order on multi-line Claude batches and
mixed Codex queue heads; the terminal-then-stop race pair; close/host-stop
join of native deliveries; Workflow answer consumption; the two
managed-Team/request tests above.

## G7. Unverified facts vs product choices; blockers

**Unverified facts (mark, do not design on them):** real Codex unbound
frequency and the live fatal-`error` shape; whether any non-member folded
submission actually needs the completion-identity fold (decides removal #2);
whether any external provider constructs a public create-context (decides
required-vs-optional pressure).

**Product choices (operator's, not mine):** required vs optional `results`
(I recommend required, for deliberation, per the RZX round); owner-stop
eligibility at terminal time (recorded already, `final.md:194-199` — a
recorded behavior, not reopened); the availability asymmetry (automatic
reports drop for an unavailable owner — accepted, revision 3 lines 89-92).

**Genuine blocker:** none blocks the ideal at the product level. One design
premise is load-bearing enough to name: **the partition assumes an
owner-reported member's submission recipient is always its owner.** If the
TeamLeader/Dispatcher-agent reply model ever grows a path that answers a
*different* requester from a member's own turn, the design must either keep
the identity-fold (delivered shape) or route that answer explicitly. This is
the single decision to confirm; everything else is implementation preference.

## G8. Classification summary

- **Unavoidable capability [decision-derived]:** one neutral
  provider→Core channel for unsolicited-normal/failed terminal results
  (Q1/Q1a), plus one owner abstraction and one explicit peer/owner send
  surface.
- **Chosen shape [inference]:** required synchronous non-throwing `results`
  sink; **payload-partitioned** coexistence of the native channel and the
  submission-answer channel; one unified `owner` port per collection.
- **Replacement [named boundaries superseded]:** the delivered
  `completionOwner`+`messagingOwner` split (one concept, two ports); the
  identity-fold's role in member reporting; the per-turn completion delivery
  side effect on `EntityTurn`.
- **Adaptation [kept]:** the neutral sink type, the `member` MCP scope and
  its two tools, the router FIFO/fence, `InFlightWork`, `RuntimeSubmission`.
- **Actual removals:** the provider same-object obligation; the member
  path's dependence on the completion-identity WeakMap (with
  `selectedCompletion`); `messagingOwner`; `DispatcherService.memberOwner` +
  its forwarding `submitInput`; codex orphan bookkeeping and Claude's
  answered-only conditional.
- **Strongest counterexample:** a member submission with a non-owner
  completion recipient (G6), bounded today by source inspection.

# Greenfield design from requirement revision 3 — cross-review and revised position

Method: read the current greenfield sections of [MiMo](mimo.md) and
[Trae Seed](trae-seed.md), the cross-review input, and the TeamLeader's
working notes (hypotheses, not an answer). Verified every contested claim at
source. This section supersedes my G2.1 and G2.2 where it says so; earlier
sections remain history. Held actions respected.

Headline: **the cross-review's Codex-interruption case falsifies my own G2.2
partition and Trae's single-path claim, and leaves the delivered
sibling-observation + identity-fold shape as the sound one.** MiMo's
single-event design is the only alternative that survives that case, and it is
not specifiable without the bookkeeping it claims to delete. My greenfield
"ideal" was wrong on its central claim; I say so below with the source.

## CG.1 The Codex interruption falsifies every payload partition

Cross-review required question 1. Source, verified:

- `packages/agent-runtime/codex/src/turn-manager.ts:295-302`: `finalize`
  builds `completionFromTerminal(terminal, codec)`, calls `resultSink` **only
  when** `terminal instanceof Error || terminal.status !== 'interrupted'`, and
  then `record.members.forEach(m => m.settle({ kind: 'completion', completion }))`
  unconditionally.
- So an **interrupted Codex bound turn produces a `kind: 'completion'`
  settlement carrying a completed, partial-text `RuntimeCompletion`, with no
  sink publication at all.** It is not a tokenless stopped/failed answer.
- `packages/agent-runtime/claude-code/src/rpc.ts:298-329`: Claude does the
  opposite for the same event — `interrupted ? {kind:'stopped'} : {kind:'completion', completion}`,
  and publishes to `results` only when `completion !== null`.

Exact behavior my design must state for the bound Codex interruption:

| Aspect | Value |
| --- | --- |
| Sink | silent (interrupted terminals publish nothing) |
| Settlement | `{ kind: 'completion', completion: { status: 'completed', resultText: <partial> } }` |
| Core recipient | the submission's captured recipient — for an ordinary member, the collection owner |
| Wording | `turnCompletionFact` maps `status: 'completed'` → `"TeamMate X completed a turn."` with the partial text as body (`completion-renderer.ts:53`) |
| Claude equivalent | settlement `{kind:'stopped'}` → `"…turn was stopped."`, no body |

Consequences, stated plainly:

- **My G2.2 payload partition is withdrawn [self-correction].** Under
  "completions only via the sink; a completion-bearing settlement on an armed
  member is not delivered," the Codex interrupted bound turn's partial result
  would vanish — an existing, requirement-preserved behavior (rev-3 line 74,
  "existing submission-associated failure/interruption outcomes remain in
  scope") lost silently. My partition would have to special-case interruption,
  which is strictly worse than the mechanism it tried to delete.
- **Trae's G.2.2 makes the same error, and its text states it outright
  [source correction]:** "an interrupted turn that answered submissions settles
  `stopped` with no completion" and "the owner still receives the existing 'was
  stopped' notice through the tokenless settlement path" (Trae G.5 #2). That is
  true for Claude and **false for Codex** (`turn-manager.ts:295-302`). Under
  Trae's rule ("the sink is the sole completion-report path to the
  subscriber; `EntityTurn` delivers tokenless only for armed members"), the
  Codex interrupted bound partial result is dropped. Trae's design is
  falsified by the same case as mine unless it is repaired by letting
  completion settlements also reach the subscriber — which is exactly the
  delivered design.
- The correct reconciliation is **"deliver on first observation of the
  completion object."** Normal bound turn: sink publishes (terminal order),
  settlement folds into the same delivery. Codex interrupted bound turn: sink
  silent, settlement is the first observation → delivered. Unbound: sink
  publishes. This is the delivered `CompletionDeliveryPolicy` WeakMap
  (`completion-router/index.ts:88-113`) doing precisely the right thing, and it
  is why the fold is not removable.

Therefore the **"same frozen object" provider convention stays load-bearing**
[withdraw my G5 removal #1 and Trae's "no longer load-bearing" claim]: a
provider that clones the completion would double-deliver the normal bound case,
and no type catches it. Required verification: per-adapter reference-identity
tests plus the interrupted-bound settlement test.

## CG.2 MiMo's single-event correspondence is not specifiable without the bookkeeping it deletes

Cross-review required question 2. MiMo's event is
`turnResults({ result, answered: readonly RuntimeRequest[] })` (MiMo G.3.1),
where `RuntimeRequest { answered: Promise<RequestAnswer> }`. Completing the
correspondence:

- **Who creates the request handle?** `AgentRuntime.submit` accepts only
  `{ text }` (`agent-runtime.ts` `AgentRuntimeSubmissionInput`) and returns a
  `RuntimeAdmission` asynchronously. Core cannot mint the handle and hand it to
  the provider (the submit input carries no correlation id and adding one
  re-opens the text-only seam). So the provider must mint the handle and expose
  it — meaning `RuntimeRequest` belongs to the provider, and MiMo's "a
  Core-issued request" is inaccurate.
- **When does Core bind the reply recipient?** At the admission ownership
  boundary (the R71 decision the root notes require preserving) — i.e. when
  `submit` resolves. But the cross-review states, and I accept as a required
  case, that **a terminal may precede the admission response**. Then the event
  arrives carrying a handle Core has never seen, so Core cannot resolve the
  recipient. The only repairs are (a) wait on an unknown promise — forbidden by
  the input, and it loses order; or (b) buffer the event keyed by handle until
  admission resolves — an **event hold queue / admission registry**, which is
  exactly the "unnamed admission bookkeeping" the input forbids and the
  mechanism MiMo claims to delete.
- **Rejected/skipped/ambiguous admissions, folded requests, close racing
  admission**: a skipped/refused input yields no handle, so it cannot appear in
  `answered` — fine — but a *folded* terminal answering handles A and B where
  B's admission is unresolved needs B's recipient before it exists (a); and a
  close racing admission needs the recipient queried at the boundary, which is
  after the event. Every one of these forces the hold buffer.

An object-lookup keyed on the handle is an identity mechanism too —
*distinct in kind* from completion identity, as the input says, but it does not
make identity disappear; it relocates it from the completed result to the
in-flight request, and adds a registry that the delivered fold does not need.
**Verdict: reject MiMo's event contract.** It is a materially larger
provider-contract break whose central claim (no identity, no bookkeeping) does
not hold once the terminal-before-admission race and the recipient-binding
point are honored. I credit it as the only one of the three designs that
carries interruption through a single channel and thus survives CG.1.

## CG.3 Residual consumers: the fold cannot be deleted

Cross-review required question 3. Enumerated at source, the completion-identity
fold has consumers beyond ordinary-member reporting:

- **Q5 folded TeamLeader requests.** `team/mcp.ts:126,156` set
  `deliverCompletionToDispatcher: true`; `team/index.ts:437-443` and
  `team/service.ts:347-354` resolve it to the collection owner's recipient.
  N accepted Dispatcher submissions answered by one leader turn each settle
  with the same `RuntimeCompletion`; the WeakMap folds them into **one**
  delivery to the Dispatcher agent. Deleting the fold would deliver N times.
- **Workflow consumes the value, not a notification.**
  `workflow-service/run.ts:586` awaits `admission.turn.settled`; the value
  must survive regardless of delivery shape.
- **Public receipt field.** `team/requests.ts:119-122` returns
  `turn_id: admission.turn.id`; `Turn.id` is a public output schema field and
  must not be removed as "private diagnostic state."

So neither MiMo's "delete the `CompletionDeliveryPolicy` fold" nor a narrower
"identity is no longer load-bearing" survives: for ordinary members the fold is
what reconciles the sink and the settlement (CG.1), and for Q5 it is what
collapses folded requests. MiMo's recipient **set-dedupe** would substitute for
the Q5 case *only if* the event's `answered` attribution existed — which CG.2
rejects. Trae keeps the fold ("stays as generic completion-router machinery"),
which is correct, but its single-path rule still drops the Codex case.

## CG.4 The Dispatcher fence is not a forwarding hop

Cross-review required question 4; corrects my G2.1. Verified:
`DispatcherService.submitInput` executes inside `this.fence.admit(...)`
(`dispatcher-service/index.ts:355-361`), while `DispatcherAgent.submitInput`
(`agent.ts:189-190`) calls `mustAgent().submitInput` with no aggregate
admission. The member MCP reaches the **fenced** entry via
`scope.owner.submitInput` (`mcp.ts:708`). So the service entry is not dead
indirection — **the aggregate fence is its reason to exist**, and during
shutdown the aggregate can close while the contained agent still runs.

**I withdraw G2.1's "one concept, two names / remove the forwarding hop."**
On the Team side `completionOwner` and `messagingOwner` coincide; on the
Dispatcher side they encode two genuinely different facts — *scope ownership /
aggregate input fence* (the service) and *the contained delivery recipient*
(the lazily resolved agent, `completionRecipient()` → `mustAgent()`). If the
ports were unified, the fence would have to move to the owner object and the
prepared-agent lookup point preserved; deleting the service entry and binding
the holder directly is not byte-equivalent (root notes). Net: unifying is a
cosmetic rename that risks the fence; **keep the two ports.** The only honest
addition from my G2.1 is the naming observation — the delivered `messagingOwner`
is really "the owner's fenced input + descriptor," and it is not the same
object as the recipient on the Dispatcher side. That is a documentation fix,
not a redesign.

## CG.5 Adoption: both skew directions under a native-only route

Cross-review required question 5. My G2.2 and Trae's G2.2 are **native-only for
member completions** (a completion-bearing settlement is not delivered to the
subscriber). Under that route:

- **New host / old non-emitting provider**: the provider never calls the sink,
  and its bound submissions settle `kind: 'completion'` — which the native-only
  route ignores — so the ordinary member loses **bound** reporting too, not just
  unbound. This is strictly worse than the delivered overlapping shape, which
  retains bound reports through settlement. This is exactly the counterexample
  Trae G.5 #1 and MiMo G.9 raise against their own single-path designs; it is a
  real cost, and it is a second independent reason to keep the delivered shape.
- **New host / new provider**: full coverage.
- **Old host / new host-contract**: unchanged — the sink is an additive inbound
  context field; a README minimum-version sentence is documentation, not
  runtime enforcement, and the delivered adapters' bare call would throw on a
  host that supplied no sink.

No migration is involved (no persisted file changes); the ordinary API/README
change-note policy applies. Unknown external inventories affect adoption risk,
not the ideal's derivability — so they do not select the member route (they
would only select staging).

## CG.6 Adjudication ledger

**Accepted**

- The root notes' Codex-interruption counterexample against the partition
  (cross-review #1) — accepted; G2.2 withdrawn.
- Trae G.1's **two-entitlement** model (an ordinary member's owner is
  *subscribed* to every turn outcome; a specific requester holds a *one-shot
  answer*) — accepted as the clearest statement of the product, and compatible
  with the delivered shape once one adds that the subscription also carries the
  Codex interrupted bound completion (CG.1). It is the correct frame; it does
  not by itself justify dropping the per-submission recipient.
- Trae's retention of the fold; MiMo G.3.2's "one notice rule" as a policy
  function — accepted in spirit; the delivered `observeRuntimeResult` +
  `turnCompletionFact` already approximate it.
- Root notes' fenced-inbox correction (#4) and residual-consumer list (#3) —
  accepted; G2.1 narrowed.
- Trae G.5.1 / MiMo G.9 (nonconforming provider loses bound coverage under a
  single path) — accepted as the decisive cost of native-only member routing.

**Rejected / corrected**

- **My G2.2 payload partition** — withdrawn (CG.1).
- **Trae's "interrupted settles `stopped`"** — source-corrected: false for
  Codex (`turn-manager.ts:295-302`); its single-path design drops the Codex
  interrupted bound partial result.
- **MiMo's `turnResults({result, answered})` event** — rejected as not
  specifiable without a request registry / event hold buffer or waiting on an
  unknown promise (CG.2); larger provider-contract break for no achievable
  simplification.
- **MiMo's fold deletion and "identity can disappear from the whole provider
  contract"** — narrowed/rejected (CG.3).
- **My G2.1 "forwarding hop"** — withdrawn (CG.4).
- **Any "remove the same-object convention"** (my G5 #1 and #2; Trae "no longer
  load-bearing") — rejected: it dedups the normal bound case and cannot be
  dropped without a MiMo-style authoritative single channel.

## CG.7 Revised complete recommendation (contract + ownership)

**Neutral runtime contract — keep the delivered shape.**

- `AgentRuntimeCreateContext` gains one **required** sink:
  `readonly results: AgentRuntimeResultSink` where
  `AgentRuntimeResultSink = (completion: RuntimeCompletion) => void`,
  beside `state`/`activity`. Payload is the pre-existing `RuntimeCompletion`.
- Provider obligation, stated precisely and **including the identity clause
  that is genuinely load-bearing**: publish once per observed normal/failed
  native terminal, synchronously in terminal order, bound or unbound, with the
  **same frozen object** every settlement of that turn uses; publish nothing for
  interruptions, refused inputs, connection/transport failure, or teardown.
- The return on this contract is the two-observation reconciliation (CG.1) and
  the preserved Codex interrupted partial result; the cost is the cross-package
  convention, which is now *documented as load-bearing* rather than removed.

**Core ownership — two legitimate inputs, one reconciliation, optionally one
side-effect owner.**

- Keep the provider-observation input (`observeRuntimeResult`) and the
  submission-settlement input (`EntityTurn`), and the single identity fold that
  reconciles them. The two inputs are **not** derivable from each other: the
  provider families disagree on the interrupted settlement shape (CG.1), and a
  request answer (`kind: failed`/`stopped` with no terminal) is a different fact
  from a result.
- **Optional, orthogonal simplification** (root-notes shape (i), the "single
  Core reporting owner consuming two legitimate inputs"): consolidate the
  delivery side effect into `AgentService` so `EntityTurn` stops owning
  recipient/report-task/`ensureDelivery`. Adopt this **only if** it genuinely
  removes those per-turn fields and preserves, per the interface-reassessment
  conclusion: original recipient lookup points, fail-loud unsettled-request
  proof, convergence of started work, native synchronous queue entry, the
  Workflow `settled` value, and `turn_id`. It is a Core-internal ownership
  change, not a transport change; not a blocker, and not part of the minimal
  answer.
- Do **not** conflate "one side-effect owner" (this shape) with "one
  authoritative notification event" (MiMo's) — the former keeps two inputs and
  the fold; the latter removes the fold's inputs and fails CG.2.

**Messaging / owner ports — keep the delivered acknowledgement.** Third
`member` scope on the existing `teammate` server with `send {name, prompt}` and
`list`; host-bound `from` via an existing envelope attribute; the two owner
ports stay distinct on the Dispatcher side (CG.4); the manager boundary needs no
filter because a TeamLeader is simply never armed.

## CG.8 Actual removals (this round's honest accounting)

The greenfield pass yields **no new structural removal beyond the delivered
candidate** — the delivered shape is the sound one, and the alternatives'
"removals" (the fold, the same-object convention) are load-bearing (CG.1, CG.3).

- Removed by the delivered candidate and kept removed: Codex
  `unboundObservedTurnIds` / `releaseOrphanTurnsIfIdle`; Claude's answered-only
  completion conditional; the duplicated fact mapping.
- Withdrawn removals (were in my G5): the same-object provider obligation (#1)
  and the fold's role in member reporting (#2) — both reinstated as load-bearing.
- Cosmetic-only: the `messagingOwner` naming note (CG.4) — documentation, not a
  removal.
- Optional (CG.7): `EntityTurn`'s per-turn delivery fields, **iff** the single
  Core report owner genuinely removes them and preserves the listed contracts.

## CG.9 Strongest surviving counterexample and genuine blockers

**Strongest surviving counterexample:** the same-object convention is enforced
only by tests and README text. A provider that constructs a second
`RuntimeCompletion` for one terminal (or publishes after an `await`) silently
double-delivers the normal bound case or reorders reports, and still loads and
looks healthy. This is unavoidable without MiMo's authoritative single channel,
and MiMo's channel is not specifiable without new bookkeeping (CG.2). Mitigation
is verification (per-adapter reference identity; delivered-order on multi-line
Claude batches and mixed Codex queue heads; the interrupted-bound settlement
test) plus honest README text — not a new mechanism.

**Genuine blockers:** none of the required-question items is a product blocker.
The two facts the input says are source-resolvable are resolved: the Codex
interruption shape (CG.1) and the fence (CG.4). What remains is (a) a
non-blocking internal choice — whether to adopt the single Core report owner
(CG.7) — and (b) verification obligations, not design forks. Real Codex unbound
frequency and live delivered-order remain unverified facts to record, not to
design on.

## Operator-delegated optimal architecture selection — independent proposal (2026-10-14)

Independent first pass from requirement revision 3 and current source only; no
other new seat section and no TeamLeader recommendation was read.

### Chosen architecture

**One provider-owned authoritative native-outcome stream, provider-resolved
per-input result values, and one Core reporting owner per producing agent.**

Concretely: keep `submit → RuntimeAdmission{RuntimeSubmission.settled}`, keep
`RuntimeCompletion` as the identity of one native result, keep the create-context
`results` sink as the single native terminal stream, and move the *reporting
decision* (eligibility, recipient selection, token passthrough) into
`AgentService` alone, deleting `EntityTurn`'s delivery state machine.

### Minimum model (from the product, not the code)

The product needs exactly three facts/actions:

1. **P1 — authoritative native result C.** Producer: the provider (only it sees
   native terminals). Consumer: the member's owner report.
2. **P2 — which accepted inputs C answered.** Producer: the provider (only it
   folds inputs into native turns). Consumer: scripts/Workflow values and the
   public receipt.
3. **P3 — a report's recipient** and **P4 — eligibility (scope fence) at
   delivery start.** Producer: Core.

Delivery is one derived action: deliver C to one recipient once, folded on C,
FIFO per recipient.

### Candidate comparison

**Candidate 2 — single outcome stream + Core-owned per-input Promises.** This
only works if Core can correlate an input to the outcome that answered it. The
neutral input is text-only (`AgentRuntimeSubmissionInput`,
`agent-runtime.ts:229`) with no input identity by design (lines 219–231). To
correlate, Core would add an input id to the ABI plus a Core-side per-input
registry resolving when "the right" outcome arrives — a new field, a new entity,
a new ordering rule. If instead the provider resolves the per-input Promise,
candidate 2 has *become* candidate 1 minus the `results` sink. That sink cannot
be dropped: requirement revision 3 mandates reporting an observed result that
answered **no** submission (lines 21–22, 59–70, story 3). So candidate 2 either
collapses into candidate 1 or grows the attributed-correspondence machinery the
requirement explicitly does not ask for (rev3 §"Technical design"; Core need not
enumerate native-turn input membership).

**Candidate 1 — chosen.** The `results` sink already *is* the single native
outcome stream; `settled` already *is* the per-input result value; folding on the
shared `RuntimeCompletion` object already unifies them. New concepts: zero. The
alternative's concepts: an input id, a registry, an answered-id list.

### Core ownership move (the actual reduction)

Today two objects run the *same* delivery call:
`AgentService.observeRuntimeResult` (`service.ts:407–416`) and
`EntityTurn.startDeliveryIfReady`/`ensureDelivery`/`selectedCompletion`/
`recipient`/`deliveryTask` (`turn.ts:75–165`). Both funnel into
`CompletionDeliveryPolicy.deliverRuntime` (`completion-router/index.ts:121`) —
two triggers, two in-flight trackers (`nativeReports`, `service.ts:103`, and the
per-turn `deliveryTask`), one fold.

Collapse to **one reporting owner** (`AgentService`): on `results(C)` use the
construction-bound `nativeResultRecipient`; on a settlement use the
per-submission recipient captured at admission (`service.ts:323`); pass C
unchanged. Removed: `EntityTurn.selectedCompletion`, `deliveryTask`,
`startDeliveryIfReady`, `ensureDelivery`, the injected `{owesCompletion}` owner,
and one of two trackers. Kept: `RuntimeSubmission.settled`, `Turn.id`/`settled`
value, the fail-loud unsettled proof (`convergeRetainedTurns`,
`service.ts:379–391`) and retained-turn eviction (`service.ts:431–436`), both
relocated to the single owner. The per-submission recipient binding and the two
eligibility read-times (native at publication `service.ts:409`; submission at
settlement `turn.ts:150`) remain product facts and stay.

### Failure-case mapping

- **N inputs → one result; queued inputs → distinct results.** The provider
  folds inputs into native turns; one terminal → one C → one `results(C)`. Two
  queued turns → two distinct C objects even with equal text → two reports.
- **Unbound result / ordering.** A terminal with no host submission still calls
  `results(C)` with the construction recipient; bound and unbound share the
  per-recipient FIFO tail.
- **Native result before admission.** At that instant only P1 (C) and the
  construction recipient exist; `results(C)` registers the fold entry. If
  admission later resolves `submitted`, its settlement passes the same C → folds,
  no duplicate; if `skipped`/`failed`/`ambiguous`, no record is created and the
  already-sent report is neither fabricated nor retracted; if close won the race,
  `owesCompletion()` is false → dropped.
- **Managed leader; Q5.** No `nativeResultRecipient` → no autonomous report.
  Explicit `team.create`/`send` replies carry a per-submission recipient; several
  answered by one C fold to one reply.
- **Scripts/Workflow.** `Turn.settled` and `turn_id` unchanged;
  Workflow-controlled members get no recipient.
- **Codex interruption / Claude stopped / transport failure.** An interrupted
  settlement `{kind:'completion', completion:partial}` delivers once from the
  settlement reaction (token never observed); `stopped` and `{kind:'failed'}`
  deliver tokenless; no native turn is fabricated.
- **Stop/close.** Fence new work, settle accepted inputs, fail loud if a runtime
  did not converge, wait started delivery — all at the single owner.

### Interface sketch, classification, version pairing

Public ABI unchanged from the delivered `agent-runtime.ts` except `results` may be
**optional**, with mandatory publication when supplied. Adoption class:
**adaptation** (Core ownership move; no persisted migration; no public receipt
change). Pairing: new host + old provider → unbound coverage absent, bound
reports intact; new provider + old host → optional sink means old submission
behavior, not a throw. Document both; no negotiation, no fallback queue.

### Strongest counterexample

The fold requires the provider to reuse the *same* `RuntimeCompletion` instance
across observation and every answered settlement. A provider that clones C per
settlement double-delivers the normal bound case while looking healthy. This is
the one real obligation; the alternative pays for it with input-id
correspondence plus a Core registry and emission ordering — strictly more
concepts.

**Decisive tradeoff:** keeping completion-object identity as the fold key makes
the provider, not Core, responsible for reference discipline; that single
obligation buys the removal of a Core input-correlation registry. The chosen
design wins on entropy, not on the smallest diff: its only cross-package duty is
the existing one (reuse the result object), and it adds no new noun to Core.

## Cross-review — operator-delegated architecture selection (2026-10-14)

Read all three new sections plus the owning source (§anchors). Compared
candidate 2 fairly as a complete replacement, not as "an event bolted on."

**Accepted (candidate 2 / MiMo).** `InputId` may legitimately *replace* the
public receipt identity, and `OutstandingInput` may *replace* `retainedTurns`
(`turn.ts:70–107`, `requests.ts:119–122`); I do not double-count these. Its
`answered: InputId[]` needs no Core turn-ID ledger, and recipient-set folding
within one event is a real mechanism. Once-per-terminal production is a provider
obligation under both designs.

**Rejected.** (1) MiMo's `turnOutcomes{status:'interrupted'}` cannot determine
the selected per-input outcome: `completionFromTerminal`
(`codex/src/turn-manager.ts:419–434`) applies schema restoration to an
interrupted `CollectedTurn` and returns `{status:'failed'}` on codec error, while
a non-error path yields `completed` with possibly null text. The event must carry
the *pre-selected* `RuntimeCompletion`, not re-derive it from cause or text — so
its ABI carries candidate 1's frozen completion object *plus* an id system
(2) MiMo's ambiguous retirement is unsound: Claude `failWrite`
(`rpc.ts:127–135`) deletes the request and returns `ambiguous`; `close`
(`rpc.ts:169–173`) returns `ambiguous` per unconfirmed request while settling a
private Promise Core never holds. "Hold until an outcome or `inputFailed`" either
strands records forever (violates challenge 5) or makes `inputFailed` fire on an
ambiguous admission — which challenge 5 forbids. Candidate 1 needs no rule:
an ambiguous admission yields no submission, so nothing is retained.
(3) MiMo claims eligibility "uniformly at event publication", but tokenless
failed/stopped input-only notices have *no* event; no single instant is supplied,
violating challenge 6's "no total order unless supplied." Trae-seed keeps two
named instants (terminal for subscriptions, settlement for one-shot) — correct.

**Net deletions/additions.** Candidate 1 (mine / trae-seed): removes
`EntityTurn` delivery state and one in-flight tracker (`service.ts:103`,
`turn.ts:75–165`); the `results` sink already exists; adds no Core noun.
Candidate 2: removes the `WeakMap` fold, same-object discipline, `EntityTurn`
delivery, and adapters' submission plumbing — but adds an `inputId` field, a
two-fact stream, the `OutstandingInput` map, per-adapter id↔native-uuid maps
(Claude must translate `InputId` to its `commandUuid` registry), and
retirement/ordering rules. The correspondence it moves across the seam is what
`settled` already resolves.

**Corrected sketch.** Keep trae-seed's: `results` optional-but-mandatory-when-
supplied, `settled`/`turn_id` unchanged, one `AgentService` reporting owner,
folding on the shared completion object. This is candidate 1 with the ownership
move — it is candidate 2 minus the id system, and it satisfies every mandatory
case.

**Strongest surviving counterexample.** A conforming provider that clones the
completion silently double-delivers (candidate 1). Candidate 2 converts the same
provider defect into a *dropped* `team.send`/script reply — strictly worse, and
catchable only per adapter.

**Recommendation: candidate 1 with the single Core reporting owner.** Decisive
reason: the result identity and its per-input answer already exist; candidate 2
re-expresses them as an id set and still must ship the completion object.
