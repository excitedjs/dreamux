# Solution C — one transactional document layer, then a Config Service on top

Independent proposal, seat C. Every structural claim below was read in
source on 2026-09-19; file:line evidence is inline. Anything not traced is
listed in §11 as unverified rather than asserted.

## 1. The decision in one page

**Two primitives, one package.** `@excitedjs/dreamux-utils` gains:

1. `writeJsonAtomic(path, data, { mode, exclusive })` — the single sibling-
   tmpfile + rename writer, with an `exclusive: true` mode (tmpfile + `link`,
   returns `false` on `EEXIST`) for create-only publishers. It absorbs the
   three implementations that exist today (Core
   `packages/dreamux/src/platform/atomic-write.ts:14,39`, utils
   `packages/dreamux-utils/src/fs.ts:19`, inline copy
   `packages/channel/feishu-channel/src/chat-bots-store.ts:128`).
2. `TransactionalDocument<TDoc>` — one file, one in-memory value, one promise
   tail: `load()` reads exactly once, `commit(mutator)` clones the current
   value, mutates the clone, durably writes it, and only then publishes it as
   `current`. This is the `FeishuRoutingStore` shape
   (`packages/channel/feishu-channel/src/routing/store.ts:56-143`) generalized,
   with parse/empty/serialize policies injected by the owner.

**Deletions:** `platform/atomic-write.ts`, `platform/json-document-store.ts`,
the utils `writeAtomic` (folded into the merged writer), and the inline
chat-bots atomic copy. None survives beside the new layer.

**Migrations split by what actually changes:**

| Store today | After |
|---|---|
| `AgentRuntimeStateStore` — memory + file-first, own tail (`service/agent-entity/runtime-state.ts:69-187`) | Tail/draft/write replaced by one `TransactionalDocument`; generation leases stay on the owner |
| `AgentIdentityStore` — stateless file writer, exclusive create, directory occupancy (`service/agent-entity/identity-store.ts:114-249`) | **Stays stateless**; only its two write calls move onto `writeJsonAtomic`. It gains no memory (see §5.1) |
| `TeamStore` — re-reads every op, disk-merge anti-resurrection (`service/team-collection/store.ts`) | One `TransactionalDocument` per dispatcher, loaded once at dispatcher start; exclusive file create stays the publication acceptance point; anti-resurrection becomes the single in-memory owner |
| `CronJobStore` — promise tail, re-reads every op (`service/scheduler/store.ts:72-214`) | One `TransactionalDocument` per scope, loaded in `SchedulerService.start`; `deleteStoreFile` becomes unlink + memory clear inside the same tail |
| `WorkflowRunStore` + `WorkflowRun` — per-run file, mixed memory/file order (`service/workflow-service/store.ts`, `run.ts`) | One `TransactionalDocument` per live run, created exclusively; all progress writes flip to file-first; dead-run reads stay disk reads |
| `FeishuRoutingStore` — already the model | Re-expressed on `TransactionalDocument`; behavior unchanged |
| `access.json` — free functions, lazy per-op reads, access mutex (`feishu-gate-io.ts`) | One document instance per session, **lazily loaded at the first gated op** (never at start), fail-loud policy unchanged |
| `chat-bots.json` — free functions, seven unlocked read-modify-writes, every read error swallowed | One document instance per session, loaded at `initialize()` with the **same lenient policy the file has today**; every mutation goes through the one commit tail |

**Config Service.** Core gains a `ConfigService` in `config/` that owns
`config.json` while the daemon runs and two process-level Commands
(`config.agents.get`, `config.agents.set`) beside `server.status`. A write
merges empty secrets against the held raw config, feeds the resulting
**whole document** (new `agents` + the held `dispatchers`) through the exact
loader path the next start uses — including loading not-yet-loaded providers —
writes the file durably, and only then replaces `config.agents` **on the same
`DreamuxConfig` object** `Server`/`Dispatchers`/every `DispatcherService`
already hold by reference. `resolveAgent` reads `config.agents` at every
launch (`service/agent-entity/agent-config.ts:27-47`), so the next launch uses
the new value with no rewiring and no subscriber.

## 2. The end-to-end behavior

### 2.1 Storage behavior (all migrated stores)

- After `load()`, reads are answered from memory. Hand edits, damage, or
  deletion of the file while the daemon runs are not observed; the next
  commit rewrites the whole file.
- `commit()`: enter the per-file tail → `structuredClone(current)` → run the
  owner's mutator against the clone → serialize → `writeJsonAtomic` → assign
  the clone as the new current → return it. A mutator that signals
  "no change" skips the write.
- A failed write leaves the current value untouched; the promise rejects and
  the caller's operation fails. The tail itself always continues (the
  `then(ok, err)` flatten pattern every existing copy uses).
- `drain()` awaits the settled tail at session/service close so no queued
  commit is abandoned (routing store precedent,
  `routing/store.ts:139-142`).
- Reads return the stored reference under a read-only contract; owners clone
  at their own API edges exactly as they do today. The draft isolation is
  what protects a reader holding a snapshot across a later commit.

### 2.2 Config Commands behavior

`config.agents.get` (no input):

- Returns `{ agents: AgentEntry[] }` in **file shape** — `{ id, provider,
  config }` — the shape `stringifyConfig` emits
  (`config/config.ts:145-168`), reconstructed from each agent's
  `rawConfig ?? config`.
- Every value whose key names a secret is returned as an **empty string**.
  The key-name rule is the existing `isSecretKeyName`
  (`dreamux-utils/src/redaction.ts:117-119`); the emission is `''`, not
  `'<redacted>'`, because the recorded ruling is "调用方表现为 input 是空的，
  但是可以写入" and acceptance says "every secret value empty". A new walker
  sets secret-keyed values to `''`; it lives beside `redactSecretKeyValues`
  in `dreamux-utils` (same key rule, different emission, one caller each).
- `dispatchers` is not present anywhere in the result.

`config.agents.set({ agents })`:

