# Solution A: one committed document owner, then runtime configuration

Status: independent proposal, not implementation approval. This proposal was
written from the requirement, rulings, product catalog, current source, and
read-only source audits. No sibling proposal was read.

## 1. Recommendation and acceptance boundary

Introduce one `TransactionalDocument<T>` capability in
`@excitedjs/dreamux-utils`. It owns one bound file, one committed value, one
initial-load fence, and one mutation queue. Domain stores retain their schema,
path selection, business operations, and initial-read error policy. They lose
their own persistence queues and authoritative snapshots.

An important part of this change is moving record ownership out of disposable
runtime objects. Creating, closing, querying, and rebuilding an Agent must reach
the same identity document. Evicting a TeamService must not discard its committed
records and accidentally reload a hand-edited file. These are storage ownership
changes, not new Agent or Team lifecycle states.

After every inventoried store uses that capability, add one process-owned
`ConfigService`. `config.read` and `config.write` expose only the complete
`agents` array through the existing Core Command catalog. The service retains
the full file document, validates the replacement with the startup validator,
commits the entire file, and publishes the new runtime configuration. Runtime
launch and runtime inventory read the service at the time of the operation.
Running runtimes retain their existing launch configuration.

One requirement wording needs an operator decision before claiming the storage
contract is complete: whether “durably” means the repository's current awaited
atomic replacement, or power-loss durability including directory synchronization.
Section 10 describes the concrete conflict and recommends the former for this
task. The remainder of the proposal uses that explicitly stated commit boundary;
it does not quietly promise power-loss durability.

## 2. Authority and facts checked

The current September 19 rulings govern: “一起迁（推荐）”, “只管 agents（推荐）”,
“不做（推荐）” for the volatile kind, and “不拆了，不管怎么样都会是顺着做。”
The authorization and runtime rules remain “由 Channel 自己鉴权”,
“整份写回，空=保留原值”, “下次拉起时生效”, and
“运行中以 Config Service 为准”. No dispatcher restart or pending-restart view
is introduced. The startup-validation preference is implemented as recorded,
and should receive the already-planned development-approval playback.

Relevant current evidence, relative to the repository root:

| Evidence | Implication |
| --- | --- |
| `packages/dreamux/src/config/config.ts:185-218,268-289,329-393,475-501` | Startup already separates file reading from provider loading and whole-envelope validation conceptually, but these are private functions today. Reuse the actual validation path, including Dispatcher runtime references. |
| `packages/dreamux/src/config/config.ts:145-167,451-469` | Resolved configuration contains derived/defaulted fields and a duplicate Dispatcher runtime projection. Serializing this is not the same thing as preserving the original `dispatchers` JSON. Retain the original validated document for file writes. |
| `packages/dreamux/src/service/teammate-service/runtime-owner.ts:239-295,331-346` | Each real launch resolves the configured Agent and provider. Failed starts release authority; a failed stop can instead leave the entity closing. A configuration update must not invent a runtime-restart path or override that teardown behavior. |
| `packages/dreamux/src/registry/provider-loader.ts:110-118,183-190`; `agent-runtime/catalog.ts:52-104` | The loader adds implementations to the process registry; catalogs resolve from that registry rather than freezing a list at construction. Newly loaded providers can be used without rebuilding catalogs. |
| `packages/dreamux/src/command/catalog.ts:20-30`; `channel/core-port.ts:57-84`; `server.ts:377-390` | One admitted Command catalog already serves Channel and admin adapters and drains admitted work at shutdown. No new Channel RPC, socket, authorization table, or shutdown framework is needed. |
| `packages/dreamux/src/platform/paths.ts:65-83` and repository-wide callers | `setRuntimeConfig` retains a global whole-config snapshot, but no production code calls `getRuntimeConfig`. Remove this unused authority and its setter/reset plumbing while introducing the real Config owner. |
| `packages/dreamux/src/service/workflow-service/run.ts:279-303,330-333,364-375,520-530` | Some Workflow mutations occur even before entering `mutationTail`, not merely before the awaited write inside it. A store substitution alone cannot fix its memory-first behavior. |
| `packages/dreamux/src/service/scheduler/store.ts:183-195` | Cron deletion participates in mutation ordering. A late fire must see an empty committed store and must not recreate the file. Replacement writes alone are insufficient infrastructure. |

Corrections and limits of the task inventory:

* `requirement.md:89-92` still calls `agents` the volatile store's first user.
  This is stale text contradicted by the same requirement's desired outcome and
  the later explicit ruling. No volatile implementation is proposed.
* The inferred chat-bots overlap is now source-confirmed. The installed Feishu
  SDK, version 1.73.0, uses an async `ws.on('message', ...)` callback at
  `common/temp/node_modules/.pnpm/@larksuiteoapi+node-sdk@1.73.0/node_modules/@larksuiteoapi/node-sdk/lib/index.js:102464-102478`.
  Its awaited dispatch at line 102538 only delays that message's acknowledgment.
  Dreamux independently tracks the handlers at
  `packages/channel/feishu-channel/src/feishu-channel.ts:274-295,680-689`.
  A message and bot-added event can therefore run read/change/write concurrently.
  This is source evidence, not a live timing measurement.
* The requirement's general “failed attempt leaves no runtime” has the existing
  failed-stop exception shown at `runtime-owner.ts:286-292`. Configuration
  repair does not promise to make an unproven native process disappear.

Ownership history was checked rather than inferred from class names. Commit
`2ed5f5ea` / #350 established path-bound identity stores, Channel-owned routing,
and the neutral provider boundaries. Its task record distinguishes Team record
existence from leader identity recovery (`minimize-provider-boundaries/README.md:131-150`)
and records routing's file-before-memory rule (lines 240-245). The older
`service-topology-foundations/requirement.md:716-810` planned a Core-local,
stateless `JsonDocumentStore`; only cron and Workflow currently use it. This
proposal supersedes that mechanism and its location because Channels must use
the same store and every store now has a committed in-memory value. It preserves
domain schema ownership. #350's exclusion of configuration from admin Commands
is superseded only for the new `agents` Commands. History is shallow in this
checkout; earlier ancestry was not reconstructed.

## 3. Shared storage contract

### Owner and surface

The new utils module provides the document implementation and its internal file
publication primitive. It imports no Core schemas, `LegacyStateError`, provider
types, host path builders, or Channel types. Its caller binds an already-resolved
path, supplies the initial loader/decoder and encoder, and retains the existing
parent-directory policy. The existing Core paths remain Core-owned; Feishu's
filenames remain Feishu-owned.

The minimum capabilities are:

* Load once, with concurrent first accesses joining one load. A failed initial
  load releases that promise, so the next ordinary access can retry. A domain
  loader that deliberately returns an empty value has successfully loaded it.
* Read the last committed snapshot. A synchronous current-value read is valid
  after initialization; lazy domain APIs await loading first. Public mutable
  results are copies. A caller must not receive a mutable alias to committed
  state or retain a mutable alias to a submitted candidate.
* Serialize a transaction's preparation against the latest committed value,
  write the candidate, and then replace the committed snapshot. Preparation may
  await, because provider validation and worktree preparation already do. It
  must not recursively call a mutation of this same document.
* Preserve no-op operations without writing or changing domain timestamps.
  A transaction can return a domain result independently of whether it commits,
  as access authorization and idempotent routing operations already require.
* Exclusively create a complete new file and report an existing destination,
  for identity and Workflow creation. Preserve Team's explicit replacement of
  an invalid initial record; a valid initial Team record still owns its name.
  Creation joins the same document queue as updates.
* Remove the file before publishing the domain's empty/missing value, using the
  same queue. `ENOENT` is success for the existing idempotent cron delete.
* Drain accepted mutations at the owner's existing shutdown boundary.

These are operations of the same store, not store kinds or a generic repository
framework. There is no global path registry, eviction policy, transaction log,
revision field, watch service, retry timer, or cross-file transaction.

