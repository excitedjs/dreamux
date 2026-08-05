# Proposal: scoped Team dissolve and durable worktree cleanup

- **Status:** Proposed; revised after resident-panel review and Alpha live gate
- **Date:** 2026-08-05
- **Affects:** `@excitedjs/dreamux` Team MCP projection, Team lifecycle
  persistence and orchestration, managed-worktree cleanup, admin IPC caller
  scoping, bundled Dispatcher and TeamLeader guidance
- **PR / Issue:** TBD

## Intent

Expose the existing Team MCP `dissolve` verb to a TeamLeader so it can dissolve
only its descriptor-bound current Team. Dispatcher and TeamLeader projections
use the same tool name and one durable Team-close capability; this change adds
no `close` alias and no second cleanup state machine.

A dissolve must never lose responsibility for a managed `delete-on-close`
worktree after the MCP caller receives its accepted receipt or `dreamux serve`
restarts. Automatic cleanup removes only the worktree with non-forced
`git worktree remove`; it never deletes the managed branch or the commits
retained by that branch. Dirty or unmerged work remains fail-closed so the user
can choose how to preserve or discard it.

## Scope

- Keep Dispatcher `dissolve({ team_name, note })` and add TeamLeader-scoped
  `dissolve({ note })`.
- Bind TeamLeader calls to descriptor-provided `team_id` and `leader_name`;
  never accept a model-supplied Team identity.
- Replace process-only accepted-close state with a persisted, recoverable Team
  dissolve lifecycle owned by `TeamCollection`.
- Make every Team work-admission path consult the same lifecycle gate.
- Extract a non-destructive, authoritative managed-worktree cleanup assessment
  from `WorktreeManager` and run it before accepting dissolve.
- Split logical Team closure from physical worktree deletion. Logical closure
  releases routes and agents and can complete while eligible worktree deletion
  continues durably in the background.
- Return the same durable accepted receipt immediately to Dispatcher and
  TeamLeader callers. Neither MCP projection waits for logical close or
  physical worktree cleanup; accepted cleanup remains server-owned background
  work.
- Teach the bundled TeamLeader workflow to inspect and preserve work before
  dissolve and to ask the user when deletion is unsafe or uncertain.

## Product Contract

### MCP projections

Dispatcher Team MCP keeps its current tools and schema, including:

```text
dissolve({ team_name, note })
```

TeamLeader Team MCP returns, in order:

1. `dissolve({ note })`
2. `bind_channel({ channel_id?, meta })`
3. `transfer_back({ channel_id?, meta })`

The TeamLeader schema contains only required, non-blank `note`. It contains no
`team_name`, `team_id`, `leader_name`, worktree path, or provider-specific
selector. Both MCP projections map to the existing `team.dissolve` admin
method; the admin method branches on descriptor-bound `caller_kind` in the same
way as scoped `team.bind_channel`.

### Result timing

Both Dispatcher and TeamLeader `dissolve` return immediately after durable
acceptance:

```json
{
  "accepted": true,
  "team_name": "...",
  "status": "closing"
}
```

For a TeamLeader, the requesting turn then settles naturally before its runtime
is stopped. Neither caller observes post-accept logical closure or worktree
deletion through this MCP response. The prior Dispatcher-only terminal-lifecycle
race, terminal-summary projection, cleanup-pending projection, and extended
`12_000ms` admin timeout are removed. The projection-only cleanup-pending result
DTO, durable-snapshot accessor on the accepted handle, timer helper, and their
tests are deleted rather than retained as unused compatibility surface.

Pre-acceptance validation remains synchronous and authoritative: caller scope,
generation, required runtime capability, and worktree safety must be known
before Dreamux persists acceptance. The Dispatcher keeps a `9_000ms`
method-entry-to-acceptance deadline so this validation finishes inside the
normal `10_000ms` admin timeout. That deadline never waits for logical close or
cleanup and never cancels an operation after acceptance. `DispatcherService`
captures the method-entry time before `admitOperation`; `TeamChannelCoordinator`
derives and forwards the absolute deadline; `TeamCollection` consumes it only
while accepting the operation. Admission queueing must not move the deadline's
origin.

