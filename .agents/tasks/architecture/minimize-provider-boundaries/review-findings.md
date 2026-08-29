# Independent Architecture Review Findings

## Review status

Three independent read-only reviews examined the current requirement, the
repository source, and the relevant decision history. All three concluded that
the direction is sound but that the requirement is not yet ready for a final
technical solution. This file records the TeamLeader's adjudicated synthesis;
reviewer vote count is not an architectural decision.

## Accepted blocking findings

### Active-session progress inspection

The review correctly found that the earlier `readTurns` text could not derive
canonical failed and stopped outcomes from provider-native history. Operator
clarification resolved the product mismatch more fundamentally: `last` is not a
Core-status or completed-turn-history capability. It lets a TeamLeader inspect
recent TeamMate activity while the only active turn may run for tens of minutes
or longer.

The current implementations intentionally discard an open transcript tail until
completion evidence appears, so they fail this user story. The target is a
mandatory neutral, record-oriented activity reader that returns stable records
already written by the active turn. Each Provider projects native history into
unified Dreamux Activity Records; raw Provider lines are not exposed. It does not
synthesize Core settlement outcomes, and Core does not create a Turn archive for
it. The exact method name, Activity Record schema, and visibility policy remain
solution inputs.

### Dissolve and scheduler behavior after removing provider idle

Deleting `waitIdle` is confirmed. It nevertheless removes two distinct existing
behaviors:

- Team dissolve currently waits for captured writers to become idle before
  logical close and worktree cleanup. The runtime stop fence converges admissions
  that started before the fence, but does not promise that active model work
  finishes naturally.
- Scheduler currently defers a held fire while the target runtime is busy. Direct
  normal submission may queue, fold into an active turn, or otherwise change the
  current missed-fire behavior depending on the runtime admission contract.

The operator resolved both behaviors. Dissolve immediately stops active work
and never waits for natural turn completion. Dispatcher-triggered dissolve checks
worktree cleanliness before dismantling the Team; TeamLeader self-dissolve stops
Workflow and TeamMates before its check, then stops the leader without waiting for
the caller turn. Non-forced dirty/unmerged managed worktrees block cleanup, while
an explicit `force` authorizes discarding local changes in that owned worktree.
The invocation returns immediately after Core validates the caller and submits
the Team-owned background dissolve; it does not await assessment, child-process
exit, logical close, or physical worktree deletion. Both Dispatcher and
TeamLeader MCP callers use the same submission boundary after their lease-bound
target authorization, so self-dissolve can answer before its own runtime is
stopped. The background operation still owns stop, durable close, and observable
cleanup state. Scheduler submits each due fire immediately through normal
admission with no busy check or held-fire delay; Provider-native folding into the
active turn is accepted behavior.

### Collaboration Space provisioning and external routing

Moving external-route authority to Channel is confirmed. Current Collaboration
Space behavior also relies on durable claim/generation state, ready-before-first-
delivery behavior, exact route ownership, and crash recovery across Team and
binding operations. Generic Commands alone do not specify who owns that durable
provisioning state or how retries remain idempotent.

The operator resolved this by deleting Core Collaboration Space entirely. Team
is the only Core container. A Channel that offers automatic external-target
provisioning owns the durable saga, target generation, binding, crash recovery,
and ready-before-first-delivery sequence; it composes ordinary idempotent
`team.create`, turn submission, and optional `team.dissolve` Commands. Core
receives a generic Team-create request id for idempotency but never parses or
persists the Channel target.

### Turn correlation and Channel presentation

Removing Core-owned binding and `ChannelOrigin.binding` must not remove the
ability to associate submitted, activity, and settled facts with the exact
Channel-originated turn. Feishu COT and other presentation adapters need an
opaque correlation value that Core carries but does not interpret. Otherwise a
Team bound to multiple external conversations cannot place activity reliably.

### Structured-output binding time

Making structured output mandatory removes feature negotiation; it does not
remove the temporal contract. Current runtimes differ between schema binding at
runtime creation and schema binding per submission. The neutral contract must
choose a portable binding time and define whether later submissions may use a
different schema.

### Push-only runtime state and start outcome