Domain parsers remain where their facts live. A loader callback is allowed to
retain the existing I/O error distinction, not another write mechanism. For
example, Team can return `null` for an invalid initial record, access can throw
for it, and chat-bots can return its current empty default. Do not put a generic
`corruptPolicy` enumeration or version schema into the shared store merely to
recreate `JsonDocumentStore` at a new path.

### Publication and failure

The common writer uses a uniquely named sibling file, creates it exclusively at
the existing mode, writes and closes it, and atomically renames it over the
target. Exclusive creation uses the existing complete-temp-file plus hard-link
publication semantics. Cleanup of an uncommitted temp must not mask the original
error. Directory creation and owner-only directory permissions retain their
current owning policies. Every migrated document currently writes at `0600`;
that includes chat-bots' explicit temporary-file chmod behavior. No final-file
chmod after publication may turn a committed write into a reported write failure.

The store prepares and encodes before replacing the target. A rejected recipe,
serialization failure, temporary-file failure, or failed publication leaves the
committed value unchanged and rejects that operation. The next queued operation
runs against the last success, not a poisoned promise or a partially changed
object. A read overlapping a write sees the old committed snapshot until
publication; a read after the Command or store operation resolves sees the new
one. A process that dies after file publication but before memory publication
recovers the file at its next start; no recovery marker is necessary.

The queue must also preserve existing domain publication ordering. In particular,
Team's `publishRecordState` obtains a roster after the record commit, inside the
serialized operation (`team-collection/store.ts:207-224`). Provide a post-commit
portion of the transaction callback for this existing operation rather than
retaining Team's old persistence queue beside the new one. File and memory are
already committed when it runs. It must never be treated as a rollback boundary;
post-commit event failure is distinct from file-write failure. Identity state
events and runtime status changes likewise occur only after successful commit.
The utility knows nothing about the event payloads.

Authority begins at the first successful load. Access's required lazy loading
means a hand edit made before its first use can still be read; ignoring that edit
would require moving its read to startup and would violate the explicit failure
location constraint. After a successful load, edits, deletion, and corruption
are ignored until the owning daemon/session ends. The next mutation writes from
memory. No reload method is exposed.

### Collection reads and memory lifetime

The owning collections retain successfully loaded document handles even after a
live entity is retired. Directory scans are only discovery for previously unseen
records. They cannot remove an already known Team, identity, or Workflow merely
because its directory has been deleted by hand: list results must include the
committed records already held by the owner. Missing lookup keys do not acquire
permanent negative-cache entries; they are not loaded persisted records.

Record retention is not live entity materialization. It retains no process,
timer, completion recipient, or runtime generation. Memory is proportional to
the bytes of successfully loaded records plus queued candidates, rather than
the number of mutations or requests. There is no finite numeric total bound in
the current product: historical Team/identity/Workflow records are unbounded.
This is a real cost of the requested lifetime authority. Do not hide it with an
LRU that reloads hand-edited records, or invent an operation-blocking cap. A
future bounded-history requirement would need its own operator decision.

## 4. Migration owners and lifecycle

| Document | Long-lived authoritative owner | Load and failure location | Domain behavior retained |
| --- | --- | --- | --- |
| Agent `identity.json` | The existing path-bound `AgentIdentityStore`, shared by its stable Dispatcher or Team scope | Same preparation/query point as today; existing missing/unreadable/legacy distinctions stay | Creation, session recovery, lifecycle fields, skills, worktree facts; runtime lease remains on the live Agent |
| Team `record.json` | `TeamStore` inside `TeamCollection`, one document per known Team | Same first lookup/discovery, invalid initial record means no Team | Names, close facts, cleanup facts, no-clobber valid creation, state events |
| Cron `cron-jobs.json` | One `CronJobStore` per retained Dispatcher/Team scope, injected into each scheduler instance | Existing startup validation and reconciliation | Schedule/action rules, timer semantics, idempotent deletion, immediate submission |
| Workflow `record.json` | `WorkflowRunStore` per retained scope, one document per run | Existing scope initialization/recovery | Journal-first recovery and terminal delivery; journal remains separately owned |
| Feishu routing | One `FeishuRoutingStore` per Channel session | `initialize` still loads it before session start | Bindings, Space policy, and subscriptions remain one transaction domain |
| Feishu `access.json` | One session-owned access domain store | First access operation, never Channel initialization | V3 defaults/validation, pairing and approval semantics |
| Feishu `chat-bots.json` | One session-owned bot-state domain store | First existing read operation | Current empty-on-read-error behavior, known/trusted bots, baseline generation, existing dedupe window |
| `config.json`, after infrastructure | One Server-owned `ConfigService` | Existing daemon bootstrap validation, before serving Commands | Existing envelope/provider rules; new durable replacement of `agents` |

### Identity and Team ownership changes

`AgentEntityCollectionStore.entity(name)` currently constructs a new store every
time (`identity-store.ts:276-285`); creation and live Service construction call it
separately (`teammate-collection/index.ts:481,542`). It must return its retained
path-bound handle. Do not introduce a dispatcher-wide identity repository that
re-derives paths from tuples; #350 removed that ownership shape deliberately.

Move Dispatcher root identity construction to `Dispatchers`, which already
retains root identity readers (`dispatchers/index.ts:61-67`). Pass that same
store into DispatcherService for preparation and the Agent. Preparation already
passes one handle through to the Agent
(`dispatcher-service/input-source-lifecycle.ts:190-211`), so it needs no special
offline-store mode.

Keep per-Team persistent dependencies at TeamCollection lifetime: its leader
identity store, member identity collection, cron store, and Workflow record store.
They can be a private map of these existing stores keyed by the already-bound
Team root, not another Team lifecycle object. Pass them into TeamService and its
children when materializing, and into record-only queries when not materialized.
Keep the existing service cache and construction fence concerned only with live
services. Retiring a service does not retire the record handles.

Replace fresh disk readers in `TeamReadModel`, `readTeamRoster`, and
`AgentNameRegistry` with those same scope-owned stores. `dreamux doctor` and
pre-start legacy checks can still use independent read-only loaders because they
are not alternative authorities for a live daemon's mutations.

`AgentRuntimeStateStore` retains its generation lease and last native runtime
status. Delete its `identity` copy and `mutationTail` (`runtime-state.ts:69-79`).
Its `current`, ordinary updates, and queued provider publications delegate to the
identity document. Preserve both the immediate and queue-entry lease checks
(`runtime-state.ts:143-165`): an old provider callback actually can arrive after
replacement. Generation metadata stays volatile and outside the persisted schema.

A mechanical conversion would deadlock: `runtime-owner.ts:217-224` currently
wraps `reprepareDeletedManagedWorktree` in `state.transact`, while that helper
calls `identities.update` (`worktree/workspaces.ts:110-116`). Change the helper to
prepare and return its identity patch; the outer identity transaction performs
the one commit. It must not enter the same queue twice.

Unheld members remain record-only closes
(`teammate-collection/dissolve-members.ts:36-51`). Do not construct runtimes to
obtain a store. A held Service whose close failed must still be excluded from
that fallback pass. Failed dissolve continues to retain every independently
committed fact and discard the invalid live service. Ordinary reconstruction
uses committed owner records in the current process; only a daemon restart
loads them from disk. Update the product/decision wording that currently says
“from disk” without that qualification.

Team `create` and `update` enter one document queue. Replace `update(oldRecord,
patch)` with an id/handle plus patch, merging against the committed value. Remove
TeamService's separately mutable `record` and its write-then-copy-back step
(`team-service/index.ts:657-659`). Closed-record worktree cleanup and live Service
queries then see the same record. TeamService continues to own close, runtime
stopping, and lifecycle events; the store does not become a lifecycle controller.

### Cron and Workflow changes

Cron deletes publish the empty job document in memory only after successful
unlink. A `setFired` queued after deletion finds no job and performs no write.
Do not introduce a deleted flag or shut down the persistent owner merely because
its scheduler is gone. Remove cron's separate `writes` tail and its
`JsonDocumentStore` composition; keep parser and semantic validation unchanged.