### Worktree safety and user decision

Before a TeamLeader calls `dissolve`, the bundled `team-workflow` instructs it
to inspect the current worktree for:

- uncommitted or untracked changes;
- unmerged index entries.

If work is unsafe or the result is uncertain, the TeamLeader asks the user how
to proceed through the current visible reply path and does not dissolve. With a
provider reply tool it sends the question there; otherwise it returns the
question as its current turn result for delivery to its initiator.

This prompt check is guidance, not authority. Before any persisted dissolve
state, closing fence, scheduler stop, route detach, or agent stop,
`WorktreeManager` performs the same decision through a single non-destructive
cleanup-assessment capability. A managed `delete-on-close` worktree assessed as
dirty or unmerged rejects dissolve with a public-safe `TEAM_DISSOLVE_BLOCKED`
result and leaves the Team and worktree unchanged. Non-managed and
`cleanup: keep` workspaces need no automatic-delete eligibility.

After acceptance closes new admission, `TeamService` waits for Team-wide
workspace quiescence: the TeamLeader and every already-admitted live member
turn that can write the shared worktree must become idle. Core then repeats the
assessment before destructive Team shutdown. If any admitted turn changed the
worktree after acceptance, Dreamux records a recoverable dissolve failure,
releases the gate, restores safe admission, and leaves the Team running rather
than deleting new work.

### Worktree-only deletion at repository scale

`delete-on-close` deletes only the linked worktree. It calls exactly the
non-forced form `git worktree remove <path>` and never calls `--force`,
`git branch -D`, `git update-ref -d`, or any equivalent ref-deletion command.
The managed branch therefore remains a Git ref after worktree removal and
continues to retain its commits. HEAD reachability from a second local or remote
ref is neither required nor relevant to worktree-only cleanup.

`WorktreeManager` must not enumerate refs or walk repository history during
cleanup assessment. In particular, delete-on-close must not invoke
`for-each-ref --contains`, another `for-each-ref` reachability scan, `rev-list`
ancestry traversal, or a per-ref substitute. This keeps acceptance independent
of repository ref count and history depth without increasing the Dispatcher
budget or MCP timeout.

Dirty and unmerged checks remain cheap, bounded safety classification before
acceptance and after Team-wide quiescence. Physical cleanup still uses the
non-forced Git command as the final authority: if Git refuses removal, cleanup
re-reads the worktree state and projects a dirty/unmerged retained result when
applicable; otherwise it records a retryable operational error. `cleanup: keep`
remains terminal-kept. The same assessment capability is used before
acceptance, after quiescence, during physical cleanup, and during restart retry.

Deleting the managed branch is a separate destructive product capability. If
Dreamux ever adds it, that change requires its own explicit design, user-facing
contract, safety proof, tests, and authorization; it must not be inferred from
`delete-on-close`.

## Durable Dissolve Lifecycle

### Persisted fact

`TeamCollection` owns an additive persisted dissolve record on the Team record.
It contains no model prompt or provider data and records at least:

- requester kind and, for self-dissolve, the accepted `leader_name` generation;
- the first accepted non-blank `note` and acceptance timestamp;
- phase: `waiting_for_team_idle`, `closing_resources`,
  `worktree_cleanup_pending`, `complete`, or `failed`;
- last public-safe error, cleanup-attempt count, and next retry time when
  relevant.

Existing Team records normalize a missing dissolve record to no pending work.
The additive durable-format change and public behavior change receive a Rush
change file. The later delete-on-close semantic correction receives a separate
Rush change note that leads with `BREAKING:`, immediately includes `Review:`,
and explicitly states that no rebuild is required. `Team.status` remains
`starting | running | closed`: the dissolve phase is a separate lifecycle fact,
so `closed` means routes and agents are closed even when worktree cleanup is
still pending.