1. Enter the Config Service's single tail.
2. Merge secrets against the held **raw** document: walk the payload and the
   held raw agents in parallel; wherever the payload has `''` at a
   secret-keyed field and a non-empty raw value exists for that field, keep
   the held raw value. Anything non-empty replaces. The merge is at raw
   level because the file is re-emitted from `rawConfig`
   (`config.ts:150`); merging parsed values would silently rewrite
   hand-authored fields the provider normalizes.
3. Assemble the candidate whole raw document: `{ agents: merged,
   dispatchers: <held dispatchers in file shape> }`, where the dispatcher
   half comes from the same mapping `stringifyConfig` uses
   (`config/config.ts:152-165`), exposed by extracting that mapping into a
   `toConfigFileShape(config)` helper that `stringifyConfig` itself calls
   (§6.2). The held in-memory `config.dispatchers` therefore round-trip
   through the loader unchanged; the Command never parses dispatcher
   semantics.
4. Validate it through the extracted loader path (§6.2): provider loading
   (`loadAgentRuntimeProviders`/`loadChannelProviders`) and
   `mergeWithDefaults`/`readAgents`/`readDispatchers`, against the process
   registry with the same importer overrides `loadConfig` used. This makes
   the next start's rules the write's rules — duplicate agent ids, bad refs,
   unrunnable implementations, provider `config.read` failures, and an
   `agentRuntime` naming a removed agents id
   (`config/config.ts:475-502`) all reject here with the loader's own
   messages. An id only existing Teams/TeamMates name is not seen by this
   check and is allowed, per ruling.
5. On validation success: `writeJsonAtomic(configFile,
   stringifyConfig(validated), { mode: 0o600 })`.
6. Only after the write settles: replace `config.agents` in place with
   `validated.agents`, and refresh the embedded `dispatcher.runtime`
   snapshots from the new agents map (§6.4).
7. Return `{ agents: <redacted file-shape agents> }`, identical in shape to
   `get`'s output.

Any failure at steps 2–5 rejects the Command; file and memory are both
unchanged. A running runtime keeps its resolved configuration; the next
launch resolves through `config.agents` and picks up the replacement
(`teammate-service/runtime-owner.ts:333` calls
`resolveAgent(config, …)` per attempt).

Both Commands are process-scoped: no `dispatcher_id` addressing (same class
as `server.status`, `server-commands.ts:29-52`), registered once in
`command/catalog.ts`, and therefore reachable identically over `admin.sock`
and through a Channel's in-process `invoke`. Core adds no authorization.

## 3. The transactional primitive (exact shape)

New file `packages/dreamux-utils/src/document-store.ts`, exported from
`packages/dreamux-utils/src/index.ts`:

```ts
export interface JsonDocumentIo<TDoc> {
  /**
   * Parse one file's JSON into the document. Throw when the content is a
   * version/shape this build refuses to accept. The owner supplies the error
   * vocabulary; this layer throws it unchanged.
   */
  parse(raw: unknown, path: string): TDoc;
  /**
   * The document when the file is absent. Required: every Dreamux document
   * has a defined empty state.
   */
  empty(): TDoc;
  /** Defaults to JSON.stringify(doc, null, 2) + '\n'. */
  serialize?(doc: TDoc): string;
}

export interface JsonDocumentLoadOptions {
  /**
   * 'throw' (default): an unreadable or malformed file rejects load().
   * 'empty': log via `warn` and start from empty() — only for files whose
   * current behavior already degrades to empty (chat-bots). The named
   * scenario is a file that is not security- or routing-critical.
   */
  corrupt?: 'throw' | 'empty';
  warn?: (message: string) => void;
}

export class TransactionalDocument<TDoc> {
  constructor(path: string, io: JsonDocumentIo<TDoc>, mode?: number);
  load(options?: JsonDocumentLoadOptions): Promise<TDoc>;
  get current(): TDoc;                    // throws before load
  commit(mutate: (draft: TDoc) => void | boolean): Promise<TDoc>;
  /** Replace wholesale, still file-first through the same tail. */
  replace(next: TDoc): Promise<TDoc>;
  /**
   * Remove the backing file and reset to empty() inside the commit tail, so
   * a mutation racing a removal cannot recreate it (cron dissolve scenario).
   */
  remove(): Promise<void>;
  drain(): Promise<void>;
}
```

Properties of the contract:

- **No `version` field, no `LegacyStateError`, no `corruptPolicy` enum of the
  old store.** The deleted `JsonDocumentStoreOptions`
  (`platform/json-document-store.ts:8-14`) made the primitive own the
  version check and the fail/warn policy. Version checking is a sentence in
  each owner's `parse` (cron's `STORE_VERSION`, routing's
  `FEISHU_ROUTING_DOCUMENT_VERSION`, the v3 access shape), and the error
  vocabulary is the owner's — Core throws `LegacyStateError`
  (`service/legacy-state.ts`), the Channel throws its own messages. The
  unused `warn-rebuild` branch (`json-document-store.ts:42-47` has zero
  non-test callers) is not carried over.
- **`parse` receives ENOENT as `empty()`, never as a call.** The wrapper
  reads the file; only "present but unacceptable content" reaches `parse`.
  A real IO error other than ENOENT rejects `load()` under both policies.
- **One tail per file.** The writer promise is the serialization mechanism;
  owners do not keep their own queue (CronJobStore's `writes`,
  routing store's `tail`, AgentRuntimeStateStore's `mutationTail` all
  collapse into it).
- **Mode defaults to `0o600`.** Every migrated file is 0600 today.
- The writer (`writeJsonAtomic`) creates the parent directory (mode
  best-effort, matching Core's current `mkdir -p` in
  `platform/atomic-write.ts:20`); owner-only directory policy remains the
  owner's call — the Feishu session keeps `ensureOwnerOnlyDir` before its
  commits, as `routing/store.ts:126` does today. No host path/layout contract
  enters utils: the primitive takes a full path and bytes, exactly like
  `fs.ts` today.

`writeJsonAtomic` signature:

```ts
export async function writeJsonAtomic(
  path: string,
  data: string,
  options?: { mode?: number; exclusive?: boolean },
): Promise<boolean>;
```