For Workflow, remove the live `record` as an authoritative mutable object and
remove `AgentCall.record` aliases into its agents array. An AgentCall retains the
agent index and genuinely volatile execution fields; durable facts are obtained
from the run document by index. Prepare the agent/phase/result changes inside
the document transaction, not before it. Publish only after the record write.
`workflow_status` and list both read `WorkflowRunStore`, so remove the live
snapshot-over-disk merge in `workflow-service/index.ts:185-218`.

The Workflow journal's append, result deduplication, terminal evidence, and
recovery semantics remain intact. Where an operation first appends journal facts
and then replaces the run record, keep that order. If the append committed and
the record write failed, the append remains committed; the record's memory stays
at its prior value and existing recovery still reads journal facts on startup
(`workflow-service/index.ts:246-319`). There is no atomic transaction across
these two files. The existing terminal coordinator and business message ordering
stay; only the redundant record-mutation tail is replaced. Progress visibility
changes as explicitly recorded in the requirement: uncommitted progress is no
longer shown.

### Feishu changes

The session already owns the relevant scope. Inject its access and bot-state
stores into handlers and tools instead of passing a directory to freestanding
read/change/write functions. Routing loses its private document and tail while
retaining its domain methods and validation. Preserve missing `subscriptions`
normalization in released V1 routing documents (`routing/store.ts:170-189`).

Move the access mutex's protected state calculation and commit into the document
transaction, then delete `_accessMutex`, its handle plumbing, and
`lib/mutex.ts`. Keep pairing's actual two-stage behavior: calculate from current
state, send the question card outside the transaction, then merge the result
against the latest committed access state
(`feishu-session-inbound.ts:182-189,266-350`). Do not hold a document queue over a
network send or replace state prepared before the send; either would change
current concurrent approval behavior. Preserve approval's explicit error result
on save failure (`feishu-session-ops.ts:332-348`). Rejecting the underlying write
does not require replacing that existing domain error result with an exception.

All four bot-state mutations enter the same transaction: observe, trust,
baseline-clear, and bot-added. Check baseline generation inside the queue, on
the current committed value. Delete the inline temp writer and `tmpCounter`.
Do not change `loadChatBots`' current catch-all empty fallback or its normalizer
as an incidental “fix” (`chat-bots-store.ts:111-138,289-327`). After the first
successful/defaulted load, later file damage is no longer consulted. Changing
initial corruption into a surfaced failure would be a separate product ruling.

Use existing session fences and in-flight draining, then drain the three
documents (`feishu-channel.ts:320-333`). No process-global Feishu store or new
cross-package owner is needed.

## 5. Config Service and end-to-end Commands

### Data and ownership

`ConfigService` belongs in Core, at Server/process scope, because `agents` is
global across Dispatchers. `CoreCommandHost` exposes that service, and the
`config` domain module contributes two definitions to `command/catalog.ts`.
Do not route them through a Dispatcher Agent or a per-Dispatcher Config copy.
The caller's Channel remains responsible for authentication and permission.
The existing admin adapter can invoke them too; no CLI verb or MCP tool is added.

Store one prepared configuration value consisting of the validated raw file
document and its resolved runtime view. The encoder writes only the file
document. The resolved view is derived during validation and published with it;
it is not independently mutable state and there is no pending configuration.
This distinction already exists in provider `rawConfig` versus parsed `config`;
extend it to the whole envelope to preserve `dispatchers` exactly as JSON data,
including omitted defaults and `~` paths. Formatting need not be byte-identical.

Extract the current post-read provider-load/validate path into one named
configuration preparation function used by both `loadConfig` and the service.
Keep file existence/mode/JSON-syntax diagnostics in the file-read boundary, and
keep provider-specific validation in `provider.config.read`. Do not round-trip
through a temporary config file merely to invoke `loadConfig`.

`dreamux serve` initializes the ConfigService through this path once, passes it
to Server, and Server hands its read capability to config consumers. Offline
onboard/doctor/config-show continue to read files through the same owning config
functions. Remove the stale global config holder in `platform/paths.ts` rather
than keeping it synchronized with a second assignment.

Replace long-lived `DreamuxConfig` references in Dispatcher/Team/TeamMate
dependencies with the ConfigService read capability. Pure helpers can still
accept a captured `DreamuxConfig`; their callers obtain that operation's value
from the service. In particular:

* `TeammateRuntimeOwner.resolveLaunch` reads current agents at every launch.
* Runtime inventory in `TeammateCollection` reads current agents, as do creation
  validation and recent-activity configuration resolution.
* Dispatcher membership, default runtime id, Channel sessions, and workspace
  policy remain initialized from the unchanged Dispatcher section. No stopped
  Dispatcher gets restarted or reconfigured.
* One launch captures one prepared Agent configuration. A write racing that
  capture may affect the following launch instead; after `config.write`
  resolves, a later launch must use the committed configuration. There is no
  live-runtime mutation, teardown, or waiting for existing turns.

### Wire contract

| Command | Input | Result |
| --- | --- | --- |
| `config.read` | `{}` | `{ agents: [...] }`, in file-entry shape, with secret-key values `""` |
| `config.write` | `{ agents: [...] }`, complete replacement | The same redacted `{ agents: [...] }` for the value this write committed |

Both outer objects and Agent entry shapes are closed. `config` remains an opaque
provider-owned object and remains optional exactly as in the file schema.
Require an actual array for write, including `[]` for an intentional empty
section. The current Command boundary performs its usual JSON/input validation;
the configuration validator owns duplicates, references, provider names, and
provider field rules. Do not build a second host schema validator in the Command.
Unknown `dispatchers` input is rejected by the closed command shape, and no
result contains it. No revision, force flag, impact classification, or restart
list is needed for the agreed whole-section replacement contract.

### Read, secrets, and write sequence

Read projects the raw `agents` entries from memory and applies the existing
`isSecretKeyName` predicate (`dreamux-utils/src/redaction.ts:117-139`). The
current CLI writes `<redacted>`; the Command must write `""` as ruled, without
changing the CLI's presentation. Recursively traverse objects and arrays, and
blank the entire value at a secret-named key, even if the stored value is not a
string. Do not mask values merely because their text resembles a secret; that
would differ from the agreed key-name rule.

A write performs the following inside the configuration document's queue:

1. Match submitted entries to current entries by Agent `id`, never array
   position. Recursively replace a submitted `""` at a secret-named key with
   the stored value at that key's path. This must use the latest committed
   value, not the snapshot returned by an earlier read.
2. Preserve only those empty secret fields. Non-secret empty strings are normal
   replacement values. Missing fields and missing Agent entries follow whole
   replacement semantics. For a new id or a previously absent secret, there is
   no stored secret to retain; pass the submitted value to normal validation.
   A changed provider is not grounds to silently erase an existing same-id
   secret: the ruling supplies no such exception.
3. Form the full candidate from those agents and the process-held raw
   `dispatchers`. Run the same preparation function as startup: load referenced
   providers through the existing loader, validate both sections, and enforce
   Dispatcher `agentRuntime` references. Do not scan Teams or TeamMates to veto
   removal. Do not add cwd, credentials, binary execution, or runtime-start
   probes to validation; those are not config-loader checks.
4. Encode and replace `config.json` at `0600`. Only then publish the prepared
   value and return its redacted agents. A failure before publication leaves
   the service and file unchanged. The next queued write derives empty-secret
   retention from the last successful commit.

Provider config is opaque: nested array matching uses its JSON path, including
array index; Core does not infer ids inside provider arrays. Top-level Agent
array reordering is safe because its ids are host-owned. Document this precise
rule and test reordered Agent entries. Adding provider-specific secret identity
or an explicit “erase secret” operation would be a new requirement.

