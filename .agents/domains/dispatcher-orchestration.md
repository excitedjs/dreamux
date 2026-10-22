# Dispatcher Orchestration

What: the current shape of Dreamux's core orchestration — the dispatcher-local
aggregate, Teams and TeamMates, dissolve, completion delivery, MCP projections,
and generated workspaces. Read this before changing `service/`, Team/TeamMate
MCP tools, completion delivery, or the workspace contract.

The model-facing tool rosters that project this model to a Dispatcher and to a
TeamLeader live in [dispatcher-skill.md](dispatcher-skill.md); this page owns
the mechanism behind them, not the tool lists.

## Ownership

### Service Graph

`dreamux serve` is the process-level composition root. It builds a `Dispatchers`
collection; `server.ts` stays wiring-only and all per-dispatcher orchestration
lives under `/packages/dreamux/src/service/`.

Each `DispatcherService` is one dispatcher-local aggregate and owns:

- the dispatcher's contained agent (an `AgentService` built from the
  dispatcher root `identity.json`, structurally outside the `teammate/`
  collection so read chokepoints never enumerate it);
- a dispatcher-local `ChannelService`;
- the dispatcher-scope `TeammateCollection`;
- the per-dispatcher `TeamCollection`;
- one stateless `CompletionDeliveryPolicy`;
- one `WorktreeManager`;
- the dispatcher-root Agent's own identity, built and read through the
  dispatcher's `AgentServiceFactory` (`create`/`open`/`upsert`) rather than a
  store any parent holds (R63: an Agent is a directory to its parents).
  `Dispatchers` (`service/dispatchers/index.ts`) holds no cached identity
  store of its own either: its `summarize()`/`status()` fallback reads call
  the stateless `readAgentIdentity()` fresh, on every call. Every other
  identity — dispatcher TeamMates, TeamLeaders, and Team members — is read or
  written the same way, through the owning entity's own factory call or a
  fresh stateless read, never through an instance any parent constructs or
  caches (see Store Construction Patterns in
  [service-topology](service-topology.md#store-construction-patterns));
- the dispatcher scheduler.

Source:

- `/packages/dreamux/src/server.ts`
- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/agent/`
- `/packages/dreamux/src/service/dispatchers/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

### Collections And Entities

The service layer is symmetric on purpose, and the two halves own different
things:

| Collection | Entity | Split |
|---|---|---|
| `Dispatchers` | `DispatcherService` | aggregate factory/cache vs. one dispatcher's object graph |
| `TeamCollection` | `TeamService` | Team store, worktrees, create/list/history vs. one Team's record and lifecycle |
| `TeammateCollection` | `AgentService` | scoped construction/cache/reads vs. entity-owned lifecycle |

A **Collection** owns its store, its factory, lookup and list, the instances
this process holds, materialization dedup, and exact-instance eviction. It does
not own an entity's lifecycle: it never enters close for cache bookkeeping and
owns no bulk runtime or membership shutdown verb, apart from the Team-scoped
bulk member close a dissolve needs.

A **Service** owns exactly one entity: its record or identity, its operations,
its runtime-backed work, and its close. `AgentService` is the sole command
owner for every dispatcher agent, TeamMate, TeamLeader, and Team member — it
owns mutation admission, its process-local Workflow lock, raw runtime authority,
in-process `Turn` objects, terminal outcome and delivery convergence, close
single-flight, and the committed retirement fact.

The dispatcher *has* an agent; it is not itself an Agent Runtime. Each
`TeamService` directly builds and holds its TeamLeader `AgentService` through
`team/leader.ts`, using the `AgentServiceFactory` (R63: no identity store of
its own), worktree manager, and completion-delivery policy its owning
`TeamCollection` injects. The per-Team
`TeammateCollection` is members-only: the TeamLeader lives at the Team root and
is never cached in the collection's entity map. The Team assembles its leader's
tools from its own members, Workflows, scheduler, status, and dissolve
operations. Channel tools receive the actual ChannelService and fences through neutral structural
views. There is no leader-scope handle or lookup back through TeamCollection.

One service class belongs in one file or directory; a class with helpers gets a
directory whose `index.ts` is the class and whose siblings are its helpers.

Source:

- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team/index.ts`
- `/packages/dreamux/src/service/team/service.ts`
- `/packages/dreamux/src/service/team/leader.ts`
- `/packages/dreamux/src/service/agent/service.ts`
- `/packages/dreamux/src/service/agent/runtime-generation.ts`

## Contracts

### Dispatcher Trust Domain

One dispatcher is one shared-context trust domain. All accepted turns submitted
to that dispatcher agent share the same runtime conversation unless a lower
layer explicitly routes them to a TeamLeader or TeamMate runtime.

Channel-originated turns are not persisted as an inbound queue. A server restart
drops queued or in-flight inbound work; durable recovery is through identity,
provider-native transcripts, and aggregate-owned Workflow/Team records, not
replaying channel events.

Visible channel communication remains provider-owned. Assistant text produced by
the dispatcher runtime is not automatically delivered back to a chat; the agent
must use an exposed channel tool such as the provider `reply` tool when it has
an eligible source message.

Ordinary start leaves the dispatcher runtime dormant. Unbound channel inbound,
dispatcher cron, or an explicit resume notice lazy-starts it.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/base-prompt.ts`
- `/packages/dreamux/src/service/dispatcher-service/lifecycle.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`

### Roles And Visibility

Agent roles are `dispatcher`, `teammate`, `team_leader`, and `team_member`. They
are derived from the owning Service, Collection, and directory — never persisted
on the identity.

Visibility is physical state scope plus one collection read chokepoint:

- dispatcher-scope `teammate.*` sees only dispatcher-owned ordinary TeamMates;
- TeamLeader-scope `teammate.*` sees only that Team's members;
- ordinary TeamMates get no peer lifecycle surface;
- a dispatcher inspects Teams through `team.*`, not `teammate.*`.

TeamLeader entities live at the Team root, beside `record.json`; Team members
live under that Team's `teammate/` collection. The single read-by-name
chokepoint applies the same scope check, so a wrong-scope name resolves as "does
not exist", and `list` and `history` apply that same dispatcher/team role
predicate before projecting any physically discovered identity.

Source:

- `/packages/dreamux/src/service/agent/records.ts`
- `/packages/dreamux/src/service/agent/requests.ts`
- `/packages/dreamux/src/service/team/leader.ts`
- `/packages/dreamux/src/platform/paths.ts`

### TeamMate Model

A TeamMate is a named, resumable agent, not a one-shot task. `spawn` returns a
concrete, never-reused name, and every later `send`, `status`, `last`, and
`close` addresses that name. `send` is also the reattach path: it reopens a
closed TeamMate from the persisted `session_id`, and there is no standalone
`resume` verb.

Read tools do not start or resume runtimes. `last` first checks the identity and
scope, then delegates a bounded cold read to the selected `AgentRuntimeProvider`
for that agent's native session history. While the entity's runtime generation
is running, the provider, config, and session id are the ones that generation
was launched with, because an online `config.agents.replace` does not change
what a running runtime uses (a TeamMate being reopened from a closed record
counts: `last` waits for that build, which settles before any launch, and reads
the entity it produced); with no runtime running they resolve from the current
config, and one that no longer resolves is an error. Dreamux persists no
historical config for this. It materializes no entity, starts no runtime, and
stores no transcript copy, index, or cursor; it returns provider-neutral bounded message/tool
records, an opaque backward cursor, and truncation state.

No surface exposes a native history path. The full `AgentEntityRuntimeStatus`
read retains the opaque `session_id`, workspace, intent, lifecycle state and
errors, and the identity's `created_at` and `updated_at`. These timestamps are
persisted identity facts, not Activity timestamps or a heartbeat; `last` is the
activity observation tool. MCP `spawn`, `send`, `close`, `list`, `history`, and
`last` project only the facts needed by that operation, while Commands keep
their full domain values. Creation still returns the allocated name and any
new workspace facts, submission still returns status/errors, close retains
cleanup outcomes, and history retains its recovery search and pagination.
MCP `status` keeps the full detail. Source:
`/packages/dreamux/src/service/agent/mcp.ts` and
`/packages/dreamux/src/service/agent/records.ts`. Existing per-entity
`turn.jsonl` files are inert residue: Dreamux does not create, stat, list, open,
validate, repair, migrate, warn about, or automatically delete them. The
persisted identity shape itself is owned by
[state-config-and-files.md](state-config-and-files.md).

Every accepted send is retained as one entity-owned `Turn` object over one
provider-owned `RuntimeSubmission`. Providers create an immutable
`RuntimeCompletion` at each real native result boundary and settle the related
submissions with it: folded sends settle with the same completion object, queued
sends settle with distinct completions in provider order, and a stop without an
observed final result settles as `stopped` with no completion at all. The first
terminal outcome is snapshotted into the object-owned latch.

Turn identity is deliberately narrow. TeamMate `spawn`, `send`, and `close`
receipts carry no Turn id; the Team `send` receipt returns a process-local
`turn_id` for a `submitted` admission only (a `duplicate` returns before runtime
admission and has no second turn identity to report), and no Channel event
carries one at all — display is keyed on the Agent, so nothing on that surface
can be mistaken for proof that an output answers an input.
Workflow records, completion routing, and identity state carry none. Dreamux
persists no Turn archive and no rolling conversation projection.

Providers report live assistant and tool activity, and the end of a native turn,
through one synchronous activity sink leased to the runtime generation and keyed
on the Agent — a provider folds any number of submissions into one native turn,
so no activity could honestly name the submission that caused it; native session
history stays cold and is read only on demand. Conversation-bearing entities
may feed that activity into the live,
non-persistent conversation display projection.

The two built-in Activity readers keep native schemas, discovery rules, cursor
envelopes, and typed provider errors inside their own runtime packages. Neutral
scan mechanics — digests, a bounded discovery budget, exact positional reads,
and lexical path containment — are single-sourced in
`/packages/dreamux-utils/src/activity-scan.ts`, which holds mechanism only and
owns no record shape. Core's own `readAgentActivity` still re-validates every
returned page's shape (record count against what was requested, record and
cursor field types) against its record, but a provider's own bounds are the
only bound on the magnitude of what it returns — Core no longer imposes a
byte/char/cursor-length cap of its own on top of them.

Source:

- `/packages/dreamux/src/service/agent/`
- `/packages/dreamux/src/service/agent/identity.ts`
- `/packages/dreamux/src/service/agent/activity.ts`
- `/packages/dreamux-utils/src/activity-scan.ts`
- `/packages/agent-runtime/codex/src/activity/`
- `/packages/agent-runtime/claude-code/src/activity/`

### Team Creation And Naming

`team.create.name_prefix` is a label request, not a durable address. Core
allocates a concrete `team_name` with a 4–8 character random suffix, and the
Team's own `record.json` is the claim: publishing it is a serialized
load-decide-write inside the one `TransactionalStore` the collection holds for
that Team id, and that create is the whole acceptance protocol. Before it the
candidate name is free and a caller that loses the race against that same
in-memory queue chooses another; after it the valid record owns the name,
including after close. Fully retired history returns to disk reads, so later
deletion or damage of that record affects existence and name availability;
active ownership and unfinished cleanup remain memory-authoritative. The
[Team record owner](state-config-and-files.md#team-records) defines retention
and release. There is no separate claim file.

Generated TeamLeader, ordinary TeamMate, and Team-member names use the same 4–8
character suffix contract. Names stay dispatcher-global:
`AgentNameRegistry.allocate()` checks the persisted dispatcher-global
entity directory namespace before selection, a directory name stays occupied
even when its identity is unreadable, identity creation is an atomic no-clobber
write, and a reserved-name guard blocks names that would recreate a removed
layout leaf. Naming adds no transient reservation queue and serializes no
separate creation operations.

`team.create` may include a first `prompt`. Creation itself starts no leader
runtime: the runtime starts inside the first submission that needs it — the
`prompt` when there is one, otherwise the first Team `send` or bound-channel
inbound — so a provider thread is never opened without the turn that makes it
durable (a codex thread started without a turn writes no rollout, and the next
start of that leader cannot resume it; found live 2026-09-03). The Team
fabricates no synthetic default prompt. A `running` Team record means creation
completed, never that a process is alive. Team-owned members share the Team
workspace.

The `team.create` and `team.status` Commands expose the same flat `TeamSummary`;
each Command `team.list` item is the compact `TeamListRow`, a same-named,
same-meaning subset with no leader runtime state and no machine-local path.
`status` is always the Team record lifecycle; creation replay is represented only by the
accepted request identity on input, not by a created/existing output wrapper.
`TeamCollection` selects the projection source once for status and
accepted-request replay: a record read as `closed` answers from that record
(a closed Team is a record, whatever the cache still holds); otherwise a
service already held by the runtime registry contributes its current runtime
status; otherwise the read model uses the Team record plus the aligned leader
identity without materializing anything. `team.list` reads records only.
`member_count` is the occupancy of the Team's `teammate/` directory on every
path, excluding the leader and including closed or unreadable member
identities. The Command DTOs remain open objects.

Team MCP owns a separate compact projection: create returns the allocated Team
and leader names, lifecycle status, selected runtime, source repository, runtime
cwd, and workspace/cleanup modes; send returns submission status and any error;
dissolve returns only `{ status: "submitted" }`. MCP list rows retain
`team_name`, `status`, `intent`, `source_repo`, `leader_state`, `member_count`,
and `worktree_cleanup`. History rows retain `team_name`, `status`, `intent`,
`source_repo`, `updated_at`, `closed_at`, `close_note_preview`, and
`worktree_cleanup`, plus the page's `next_cursor`; matching still searches the
full stored close note. MCP status retains the complete `TeamSummary`, including
leader session/runtime details and full close notes. This changes model-facing
projections without reducing Command/domain detail.

Binding a conversation to a Team is not a Team capability at all: routing is the
Channel's own decision, made with that Channel's tools, so Team MCP has no
`bind_channel` and no `transfer_back`. Peer Team send remains future work;
TeamLeaders use their scoped TeamMate MCP to reach members. The TeamLeader's
Team surface has descriptor-bound `status({})` and `dissolve({ note, force? })`,
with no Team selector. Status invokes the actual Team's existing `status()`
summary owner, including `leader_session_id`; member rows remain on
`teammate.list`. Both tools cross `admitLeaderTools`, which refuses dispatcher
shutdown and a durably closed Team. They grant no global Team list/history
access and introduce no message-history store.

Source:

- `/packages/dreamux/src/service/team/store.ts`
- `/packages/dreamux/src/service/team/create-request.ts`
- `/packages/dreamux/src/service/team/mcp.ts`
- `/packages/dreamux/src/service/team/leader-mcp.ts`
- `/packages/dreamux/src/service/team/service.ts`
- `/packages/dreamux/src/service/agent/store.ts`

### Dissolve

A dissolve belongs to the Team, and it is a submission rather than a persisted
operation. Its domain/Command receipt is
`{ accepted, team_name, status: "submitted" }`; both MCP scopes project only
`{ status: "submitted" }`. The receipt returns as soon as
the Team owns the one background task that will write it closed, destroy every
child service, and reclaim its checkout, and it never reports how that went —
a TeamLeader dissolving its own Team should expect to lose the response,
because its runtime is one of the things being stopped. A second submission
joins the first rather than dismantling the same Team twice. A precheck
refusal (below) leaves the Team untouched and can be asked again; once the
closed record commits, dissolve can no longer fail in a way that undoes
anything (R62): a process that dies before that commit leaves the Team exactly
as `dissolve` found it, and one that dies after it leaves the Team durably
closed with whatever children the destroy pass had not yet reached — inert
residue nothing revisits, since a closed Team is never rebuilt.

The Team holds the fence, and the fence *is* the operation: it goes up the
moment a dissolve is submitted, before the first await, and refuses new work
rather than queueing it — dissolve is a stop-and-reclaim, not a drain. From that
point every caller operation the Team admits is refused (Dispatcher and Channel
send, TeamLeader member and Workflow mutation, Team scheduler mutation and fire,
member-completion injection), and permanently so once the record says closed;
Dispatcher Team-summary reads stay available; the leader's bound status rejects
a durably closed Team. Only a precheck refusal, or a failure to write the closed
record itself, lowers the fence again and leaves the Team open, exactly as it
was — the operation's only two reversible outcomes.

Behind the receipt the order is fixed, uniformly for every caller, including a
TeamLeader dissolving itself (R62, reaffirmed by R67 — there is no longer a
caller-specific early-stop variant). A non-forced dissolve calls the
non-destructive `WorktreeManager.assessCleanup()` first, while nothing has
stopped, so a refusal costs the Team nothing; `force` overrides the refusal,
never the question. Once that precheck passes (or `force` skips it), the Team
writes its record `status: "closed"`, `closed_at`, the close note, and a
worktree fact from one more `assessCleanup()` read — this write is the commit
boundary, and the only step the operation can still take back: a write that
fails clears the fence and leaves the Team exactly as `dissolve` found it.
Nothing after this write may take it back. Only then does the Team destroy
every child service it holds, one after another, trying each and aggregating
failures rather than stopping at the first: Workflows (`stopAll()`, releasing
held members' locks and keeping history), the scheduler's own `destroy()`
(stop, then delete its own cron store file), the member collection's
`destroy()` (closes every held member through the Agent's own close, marks
every never-built member closed at rest), and the leader's `close()`. A
failure destroying any of them is logged, never retried, and never reopens the
Team — there is nothing left to roll back to. Only the worktree reclaim that
follows (`WorktreeManager.cleanup()`, via `settleTeamWorktreeCleanup` in `team/service.ts`) re-assesses
the checkout fresh, after every child has actually stopped, and that read is
what a destructive reclaim acts on; a member that dirties the worktree after
the precheck no longer refuses the dissolve — the Team still closes, and a
non-forced cleanup then only keeps the directory instead of removing it.

Assessment checks only dirty and unmerged state; it enumerates no refs and walks
no repository history. `cleanup: keep` and non-managed workspaces are terminally
retained, as is dirty or unmerged work, which requires an explicit user
decision. A managed worktree requested without `cleanup` is `delete-on-close`
(`worktree/manager.ts`; R31 of the refine-model-facing-surfaces record). Its
TeamLeader's prompt names the workspace and its cleanup mode, nothing more;
what the mode means at dissolve is stated only by the `dissolve` description,
which asks the leader to check a `delete-on-close` worktree before dissolving
(R34). The Dispatcher reads the same two facts from the canonical Team summary
(`worktree_mode`, `worktree_cleanup_mode`; R35), because the lifecycle state
`worktree_cleanup` reads `managed-active` for every open managed worktree and
so cannot say whether a dissolve removes anything. Managed `delete-on-close`
cleanup calls `git worktree remove <path>`,
non-forced by default so Git's own refusal is the final authority. `force: true`
is that user decision, not a bypass of it: it authorizes
`git worktree remove --force` and discards the uncommitted, untracked, or
unmerged work the refusal was protecting. Neither form deletes the managed
branch, its commits, a reused directory, or the source repository, and
branch/ref deletion is outside Team dissolve entirely.

Only the physical reclaim outlives the process. A managed `delete-on-close`
checkout that could not be reclaimed is committed as `cleanup-pending` together
with the caller's `worktree_cleanup_force` authorization; that pair on the
closed record is the only restart-recovery authority, and there is no persisted
dissolve state machine. Startup scans closed records for it and finishes each
one from the record alone: no Team is materialized, each reclaim is launched
rather than awaited so a slow Git cannot hold up dispatcher start, and a failure
leaves the same pending fact for the next start rather than a retry ledger.

A host shutdown is not a dissolve. It gives back the runtime authority this
process took — Workflows, then materialized members, then the leader — and
writes nothing durable, because a Team is closed by dissolve and never by a
process stopping. Only agents this process actually materialized are reached: a
durable member nobody materialized is already idle, and starting one to stop it
would make a host sweep touch entities it never ran.

A host stop sweeps the runtimes it can already see exactly once, after every
already-admitted operation has settled (`DispatcherLifecycle.close()`); nothing
newly appears in either collection's live map after that, because a spawn or a
Team create/rebuild that was admitted before the stop fence published checks
that fence itself the instant it registers into the collection and closes
itself immediately instead of proceeding, rather than relying on a second
sweep to catch it.

Source:

- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/team/service.ts`
- `/packages/dreamux/src/service/team/index.ts`
- `/packages/dreamux/src/service/team/mcp.ts`
- `/packages/dreamux/src/service/worktree/manager.ts`

### Completion Routing

AgentService is the sole notification owner. It observes native results and
accepted submission values, selects eligibility at those boundaries, and hands
facts to the existing CompletionDeliveryPolicy. EntityTurn holds a receipt and
selected value; it has no recipient, delivery task or second delivery controller.
One agent-owned in-flight set joins started reports at close and host stop; retained
accepted inputs still prove runtime-stop convergence and are evicted after selection.

An ordinary member's native subscription binds its actual collection owner at
construction; createLocked binds none. Team and root collections share this rule.
A managed TeamLeader has no subscription: only explicitly requested Dispatcher
team.create prompt/team.send answers carry a reply recipient. Do not derive
notification routes by walking the management tree. Member reports stop at their
TeamLeader, while management reads and Channel presentation remain separate.

The initiating action captures any requested reply recipient before admission.
Native callbacks use the construction-bound recipient; request values use the
captured recipient. Both are stable, equal actual objects for ordinary members.
The policy folds repeated observation of one RuntimeCompletion on object identity,
then queues by actual recipient. Several folded inputs yield one report; queued
equal-text results have distinct identities. No input-id correspondence map, native
turn registry or text-based deduplication is introduced. Tokenless stopped/input
failures retain their input-scoped notices without a fabricated fold token.

- Native normal/failed results enqueue in finalization order. Input-only stopped/
  transport notices can interleave through settlement continuations; do not claim
  universal native ordering for them.
- Requested reply rights are explicit. Channel and member-to-owner inputs do not
  acquire a Dispatcher reply recipient merely because a Team is managed there.
- Preparation and submission attempts retain existing bounded delivery. Only a
  provider-proven pre-admission failure may retry; thrown, timed-out or ambiguous
  admission is not replayed.
- Automatic result input uses a live runtime (`wake: false`); an unavailable owner
  can reject/drop it. Explicit member messages retain ordinary waking input.
  Delivery is process-local, with no durable offline mailbox or restart replay.

Native subscription eligibility is read at publication; requested/input-only
eligibility is read when the accepted input settles. AgentService checks active
phase and host release at the relevant boundary. Its close/host stop publishes the
fence before runtime teardown. A suppressed observation is never revived and a
started delivery is not retracted. Closing stops the runtime, drains admissions
and accepted mutations, proves accepted inputs settled, then drains started reports;
report errors and unproved runtime stop remain fail-loud.

CompletionDeliveryPolicy still reads the dispatcher gate before folding/queueing.
Team recipients retain TeamService admission, so dissolution can refuse delivery.
Workflow run-level terminal reporting retains its own stopped-intent recipient
boundary. A managed leader's answer to a pre-existing explicit Dispatcher request
can still be real news during a dissolve window; autonomous results are not.

The recipient query timing is part of this boundary. DispatcherAgent returns
`mustAgent()` at the original initiating operation; a configured but disabled
dispatcher therefore still fails before submitting a member's first turn.
TeamService returns itself without an additional readiness check and performs
its Team-only check during preparation and prepared submission. Adding a
dispatcher check there would retract already-queued delivery. The stable Team
object supplies FIFO identity without a separate recipient key.

Source:

- `/packages/dreamux/src/service/completion-router/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/lifecycle.ts`
- `/packages/dreamux/src/service/agent/admission.ts`
- `/packages/dreamux/src/service/agent/turn.ts`
- `/packages/dreamux/src/service/agent/service.ts`
- `/packages/dreamux/src/service/workflow-service/run.ts`

### Workspaces

Each dispatcher must declare an explicit `cwd`. Dreamux-managed work areas live
under that dispatcher workspace, never under `~/.dreamux`:

```text
<dispatcher cwd>/.workspace/work/<name>/
<dispatcher cwd>/                # default; dispatchers[].workspace.enabled is false
<dispatcher cwd>/.workspace/worktree/<repo-slug>/<slug>/
```

Omitting `repo` uses the dispatcher cwd by default; explicit workspace isolation
selects a separate plain directory. The selected path persists as a `reuse-cwd`
worktree; no git command runs, so the dispatcher cwd need not be a
git repository. Managed worktrees are created only when the request explicitly
asks for managed repo work. `.workspace/` self-ignores with `*`.

Source:

- `/packages/dreamux/src/service/dispatcher-workspace.ts`
- `/packages/dreamux/src/service/worktree/`
- `/packages/dreamux/src/config/config.ts`

### Regression Trap: management ancestry is not conversational reporting

Sharing ordinary member tools across Team and Dispatcher-root collections does
not make a managed TeamLeader a root ordinary member. Many managed Teams can
produce internal activity without waking the Dispatcher. Arm native subscriptions
only at ordinary collection construction. Retain explicit team.create prompt/
team.send reply recipients, and do not forward a Team member report recursively.
Management reads/state projections and Channel display remain independent.

Requirement: [ordinary-member communication and managed-Team boundary](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md).
Source: `/packages/dreamux/src/service/agent/index.ts`,
`/packages/dreamux/src/service/team/leader.ts`,
`/packages/dreamux/src/service/team/service.ts`.

### MCP Boundaries

Dreamux-owned orchestration is exposed through MCP tools injected into runtime
roles. Each surface is an in-server delegate owned by its own domain — Team,
TeamMate, scheduler, workflow, and one per channel that publishes tools.

The role owner assembles its delegates: DispatcherAgent during build,
`teamLeaderOptions` in `team/leader.ts` when TeamService builds its leader, and
TeammateCollection's ordinary construction for member send/list. The member
scope binds the real sender and structural actual owner; Workflow construction
omits it. `/packages/dreamux/src/service/agent/member-mcp.ts` owns that member
authority object, its send/list projections, and its admission-only receipt
wording. The entry point in `agent/mcp.ts` retains the server name and the
Dispatcher/TeamLeader roster catalogs, forwarding member scopes to their own
delegate.
Each holds the actual channel source and
its own domain collaborators. Channel snapshots are taken after initialization.
The different tool sets follow the callers' ownership, not a shared server's
filter or a lookup back through TeamCollection.

A live leader MCP lease can outlast the Team's closed-record write while
earlier children stop. Lease validity therefore does not replace the actual
Team's access policy. The per-entry order and admission spans of
`admitLeaderTools(operation)` are owned by
[`service/CLAUDE.md`](/packages/dreamux/src/service/CLAUDE.md).

There is one Agent-facing MCP descriptor shape for every server: the same
binary, the same `mcp` subcommand, the admin socket to reach, and an opaque
generation-scoped lease token in `env`. Nothing renders a caller flag or a
provider routing argument into a command line the model's runtime could read.
The token names no dispatcher, Team, or caller; what bounds the capability is
`admin.sock` file permissions, since a reader who cannot open the socket cannot
redeem a token and one who can already holds full admin authority.

`/packages/dreamux/src/mcp/server.ts` is the sole official stdio MCP transport
and protocol owner. It serves exactly `2026-07-28`, `2025-11-25`, and
`2025-06-18` and validates the JSON Schemas it advertises. A success with nonempty
text forwards that complete authored result verbatim in content only, without a
JSON copy. With absent or empty text it uses
`structuredContent` and `content: []`. Tools that can return text publish no
output schema. The complete wire contract lives in
[model-facing writing](model-facing-writing.md#mcp-descriptions-and-results).
Each delegate owns its tool visibility, bound scope, result projection, and
success-text selection; the common admission boundary renders thrown failures.

Source:

- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/mcp/shim.ts`
- `/packages/dreamux/src/service/mcp/`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team/leader-mcp.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/service/agent/mcp.ts`
- `/packages/dreamux/src/service/team/mcp.ts`
- `/packages/dreamux/src/service/scheduler/mcp.ts`

## Invariants

- **Drive every runtime through the published `AgentRuntime` interface.** The
  service resolves a provider from the registry-backed catalog and calls the
  same contract for every runtime; it knows no runtime specifics. The same
  applies to Channels through `ChannelProvider`. The channel service never
  imports back from `dispatcher-service`, and provider packages stay
  core-agnostic.
- **The operation is the fence.** A nullable `Promise` field *is* the state: a
  dissolve, a host stop, or a start publishes its promise before doing the work
  behind it, and a second caller joins that promise instead of starting a second
  operation. Do not add a boolean beside a task, or a phase enum beside either.
- **A closed entity is a record, not a dormant Service.** Terminal facts
  (`team.closed`, `teammate.closed`) evict the exact instance that ended. Read
  models, startup, and physical cleanup answer from records and never
  materialize a closed entity; only `send` may reopen a closed TeamMate, and it
  enters the cache only after that reopen succeeds.
- **One Team, one construction.** Creating a Team publishes its record before
  its object graph is finished, so create and rebuild share one keyed
  construction: a read that arrives mid-create joins it rather than building a
  second owner of the same Team.
- **A Team lends its directory, never its checkout.** The Team record is the
  single owner of the managed checkout and of what happened to it. A member that
  runs in that directory records a plain `reuse-cwd` workspace, so it can
  neither clean the Team's checkout nor hold a drifting copy of its state. The
  attempt that created a checkout is the only one that may discard it.
- **A settled turn is reported unless its owner ended it.** Completion
  delivery folds on the provider's own completion token when there is one,
  delivers an independently failed or stopped turn without inventing one, and
  keeps per-recipient FIFO order. Whether to report at all is the recipient
  scope's fence, read when delivery would start: an entity's own close or host
  release, a Workflow's stop, a dissolving Team, and a dispatcher whose
  admission is closed produce no push. A delivery already started is never
  retracted.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** Role
  differentiation is the tool set and system prompt injected at launch.
- **Commands are domain-owned.** Each owning module declares its canonical
  Command definitions in its own `commands.ts`, and one registry serves both
  `admin.sock` and the in-process Channel `invoke`. Agent MCP is not a Command
  adapter: tools converge through the generic MCP infrastructure Commands and a
  runtime-bound delegate that calls domain objects directly.
- **Payload readers belong to the layer that owns the fact.** `command/` keeps
  only generic JSON and scalar readers; what a repository request, a history
  query, or a Team status means is read by its own module.

History: [/.agents/tasks/architecture/README.md](/.agents/tasks/architecture/README.md)