The push-only direction is confirmed, but the state sink needs a runtime
generation or lease, ordered updates, revocation, start completion fencing, and
defined sink-failure behavior so an old runtime cannot overwrite a replacement.
`start` also needs a neutral fresh-versus-resumed result before the first
submission is admitted so Dispatcher restart notification remains correct.

### Submission and settlement invariants

The new `submit` union must preserve the existing provider-neutral invariants:

- channel-rendered and Core-owned text variants remain distinct;
- source identity and deduplication namespaces remain stable;
- `failed` proves pre-admission while an unknown boundary outcome is
  `ambiguous` and is never automatically retried;
- stop fences new input synchronously and converges admissions already begun;
- immutable completion identity, fold-versus-queue behavior, exactly-once
  settlement, and per-recipient FIFO delivery remain unchanged;
- transcript-derived activity output is never the live settlement source.

### Protocol, persistence, and shutdown contracts

The final solution must specify the versioned Command and event envelopes,
validation and typed errors, idempotency, payload bounds, event failure/time
isolation, slow-consumer behavior, and shutdown revocation. Channel-owned binding
state also needs a single-writer/concurrency model and an explicit fail-loud
cutover from the current Core-owned persisted state. The confirmed no-
compatibility policy removes adapters; it does not remove the need for precise
upgrade errors and operator recovery instructions.

## Confirmed consequences, not reopened decisions

- Provider `waitIdle` remains deleted; no provider-native or Core-derived idle
  capability is reintroduced.
- Team dissolve immediately terminates active work. An explicit `force` may
  discard local changes only in the Team-owned managed worktree; it does not
  authorize deleting committed history or a reused/source workspace.
- Scheduler fires immediately through ordinary submission and may fold into an
  active turn. It no longer provides busy-only deferral, a one-hour idle wait, or
  an independent queued-turn guarantee.
- Runtime recovery and structured output remain mandatory.
- Activity reporting remains optional; absent activity suppresses live COT
  detail without affecting execution or settlement.
- Channel is trusted only for its deliberately minimal Command catalog;
  internal Agent/MCP and host-maintenance capabilities remain outside it.
- Core binding ownership and binding-scoped TeamLeader egress authorization
  remain removed.
- The public rewrite remains intentionally incompatible, with no adapter or old
  tool alias.
- Zero-consumer live-runtime `getContext`, handle-level `getCapabilities`, and
  duplicate pull surfaces remain deleted.

## Rejected or non-blocking reviewer claims

- A hypothetical future diagnostic consumer is not sufficient reason to retain
  live-runtime `getContext`; no current unconditional Core consumer exists.
- The fact that the built-in Channel does not yet implement Channel-owned
  binding tools is implementation scope, not evidence against the target
  ownership.
- Removing the current structured-output capability preflight is intentional.
  The real requirement is a portable schema contract and conformance validation,
  not preserving an unsupported-feature branch.
- Existing third-party Providers failing to load after the incompatible rewrite
  is an accepted compatibility consequence. Clear loader errors, fixtures, and
  change notes remain implementation requirements.
- Exact facade composition, catalog type shapes, runtime epochs, opaque
  correlation representation, and migration mechanics are TeamLeader technical
  solution choices.

## Resolved operator decisions

The second independent review round found three candidate product choices. All
are now resolved:

1. resolved: lifecycle ownership and close behavior for a Channel-provisioned Team;
2. resolved: the minimum visible content and redaction policy for Activity Records;
3. resolved: existing COT activity-event categories and visibility are frozen;
   Workflow/scheduler remain internal MCP-only capabilities and add no Channel
   events.

The first review finding came from an invalid exclusivity assumption. Automatic
provisioning creates a normal Team and a removable default binding. Unbinding or
external-target closure leaves the Team alive; unbound Teams are common and need
no orphan policy. A later message on that unbound target may provision a new
Team. A Team may have multiple bindings, and actual Team dissolve invalidates all
of them. The remaining exact protocol, storage, and type choices belong to the
technical solution.

For the second choice, Activity Records expose assistant messages and tool name
plus lifecycle status. They never expose tool input arguments or output content.
Tool records are present by default but may be omitted as a group by the caller.
Field names, pagination, cursors, truncation, and Provider projection remain
technical solution work.