Provider implementations remain owned by the Server's existing registry. Reuse
that registry for the loader, so existing catalogs immediately resolve a newly
loaded provider. Do not unload a provider when its last configured Agent is
removed: existing runtimes may still use it. A rejected candidate can have
successfully imported/registered a provider before a later validation or file
failure. It still changes no configured Agent or persisted configuration; the
loader's process cache is outside the config transaction. Import/factory side
effects are not rollbackable in the existing plugin contract. This limitation is
explicit, rather than hidden behind a registry-cloning protocol that cannot undo
module side effects anyway. No production runtime-catalog `list()` consumer was
found that would turn this warm cache into a new configured Agent.

No Command re-reads the file. A live hand edit to either section, or a concurrent
onboard rewrite, is overwritten by the next successful Command write from
memory. Guidance must say to stop the daemon before either manual operation.

## 6. Greenfield comparison and entropy accounting

| Module being reshaped | If this requirement were the only history | Gap from current code and decision |
| --- | --- | --- |
| Shared persistence | One file-bound committed document with serialized mutations | Replace `JsonDocumentStore` and atomic writer duplication; do not wrap them and retain their queues |
| Identity/runtime state | A scope owns its persisted identity; a live Agent owns runtime write leases | Adapt domain parsing and lifetime wiring; replace the split snapshot/queue authority and remove fresh-store readers |
| Team collection/service | Collection owns committed Team records; live Service performs Team actions | Adapt ownership/injection; replace file-merge freshness with one record handle; retain service lifecycle and record-only queries |
| Cron | A schedule document plus volatile timer service | Adapt CronJobStore to shared transactions, including unlink; retain scheduler behavior |
| Workflow | One committed run record, separate append-only journal, separate live executions | Replace mutable run/AgentCall record aliases and the live-query overlay; adapt existing terminal and journal coordination |
| Feishu routing/access/bots | One session owns three documents with distinct domain semantics | Adapt routing; replace access/bot filesystem functions and access mutex with document transactions; preserve lazy access and pairing boundaries |
| Config parsing | One raw-envelope-to-prepared-value path, callable from boot and replacement | Adapt existing validator by separating it from filesystem reading; preserve all provider-owned readers |
| Config Service/Commands | One global owner, two projections over existing Command transport | Add the requested capability; replace long-lived config-object wiring, remove unused global holder; no Channel feature or restart machinery |

Concrete removals, to check at the end of the infrastructure pass:

1. Three independent atomic replacement implementations: Core
   `writeFileAtomic`, utils `writeAtomic`, and chat-bots' inline writer.
2. The separate Core `writeFileExclusiveAtomic` implementation; its capability
   is retained in the one shared publication implementation.
3. `JsonDocumentStore` as an extra stateless store layer, including its generic
   corruption-policy machinery. Domain parsers/error meanings remain.
4. Five redundant serialization mechanisms: identity runtime-state tail, Team's
   persistence queue, cron's tail, Workflow's record-mutation tail, and routing's
   tail; plus access's mutex class/plumbing. Real service admission and Workflow
   message/terminal coordination remain because they serialize different work.
5. Three competing durable-value authorities: runtime-state identity copy,
   TeamService record copy, and WorkflowRun record/AgentCall aliases. Routing's
   committed value moves into the shared document rather than remaining beside it.
6. Four repeated file-read/modify/write protocols: Team, cron, access, and
   chat-bots. Domain methods stay, but none independently loads its current file
   for a mutation after initialization.
7. Live-daemon identity readers that construct competing stores; Workflow's
   disk-plus-live result overlay; unused `platform/paths.ts` global config.

The additions are one shared persistence capability, retained handles needed to
make its lifetime real, one ConfigService, two Command definitions, and one
reusable config preparation entry point. There are zero new persisted fields,
store versions, phase states, recovery ledgers, provider-specific Core rules,
or deployment services. A patch that adds the shared class while retaining the
old snapshots/queues does not meet this proposal's acceptance boundary.

## 7. Product behavior ledger

The following catalog entries are touched. “Preserve” means their observable
contract must survive the ownership change, not that their current implementation
is untouchable.

| Catalog entry | Disposition |
| --- | --- |
| The Channel is the operator's doorway | Extend with Channel-invoked agents configuration; web Channel itself remains out of scope |
| A binding is an expected route, not an assertion | Preserve; no external-target validation added |
| Unbound input reaches the Dispatcher Agent | Preserve across routing migration and invalid Agent configuration |
| Unbinding leaves the Team alive; teams without bindings are normal | Preserve routing-only writes and Team-close route release |
| A message that starts with a known slash command is executed, not delivered | Preserve existing authorization/intake; no config slash command added |
| `/bind <team_name>` routes the whole group from inside the conversation | Preserve routing scope and announcement location |
| A chat is either bound to one Team or run as a collaboration space, never both | Preserve the same document transaction checks |
| A rebind names the Team it displaced | Preserve prior-Team fact and resulting notification |
| A collaboration space is a Channel product flow | Preserve completed bindings/policy and volatile provisioning; add no persisted saga |
| A provisioning run that produces no Team answers in place | Preserve failure routing; bad Agent launch settings must not reroute commands through an Agent |
| Binding changes are confirmed with a card, and the card names real paths | Preserve commit-before-notification behavior and existing delivery policy |
| Workspace isolation defaults to off | Preserve through config preparation and pure helper call sites |
| The Team record is the only existence fact | Explicitly change live reads to the loaded committed record; hand-deleting/damaging its file no longer frees its name until restart |
| Dissolve means terminate now and reclaim | Preserve immediate runtime stop, durable logical close, and separate physical cleanup |
| A dissolve that cannot reclaim its worktree is refused before it is accepted | Preserve preflight and force semantics |
| A failed dissolve leaves a Team that still exists | Preserve partial committed facts and retry; qualify reconstruction as committed owner records in-process, disk after restart |
| Creation tools use entity-based worktree names | Preserve while changing worktree preparation to return an identity patch |
| `identity` shapes only the agent it is given to | Preserve per-entity identity ownership and no member inheritance |
| Creating a Team starts no process | Preserve record-only creation and next-launch failure display |
| Create and status show the same Team facts; list stays compact | Preserve result shapes while all projections read the same owner |
| Closed entities are records | Preserve; retained documents do not construct live services or runtimes |
| An owner is not told about the stop it asked for | Preserve Workflow/Team shutdown and completion suppression |
| `last` is the mid-turn progress window | Preserve provider query behavior; resolve any required current configuration through ConfigService |
| Live conversation display is a best-effort stream | Preserve; store migration adds no activity replay or delivery guarantee |
| A displayed input is announced when it is submitted, and always ends | Preserve when an allowed removed runtime id fails its next launch |
| Every tool failure is model-visible and actionable | Preserve native/typed failure propagation for new Commands and migrated stores |
| Business rejections are results, not exceptions | Preserve Feishu approval and other existing domain results |
| Cron fires submit immediately | Preserve; no idle gating or waiting added |
| Tools return receipts, work runs behind them | Preserve existing long-running operations; config write returns only after its bounded file operation |
| Local runtime state is disposable; upgrades fail loudly | Preserve accepted released formats; no migration or new incompatibility introduced |

Add the missing product entry for agents configuration, including secret
retention and next-launch timing. Record Workflow's committed-only progress
visibility and the live-memory authority rule. Other presentation details, native
runtime behavior, and completion contracts are outside the change boundary.

## 8. Implementation sequence

Use two delivery PRs in this task, or two strictly ordered implementation passes
if the TeamLeader chooses one PR. The infrastructure PR must be coherent on its
own and complete before Config work builds on it. It must not leave the old
atomic helpers as permanent alternatives.

**Pass/PR 1: all storage owners.**

1. Implement the shared document and one publication mechanism with direct
   filesystem behavior tests. Establish replacement, exclusive creation,
   removal, lazy-load retry, and queue ordering. Resolve Section 10's durability
   question before locking these tests.