The dissolve record is written atomically before an accepted response. A
same-generation retry while active joins the existing operation and returns the
same receipt; the first note wins. A stale TeamLeader generation cannot join or
replace it. After a failed, fully unwound attempt, a later caller may start a new
attempt with a new note.

### One gate for all Team work

The persisted active phase is projected into the existing process-local Team
lifecycle fence. All mutating or turn-producing Team paths pass through one
availability gate, including:

- Dispatcher `team.send`;
- channel binding publication and all bound/strict inbound delivery;
- settled Team member completion delivery back into the TeamLeader;
- TeamLeader member spawn/send/close and workflow mutation;
- Team scheduler timer fire and public cron mutation;
- Team creation/rebuild paths that could publish the same concrete owner.

Acceptance closes workflow admission and stops the Team scheduler immediately.
Reads remain available. A pre-logical-close failure reopens only admission that
is safe to restore and restarts the scheduler from its persisted jobs. This gate
prevents new turns from extending `waitIdle()` indefinitely after self-dissolve
acceptance.

Member completion delivery currently captures the raw TeamLeader as a generic
`CompletionInitiator`, which would bypass a later Team lifecycle fence. The
Team layer therefore exposes an internal `CompletionInitiator` adapter whose
`completionInput` enters this same availability gate before delegating to the
current leader. Dispatcher producer registration uses that adapter rather than
the raw leader. A closed gate returns the existing terminal `unsupported`
delivery result so the generic `CompletionRouter` drops the completion without
submitting a new runtime turn. Team lifecycle knowledge does not move into the
generic router, and this adds no MCP or public DTO surface.

The current `withTeamRouteClosing` behavior is refactored over the same private
begin/end lifecycle primitives. It must not raise a fence and then re-enter the
old wrapper, and it must not duplicate fence state in MCP, admin, or
`TeamService`.

### Accepted operation

Acceptance returns an idempotent handle backed by the durable record:

1. Resolve and validate the concrete Team and optional TeamLeader generation.
2. Enumerate the TeamLeader and every live member runtime that can write the
   shared worktree. Require `waitIdle` for each live writer. This intentionally
   differs from the neutral contract's general "missing means idle" fallback;
   fail before acceptance rather than risk swallowing the self-dissolve tool
   response or racing an unobservable member writer.
3. Run the authoritative worktree assessment before any lifecycle mutation.
4. Persist acceptance, raise the shared availability fence, close workflow
   admission, and stop the Team scheduler.
5. Return the caller-specific receipt.
6. Start the idempotent lifecycle task through the existing Dispatcher admitted
   operation drain, register its Team-owned shutdown interruption, and attach
   structured failure logging.

The task asks `TeamService`, which owns both leader and member runtimes, to wait
for every writer captured at acceptance to become idle. New writer turns cannot
start because the shared gate is already closed. Only after Team-wide
quiescence does `WorktreeManager` repeat its authoritative assessment. On
restart there is no live accepted turn to preserve, but recovered live writers
must still be quiesced before revalidation and shutdown; recovery never assumes
that leader-only idle proves a shared worktree is stable.

The accepted handle contains only its opaque `operationId`, the caller-specific
receipt, and `logicalClosed`. The milestone resolves only after routes and
runtimes are closed, Team `status: "closed"` is durable, and any worktree-cleanup
responsibility is durable; it rejects if the operation unwinds while the Team
remains running. Team identity stays authoritative on the controller-owned
operation keyed by `operationId`; the handle carries no duplicate `teamId`.

Both MCP projections return only the receipt. Collaboration target close joins
`logicalClosed`; terminal cleanup and recovery are observed from persisted Team
read surfaces and structured lifecycle logs. Durable acceptance alone is never
interpreted as logical closure by internal consumers.

### Shutdown interruption