- `exclusive` omitted/false → replace write, returns `true`.
- `exclusive: true` → create-only via tmpfile + `link`; returns `false` on
  `EEXIST`, exactly the current `writeFileExclusiveAtomic`
  (`platform/atomic-write.ts:39-62`). This is retained, not invented: the
  Team record publication (`team-collection/store.ts:152-159`), identity
  creation (`identity-store.ts:191-199`), workflow run creation
  (`workflow-service/store.ts:46-53`), and journal creation
  (`workflow-service/journal.ts:58-65`) all depend on create-only publish
  as an acceptance protocol.

## 4. Change boundary

**`@excitedjs/dreamux-utils`**

- Add `src/document-store.ts` (the class + options above).
- Replace `src/fs.ts`'s `writeAtomic(dir, filename, …)` with
  `writeJsonAtomic(path, …, { exclusive })`. The only callers are Feishu
  access (`feishu-gate-io.ts:91`), Feishu routing (`routing/store.ts:127`),
  and — after this change — the new document layer; all are updated in the
  same task. The "parent dir must exist" rule moves to the writer (mkdir
  parent), and callers that need owner-only dirs continue to call
  `ensureOwnerOnlyDir` first.
- Add the empty-string secret walker next to `redaction.ts:128`
  (`emptySecretKeyValues(value): void`), sharing `isSecretKeyName`.
- Tests for tail ordering, file-before-memory, failed-write immutability,
  exclusive collision, draft isolation, drain.

**`@excitedjs/dreamux`**

- Delete `src/platform/atomic-write.ts` and
  `src/platform/json-document-store.ts`.
- `config/config.ts`: extract the post-read half of `readConfigFile`
  (provider loading + document parse) into an exported entry point the
  Config Service calls; `readConfigFile` keeps file existence, mode check,
  and JSON parsing, then calls it.
- Add `config/config-service.ts`.
- Add `src/config-commands.ts` (process-level Commands; mirror
  `server-commands.ts`), register in `command/catalog.ts`, extend
  `CoreCommandHost` (`command/host.ts:17-37`) with one member: the
  `ConfigService`.
- Server wiring (`server.ts`): construct the Config Service in the
  constructor with the loaded path, the live `config` object, the
  `providerRegistry`, and the importer overrides; expose through
  `commandHost()` (`server.ts:209-218`). `cli/server.ts` passes
  `configFile` into `ServerOptions` (today it discards it after logging,
  `cli/server.ts:56,69`).
- Store migrations: `agent-entity/runtime-state.ts`,
  `scheduler/store.ts`, `team-collection/store.ts`,
  `workflow-service/store.ts` + `run.ts` + `journal.ts`,
  `agent-entity/identity-store.ts` (write calls only).
- Maintenance skill + `.agents/` updates (§9).

**`@excitedjs/feishu-channel`**

- `routing/store.ts` re-expressed on the primitive.
- `feishu-gate-io.ts` free functions become operations on a per-session
  access document (lazily loaded); the gate's decision logic in
  `feishu-gate.ts` is untouched.
- `chat-bots-store.ts` free functions become operations on a per-session
  chat-bots document loaded at session `initialize()`.
- `feishu-channel.ts` constructs and owns both documents, hands them to the
  inbound/ops modules (which already receive a session handle with
  `stateDir`), and drains them at close (alongside the existing routing
  drain, `feishu-channel.ts:332`).
- The package's dependency set is unchanged: the primitive is in
  `dreamux-utils`, which it already depends on.

No changes to any persisted file's shape, path, name, or mode. No CLI verb.
No Core authorization. No volatile store kind.

## 5. Per-store migration designs

### 5.1 Live agent identity — `AgentRuntimeStateStore` + `AgentIdentityStore`

Greenfield shape: one live owner per running entity holding the identity in
memory and writing through one serialized transactional document. The live
half already is that (`runtime-state.ts`): `mutationTail`, `current()`,
leases. Change: replace its private tail-and-write with a
`TransactionalDocument<AgentEntityIdentity>` constructed from the loaded
identity; `update`/`transact` become `commit` calls that build the updated
record via the existing field merge. The identity is written by
`AgentIdentityStore.update` today *inside* the state store's tail
(`runtime-state.ts:161-166,173-176`); after the change the document **is**
the writer, so `AgentIdentityStore`'s update/upsert methods are no longer
reached from the live path.

`AgentIdentityStore` deliberately **does not** gain memory:

- Its readers are cold by construction: `AgentEntityCollectionStore.list()`
  scans directory names (`identity-store.ts:293-305`), `AgentNameRegistry`
  walks the namespace (`identity-store.ts:331-349`), read models and roster
  readers construct throwaway instances
  (`team-collection/read-model.ts:145`, `roster-reader.ts:49`,
  `dispatchers/index.ts:88`, `server.ts:403` preflight). A dispatcher-wide
  identity cache would have to stay coherent with writers that have no live
  owner.
- Its writers without a live owner are real: entity creation
  (`teammate-collection/index.ts:481`), TeamLeader creation
  (`team-service/leader-agent.ts:175`), Dispatcher Agent preparation before
  the service exists (`dispatcher-service/identity.ts:87,119`), and closing
  members that are not held during a dissolve
  (`teammate-collection/dissolve-members.ts:47`).