2. Convert identity and Team scope ownership end to end, including all read
   paths, Team create serialization, unheld close, failed dissolve rebuild, and
   worktree transaction re-entry. Do not declare completion at the writer alone.
3. Convert cron and Workflow with retained scope stores. Remove live-record
   overlays and mutable Workflow record aliases; retain journal recovery.
4. Convert all three Feishu documents, delete access mutex and inline bot
   writer, and verify lazy access startup behavior and concurrent pairing.
5. Remove the old store/helpers once their final callers are gone. Update utils
   exports/tests for the actual public capability; do not preserve obsolete
   write bypasses solely to satisfy source/export-list assertions.
6. Update owning maintenance references, product entries, state/channel/service
   topology KB, and the superseded historical design record. Run all gates.

**Pass/PR 2: ConfigService and Commands.**

1. Extract and reuse configuration preparation, retain raw document plus derived
   runtime view, and add the service on the now-established store.
2. Wire one Server-owned service and current reads through the host graph;
   remove the unused global snapshot. Verify runtime inventory and every launch
   path, including Dispatcher Agent launch, use the correct current agents.
3. Register `config.read`/`config.write`, secret projection and retention, and
   validation/provider loading through the existing Channel/admin ports.
4. Update `dreamux-maintenance/SKILL.md` routing and the single owning
   `references/config-envelope.md`: Commands for live agents edits, stopped-daemon
   manual edits/onboard, full-file overwrite from memory, secret retention,
   allowed entity-only reference removal, and current failure behavior.
5. Update relevant provider guidance only where ownership instructions actually
   change; record KB/design deltas and ordinary Rush change notes. Run all gates.

Persisted file shape, path, and mode remain unchanged, so there is no
`BREAKING:`, `Rebuild:`, migration reader, or 0.x major bump. Public utils API
removal and internal Channel API adjustments still need ordinary change notes.
Maintenance references remain current-state-only; historical transitions belong
in this task/change notes, not repair recipes in current references.

## 9. Verification mapped to the acceptance criteria

| Requirement criterion | Behavioral proof |
| --- | --- |
| Every moved store reads memory, commits file first, and fails without changing memory | Parameterize the common contract over real temporary files; block a write and observe old reads, fail preparation/publication and observe unchanged bytes/snapshot, then succeed with a following mutation. Add one domain integration case for each of the seven migrated store families. Mutate/delete the loaded file and verify current reads and next write use memory. |
| chat-bots writes serialized | Overlap actual observe/trust/bot-added methods; retain both updates. Queue an old baseline-clear behind a newer baseline and verify generation check uses the new value. |
| Released state/config loads unchanged | Seed sanitized released-format fixtures before owner initialization, covering optional fields/defaults, routing without subscriptions, existing identity variants, Team cleanup fields, cron V1, Workflow V1, access V3, bots V1, and opaque provider config. Assert unchanged path/schema/mode and next-start load of a Command-written config. |
| Bad access does not fail Channel start | Start a real session fixture with unreadable/malformed access; initialization succeeds, first access operation fails as today. Repair before first successful load and show an ordinary retry succeeds; after success, later file damage is ignored. |
| Channel read returns complete redacted agents | Invoke through `createChannelCorePort` and the real admitted registry; cover nested objects/arrays, non-string secret values, and no accidental `dispatchers` in success or write result. Verify caller cannot mutate stored data through a returned object. |
| Invalid or failed file write changes neither config memory nor file | Fail duplicate id, bad provider block, provider import, and a real filesystem publication attempt. Compare config and exact original file bytes; a later valid command succeeds. Distinguish the documented provider-loader cache side effect. |
| Dispatcher runtime reference removal refused | Include enabled and disabled Dispatchers; both are checked by startup's validator. Compare the same invalid candidate through startup preparation and Command preparation. |
| Valid config committed when write returns and used at next launch | Through the Channel port, change a configured runtime; inspect file, launch a new runtime and observe its create context, and confirm an existing runtime was neither stopped nor reconfigured. Load a previously absent provider through the same importer and launch it. |
| Empty secret retains stored value | Read/edit/write round trip; reorder Agent array; overlap a real-secret replacement and a write carrying blanks; retain the latest successful value. Cover new id, omitted field, and unchanged non-secret empty value. |
| No Command reads/writes dispatchers | Closed input rejects `dispatchers`; outputs contain only `agents`; successful write preserves the process-held raw Dispatcher JSON even when disk has been hand-edited. |
| Maintenance ownership and quiesce guidance | Review owning config/state references against the final implementation; run `.agents/scripts/check.sh`. |
| Full gates | `node common/scripts/install-run-rush.js build`, `lint`, `test`, and `typecheck:tests` must all pass for each completed delivery boundary. Run Rush update if dependency/export wiring requires it. No per-package npm install. |

Additional load-bearing regressions are necessary because the storage criterion
crosses existing lifecycle boundaries:

* Keep `teammate-dissolve-members.test.ts` cases for held/unheld/already-closed
  members and failed held close. Keep `team-dissolve-recovery.test.ts:131-208`
  for preserved member closure and deleted cron after failure; also damage disk
  between attempts and show the retained committed owner still governs.
* Intentionally replace `team-collection-read-path.test.ts:125-151`, whose
  current assertion says mid-daemon disk corruption makes update fail. The new
  ruling explicitly changes that behavior. Keep initial-invalid-record and
  name-reuse tests at lines 35-123, with fixture writes before loading the owner.
* Exercise creation/update overlap and state projections through more than one
  reader; stale snapshots must not revert close/cleanup facts. Verify a deleted
  Team directory cannot hide an already loaded record from list or name lookup.
* Keep runtime generation rejection, including a callback queued before lease
  revocation and executed after it. Exercise managed-worktree reopening to catch
  the known nested-queue deadlock.
* Overlap cron fire settlement and store deletion in both orders. Keep existing
  non-blocking inbound/live tests unchanged.
* Hold a Workflow record write pending: status shows the prior committed value.
  Fail it after a journal result commits: the result must still recover on a
  fresh process owner. Normal runner responses/delivery retain their current
  ordering and owner-stop suppression.
* Preserve routing's binding-plus-subscription removal in one commit and access
  approval racing with pairing-card delivery. Failed persistence emits no false
  committed state or success notification.

These are observed-output tests with real owners. Do not add source-text/AST
checks for class names, constructor locations, or helper exports. No tests or
build gates were executed during this proposal-only task.

## 10. Risks, open decision, and rejected alternatives

**Biggest implementation risk: a second record authority surviving the migration.**
Fresh identity readers, disposable Team-scoped stores, mutable Workflow aliases,
and TeamService's record copy are all present today. Leaving any of them behind
can pass ordinary persistence tests and still violate runtime authority or
resurrect stale facts. The mitigation is the owner/read-path migration and
lifecycle tests above, not a global path cache or extra reconciliation loop.

**Operator decision: what does “durably” promise?** Current Core
`platform/atomic-write.ts:19-27` and utils `fs.ts:39-43` await write/close/rename;
neither synchronizes the file or directory. The source itself calls this durable
when publishing identity updates (`runtime-state.ts:65-67`). I recommend retaining
that process-level atomic-publication meaning for this task and stating it
explicitly. It satisfies unchanged-file-on-write-failure at the defined
publication boundary without a new recovery protocol.

If the requirement instead includes power-loss durability, write and sync the
temporary file, rename, then sync its parent directory. The concrete conflict is
a directory-sync failure after a successful rename: the file has already changed,
so it is impossible to truthfully reject that operation while also promising
“neither memory nor the file changes.” Rolling back is another fallible write,
not a solution. That choice needs an explicit committed-but-durability-uncertain
outcome/failure policy and filesystem/platform validation. This proposal does not
choose that product failure behavior on the operator's behalf.

Other risks and evidence limits:

* Retaining historical records has no finite product-defined memory ceiling.
  The cost is explicit in Section 3; no new synthetic cap is proposed.