An admitted lifecycle task must not make Dispatcher shutdown wait forever for
a runtime that Dispatcher stops only after draining admitted work. Before
`DispatcherService.doStop()` drains admitted tasks, it signals every active Team
dissolve runner to interrupt cancellable waits such as
`waiting_for_team_idle`. The runner races runtime `waitIdle()` promises against
this internal shutdown signal; the signal does not claim that a runtime became
idle and does not cancel or weaken a normal close.

Shutdown interruption is recoverable suspension, not dissolve failure:

- keep the durable phase, first note, cleanup responsibility, and availability
  gate intact;
- do not reopen Team admission or restart its scheduler in the stopping process;
- settle the process-local `logicalClosed` milestone with a typed recoverable
  interruption so a collaboration target join leaves its record in `closing`
  rather than marking it `closed`;
- let the admitted lifecycle task return so the existing drain can complete,
  then continue the normal runtime-stop order;
- on the next Dispatcher start, restore the gate and resume the persisted phase
  before Team work or target recovery is published.

An already-running, non-cancellable physical worktree deletion attempt remains
drained to its authoritative result; only idle waits and retry timers are
interrupted. The lifecycle owner consumes or observes every losing promise in a
shutdown race so detached `waitIdle()` completion cannot become an unhandled
rejection.

### Logical close and route ownership

After any required idle wait, the shared dispatcher-side route reconciler:

1. detaches collaboration target intent;
2. transfers every channel binding owned by the accepted Team generation;
3. closes workflow resources, members, the TeamLeader, and scheduler storage;
4. persists Team `status: "closed"`, `closed_at`, the first note, and
   `worktree_cleanup_pending` before physical delete begins.

The route reconciler consumes the already-held closing owner; it does not
re-enter a second closing wrapper. `TeamService` remains the owner of its
runtime/member shutdown and shared-worktree identity propagation. Its current
monolithic dissolve is split so logical closure can commit before physical
cleanup without reproducing route or agent teardown elsewhere.

### Collaboration target join and lock handoff

Closing a collaboration target is an internal logical-close consumer, not a
bounded MCP caller. Its lifecycle may persist the target as `closing` and
accept the owning Team dissolve, but it must await the accepted handle's
`logicalClosed` milestone before persisting the target as `closed`. A rejected
or failed pre-logical Team dissolve leaves the target in `closing` with a safe
error so the existing target recovery path can retry it; target `closed` never
means merely "Team dissolve accepted."

The target route lock is not held across Team-wide quiescence or background
work. Target close is refactored as a two-phase handoff:

1. under the target lock, re-read the exact target generation, persist
   `closing`, and accept the Team dissolve with an internal handoff identifying
   that exact closing target generation;
2. release that lock before route reconciliation waits for quiescence; during
   the later owner sweep, reacquire the target lock briefly and exclude this one
   target only if it still matches the handoff and is still `closing`, while
   closing every other route normally;
3. await `logicalClosed` outside the target lock;
4. reacquire the target lock, re-read the same target generation, and persist
   `closed` only if it is still the matching `closing` record, releasing any
   remaining claimed target route as part of that transition.

The deferred path must not pass a stale `lockedTarget` value that falsely
asserts lock ownership after releasing the lock. The handoff is an explicit,
generation-checked close claim, not a lock exemption; if validation fails, Team
close does not skip the target. This prevents both an early target `closed`
record and a target-lock/Team-close deadlock without duplicating the Team
dissolve state machine.

### Durable worktree cleanup

`AgentEntityWorktreeCleanupState` gains `cleanup-pending`. At logical close the
Team, leader, and every member record receive that shared state before deletion
starts. The Team-owned cleanup operation then calls `WorktreeManager.cleanup`
once for the shared worktree and propagates its one authoritative result to all
borrowers, preserving the existing single-owner invariant.

- `deleted`, `kept`, and `not-managed` are terminal.
- Dirty or unmerged outcomes are safety-blocked and are never force-deleted.
  They should normally be caught before acceptance; a later external filesystem
  change records a visible blocked failure.
- Operational deletion errors remain pending, persist the error and next retry
  time, and retry with bounded exponential backoff and no fixed attempt limit.

