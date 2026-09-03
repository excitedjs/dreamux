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

- the dispatcher's contained agent (a `TeammateService` built from the
  dispatcher root `identity.json`, structurally outside the `teammate/`
  collection so read chokepoints never enumerate it);
- a dispatcher-local `ChannelService`;
- the dispatcher-scope `TeammateCollection`;
- the per-dispatcher `TeamCollection`;
- one stateless `CompletionDeliveryPolicy`;
- one `WorktreeManager`;
- one shared `AgentIdentityStore`, built at construction in
  `service/agent-entity/` and injected into the dispatcher agent, the
  dispatcher-scope teammate collection, and each Team's `TeamCollection` /
  `TeamService` / member `TeammateCollection`. Collections never self-build the
  store;
- the dispatcher scheduler.

Source:

- `/packages/dreamux/src/server.ts`
- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/agent-entity/`
- `/packages/dreamux/src/service/dispatchers/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/index.ts`

### Collections And Entities

The service layer is symmetric on purpose, and the two halves own different
things:

| Collection | Entity | Split |
|---|---|---|
| `Dispatchers` | `DispatcherService` | aggregate factory/cache vs. one dispatcher's object graph |
| `TeamCollection` | `TeamService` | Team store, worktrees, create/list/history vs. one Team's record and lifecycle |
| `TeammateCollection` | `TeammateService` | scoped construction/cache/reads vs. entity-owned lifecycle |

A **Collection** owns its store, its factory, lookup and list, the instances
this process holds, materialization dedup, and exact-instance eviction. It does
not own an entity's lifecycle: it never enters close for cache bookkeeping and
owns no bulk runtime or membership shutdown verb, apart from the Team-scoped
bulk member close a dissolve needs.

A **Service** owns exactly one entity: its record or identity, its operations,
its runtime-backed work, and its close. `TeammateService` is the sole command
owner for every dispatcher agent, TeamMate, TeamLeader, and Team member — it
owns mutation admission, its process-local Workflow lock, raw runtime authority,
in-process `Turn` objects, terminal outcome and delivery convergence, close
single-flight, and the committed retirement fact.

The dispatcher *has* an agent; it is not itself an Agent Runtime. Each
`TeamService` directly builds and holds its TeamLeader `TeammateService` through
`team-service/leader-agent.ts`, using the identity store, worktree manager, and
completion-delivery policy its owning `TeamCollection` injects. The per-Team
`TeammateCollection` is members-only: the TeamLeader lives at the Team root and
is never cached in the collection's entity map. `DispatcherService.team()`
returns a `TeamLeaderHandle` to admin and MCP team-leader callers, never the
concrete `TeamService`.

One service class belongs in one file or directory; a class with helpers gets a
directory whose `index.ts` is the class and whose siblings are its helpers.

Source:

- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team-collection/index.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/team-service/leader-agent.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/runtime-owner.ts`

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
- `/packages/dreamux/src/service/dispatcher-service/input-source-lifecycle.ts`
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

- `/packages/dreamux/src/service/agent-entity/read-helpers.ts`
- `/packages/dreamux/src/service/team-service/leader-agent.ts`
- `/packages/dreamux/src/platform/paths.ts`

### TeamMate Model

A TeamMate is a named, resumable agent, not a one-shot task. `spawn` returns a
concrete, never-reused name, and every later `send`, `status`, `last`, and
`close` addresses that name. `send` is also the reattach path: it reopens a
closed TeamMate from the persisted `session_id`, and there is no standalone
`resume` verb.

Read tools do not start or resume runtimes. `last` first checks the identity and
scope, then delegates a bounded cold read to the selected `AgentRuntimeProvider`
for that agent's native session history. It materializes no entity, starts no
runtime, and stores no transcript copy, index, or cursor; it returns
provider-neutral bounded message/tool records, an opaque backward cursor, and
truncation state.

No surface exposes a native history path. `spawn`, `send`, `list`, `status`, and
`history` receipts carry the entity's `AgentEntityRuntimeStatus`, whose only
session-derived field is the opaque `session_id`. Existing per-entity
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
owns no record shape. Output bounding is not delegated: Core's own
`readAgentActivity` re-validates every returned page against its record, cursor,
text, and byte budgets, because a provider is not trusted to bound Core's
output.