* Existing trusted provider imports/factories can have effects before complete
  config validation. The existing contract cannot undo them. The transaction
  guarantees configuration memory/file atomicity, not rollback of plugin code.
* Initial chat-bots error-to-empty behavior remains a potentially lossy existing
  behavior. Tightening it is not authorized by this refactor.
* No live Feishu or real-runtime configuration smoke was run. SDK concurrency
  was verified in installed source only. External consumers of removed utils or
  Feishu file-helper exports were not inventoried outside this repository.
* Current gates and real filesystem permission/fault behavior have not been
  measured here. Implementation must verify them; this is a design artifact.

Rejected alternatives:

* **A new writer under every existing store.** It leaves old queues, memory
  copies, and freshness rules intact: deduplication without ownership reduction.
* **A global store registry keyed by arbitrary path.** It adds another owner,
  codec collision rules, and hidden cross-instance coupling. Existing domain
  collections already determine each path and can retain the correct handles.
* **Keep runtime-state as the identity authority.** It cannot cover creation,
  pre-Agent Dispatcher preparation, unheld member close, or queries without
  constructing a live entity. The durable identity owner must outlive it.
* **Eagerly load every Feishu file at startup.** It turns bad access into a
  Channel/Dispatcher startup failure, expressly forbidden by the requirement.
* **Evict closed records and reload on demand.** It lets hand edits alter an
  already loaded document during the same daemon and confuses service eviction
  with record authority. Closed services may be evicted; committed records stay.
* **Globally reject corrupt documents.** It changes established Team and
  chat-bots semantics and moves failures. Uniform mechanism does not imply
  uniform domain error policy.
* **Patch the shared DreamuxConfig object in place.** It depends on aliasing,
  leaves runtime readers unable to name their authority, and can mutate settings
  already handed to running runtimes. Replace prepared snapshots through a
  named owner instead.
* **A raw-config store plus an independently assigned resolved-config cache.**
  It creates two publication points. Store one prepared value with one encoder.
* **Volatile writes, filesystem watchers, config revisions, automatic restart,
  credential probes, or per-Channel Command allowlists.** They have no caller in
  the converged requirement or contradict explicit rulings.
* **A config-provider sandbox or staged rollback registry.** It cannot roll back
  arbitrary module imports, and no such execution-isolation requirement exists.
  Reuse the installed provider loader and state its real limitation.

No additional product decision is required for the stated `agents`-only scope,
entity-reference removal rule, lazy access behavior, or absence of a volatile
kind. They are already settled; the durability question above must not be used
to reopen them.

## Cross-review

This section follows a complete reading of first-round B and C and fresh checks
of their load-bearing claims against source. It supersedes earlier parts of A
where a revised position is explicitly stated. No product implementation or
other proposal was edited. Source paths below are relative to
`packages/dreamux/src/` unless another package is named.

The principal result is not a three-way convergence. B and C correctly show that
in-place replacement of the shared config object's `agents` property can reach
today's launch readers. They do not establish that cold-looking identity readers
only touch entities without a live owner; current list/status paths disprove
that premise. I retain the single committed record owner across runtime-object
eviction, but change my Team publication design to B's domain-owned queue and
accept C's identification of the journal's exclusive-create dependency. I also
adopt a three-PR sequence, with corrected deletion and documentation boundaries.

The ruling “以代码量最小的方式来做” is scoped to the entry-point question in
`rulings.md:11-13`. It is not authority for choosing a memory lifetime, mutable
configuration wiring, or reduced creation guarantee. Smaller equivalent designs
can still win under the engineering whitepaper; that requires establishing the
equivalence, not broadening this ruling.

### Review of solution B

Arguments accepted, and their effect on A:

* **Keep Team's domain publication ordering outside the generic store.** B
  correctly distinguishes the file transaction from the operation that commits
  a Team record, awaits its roster, and publishes the aggregate. Current
  `team-collection/store.ts:175-203,207-223` makes that distinction concrete.
  I withdraw A's proposed generic post-commit transaction portion. Retain
  TeamStore's keyed operation queue around document mutation and publication;
  put `create` inside it too. The document still owns the file/current-value
  transaction. This leaves two queues with different obligations in this one
  owner, but adds no generic callback contract or post-commit failure mode to
  every document. A's deletion count is reduced accordingly: Team's keyed queue
  is retained, not claimed as removed.
* **Fix file mode at 0600 in the document API.** All current document callers
  use that mode. I accept removing the unused document-level mode parameter;
  domain parent-directory rules remain separate. This narrows A's proposed
  configurable surface without changing any persisted mode.
* **Retain raw configuration alongside its derived runtime view and reuse the
  actual loader.** Confirmed by `config/config.ts:145-167,208-218,451-469`.
  This reinforces A's existing position, rather than changing it. The raw
  Dispatcher section must not be reconstructed from expanded/defaulted values.
* **In-place `agents` replacement can meet current next-launch timing.**
  `agent-entity/agent-config.ts:27-47`,
  `teammate-service/runtime-owner.ts:331-346`,
  `agent-entity/activity-reader.ts:88-108`, and
  `teammate-collection/index.ts:335-342` all read the selected configuration at
  use time. I retract any implication in A's rejected-alternative text that
  assigning a new agents map necessarily changes a running runtime's captured
  config. It does not. I still prefer the explicit read capability for the
  ownership reasons below; it is an architectural preference, not a demonstrated
  functional impossibility of B's approach.
* **The lifetime cost of retained historical records is real.** B is right to
  challenge a forever-growing map. My retained-owner design must state its
  actual bound: loaded persisted bytes and queued candidates, with no finite
  product-defined ceiling. I do not describe that as a collision defense. It
  implements the explicit ignore-hand-edits behavior. Choosing a shorter
  authority lifetime changes that behavior and needs to be said plainly.
* **Feishu first is a useful implementation slice.** I adopt B's three-PR
  delivery size, but move all atomic-writer cutovers into the first PR and put
  each owning maintenance/KB change in the PR that changes that ownership.
  Section “Revised positions” gives the precise sequence.

Arguments rejected or needing correction:

1. **One-shot identity scans are not confined to unmaterialized entities.**
   B's Section 2.3 asserts that these scans read files with no memory owner.
   `TeamCollectionReadModel.list()` traverses every Team and obtains its leader
   state through a new identity reader, without checking the live cache
   (`team-collection/read-model.ts:38-42,85-94,128-150`).
   `TeammateCollection.list/status` first read identities and only then consult
   live services (`teammate-collection/index.ts:266-275,630-642`). A hand-damaged
   live member identity can therefore disappear from list or fail status before
   the live fallback is reached; a changed live leader identity can change
   `team.list`'s `leader_state`. These are existing public paths, not invented
   concurrent writers. Keeping their one-shot reads does not complete the new
   memory authority contract.
2. **Dropping the store at live-object retirement changes later ordinary
   access.** A retired member is evicted at
   `teammate-collection/index.ts:567-573`; later materialization reads identity
   again at lines 599-609 and 630-636. Workflow completion evicts its execution
   object at `workflow-service/index.ts:165-169,336-337`, after which status
   uses the record store at lines 185-196. B's one-shot Workflow listing and
   live-run-owned handle leave the same gap. Repeated access to a previously
   loaded closed record must either keep memory authority or explicitly adopt
   a narrower product guarantee.
3. **Deleting all exclusive publication has a missed real caller.**
   `WorkflowJournal.create` uses `writeFileExclusiveAtomic`
   (`workflow-service/journal.ts:55-65`) on every Workflow initialization before
   run-record creation (`workflow-service/run.ts:154-165`). Thus deleting
   `atomic-write.ts` while declaring the journal untouched cannot compile or
   complete the call graph. This is sufficient to retain a shared create-only
   publication capability; no fabricated UUID collision is needed. Conversely,
   I did not establish that ordinary generated-name spawn races would break
   solely because its identity creation becomes serialized update. B's narrower
   argument about those fenced callers deserves credit, not a speculative race
   finding. It does not prove the primitive is unused everywhere.