The persisted readers continue to accept the previously emitted
`retained-unique-commits` cleanup state and `worktree-unique-commits` dissolve
error so Alpha-created records remain readable. Those values no longer express
a current deletion blocker. During startup recovery, `TeamCollection` recognizes
only the exact closed-Team terminal tuple `cleanup: delete-on-close`,
`cleanup_state: retained-unique-commits`, dissolve `phase: failed`, and
`last_error: worktree-unique-commits`. Under the Team lifecycle serializer and
store CAS it preserves the operation identity, requester, first note,
acceptance time, and handoffs while atomically reopening the record as
`worktree_cleanup_pending`, clearing the obsolete public error and retry time,
and setting the shared cleanup state to `cleanup-pending`. Normal recovery then
reassesses dirty/unmerged state and attempts the same non-forced worktree
removal. Other failed records remain terminal. This compatibility belongs to
the persisted Team lifecycle owner, not `WorktreeManager`. It reopens only the
cleanup phase: `Team.status` stays `closed`, the closing gate stays active, and
no Team work resumes.

In-flight attempts are tracked by the Dispatcher operation drain. Retry timers
are owner-managed rather than sleeping inside the drain: shutdown cancels
timers, interrupts active idle waits before the drain, drains any active
physical cleanup attempt, and leaves the durable pending fact. On every
Dispatcher start, pending Team dissolves and worktree cleanups are reconciled
before collaboration target recovery, channel inbound publication, or Team
scheduler start. A restart therefore resumes responsibility instead of reviving
Team work or forgetting deletion.

Dreamux guarantees durable retry responsibility for a worktree that was eligible
for automatic deletion. It cannot guarantee forced physical deletion against
permanent filesystem/Git failures or later dirty/unmerged work; those conditions
remain observable and never bypass data-safety retention. Worktree deletion does
not delete the managed branch.

## Errors and Observability

- Missing/blank `note`, malformed scope, or TeamLeader-supplied Team identity:
  `BAD_REQUEST`.
- Missing/closed/stale TeamLeader scope: `TEAM_NOT_FOUND`.
- Unsafe automatic deletion before acceptance: `TEAM_DISSOLVE_BLOCKED` with a
  safe reason enum; no Team or route state changes.
- Missing `waitIdle` on any live shared-worktree writer:
  `TEAM_DISSOLVE_FAILED` before acceptance.
- Active same-generation retry: the existing accepted receipt.
- Background failures: structured logs with dispatcher, Team, phase, attempt,
  and safe error; no unhandled rejection.
- Dispatcher shutdown interruption is an internal recoverable outcome, not a
  public failure and not a transition to dissolve phase `failed`.

Team status/history expose the dissolve phase, accepted timestamp, cleanup
state, and safe last error without exposing machine-local paths. Existing
`close_note` remains the final first accepted note once logical closure commits.

## Acceptance

- Dispatcher tool names and `dissolve({ team_name, note })` schema are unchanged;
  no `close` alias exists.
- TeamLeader Team MCP lists exactly `dissolve`, `bind_channel`, and
  `transfer_back`; its `dissolve` schema requires only `note`.
- TeamLeader mapping and raw admin handling cannot override descriptor-bound
  `team_id` or `leader_name` with `team_name`.
- Self-dissolve persists acceptance before returning `status: "closing"`, lets
  the active tool response complete, waits for Team-wide natural quiescence,
  then shuts down.
- Missing `waitIdle` on any live shared-worktree writer and unsafe worktree
  assessment fail before any Team mutation.
- Skill guidance asks the user before unsafe deletion, while core independently
  enforces the same authoritative assessment.
- After acceptance, every new Team turn/mutation/scheduler/route path fails
  closed, including member completion injection into the leader; reads remain
  available.
- Same-generation retries join one task and preserve the first note; stale
  generations fail.