Source:

- `/packages/dreamux/src/service/teammate-collection/`
- `/packages/dreamux/src/service/teammate-service/`
- `/packages/dreamux/src/service/agent-entity/types.ts`
- `/packages/dreamux/src/service/agent-entity/activity-reader.ts`
- `/packages/dreamux-utils/src/activity-scan.ts`
- `/packages/agent-runtime/codex/src/activity/`
- `/packages/agent-runtime/claude-code/src/activity/`

### Team Creation And Naming

`team.create.name_prefix` is a label request, not a durable address. Core
allocates a concrete `team_name` with a 4–8 character random suffix, and the
Team's own `record.json` is the claim: publishing it is an exclusive create, and
that create is the whole acceptance protocol. Before it the candidate name is
free and a caller that loses the race chooses another; after it the record owns
the name for good, so closed and not-yet-materialized concrete names are never
reused. There is no separate claim file.

Generated TeamLeader, ordinary TeamMate, and Team-member names use the same 4–8
character suffix contract. Names stay dispatcher-global:
`AgentIdentityStore.allocateName()` checks the persisted dispatcher-global
entity directory namespace before selection, a directory name stays occupied
even when its identity is unreadable, identity creation is an atomic no-clobber
write, and a reserved-name guard blocks names that would recreate a removed
layout leaf. Naming adds no transient reservation queue and serializes no
separate creation operations.

`team.create` may include a first `prompt`. When it is omitted the TeamLeader
starts idle and waits for a later Team `send` or bound-channel inbound; the Team
fabricates no synthetic default prompt. Team-owned members share the Team
workspace.

Binding a conversation to a Team is not a Team capability at all: routing is the
Channel's own decision, made with that Channel's tools, so Team MCP has no
`bind_channel` and no `transfer_back`. Peer Team send remains future work;
TeamLeaders use their scoped TeamMate MCP to reach members. The TeamLeader's
Team surface is exactly one descriptor-bound `dissolve({ note, force? })` that
derives its Team from the MCP descriptor and accepts no Team selector.

Source:

- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/team-collection/create-request.ts`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`

### Dissolve

A dissolve belongs to the Team, and it is a submission rather than a persisted
operation. Both caller forms answer `{ accepted, team_name, status: "submitted" }`
as soon as the Team owns the one background task that will stop it, close it,
and reclaim its checkout, and neither ever reports how that went — a TeamLeader
dissolving its own Team should expect to lose the response, because its runtime
is one of the things being stopped. A second submission joins the first rather
than dismantling the same Team twice, and a refused dissolve can be asked again.
Nothing about the operation is written down, so a process that dies mid-dissolve
simply leaves an open Team whose children reopen lazily.

The Team holds the fence, and the fence *is* the operation: it goes up the
moment a dissolve is submitted, before the first await, and refuses new work
rather than queueing it — dissolve is a stop-and-reclaim, not a drain. From that
point every caller operation the Team admits is refused (Dispatcher and Channel
send, TeamLeader member and Workflow mutation, Team scheduler mutation and fire,
member-completion injection), and permanently so once the record says closed;
reads stay available. A failed dissolve lowers the fence again and the Team
stays open, its children reopening lazily, because nothing durable was written.

Behind the receipt the order is fixed. A Dispatcher-requested dissolve calls the
non-destructive `WorktreeManager.assessCleanup()` first, while nothing has
stopped, so a refusal costs the Team nothing; a TeamLeader cannot ask that
question about itself, so it stops its members first and then asks while it is
still alive to be told. `force` overrides the refusal, never the question. Then
Workflow admission closes, the scheduler stops, members and the leader stop and
close, and the assessment is repeated now that nothing is running — that second
answer is the only one a destructive reclaim may act on. The single record write
that sets `status: "closed"`, `closed_at`, the close note, and the worktree fact
is the commit boundary; nothing after it may take that back, which is why the
Team's cron store is discarded only after it and why a failure before it reopens
admission instead.

Assessment checks only dirty and unmerged state; it enumerates no refs and walks
no repository history. `cleanup: keep` and non-managed workspaces are terminally
retained, as is dirty or unmerged work, which requires an explicit user
decision. Managed `delete-on-close` cleanup calls `git worktree remove <path>`,
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