For the third choice, the operator rejected changing COT. Providers continue to
emit the existing normalized real-time activity, Core continues its current
bounded projection and simple redaction, and Channels continue to consume the
same display-only `turn.message` and `turn.tool_call` facts. Delivery remains
live, best-effort, non-retained, non-replayed, and fail-open, with no retry or
acknowledgement contract. This is deliberately broader than the newly narrowed
`last` record content. Only the product decision about adding Workflow and
scheduler lifecycle events remained at that point.

The operator then corrected a broader false premise in the requirement: a Core
business capability is not automatically a Channel Command. Workflow and
scheduler remain Dreamux-internal Agent/MCP capabilities and expose neither
Channel Commands nor Channel lifecycle events. Channel trust applies only to the
small catalog deliberately exposed to it. The final clarification fixed the
initial catalog to external turn submission plus restart-durable idempotent Team
creation for automatic provisioning. The initial event catalog is limited to the
existing Team, Agent, and turn facts needed for binding invalidation and current
COT. Generic `invoke` and `onMessage` ports remain extensible without speculative
catalog entries.

## Second-round direct corrections

The TeamLeader accepted and wrote the following requirement invariants without
delegating product policy:

- Channel-chosen opaque turn correlation is carried unchanged through submitted,
  activity, and settled events.
- Team-create idempotency survives Core restart and returns the same `team_name`
  for the same accepted request identity.
- `start` reports fresh versus resumed before the first submission is admitted.
- The optional activity sink is a transient real-time projection, while the
  mandatory reader is stable progress inspection; neither is a replay contract
  for the other.
- Automatic-provisioning policy moves to Channel-owned configuration, and the
  removed Core Collaboration Space configuration is an explicit breaking
  configuration change.

The review claim that every sink event must later appear one-for-one in the
reader was rejected. Transient presentation updates and stable progress records
serve different consumers; their neutral vocabulary should align where useful,
but equating their delivery guarantees would recreate an event archive that the
operator explicitly rejected.

## Solution obligations

The TeamLeader will define, without further product delegation, the exact
`start`/`submit`/`stop` contracts, state-sink lease, output-schema binding,
opaque turn correlation, Channel-owned routing serialization, provisioning
saga, Collaboration Space deletion, minimal Command/event catalogs, MCP facade,
Provider composition, external-loader conformance, binding-state cutover, and
verification matrix.

## Third-round freeze audit

The same Codex, Claude, and Trae Seed 2.1 seats independently reviewed the
minimal-catalog revision against current source and decision history. All three
reported the same apparent contradiction; agreement prompted clarification but
does not make the premise correct.

The finding incorrectly modeled Channel as an independently deployed remote
service that can go offline while Core continues mutating state. The operator
clarified that every configured Channel runs in the Dreamux process and shares
its lifecycle. It restores and maintains its own authoritative local state;
remote push synchronization, reconnect reconciliation, snapshots, and replay are
not product concepts. The contradictory startup-Team-read sentence is removed,
and no Team read Command is added. A proven `TEAM_NOT_FOUND` or `TEAM_CLOSED`
submission remains defensive cleanup rather than normal synchronization.

The technical solution must order in-process startup and shutdown so event
consumers are attached before operations are admitted and revoked only after
relevant work is fenced. This is a lifecycle obligation, not a wider public
seam. The following additional implementation obligations do not reopen product
clarification:

- persist a restart-durable `team.create` idempotency ledger, reject one request
  id reused with different canonical input, and bound or garbage-collect it;
- preserve the post-stop worktree cleanliness recheck so only explicit `force`
  can discard changes created after preflight;
- retain start/stop single-flight, synchronous submit fencing, late-start
  termination, state-sink epoch/lease/revocation, and failed-start rollback;
- define active-session Activity Record stability, growing-session cursors, and
  Provider-owned session-to-history location after native locator removal;
- preserve COT projection and redaction while adding bounded asynchronous
  observer isolation, ordering, drop policy, and session revocation;
- define the recoverable partial state after non-forced self-dissolve has stopped
  children but a dirty worktree blocks final close;
- replace the removed Core binding-route fallback anchor with Channel-owned
  binding state without changing COT display;
- publish the required breaking change notes for the narrowed `last` content,
  removed Collaboration Space/config/binding state, and Provider contracts.