- The settled existence fact is the **directory name**, by design
  (`src/service/CLAUDE.md`: "a directory name stays occupied even when its
  identity is unreadable, and identity creation is no-clobber"). That
  contract does not move.

So `AgentIdentityStore` keeps its lenient read semantics (missing → null,
Legacy rethrow, other parse failure → warn + null,
`identity-store.ts:134-161`) and swaps only its two write primitives:
exclusive create (`writeJsonAtomic(..., { exclusive: true })`) and replace.
This is the smallest change that honors "the live identity is
memory-authoritative, the durable identity stays a no-clobber file".

The one `transact` caller (`teammate-service/runtime-owner.ts:217`, reopen a
deleted managed-worktree leader) must keep its durable-before-memory
guarantee: its callback writes the reprepared identity via `identities`
inside the transaction. When the live state store owns the document, that
nested write is expressed as "build the candidate and let the document
commit it" — the reprepare function returns a candidate identity instead of
writing one, and `transact` commits it file-first. Verified: this is its
only `transact` caller (grep, non-test).

### 5.2 Team record — `TeamStore`

Greenfield shape: one owner per dispatcher holding every Team record in a
`TransactionalDocument<Record<teamId, TeamRecord>>` over... today's layout is
one file per Team (`team/<team>/record.json`). **The on-disk layout does not
change** (path/shape constraint). The in-memory document is therefore a
**map loaded from the per-team directory**, while commits continue to write
one `record.json` per Team. The generic primitive writes one file; the Team
collection needs a small owner class around it:

- `load()`: scan `root` (same scan `list()` does today,
  `team-collection/store.ts:100-117`), parse each `record.json` with the
  existing `readTeam` rules (store.ts:282-305); malformed entries occupy
  nothing, exactly as today's `get()` returns null for them. This is a
  directory-derived document, loaded once.
- `get`/`list` answer the map after load; `validateTeamId` still throws on a
  bad id (store.ts:86).
- `create`: inside the one commit tail — check the map (the name is free),
  `writeJsonAtomic(recordPath, ..., { exclusive: true })`; on EEXIST re-read
  that one file: valid record → return null (name taken, same three-outcome
  protocol, store.ts:119-162); residue → replace write — then publish into
  the map and fire `publishRecordState`. The exclusive publish remains the
  atomic acceptance point across crashes; the in-memory check is what stops a
  duplicate publish inside the process.
- `update`: inside the tail, merge against the **map entry**, not a fresh
  file read; missing → `TeamNotFoundError` (store.ts:181-186); write the
  per-team file first, then update the map entry and publish. The old
  anti-resurrection comment (store.ts:177-180) is superseded knowingly:
  under the single-server model (admin lock) with one in-memory owner per
  dispatcher, a dissolved Team is removed from the map inside its own
  commit and cannot be resurrected by a stale snapshot, because the only
  writer is the map owner. A hand deletion while running no longer frees the
  name — the operator accepted this (rulings 2026-09-19, product catalog
  "Team record is the only existence fact").
- Closed-team worktree recovery, accepted-request replay, and name
  allocation currently scan disk
  (`team-collection/index.ts:184,291`, and `allocateName` via `store.get`).
  After migration they read the loaded map; `load()` runs from the
  dispatcher input-source start, which already calls
  `teams.recoverWorktreeCleanup()`
  (`input-source-lifecycle.ts:267`) and `scheduler.start()` (:280) — add the
  Team store load there, before recovery. Before load, `get/list` throw
  "used before loaded" (same stance as routing store,
  `routing/store.ts:101-104`).
- **Standalone disk readers stay.** `server.ts:398-410` startup preflight and
  `cli/doctor.ts:156-171` run in separate processes and must not instantiate
  the live owner. Extract the current pure scan (`list()` + `readTeam`) into
  an exported read-only `readTeamRecords(root, dispatcherId)` that both the
  live `load()` and the preflight/doctor use. The preflight's
  `detectLegacyCronJobStore` calls keep working unchanged.

### 5.3 Cron — `CronJobStore`

Greenfield shape is exactly `TransactionalDocument<CronJobFile>`:

- Constructed in the same two places (`dispatcher-service/index.ts:179`
  per-dispatcher; `team-service/collaborators.ts:110` per Team).
- `load()` in `SchedulerService.start` (`scheduler/service.ts:56-63`), which
  folds in today's `assertCurrent()` semantics: parse with `parseCronJobFile`
  (throws `LegacyStateError`, `scheduler/store.ts:229-269`) and
  `assertCronJobSemantics` (:299-313). A malformed file therefore keeps
  failing **at Dispatcher start / Team open**, where it fails today — the
  failure location does not move.
- `list/get/create/update/setFired` operate on the memory document inside
  `commit`; the `maxJobs` check and `updated_at` handling move into the
  mutator unchanged (store.ts:101-181). Results keep being cloned at the API
  edge (`cronJobResult`, :417-432).
- `deleteStoreFile()` (:183-196) becomes `document.remove()`: `unlink` with
  ENOENT tolerated **then** reset to empty, both in the one tail. The
  comment's race guarantee holds verbatim: a `setFired` ordered before the
  delete commits first and is unlinked; one after sees an empty document,
  finds no job, returns null, and never writes.
- `detectLegacyCronJobStore` (:216-227) stays a standalone disk parse used
  by server preflight and doctor — it must not require a loaded live store.
  It parses directly with `parseCronJobFile` + semantics over the path (no
  `JsonDocumentStore`).

### 5.4 Workflow run record

- A live `WorkflowRun` owns one
  `TransactionalDocument<WorkflowRunRecord>` over its run file.
  `WorkflowRunStore.create`'s exclusive create
  (`workflow-service/store.ts:43-54`) moves to the run's initialization:
  `load()` starts from empty and the first commit uses
  `writeJsonAtomic(..., { exclusive: true })`, throwing the same "already
  exists" error on collision. A recovered run loads its file instead.
- **Ordering flip (the recorded consequence).** Today `handleAgentStart`
  pushes to memory *before* entering the tail (`run.ts:301-303`), and
  `emit` mutates inside the tail before journal append and store write
  (`run.ts:224-237`). After: the record mutation happens on the commit draft
  inside the tail, the journal append and file write happen, then the draft
  publishes. `workflow_status` therefore no longer shows progress that is
  not durable — the TeamLeader-recorded consequence — and a failed write
  leaves the live record on its last durable value. `finalize` is already
  file-first (`run.ts:625-626` pattern) and just adopts the primitive.
- Journal stays append-only (`journal.jsonl`) — an explicit non-goal. Its
  only replace-write dependency is the exclusive create
  (`journal.ts:58`), which uses `writeJsonAtomic(..., { exclusive: true })`.
  `appendJsonLine` is untouched.
- Dead-run reads stay disk reads: `WorkflowService.status` falls back to
  `store.get` and `list` merges a directory scan
  (`workflow-service/index.ts:197-206,211-223`), because recovery
  (:243-247) and queries on finished runs must work with no live owner.
  `WorkflowRunStore` keeps the parse/scope validation (`store.ts:94-182`)
  as the cold reader; the live run's document uses the same `parseRecord`.
  `JsonDocumentStore` disappears from this file.

### 5.5 Feishu routing document

`FeishuRoutingStore` is the reference implementation of the target shape, so
the migration is mechanical: its private `document`/`tail`/`load`/`update`/
`drain` (`routing/store.ts:56-143`) become a `TransactionalDocument`
configured with the existing `validated()` parser (:145-194), ENOENT →
`emptyRoutingDocument`, the no-change mutator skip, and
`ensureOwnerOnlyDir` kept before the write. The header comment (:1-17)
becomes the primitive's contract. Behavior change: none intended; this
module's existing tests pin it.

### 5.6 Feishu `access.json`

- One `TransactionalDocument<DispatcherAccessStateV3>` per
  `FeishuChannelSession`, constructed beside the routing store
  (`feishu-channel.ts` ctor region, routing `store.load()` at :225).
- **Lazy load at the first gated op, never at initialize.** The invariant is
  explicit: an unreadable `access.json` must keep failing the operation that
  reads it and must not become a Channel/Dispatcher start failure
  (requirement, constraints). `load()` is awaited inside the first
  read/mutate operation; ENOENT → `defaultDispatcherAccessState()`
  (`feishu-gate-io.ts:54`), malformed/wrong-version → throw with the same
  `V3_FAIL_MSG` (:22-23,61-65), other IO errors → throw (:55).
- Reads (`isTrustedDispatcherUser`) answer `current.allow_users`. Today this
  read deliberately bypasses both memory and the mutex to re-read disk on
  every check (`feishu-gate-io.ts:94-112`); under the migrated model it reads
  the memory document. The old rationale — seeing a hand edit immediately —
  is superseded by the stated product rule: while the daemon runs, hand
  edits are not read and the next write overwrites them. Named knowingly.
- Writes: the session `_accessMutex` (`feishu-channel.ts:142`) stays, because
  it serializes **decisions** larger than one file write (read pending →
  validate token/card → mutate → respond; e.g.
  `feishu-session-ops.ts:291-333`). The document's own tail serializes the
  commit; nested ordering is harmless. Each of the five save sites
  (`feishu-session-ops.ts:333`, `feishu-session-inbound.ts:187,251,328,350`)
  becomes a `commit` that mutates the draft; the v3 write-time refusal
  (`feishu-gate-io.ts:77-79`) is structural — the parser only ever produces
  v3, and draft fields are typed, so it is deleted with the saver.
- `drain()` joins session close next to the routing drain
  (`feishu-channel.ts:332`).

### 5.7 Feishu `chat-bots.json`

- One `TransactionalDocument<ChatBotsState>` per session, loaded at
  `initialize()` next to `store.load()` (`feishu-channel.ts:225`).
- **Load policy stays lenient.** Today `loadChatBots` swallows every error
  to an empty store (`chat-bots-store.ts:116-126`), and the file is
  documented non-security-critical (:111-115). Failing loud at initialize
  would invent a new Channel-start failure for exactly the file the current
  release treats most loosely — a moved failure location, which the
  requirement forbids. So `load({ corrupt: 'empty', warn })` keeps
  ENOENT/parse/IO degradation to `defaultChatBotsState()`, and the existing
  `normalizeChatBots`/`normalizeEntry` coercion (:289-323) remains the
  parser. The one behavior this *does* remove is the real data-loss race
  named in the inventory: a failed read followed by a save replacing the
  file with an empty one — after `load()` the empty state is established at
  most once, at session start, never mid-session.
- The seven functions (`observeKnownBot`, `trustIntroducedBots`,
  `pendingBaseline`, `clearBaselineIfCurrent`, `listChatBots`,
  `trustedBotIds`, `recordBotAdded`, :149-280) become document operations:
  reads answer memory; the five mutators are one `commit` each, so writes
  are serialized (acceptance criterion) and the generation-safe clear
  (`clearBaselineIfCurrent`, :226-237) is checked against the draft inside
  the tail, which makes it race-free without re-reading.
- Callers (`feishu-channel.ts:279,559`,
  `feishu-session-inbound.ts:125,139,165,471,485,553`,
  `tools/messaging-tools.ts:141`) receive the document through the session
  handle they already use.

## 6. Config Service design

### 6.1 Ownership and construction

`config/config-service.ts`:

```ts
export class ConfigService {
  constructor(opts: {
    configFile: string;
    config: DreamuxConfig;            // the live shared object
    registry: ProviderRegistry;
    importers?: Pick<ConfigPathOverrides,
      'externalAgentRuntimeModuleImporter' | 'externalChannelModuleImporter'>;
  });

  getAgents(): FileShapeAgent[];                 // redacted
  setAgents(agents: unknown): Promise<FileShapeAgent[]>;
}
```

One instance per `Server`, built in the constructor (the registry and config
exist there, `server.ts:167-207`). It owns no second config copy: `config` is
the same reference `Dispatchers` received. It owns a commit tail so two
concurrent Channel sets serialize whole (last whole-section write wins — the
ruling is "整份写回"; there is no field-level merge across requests and no
optimistic token in this version).

### 6.2 Loader extraction

Today `readConfigFile` (`config/config.ts:185-219`) does existence check →
mode check → read → JSON.parse → `loadAgentRuntimeProviders` →
`loadChannelProviders` → `mergeWithDefaults`. Extract:

```ts
export async function loadConfigDocument(
  parsed: unknown,
  file: string,
  registry: ProviderRegistry,
  overrides?: Pick<ConfigPathOverrides, ...Importer>,
): Promise<DreamuxConfig>
```

comprising the two provider loads and `mergeWithDefaults` (:208-218).
`readConfigFile` calls it after parsing; the Config Service calls it with
the candidate assembled in step 3 — the loader accepts a parsed document, so
no JSON serialization is needed for validation; serialization happens only
for the durable write. Existence/mode checks stay in `readConfigFile` (a daemon that is running has already passed them; the
write path creates a 0600 tmpfile and renames, so the result is 0600).
Because the candidate includes the held `dispatchers`, every dispatcher rule
runs too — duplicate channel providers, channel provider `config.read`,
`agentRuntime` resolution. `cwd`/workspace checks are intentionally absent:
the Commands cannot change dispatchers, and the next start's workspace
preflight (`Server.assertDispatcherWorkspaces`) reads nothing a write can
affect — matching the evidence played to the operator.

### 6.3 Provider loading side effects

`loadProviderPackages` permanently registers loaded implementations and
skips only an already-registered implementation (the loader the requirement
names). A set that references a new provider therefore loads it into the
process registry even if a *later* validation step rejects the write. This
is acceptable and is stated, not hidden: it is exactly the state the next
restart would produce, the registry is idempotent for already-loaded refs,
and the provider's catalogs (`AgentRuntimeProviderCatalog` wraps the
registry live, `agent-runtime/catalog.ts:42-49`) resolve the new agent from
the same registry once the write commits. A failed provider load rejects
before anything is registered.