4. **The claimed all-policy `decode(text | null)` seam cannot handle read I/O
   errors.** It never receives an `EACCES` raised before decoding. Team's
   initial `get` catches read errors (`team-collection/store.ts:85-97`), whereas
   identity propagates non-ENOENT I/O errors
   (`agent-entity/identity-store.ts:126-159`). Feishu bots catch all read/parse
   errors (`packages/channel/feishu-channel/src/chat-bots-store.ts:116-125`).
   These policies cannot all be preserved by B's exact signature. Keep an
   owner-controlled initial-load result, including its I/O failure policy.
   Returning an uncached empty value outside an unloaded store is not a complete
   substitute: the next mutation would load and fail again. If the policy
   intentionally returns a default, that default must become the store's value.
5. **Chat-bots I/O failure is an explicit proposed product change, not accepted
   simplification.** B correctly discloses it as an operator question; I reject
   adopting it without that ruling. It also does not remove every possible
   initial overwrite-with-empty: a parse failure still produces empty under B.
   The source's “not security-critical” comment is existing rationale, not an
   operator ruling in this task ledger.
6. **Leaving TeamService's separate record copy as a cleanup note leaves an
   unnecessary second authority in the new design.** Its unbooted state is real
   (`team-service/index.ts:85,668-670`), but a document with no committed Team
   already represents it. Its write-followed-by-copy-back is at lines 657-659;
   record-only cleanup updates through the store separately
   (`team-collection/worktree-cleanup.ts:31-53`). Finish that read-path change
   in the ownership migration; no new service phase is required.
7. **Several smaller factual qualifications matter.**
   `dispatchers/index.ts:88` is the root identity status reader, not the
   preparation store; preparation already passes the same handle into the Agent
   (`dispatcher-service/input-source-lifecycle.ts:190-211`). Workflow's old
   `JsonDocumentStore` fails on malformed/non-ENOENT reads
   (`platform/json-document-store.ts:23-53`), so the claim that a decoder-based
   create necessarily overwrites an unreadable Workflow record “the same way
   identity does” is not established by that parser. Adding complete power-loss
   durability is not “one line”: temporary-file sync, rename, parent-directory
   sync, and the post-rename error contract are separate concerns. Finally, the
   task inventory really does contain stale volatile wording at
   `requirement.md:89-92`; the claim that it has no error is too broad.

### Review of solution C

Arguments accepted, and their effect on A:

* **Exclusive creation has an out-of-scope append-log caller.** C correctly
  identifies `WorkflowJournal.create`, which A's first pass missed as a caller
  of the helper being removed. I revise “internal file publication primitive”
  to permit the journal to use the one shared create-only publication
  capability. The journal remains append-only after initialization; it does not
  become a transactional document. This is a mechanical callsite change needed
  to delete the old helper, not expansion into journal redesign.
* **Distinguish directory occupancy from readable identity.** The existing
  member-name inventory preserves occupied directories even when their identity
  is invalid (`agent-entity/identity-store.ts:293-306,331-346`). Preserve that
  rule and the explicit `replaceExisting` exception at lines 188-199. A shared
  record owner does not authorize turning an invalid initial identity file into
  a free member name. This strengthens the explanation of A's existing choice.
* **Worktree preparation must return a candidate rather than recursively
  write the same document.** Confirmed at
  `teammate-service/runtime-owner.ts:217-224` and
  `worktree/workspaces.ts:110-116`. A already identifies this; C independently
  supports retaining it as an implementation acceptance check.
* **Preserve lazy access and initial lenient bot-state behavior.** I accept C's
  intended product behavior, but not the contradictory load API or the move of
  chat-bots' first load to initialize. The corrected policy belongs to its
  actual first consumer. The current load locations are shown by
  `packages/channel/feishu-channel/src/feishu-channel.ts:215,221-225` and
  `feishu-session-inbound.ts:116-118,125-139`.
* **One common low-level publication implementation is enough.** Accept C's
  distinction between publication and document memory, given the real journal
  caller. The primitive takes bytes, so a name claiming JSON-only semantics is
  unnecessary. This permits the first PR to remove all three old writer bodies
  without migrating every Core domain owner in that same PR.

Arguments rejected or needing correction:

1. **A stateless identity store plus a live runtime document leaves two read
   authorities.** The source counterexamples under the B review apply equally
   to C's “cold by construction” claim. Existing architecture explains why
   these readers exist; it does not establish that they satisfy the new story.
   C also explicitly preserves disk reads for dead Workflow runs in Section
   5.4. That reads hand edits after a normal run finishes. A query can work with
   no live execution object while still using a retained record document.
2. **The Team map is not the stated one-file document.** C's Section 5.2
   describes `TransactionalDocument<Record<teamId, TeamRecord>>`, then writes
   different per-Team paths inside a collection tail. Its public primitive
   accepts exactly one path and encoder. Either the Team owner still implements
   separate snapshot/write/tail machinery, or the primitive becomes a
   multi-file transaction abstraction. Neither is the advertised reuse. Use
   one document per Team inside a collection map. A single collection tail also
   makes unrelated Teams wait on each other's file I/O and roster query;
   today's keyed queue is per Team (`team-collection/store.ts:175-176`).
3. **Dissolution does not free the Team record/name.** Section 5.2 says a
   dissolved Team is removed from the map; Section 8 says its closed record
   stays. The latter matches source and product. Closed records also retain
   accepted-request history (`team-collection/index.ts:124-135,183-187`);
   creation failure deliberately closes rather than removes a published Team
   (`team-service/closing.ts:265-270`). Correct the former statement; removing
   the map entry is not an anti-resurrection fix.
4. **ConfigService still has its own transaction mechanism in C.** Section
   6.1 gives it a private tail, and Section 2.2 writes through the raw atomic
   helper before assignments. That is another hand-built file-first store,
   instead of the agreed Config Service using the shared transactional store.
   C's exact document API also lacks async preparation even though provider
   validation and Workflow journal append are awaited. Its “every document has
   an empty state” is false for daemon configuration: missing config is an
   explicit startup error (`config/config.ts:190-194`). Fix these capability
   gaps in the one store; do not make Config/Workflow exceptions beside it.
5. **Reconstructing `dispatchers` from resolved config is not unchanged JSON.**
   C's mapping explicitly emits enabled/workspace defaults and the expanded
   cwd (`config/config.ts:152-165,451-469`). A file with omitted defaults or
   `cwd: "~/repo"` will change in its Dispatcher section on an agents write.
   This may preserve current resolved behavior, but C's promise to leave that
   file content unchanged is false. B's held raw document is the simpler way
   to honor the agents-only surface without requiring that extra interpretation.
   C's secret merge also needs an explicit match by Agent id: “walk in parallel”
   does not establish safe behavior when the submitted array is reordered.
6. **The claimed live diagnostics/onboard readers are not daemon consumers.**
   `provider-diagnostics.ts:48-74` does read `dispatcher.runtime`; its production
   callers are doctor/onboard (`cli/doctor.ts:310-318`, `onboard/run.ts:293`),
   which load their own configuration. The daemon reference found is the
   startup assertion (`server.ts:425-429`). Thus C's live-consumer justification
   for mutating every existing Dispatcher element is factually wrong. Keeping
   a derived view coherent is reasonable, but does not require in-place
   Dispatcher mutation or reverse the runtime-restart non-goal.
7. **The bot-state load contract contradicts its promised failure location.**
   C's Section 3 says non-ENOENT I/O errors reject under both policies; Section
   5.7 says they become empty at initialize. Actual `loadChatBots` catches all
   errors (`packages/channel/feishu-channel/src/chat-bots-store.ts:116-125`).
   Following the proposed API turns EACCES into a new Channel-start failure.
   Following the narrative instead requires a different API. Preserve the
   current policy at the owner and keep loading at first use; do not move its
   authority boundary earlier merely for symmetry with routing.