Source:

- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/team-service/closing.ts`
- `/packages/dreamux/src/service/team-collection/worktree-cleanup.ts`
- `/packages/dreamux/src/service/team-collection/index.ts`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/worktree/manager.ts`

### Completion Routing

Completion delivery is captured by object and closure, not reconstructed through
a dispatcher-wide key. A delivery-initiating action (`spawn`, `send`, or
team-create-with-prompt) resolves its initiator before runtime admission and
attaches one closure to the entity-owned `Turn`. After the winning terminal
outcome is selected, that Turn invokes the shared stateless
`CompletionDeliveryPolicy`, which delivers at-most-once per producer, completion
token, and recipient while preserving provider order — never keyed by native
ids, completion text, or slot heuristics.

- the initiating action retains the target directly; there is no Turn id lookup
  map or terminal registry;
- channel inbound and remote-control turns do not attach a completion closure,
  so they are not pushed;
- one Turn starts at most one delivery task after outcome selection;
- completion preparation and each submission attempt are deadline-bounded;
- only an explicit provider-proven pre-admission failure may retry; a throw, a
  timeout, or an `ambiguous` admission is terminal and never replayed;
- completion delivery is process-local and is not replayed after restart;
  durable recovery is through `last` and Workflow/TeamMate records.

Source:

- `/packages/dreamux/src/service/completion-router/index.ts`
- `/packages/dreamux/src/service/teammate-service/turn-recording.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`

### Workspaces

Each dispatcher must declare an explicit `cwd`. Dreamux-managed work areas live
under that dispatcher workspace, never under `~/.dreamux`:

```text
<dispatcher cwd>/.workspace/work/<name>/
<dispatcher cwd>/                # when dispatchers[].workspace.enabled is false
<dispatcher cwd>/.workspace/worktree/<repo-slug>/<slug>/
```

Omitting `repo` creates a plain work directory with `mkdir -p` and persists a
`reuse-cwd` worktree; no git command runs, so the dispatcher cwd need not be a
git repository. Managed worktrees are created only when the request explicitly
asks for managed repo work. `.workspace/` self-ignores with `*`.

Source:

- `/packages/dreamux/src/service/dispatcher-workspace.ts`
- `/packages/dreamux/src/service/worktree/`
- `/packages/dreamux/src/service/agent-entity/agent-config.ts`

### MCP Boundaries

Dreamux-owned orchestration is exposed through MCP tools injected into runtime
roles. Each surface is an in-server delegate owned by its own domain — Team,
TeamMate, scheduler, workflow, and one per channel that publishes tools.

The role→delegate decision lives in one place,
`dispatcher-service/mcp-delegates.ts`. The Dispatcher Agent and a TeamLeader get
different sets because they are different callers, not because a shared server
filters by who is asking.

There is one Agent-facing MCP descriptor shape for every server: the same
binary, the same `mcp` subcommand, the admin socket to reach, and an opaque
generation-scoped lease token in `env`. Nothing renders a caller flag or a
provider routing argument into a command line the model's runtime could read.
The token names no dispatcher, Team, or caller; what bounds the capability is
`admin.sock` file permissions, since a reader who cannot open the socket cannot
redeem a token and one who can already holds full admin authority.

`/packages/dreamux/src/mcp/server.ts` is the sole official stdio MCP transport
and protocol owner. It serves exactly `2026-07-28`, `2025-11-25`, and
`2025-06-18`, validates the same JSON Schemas it advertises, and emits canonical
`structuredContent` with exact `content: []` for ordinary successes. Bound Team,
TeamMate, and workflow tool definitions may select one operation-local reminder
text from a successfully submitted projected result without changing that
structured value. Each delegate retains tool visibility, descriptor-bound scope,
result projection, success-text selection, and public-error allowlists.

Source:

- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/mcp/shim.ts`
- `/packages/dreamux/src/service/mcp/`
- `/packages/dreamux/src/service/dispatcher-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/teammate-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/scheduler/mcp-delegate.ts`

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
- **Every settled turn is reported.** Completion delivery folds on the
  provider's own completion token when there is one, delivers a failed or
  stopped turn without inventing one, and keeps per-recipient FIFO order.
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