### 6.4 The in-place commit

`DreamuxConfig` is one mutable object captured by reference at `serve`
→ `Server` → `Dispatchers.dispatcherOptions` → each
`DispatcherService` → `createTeammateService({ config })`
(`server.ts:239` passes `this.opts.config`; requirement evidence in
requirement.md). So after the file write:

```ts
config.agents = validated.agents;
for (const d of config.dispatchers) {
  const a = validated.agents[d.agentRuntime];
  d.runtime = { provider: a.provider, config: a.config,
    ...(a.rawConfig === undefined ? {} : { rawConfig: a.rawConfig }) };
}
```

Replacing the `agents` **property on the same object** (not swapping the
object) is what reaches future launches with no subscriber:
`resolveAgent` indexes `config.agents` fresh each call
(`agent-config.ts:32`). The `dispatcher.runtime` snapshots
(`config.ts:465-469`) are refreshed in the same commit because they have
live in-process readers — `provider-diagnostics.ts:53-73` and the onboard
config builder (`onboard/config-files.ts:53-111`) — and leaving a stale
second copy would reintroduce the two-copies problem the operator
explicitly rejected ("2 这个点…"). Running sessions' copied channel
credentials and running runtimes' resolved configs are deliberately not
touched ("下次拉起时生效").

### 6.5 Commands