8. **Access's retained mutex has no extra operation to protect.** All five
   existing critical sections were read: `feishu-session-inbound.ts:116-118`,
   `183-190`, `247-262`, `296-351`, and `feishu-session-ops.ts:293-367`, under
   `packages/channel/feishu-channel/src/`. Each is a read, synchronous decision,
   optional write, and returned result; none sends a network response inside
   the lock. These fit the document transaction. The card send remains between
   two transactions (`feishu-session-inbound.ts:266-296`). Unlike Team's
   asynchronous post-commit roster publication, no second serialized obligation
   was found. Delete this mutex, as B proposes.
9. **Its stages are not independently shippable as written.** Stage 2 deletes
   `JsonDocumentStore`, while stage 3 still has to migrate its imports in
   `scheduler/store.ts:4,73` and `workflow-service/store.ts:5,35`. Stage 2's
   assertion that no old writer remains conflicts with stage 4 deleting the
   inline bot writer. Maintenance and gate work must accompany each deliverable,
   not wait for a final cleanup stage.
10. **Other factual corrections:** chat-bots has seven domain functions but
    four mutators, not seven/five: `observeKnownBot`, `trustIntroducedBots`,
    `clearBaselineIfCurrent`, and `recordBotAdded` at
    `chat-bots-store.ts:149-162,169-196,226-236,265-279` in the Feishu package.
    `server.ts:396-415` preflight is in the daemon process before activation,
    not a separate process like doctor. A provider batch can register one ref
    before another ref fails (`registry/provider-loader.ts:110-118,183-190`),
    so “a failed provider load rejects before anything is registered” is only
    true when scoped to that individual failed provider. A rejected candidate's
    newly warmed registry is not literally what restarting from the unchanged
    config file produces. The side effect can be acknowledged without that
    incorrect equivalence.

### Revised positions on the named divergences

| Point | Revised A position |
| --- | --- |
| Record lifetime without a live entity | Retain each successfully loaded identity, Team, and Workflow document in its domain scope for the daemon lifetime; evict only execution objects. One-shot reload or a permanently stateless identity reader would require narrowing the ignore-hand-edits guarantee. |
| Observing committed agents | Continue recommending a ConfigService read capability for dynamic consumers and one prepared committed value. Admit that a service-owned stable shared object can satisfy today's timing; reject arguments based on a nonexistent global “least code” ruling or on a claimed inevitable running-runtime mutation. |
| Exclusive creation | Keep create-only publication and document creation semantics; share the same implementation with the journal's initial create. Do not add a collision registry, and do not claim a normal generated-name race was proved. A per-document serialized update can simplify Team's valid-record decision, but it does not erase the journal caller or automatically preserve identity's no-clobber contract. |
| Team publication order | Change A to retain TeamStore's per-Team operation queue around document commit and awaited roster publication, including create. Remove A's generic post-commit hook/portion. Neither no ordering nor a Dispatcher-wide tail is warranted. |
| Unreadable chat-bots | Keep current catch-all initial default and cache that result; load at first existing consumer, not initialize. Non-ENOENT operation failure is an operator-owned behavior change, not a limit the utility should impose. |
| PR staging and Commands | Prefer three coherent PRs as specified below; adopt `config.agents.get` and `config.agents.replace`, returning `{ agents: [...] }` with empty secret values and whole-array replacement. No dispatchers, CLI verb, new authorization, or aliases. |
| fsync | Recommend preserving awaited atomic publication without adding fsync in this task, but ask the operator to confirm that meaning. If power-loss durability is intended, the post-rename failure contract must also be decided; it is not a one-line implementation tweak. |

The revised three PRs are:

1. **One publication backend plus shared document plus Feishu.** Move *all*
   atomic publication callers, including the journal's initial create, to the
   one utils backend. Delete the old Core writer file, utils writer body/name,
   and inline bot writer. Migrate all three Feishu documents and remove access
   mutex. Update the Feishu owning maintenance/KB references and change notes
   now. Core's existing domain stores can temporarily call the same publication
   backend through their current ownership; there are no parallel writer
   implementations or compatibility forwarding files.
2. **Core memory ownership.** Migrate identity, Team, cron, and Workflow and
   their query/recovery paths. Retain stable record handles across service
   eviction; remove competing snapshots. Delete `JsonDocumentStore` only after
   its final cron/Workflow caller moves. Retain Team's domain queue and journal
   append behavior. Update the matching maintenance/product/KB records now.
3. **ConfigService and Commands.** Reuse the established store, share startup
   preparation, retain raw Dispatcher JSON, implement secret retention, and
   wire current reads. Update config maintenance and change notes here. Start
   this PR only after both infrastructure PRs meet all four gates.

Every PR runs build, lint, test, and `typecheck:tests`; the relevant KB delta
also runs `.agents/scripts/check.sh`. Staging is a technical delivery choice,
not permission to leave the final architecture with raw-document write bypasses.
The final exception is the journal's initialization, because it is not a mutable
JSON document and is expressly outside the document migration.

For Commands, the closed outer `{ agents }` envelope and the loader's entry
validation are enough for input; provider configuration remains opaque. A closed
output projection can describe host-owned `id`/`provider`/optional `config`
without reimplementing provider validation. Return the redacted value committed
by that invocation. Match secret preservation by Agent id and nested JSON path,
and retain the already-ruled empty-string convention; C's suggestion to ask
whether the front end accepts empty strings would reopen an explicit decision.

### Remaining material disagreements and who decides

**Operator-owned behavioral decisions:**

* **Authority after live-object eviction versus retained-memory cost.** My
  recommendation preserves the requirement's daemon-lifetime wording; B/C's
  one-shot/dead-run approaches reduce retained memory but allow a later read to
  accept disk changes. This affects list/status, reopen, and failure recovery.
  If the operator intends authority only while a live entity holds a store,
  record that narrower guarantee and its visible consequences. Source alone
  cannot decide that product trade-off. Even under that narrower choice, readers
  of an actually live entity must use its existing owner; the current contrary
  premise is a factual defect, not an option.
* **First-load chat-bots I/O failure.** Keep today's empty default, or change
  that operation to fail and require successful reading before mutation. I
  recommend preservation in this refactor. A new Channel-start failure is not
  an equivalent version of either choice.
* **Meaning of “先确保落盘”.** Confirm atomic publication versus power-loss
  durability. No fsync recommendation becomes an operator ruling by consensus.
  The latter choice must also specify what a directory-sync failure after
  rename means, since the previous file cannot be promised unchanged.

**Technical disagreements for the final design, not new product questions:**

* Explicit config read capability versus the service owning a stable shared
  object. Both can implement the current timing. I prefer removing the separate
  publication/aliasing obligation; B/C prefer a smaller wiring diff. Whichever
  is selected must publish through the shared store and preserve raw Dispatcher
  JSON, not implement a second Config transaction.
* How much of create-only publication the document API exposes. The journal's
  actual caller and identity's current no-clobber behavior must be addressed.
  They cannot disappear because a primitive interface omitted them. Removing
  a user-visible collision refusal would become an operator question if someone
  still proposes it after tracing all affected entry points.
* Team domain queue versus a generic post-commit facility. I now favor B's
  domain queue, with a precise retained-mechanism count. A generic facility is
  not needed by Config or Feishu and should not be added just to remove one
  existing domain operation queue.
* Whether the completed migration actually includes cold identity/Workflow
  query paths, Config's transaction, access's mutex removal, and the journal
  helper callsite. These alter implementation boundary and risk substantially;
  they are not naming differences or optional cleanup.
* PR grouping and `get/replace` versus `get/set` or `read/write` names. These
  remain ordinary engineering/API naming decisions within the confirmed
  complete-agents contract. A future required client contract would change that
  status; no such client implementation is in this task.

No review findings above rely on a green test run: this was a source review,
and no tests or live services were run. The prior shallow-history and external
package-consumer limits remain. The SDK concurrency uncertainty was resolved
from installed source in round one; no live event-timing claim is made.