- Dispatcher and TeamLeader dissolve both return the durable accepted receipt
  without awaiting `logicalClosed`. Dispatcher pre-acceptance
  validation remains bounded by a `9_000ms` method-entry deadline under the
  normal `10_000ms` admin timeout; tests prove no post-accept timer or extended
  MCP timeout remains. A Dispatcher facade test blocks admission and proves the
  deadline still starts at public method entry. A real
  `runTeamMcp -> tools/call -> sendAdminRequest` boundary test proves Dispatcher
  dissolve, TeamLeader dissolve, and an ordinary Team method all use the default
  `10_000ms` timeout without exposing a production helper or test-only export.
- Logical close persists before worktree deletion. A clean eligible managed
  worktree with a transient deletion error is retried in background and after
  restart until deleted or a safety blocker is observed.
- Dirty and unmerged worktrees are never force-deleted; preflight rejection
  leaves Team, routes, agents, scheduler, and worktree unchanged.
- A seeded restart test proves that the exact persisted closed-Team
  `retained-unique-commits` / `worktree-unique-commits` terminal tuple is
  atomically reopened as cleanup-pending and reaches deletion through the normal
  recovery runner, while unrelated failed records remain terminal and readable.
- A deterministic large-ref regression test structurally proves delete-on-close
  never invokes `for-each-ref --contains`, any other ref enumeration, or an
  ancestry/history walk. A managed-branch-only commit does not block worktree
  removal; the test proves the non-forced remove deletes only the worktree and
  leaves the managed branch pointing at the same commit. The assertions do not
  depend on repository size or wall-clock slowness.
- An MCP/admin acceptance-boundary test drives the real `tools/call` projection:
  the clean worktree-only path persists acceptance before returning success
  with `structuredContent`; a genuine pre-acceptance assessment failure returns
  `TEAM_DISSOLVE_FAILED` without `structuredContent` or a persisted dissolve
  record.
- The live Alpha fixture is re-read before validation to prove it is still
  running, clean, and unmerged-free. No ref-reachability precondition is needed.
  The fixed installed artifact must make Dispatcher `team.dissolve` immediately
  return the accepted `status: "closing"` receipt with `structuredContent`.
  Independent Team status/history and Git read-only checks then prove the
  background operation reached its terminal phase and removed both the managed
  directory and its Git worktree registration without direct state or worktree
  mutation.
- Restart restores active Team gates and resumes pending phases before inbound,
  collaboration provisioning, workflows, or Team schedulers can revive work.
- Dispatcher shutdown interrupts `waiting_for_team_idle` before admitted-task
  drain without reopening admission; drain completes, runtimes stop, and the
  next start resumes the durable phase.
- Collaboration target close awaits Team logical closure outside its target
  lock, leaves failures in recoverable `closing`, and cannot persist target
  `closed` from an accepted-only receipt.
- Existing target-close, route-detach, completion-delivery, Team-wide idle,
  worktree single-owner, and cleanup-state propagation contracts stay covered
  rather than being weakened.
- Model-facing gates are updated together: current architecture, dispatcher
  orchestration and skill references, service topology,
  `packages/dreamux/src/service/CLAUDE.md`, agent-activity decision, bundled
  `team-workflow`, the owning
  `dreamux-maintenance/references/service-lifecycle.md`, Team MCP
  schema/whitelist tests, skill tests, contract parity, admin scope tests, and
  real worktree integration tests. Current-state guidance says delete-on-close
  removes only the worktree and preserves its branch; transition detail is kept
  in the generated Rush change note rather than the maintenance reference.
- Focused tests, full Rush build/test, `.agents/scripts/check.sh`, and CI pass.

## Out of Scope

- Letting a TeamLeader select, inspect, or dissolve another Team.
- Adding a duplicate `close` alias or renaming dispatcher `team.dissolve`.
- Force-deleting dirty, unmerged, or `cleanup: keep` worktrees.
- Deleting the managed branch or any other Git ref as part of worktree cleanup.
- Deleting external channel containers or sending an automatic provider message.
- Reopening a logically closed Team or reusing a concrete Team name.
- Adding runtime-specific or channel-specific branches to Dreamux core.