`src/config-commands.ts` contributes two definitions (version 1), following
`server-commands.ts` literally:

- `config.agents.get`: `NO_INPUT`; output
  `objectSchema({ agents: arrayOf(OBJECT) }, ['agents'])`. Each entry is an
  object because its `config` is provider-owned opaque data — the same
  rationale `command/schema.ts:12-16` gives for rich domain DTOs; Core's
  JSON canonicalization still applies.
- `config.agents.set`: input
  `objectSchema({ agents: arrayOf(OBJECT) }, ['agents'])`; output identical
  to `get`. The loader path is the real validation; the schema enforces only
  the closed envelope. Payload size/depth/entry bounds come from the
  existing Command transport limits; the agents section is small in
  practice, and no special cap is added without a scenario that reaches one.
- Registration: add `...configCommands(host)` to `createCoreCommandRegistry`
  (`command/catalog.ts:19-28`); add `config: ConfigService` to
  `CoreCommandHost` and its adapter in `server.ts:209-218`.
- Failure mode: validation failures are caller mistakes routed through the
  existing Command error path (`throwCallerMistake`), so the Channel sees a
  structured rejected Command rather than a process error; file-write
  failures surface as the Command failing (ruling: failed write fails the
  Command, supersedes the old "write a log" ruling).

## 7. What is reused, deleted, added

**Reused as-is:** structuredClone isolation pattern; promise-tail
flattening; exclusive tmpfile+link publish; `appendJsonLine` (journal);
`assertConfigFileMode`; `stringifyConfig`; `isSecretKeyName`; the routing
store's parser and empty-document policy; cron's file/version/semantics
parsers; workflow's `parseRecord`; the access v3 shape check; the chat-bots
normalizers; `KeyedAsyncQueue` (Team per-team ordering not needed after the
single tail — see below).

**Deleted (counts):**

1. `packages/dreamux/src/platform/atomic-write.ts` — both functions.
2. `packages/dreamux/src/platform/json-document-store.ts` — whole class; its
   version assumption, the unused `warn-rebuild` branch, and
   `assertCurrent`'s generic shape go with it.
3. `writeAtomic` in `packages/dreamux-utils/src/fs.ts` — folded into
   `writeJsonAtomic` (one merged implementation, one name).
4. The inline atomic writer in
   `packages/channel/feishu-channel/src/chat-bots-store.ts:128-138` and its
   `tmpCounter`.
5. The four private promise tails collapsed into the primitive:
   `CronJobStore.writes`, `FeishuRoutingStore.tail`,
   `AgentRuntimeStateStore.mutationTail`, `WorkflowRun.mutationTail`.
6. `TeamStore`'s per-team `KeyedAsyncQueue` (`store.ts:39`): the single
   collection tail plus per-team map entries replace it; the
   merge-against-fresh-file read and the replace-residue probe branch are
   reduced to the one create protocol described in §5.2.
7. `feishu-gate-io.ts`'s standalone reader/saver functions and the v3
   write-time re-validation; the seven chat-bots free functions become
   document operations (their normalizers stay).

Net concept count goes down: three atomic writers → one; four hand-rolled
tails + one keyed queue → one document tail; one version-aware generic store
→ one policy-neutral document plus owner parsers; two unlocked Channel
read-modify-write styles → one commit style.

**Added (each paid for by a ruling):** `TransactionalDocument`,
`writeJsonAtomic` (replacement, not a coexisting layer),
`emptySecretKeyValues`, `loadConfigDocument` extraction, `ConfigService`,
two Commands, the per-session access/chat-bots document instances. Nothing
is added for the volatile kind (explicit non-goal), for restart, or for
authorization.

## 8. Concurrency, lifecycle, compatibility, failure locations

- **Per-file serialization** is the document tail in every case, including
  chat-bots (acceptance) and access (tail inside the retained decision
  mutex).
- **Close/drain:** routing/access/chat-bots drain at session close
  (`feishu-channel.ts:332` region); cron/team/workflow documents live inside
  dispatcher/team aggregates that already fence and drain admitted work
  before stop (`service/CLAUDE.md`: "The operation is the fence").
- **Dissolve race:** cron `remove()` in-tail (§5.3) preserves the
  mid-dissolve setFired guarantee.
- **Team dissolve:** closing a Team removes its service; the record stays in
  the collection map with `status: closed`; worktree recovery reads the map.
  The Team cron file removal and the closed record commit order are
  unchanged (`team-service/closing.ts:252-254`).
- **File compatibility:** every parser is byte-for-byte the released
  parser — cron v1, routing version constant, identity v1 +
  `assertNoRemovedRecordFields`, Team `readTeam`, workflow v1, access v3,
  chat-bots normalize, config via the unchanged loader. No file is renamed,
  reshaped, or re-moded; `config.json` writes stay 0600.
- **Failure locations (explicit map):**
  - `access.json` unreadable → first gated op rejects; Channel start
    unaffected (lazy load).
  - routing document unreadable → session initialize fails as today
    (`routing/store.ts:69-97`).
  - cron unreadable → Dispatcher start / Team open fails as today
    (`scheduler/service.ts:62`).
  - Team records: individual malformed record → skipped/null as today; no
    new start gate introduced.
  - chat-bots unreadable → empty at initialize with a warning (today's
    behavior preserved; §5.7).
  - identity files → lenient entity reads, Legacy rethrow, unchanged
    (`identity-store.ts:134-161`).
  - config write validation → Command rejection; config file write failure
    → Command failure, daemon keeps running on the old memory.
- **No migration code, no `BREAKING:` notes.** Nothing changes shape/path/
  mode; change files describe the storage refactor and the new Commands
  plainly (`minor`, Rush 0.x rule).

## 9. Skill, knowledge base, change notes

- `skills/dispatcher/dreamux-maintenance/SKILL.md` routing row and
  `references/config-envelope.md`: state that while the daemon runs the
  Config Service owns `config.json`; `agents` are viewable/replaceable
  through the Commands (via the Channel/admin port); `dispatchers` stays a
  stopped-daemon hand edit; stop the daemon before any hand edit or
  `dreamux onboard`, because the next Command write rewrites the whole file
  from memory (covering both sections). The reference remains
  current-state-only per the config/state sync rule: one accepted shape, no
  migration/history content.
- `.agents/domains/state-config-and-files.md`: document the single
  transactional document kind and the store ownership/lifecycle table.
- `.agents/domains/service-topology.md` and the
  service-topology-foundations task record carry the drift the inventory
  found (they name removed stores and say collections build no identity
  stores while several do); correct in this change's KB delta.
- `.agents/domains/channel.md`: access/chat-bots per-session document
  ownership and lazy-load failure location.
- Rush change files: `@excitedjs/dreamux-utils` (new export),
  `@excitedjs/dreamux` (store refactor + Commands),
  `@excitedjs/feishu-channel` (document stores); plain notes, no
  `BREAKING:`. Run `.agents/scripts/check.sh`.

## 10. Staging (infrastructure first; each stage independently shippable)

1. **Utils layer:** `writeJsonAtomic` (replace + exclusive),
   `TransactionalDocument`, `emptySecretKeyValues`; full unit tests. No
   callers changed yet except utils' own `fs.ts` re-export kept until stage 2
   lands in the same PR.
2. **Core writer cutover + deletions:** delete `platform/atomic-write.ts`
   and `platform/json-document-store.ts`; move identity, Team exclusive
   publish, workflow run create, and journal create onto
   `writeJsonAtomic`; re-express routing store on the document. After this
   stage no old writer exists.
3. **Memory migrations:** cron → document (plus standalone legacy parse),
   Team collection document + cold `readTeamRecords` + start-time load,
   workflow run file-first ordering flip, AgentRuntimeStateStore document.
4. **Channel documents:** access (lazy) and chat-bots (initialize)
   per-session documents; drain wiring; remove the inline writer.
5. **Config Service:** loader extraction, `ConfigService`, two Commands,
   Server wiring, secret/empty-secret handling, in-place commit.
6. **Skill, KB, change files, gates** (`build`, `lint`, `test`,
   `typecheck:tests`). Stages 1–4 are the storage prerequisite the operator
   ordered before the Config Service; stage 5 starts only after 4 is green.

## 11. Verification mapped to the acceptance criteria

1. *Memory reads / file-before-memory / failed write leaves memory and fails
   op* — unit tests per migrated store against a fault-injecting writer
   (force rename failure): assert file untouched, memory unchanged,
   operation rejects; commit-order test proving a later reader never sees an
   unpersisted value. Covers cron, Team, workflow, routing, access,
   chat-bots, Config Service.
2. *chat-bots writes serialized* — interleave five mutators; assert one
   final file and no lost entry (the exact race free-function load/save had).
3. *Current-release state files and config.json load unchanged* — fixtures
   freeze: v1 cron, routing current version, identity v1, Team record,
   workflow v1, access v3, chat-bots v1, and a real-shaped config.json all
   parse through the new owners; plus removed-field/Legacy fixtures still
   fail loud.
4. *unreadable access.json does not fail Channel start* — initialize a
   session with a corrupt access file present; assert start succeeds and the
   first gated op fails with the v3 message; ENOENT starts from defaults.
5. *Channel-port read returns whole agents with secrets empty* — Command
   test through the registry with config containing secret-keyed fields at
   multiple nesting depths; assert `''` values and no dispatchers key.
6. *failed validation / failed file write changes neither* — inject bad
   provider ref and a writer fault; assert rejection, on-disk file bytes
   unchanged, `config.agents` unchanged.
7. *removing a dispatcher-named agent rejects* — config with one dispatcher's
   `agentRuntime`; set without that id; assert loader error naming it;
   removing an id only a Team identity references succeeds.
8. *valid agents change is durable on return and used at next launch
   without restart* — set, assert file content parses to the new value, then
   resolve through `resolveAgent(config, …)` (the runtime-owner path) and
   assert the new provider config; a pre-resolved "running" copy is
   unaffected.
9. *empty secret keeps stored raw secret* — set with `''`; assert the file
   retains the previous raw value (raw byte-level assertion for the secret
   field) and a non-empty value replaces it.
10. *no Command reads/writes dispatchers* — schema assertion + test that a
    set payload cannot alter dispatcher file content and get output has no
    dispatchers.
11. *maintenance skill states ownership and stop-first* — doc review against
    the updated reference; check.sh.
12. *Four gates* — `rush build`, `rush lint`, `rush test`,
    `rush typecheck:tests` (the last is mandatory because workflow/config
    test call sites change types esbuild would erase).

Additional targeted tests: provider load of an unloaded `npm:`/builtin ref
during validation (success registers and commits; load failure rejects);
cron `remove()` vs in-flight `setFired` ordering; Team create collision
(EEXIST → valid → null, residue → replace); workflow crash-recovery
reconciliation still works with file-first ordering; concurrent
`config.agents.set` serialization.

## 12. Risks and named unknowns

1. **Team anti-resurrection moving from disk merge to one in-memory owner
   (biggest risk).** The old guard re-read the file inside every update
   (`team-collection/store.ts:177-186`). The new guard is structural — one
   writer per dispatcher under the single-server admin lock. It holds if no
   second `TeamStore` writer exists in the process; verified construction
   sites are the one live collection (`team-collection/index.ts:57`) plus
   read-only preflight/doctor in other processes (`server.ts:403`,
   `cli/doctor.ts:165`). A future second in-process writer would break the
   invariant silently; the store's class comment must state "one live
   instance per dispatcher root", and the exclusive per-file publish still
   catches cross-process crashes.
2. **Workflow progress visibility.** `workflow_status` becomes durable-state
   visibility by design (recorded TeamLeader consequence). Existing tests
   that assert immediate in-memory progress will need to move the assertion
   after the commit; no load-bearing live gate is weakened by this.
3. **Provider registration survives a later rejection** (§6.3). Process
   state differs slightly after a rejected set; judged equivalent to a
   restart and idempotent, but it is a side effect worth a test.
4. **`dispatcher.runtime` snapshot refresh** mutates dispatcher records that
   running channel sessions do not read; verified readers are diagnostics
   and onboard only. If another live reader is missed, it sees the *new*
   value earlier than a restart — a conservative inconsistency, but it
   should be grep-confirmed at implementation time.
5. **chat-bots lenient load** deliberately preserves "unreadable → empty"
   at initialize. A warning log is added; see open question Q1.
6. **Config payload size** rides the existing 256 KiB Command bound with no
   agents-specific cap; named real scenario for a tighter cap does not
   exist today.

## 13. Operator-owned open questions

- **Q1 (product behavior):** a corrupt/unreadable `chat-bots.json` today
  silently degrades to an empty store on every read. This proposal preserves
  that at session load (warn + empty) to avoid moving a failure to Channel
  start. Alternative: make a *present but malformed* file fail loud at
  initialize (stricter, but a new start failure for a non-security file).
  Recommendation: keep current behavior. Needs one operator word.
- **Q2 (surface shape, minor):** Command names proposed as
  `config.agents.get` / `config.agents.set` and output as the file-shape
  array `{ id, provider, config }` with secret fields emitted as empty
  strings (per the 2026-09-17 "input 是空的" ruling). Naming and the
  empty-string vs omitted-key distinction are surface decisions; the
  empty-string emission is required for "write back unchanged" round
  trips, but confirm the front end treats `''` (not key absence) as
  "unchanged secret".

## 14. Rejected alternatives

- **Volatile (memory-first) store kind.** Explicitly ruled out
  ("不做（推荐）"); no user remains once agents itself is transactional.
- **Giving `AgentIdentityStore` a dispatcher-wide memory cache.** Its
  existence fact is the directory; its writers include ownerless paths
  (creation, preparation, dissolve of unheld members). A cache would add a
  coherence mechanism across ad-hoc instances while removing nothing; the
  live runtime state is the only part that needs memory and already has it.
- **Config Service writing only the `agents` slice of the file.** A
  partial JSON rewrite has no atomic story and would force a parser
  split; whole-file rewrite through `stringifyConfig` is the existing
  serializer and is what "整份写回" says.
- **Optimistic concurrency tokens / field-level merge for concurrent sets.**
  No ruling asks for multi-writer config editing; the whole section is the
  write unit and the tail serializes it.
- **Keeping the three atomic writers and building the document layer on
  "one of them".** Forbidden by the entropy constraint and the 2026-09-19
  migration ruling; the exclusive-flag merge removes a mechanism rather
  than adding one.
- **Loading the access document at session initialize for symmetry.**
  Violates the failure-location invariant; lazy load is the only placement
  that keeps today's behavior.
- **Moving `dispatchers` validation into a hand-maintained ruleset for the
  Command.** The loader is the ruleset; a second list of checks would drift
  from the next-start behavior the operator asked to guarantee.

## 15. Items not re-verified in this pass

- Feishu SDK concurrency (whether two bot-event paths can truly interleave)
  was marked "inferred" in the requirement inventory; the serialized tail is
  correct regardless, but no SDK source was read.
- `onboard/run.ts` plain-write mechanics were taken from the requirement
  inventory (single non-atomic writer); only `config-files.ts` builder was
  re-read here. The proposal changes onboard code nowhere; the stop-daemon
  guidance is the agreed mitigation.
- Exact admin-socket NDJSON exposure of a new Command was assumed identical
  to `server.status` by construction (`createCoreCommandRegistry` is the
  single registry); transport tests will confirm without new transport
  code.
