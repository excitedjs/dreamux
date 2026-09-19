# Solution B — one `TransactionalStore`, owners keep their policy, Config Service on top

Seat B, independent first-round proposal. Inputs: `requirement.md`,
`rulings.md`, `README.md` as committed at `db41f73b`, the product catalog, and
the current source. Every source claim below was read in this round; what I
could not verify is listed in §11.

## 0. The shape in one paragraph

`FeishuRoutingStore` (`channel/feishu-channel/src/routing/store.ts:56-143`) is
already the requirement's store: `load()` once, a synchronous `current`, an
`update()` that runs on a promise tail, writes temp + rename, and only then
replaces memory. The proposal generalizes that class into one
`TransactionalStore<T>` in `@excitedjs/dreamux-utils` that knows **one file and
nothing else** — no versions, no legacy errors, no corrupt policy, no
collections. Every owner keeps what is genuinely its own (how to decode, what a
missing or unreadable file means, when to load) and deletes what is not (its
private tail, its private temp + rename, its per-access re-read). The Config
Service is one more owner of one more file; its only extra work is that its
decode step is the config loader.

Entropy claim: five serialization tails, three atomic-write helpers, one
link-based exclusive publish, one no-memory document layer, and one mutex become
one class with five members (`load`, `current`, `update`, `delete`, `drain`). The additions are that class, the Config Service,
and two Commands — each named in the requirement.

## 1. The store primitive

Owner: `@excitedjs/dreamux-utils`, new file `src/transactional-store.ts`,
exported from `src/index.ts`. Zero Dreamux imports (the utils boundary), so it
cannot know `LegacyStateError`.

```ts
export interface TransactionalStoreOptions<T> {
  /** Absolute path of the one file this store owns. */
  path: string;
  /** Mode for a parent directory the store has to create. Feishu passes 0o700. */
  dirMode?: number;
  /** `null` text means the file does not exist. Throwing fails the load. */
  decode(text: string | null): T | Promise<T>;
  /** Defaults to `JSON.stringify(value, null, 2) + '\n'`. */
  encode?(value: T): string;
}

export class TransactionalStore<T> {
  /** Read once; concurrent callers share the read; a failed read is not kept. */
  load(): Promise<T>;
  /** The authoritative value. Throws when used before a successful load. */
  get current(): T;
  /**
   * Serialized. `change` sees the committed value and returns the next one;
   * returning the same reference commits nothing. The file is written (temp in
   * the same directory, `wx`, mode 0600, rename) before memory is replaced. A
   * throw from `change` or from the write leaves memory and file as they were
   * and rejects. Resolves after the swap and before the next queued update
   * starts. Loads first when nothing is loaded yet.
   */
  update(change: (current: T) => T | Promise<T>): Promise<T>;
  /** Serialized unlink; memory becomes `decode(null)`. */
  delete(): Promise<void>;
  /** Resolves when every update queued so far has settled. */
  drain(): Promise<void>;
}
```

Decisions inside it, each with its reason:

- **File mode is an invariant, not a parameter.** Every moved file is written
  0600 today (`writeFileAtomic` default, `JsonDocumentStore.write`,
  `writeAtomic` callers, `saveChatBots`, and `config.json`'s mode gate). A
  parameter with one legal value is an invariant.
- **Lazy load is the whole failure-location story.** A store never reads at
  construction. An owner that reads at start today calls `load()` at start; an
  owner that reads per operation today calls `load()` (or `update()`) per
  operation, which is a memory read after the first success. A failed load
  caches nothing, so the next operation retries — exactly how an unreadable
  `access.json` behaves today. No per-store "when to load" option exists.
- **All corrupt / legacy / absent policy is the owner's `decode`.** That is how
  seven stores with seven different policies (fail loud, skip as `null`,
  degrade to empty, secure default) share one class without a policy enum.
  `JsonDocumentStore.corruptPolicy: 'warn-rebuild'` has zero callers in
  `packages/dreamux/src` today and is simply deleted, not carried over.
- **`decode` may be async** only because the config loader is (provider
  `config.read` is awaited, `config.ts:381`). Every other owner passes a sync
  function.
- **No `create` method and no link-based exclusive publish.** "Already
  exists" is `update((cur) => cur === null ? value : fail())` on a `T | null`
  store. `writeFileExclusiveAtomic` arbitrated between two publishers inside
  one process; under one memory owner per file the serialized `update` is that
  arbiter. See §2.3, §2.4, and §2.6 for the three callers this replaces.
- **`delete` exists for one named caller:** dissolve deletes a Team's cron
  store, and the product catalog promises "deleted cron stores stay deleted".
- **`drain` exists for two named callers:** Feishu session stop
  (`feishu-channel.ts:332`) and `WorkflowRun.finalize` (`run.ts:591,597`).
- **No `fsync`.** Nothing calls it today; adding it is a latency decision on
  every identity publish. It is an operator question (§10), and after this
  change it is a one-line change in one place, which it is not today.
- **Values are treated as immutable.** `update` takes a function returning the
  next value, not a draft mutator. Owners whose code mutates a freshly read
  document (cron, chat-bots, routing) wrap with `structuredClone` at their own
  call, as `FeishuRoutingStore.update` already does.

Greenfield pass: if only this requirement existed, this class is what one would
write, and it is ~90% `FeishuRoutingStore` minus Feishu. Gap to today: five
hand-rolled copies of parts of it. Replacement, not adaptation.

## 2. Moving each store

For each: owner, load point (= failure location, unchanged), what is deleted.

### 2.1 Feishu routing document — adaptation, trivial

`FeishuRoutingStore` keeps its filename rule, `validated()`, the `updated_at`
stamp, and its `ensureOwnerOnlyDir` call (a symlink/owner check on the
directory, not part of writing a file). Its `document` field, `tail`, `load`
body, temp + rename call, and `drain` body are replaced by a held
`TransactionalStore`. Load point: session start, as today.

### 2.2 Feishu `access.json` and `chat-bots.json` — replacement

- One `TransactionalStore<DispatcherAccessStateV3>` per session, held by
  `FeishuChannel` where `_accessMutex` is held today (`feishu-channel.ts:142`).
  `decode`: `null` → `defaultDispatcherAccessState()`; parse or shape failure →
  the existing `V3_FAIL_MSG` errors. **Never loaded at start**: each gate
  operation calls `update`/`load`, so an unreadable file fails that operation
  and the next one retries (acceptance criterion 4).
- Every `accessMutex.lock(async () => { load; decide; save })` body
  (`feishu-session-inbound.ts:116,183,247,296`, `feishu-session-ops.ts:293`)
  becomes `access.update((cur) => next)`; the gate result leaves through a
  closure variable. `AsyncMutex` use for access, `readDispatcherAccess`,
  `saveDispatcherAccess` (with its `stat`/`mkdir` block), and the
  `loadDispatcherAccess` alias are deleted. `isTrustedDispatcherUser` becomes a
  memory read after `load()`, and its "not under the mutex because rename"
  comment goes with the reason for it.
- One `TransactionalStore<ChatBotsState>` per session. `decode`: `null` or any
  parse failure → `defaultChatBotsState()` through `normalizeChatBots`, keeping
  today's "not security-critical, degrade to empty" ruling
  (`chat-bots-store.ts:111-126`). The exported operations lose their
  `stateDir` parameter in favor of the store; the four read-change-write paths
  (`observeKnownBot`, `trustIntroducedBots`, `clearBaselineIfCurrent`,
  `recordBotAdded`) become `update` calls and are therefore serialized
  (acceptance criterion 2) without my needing to know whether the SDK runs two
  at once. `saveChatBots`, its inline temp + `chmod` + rename, and `tmpCounter`
  are deleted.
- The requirement's data-loss path — "a failed read followed by any save
  replaces the file with an empty one" — shrinks from every operation to the
  first load only. One narrow delta, stated knowingly: a non-`ENOENT` IO error
  (for example `EACCES`) on `chat-bots.json` today degrades to empty; under the
  primitive it fails the operation that loaded, and the next one retries. I
  recommend accepting it (it removes the remaining overwrite-with-empty case);
  the faithful alternative is a Feishu-side `catch` that returns the default
  without caching.

### 2.3 Agent identity — adaptation of the pair, the open question answered

Today: `AgentIdentityStore` (bound to one directory, no memory) under
`AgentRuntimeStateStore` (memory + tail, live entities only).

After: `AgentIdentityStore` stays the class bound to one entity directory, and
**it** holds the `TransactionalStore<AgentEntityIdentity | null>`. `decode` is
today's `read()` policy verbatim: `null` text → `null`; `LegacyStateError`
rethrown; any other parse failure logged and `null`.

- `read()` is `load()`. `create(input)` is
  `update((cur) => cur === null || input.replaceExisting ? identity : fail('already exists'))`.
  `update(input)` drops its first parameter: the merge base is the store's
  committed value, not a snapshot the caller carried.
  - Delta, stated knowingly: today's exclusive `create` refuses whenever a
    *file* is there, readable or not ("a collision it has not reasoned about
    still has to surface"); the replacement refuses only when a *readable*
    identity is there, because `decode` answers `null` for an unreadable one,
    and would overwrite the unreadable file. I could not find a path that
    reaches it: every spawn name goes through `names.allocate`
    (`teammate-collection/index.ts:427`), which treats the entity *directory*
    as occupied, and the TeamLeader path already passes `replaceExisting`. If
    the cross-review finds one, the fix is a `decode` that throws for
    unreadable on the create path, not a tri-state in the primitive. `upsert(identity)` is
  `update(() => identity)`. `onPersisted` fires where it does today.
- `AgentRuntimeStateStore` loses its `identity` field, `mutationTail`, and
  `enqueue`; `current()` reads the identity store. It keeps what is actually
  its own: the generation lease and `lastRuntimeStatus`. The "re-check the
  lease inside the serialized tail" rule survives as a throw inside the
  `change` function, which aborts the update. `transact(task)` becomes an
  `update` whose async `change` returns the re-prepared identity
  (`runtime-owner.ts:217`) instead of writing it itself.
- **Writes with no live owner** (the known unknown). These are creation
  (`teammate-collection/index.ts:481`), Dispatcher Agent preparation
  (`dispatcher-service/identity.ts:87,119`, built at `dispatchers/index.ts:88`
  before the service exists), and closing members not held during a dissolve
  (`dissolve-members.ts:47`). For each, **no memory exists to be stale**: the
  entity is not materialized, so its file is the only copy. They use a
  one-shot `AgentIdentityStore` — construct, one `update`, drop — which is the
  same class and the same write order and adds no mechanism. The rule a
  maintainer holds: *a file has at most one loaded store at a time, and for a
  materialized entity that store is its live owner's.* That is today's rule
  ("held members close through the service, the rest through the record",
  `dissolve-members.ts`), now stated once instead of implied.
  - The TeamMate materialize path has the same shape: `index.ts:631` reads
    through one `entity(name)` instance and `:542` builds another for the live
    owner. Hand the loaded instance over rather than loading twice.
  - The Dispatcher Agent has two constructions of the same store today
    (`dispatchers/index.ts:88` and `dispatcher-service/index.ts:142`). The
    preparation store should be handed to the service instead of rebuilt, so
    the one-owner rule holds structurally there. Small, inside this change.
  - Read-only scans of non-materialized entities (`AgentNameRegistry.occupied`,
    `roster-reader.ts:49`, `read-model.ts:145`, `AgentEntityCollectionStore.list`)
    stay one-shot loads. They read a file that has no memory owner, so the file
    is the authority. Rejected alternative: a per-collection map holding every
    identity forever — it makes the one-owner rule structural, but it is a
    per-entity structure that grows for the process lifetime (whitepaper §1)
    to defend a collision today's fences already prevent.

### 2.4 Team record — replacement of the read path, per ruling

`TeamStore` becomes the memory owner of its collection: a
`Map<teamId, TransactionalStore<TeamRecord | null>>` filled by one directory
scan on first use (`load()` deduplicated; first use is already dispatcher
start: `recoverWorktreeCleanup`, `startSchedulers`). `decode` is `readTeam`
with today's rule: anything not a valid record is `null`, "not a Team".

- `get` / `list` answer from memory. They stay `async` (they await the
  one-time scan), so the ~20 call sites do not change.
- `update` no longer re-reads the file. Its guard comment — "writing the
  caller's older snapshot back would resurrect a Team" — is answered
  differently now: the merge base is the store's committed value, so there is
  no caller snapshot to be stale. The `team` parameter narrows to the id.
- `create` moves **inside** the per-team `KeyedAsyncQueue` key (closing the
  known unknown): check the map, write, insert. `writeFileExclusiveAtomic` and
  the "exists but invalid → replace" branch collapse into "memory says free →
  atomic replace", which is the same outcome.
- `KeyedAsyncQueue` **stays** in `TeamStore`. It orders *write + aggregate
  publication* (`publishRecordState` awaits a roster read after the write), and
  the primitive deliberately knows nothing about post-commit work. I am not
  claiming this deletion.
- `TeamService.record` (`team-service/index.ts:655-667`) is a second in-memory
  copy that exists because the store had none. It becomes a candidate to read
  through the store; I did not trace its "not booted" null state far enough to
  promise it, so it is a cleanup-trail item, not a staged deletion.
- Product catalog, knowingly changed (operator ruling 2026-09-19, "一起迁"):
  "The Team record is the only existence fact" still holds across restarts;
  while the daemon runs, a record deleted or damaged by hand no longer frees
  the name. "A failed dissolve … the next ordinary use rebuilds from disk"
  becomes "rebuilds from the record", which equals the disk because the file is
  written first.
- `dreamux doctor` (`cli/doctor.ts:165`) is another process, read-only; it
  keeps constructing its own `TeamStore` and loading once.

### 2.5 Cron jobs — replacement of the read path

`CronJobStore` holds a `TransactionalStore<CronJobFile>`. `decode`: `null` →
empty file; otherwise the version check that `JsonDocumentStore.read` did plus
`parseCronJobFile`, both raising `LegacyStateError` with today's messages (the
check moves into the owner because utils cannot import the error). Load point:
`SchedulerService` start via `assertCurrent` (`scheduler/service.ts:62`), as
today. `writes`/`runExclusive` are deleted. `deleteStoreFile` is `delete()`;
its ordering comment stays true — a `setFired` queued after the delete finds no
job in the now-empty memory and writes nothing. `detectLegacyCronJobStore`
(server start, doctor) stays a one-shot load.

### 2.6 Workflow run record — the costliest move

`WorkflowRunStore` becomes a factory of per-run
`TransactionalStore<WorkflowRunRecord | null>` plus `list()` (a scan of
one-shot loads at recovery, as today). `WorkflowRun` holds its run's store.
Every `this.record.x = …; await this.mutate(() => store.write(this.record))`
(`run.ts:227-236,301-303,331-333,366-374,524-530`) becomes
`await this.doc.update((r) => ({ ...r, … }))`, with the journal append inside
the async `change` where it sits inside `mutate` today. `mutationTail`/`mutate`
are deleted; `finalize` awaits `doc.drain()`. `create` loses its
"already exists" refusal of an unreadable file the same way identity does
(§2.3); run ids are generated, so I name it and recommend no defense. `AgentCall.record` — a live
reference into `record.agents` that is mutated in place (`run.ts:331`) —
becomes an index.

This is the behavior change the requirement already records:
`workflow_status` stops showing progress that is not yet written. Risk: `run.ts`
is 687 lines against a 700-line gate; if the rewrite trips it, the legitimate
answer is a named module for the record transitions, not trimming (whitepaper
§6).

### 2.7 What is deleted by the end of the infrastructure stage

| Deleted | Where |
| --- | --- |
| `writeFileAtomic`, `writeFileExclusiveAtomic` (whole file) | `dreamux/src/platform/atomic-write.ts` |
| `JsonDocumentStore`, `corruptPolicy`, `assertCurrent` | `dreamux/src/platform/json-document-store.ts` |
| exported `writeAtomic` (its body becomes the store's private write) | `dreamux-utils/src/fs.ts` |
| inline temp + chmod + rename, `tmpCounter`, `loadChatBots`/`saveChatBots` | `feishu-channel/src/chat-bots-store.ts` |
| `readDispatcherAccess`, `saveDispatcherAccess`, alias, access `AsyncMutex` use | `feishu-gate-io.ts`, `feishu-channel.ts`, session files |
| `mutationTail` + `enqueue`, duplicate `identity` field | `agent-entity/runtime-state.ts` |
| `tail`, `document`, write call | `routing/store.ts` |
| `writes` + `runExclusive` | `scheduler/store.ts` |
| `mutationTail` + `mutate` | `workflow-service/run.ts` |
| re-read-and-merge in `update`, exclusive-publish branches in `create` | `team-collection/store.ts` |
| caller-snapshot parameter of `AgentIdentityStore.update` / `TeamStore.update` | both stores |

Tests that import a deleted helper are deleted or rewritten against the owner's
behavior; `typecheck:tests` is the gate that finds them.

Not touched (non-goals): `journal.jsonl`, `run/restart-intent.json`,
`atomicWriteIfAbsent` for the first-boot default config, the onboard ledger.

## 3. Config Service

### 3.1 Loader split (the real loader change)

`readConfigFile` (`config.ts:185-219`, not exported) does four things: missing
check + mode check, read, `JSON.parse` with its error text, then "load the
referenced providers and `mergeWithDefaults`". Extract the last two into

```ts
export async function resolveConfig(raw: unknown, file, providerRegistry, overrides)
  : Promise<DreamuxConfig>   // load referenced providers, then mergeWithDefaults
```

`readConfigFile` (CLI: doctor, onboard, and today's start) calls it after its
read and parse; the Config Service calls it from its `decode` (after the same
`JSON.parse` with the same error text) and as its write validation. One validation path, so "a write the next start would reject is
rejected" is true by construction rather than by a parallel rule set — the
answer to the operator's "可能要写一堆的代码" concern is that no validation
code is written.

### 3.2 The service

Owner: new `packages/dreamux/src/config/service.ts`, one instance per process,
created in `cli/server.ts` where `loadConfig` is called today (line 56) and
handed to `Server`.

- State: `TransactionalStore<{ raw: RawConfigFile; config: DreamuxConfig }>`
  over `config.json`, `encode = JSON.stringify(value.raw, null, 2) + '\n'`.
  Holding the **raw file object** matters: `stringifyConfig` would rewrite
  hand-written `dispatchers` (`~/…` expanded by `expandHome`, omitted
  `enabled`/`workspace` defaults materialized, `config.ts:145-168,456`). With
  the raw object, a Command write changes the `agents` array and leaves the
  `dispatchers` value exactly as the operator wrote it. `stringifyConfig` stays
  what it is today: onboard's serializer.
- `open()`: `assertNoLegacyTomlOnly`, the missing-file error,
  `assertConfigFileMode`, then `store.load()`. Same checks, same messages, same
  place (`dreamux serve` exits) as today.
- `readAgents()`: a deep copy of `current.raw.agents` with every value whose
  key satisfies `isSecretKeyName` replaced by `''`. It reuses the key rule of
  `dreamux config show`, not the `redactSecretKeyValues` walker, which writes
  `'<redacted>'` (`redaction.ts:136`) — the ruling says the caller sees an
  empty input.
- `replaceAgents(agents)`: one `store.update`:
  1. fill: for each submitted agent matched **by id** to a stored agent, every
     secret-named key whose submitted value is `''` takes the stored value at
     the same path; a `''` with no stored counterpart stays `''`;
  2. candidate raw = `{ ...current.raw, agents: filled }`;
  3. `resolveConfig(candidate)` — loads any new provider into the
     live `ProviderRegistry` through the start's loader, validates both
     sections, including every Dispatcher's `agentRuntime` reference
     (`config.ts:489`). A throw rejects the Command; nothing was written;
  4. return `{ raw: candidate, config: resolved }` — the store writes 0600 and
     then swaps.
  Two concurrent writes serialize on the store's tail and each builds from the
  committed value.
- A provider that loads but whose agent then fails validation stays in the
  registry. It is unreachable (no `agents` entry names it) and a dynamic import
  cannot be undone; I add no unload path.

### 3.3 How readers see the new value — the decision

`cli/server.ts` hands one mutable `DreamuxConfig` by reference through ~15
holders; the three `agents` readers already read at use time
(`runtime-owner.ts:333` per start attempt, `activity-reader.ts:88`,
`teammate-collection/index.ts:335`), and the Dispatcher Agent resolves through
the same `identity.agent_runtime → agents[]` path (`dispatcher-service/agent.ts:50`).

- **Chosen (A): the Config Service owns that object.** After a committed
  update it assigns `agents` and `dispatchers` on it from
  `store.current.config` (always the latest committed value, so the order of
  two writers' continuations cannot matter). No holder changes; "read through
  the Config Service" means "read the object it owns and alone writes". Both
  fields are assigned for consistency only: `DispatcherConfig.runtime` is a
  derived copy of `agents[agentRuntime]` (`config.ts:465`), and I found no
  daemon reader of it after start (`server.ts:429`); a holder that captured a
  dispatcher element at construction keeps the old element either way.
- **Rejected (B): thread `configService.current()` through every holder.** It
  is the greenfield shape — the type would say "this can change" — but it
  edits ~15 source files and a few dozen test files that pass a config literal
  (26 files under `packages/dreamux/tests` match `config:`/`config,`; an upper
  bound, not a count of constructions), for no behavior difference today. The operator's standing instruction on this
  task is "以代码量最小的方式来做". What would flip it: the first reader that
  must see one consistent snapshot across an `await`. Recorded, not built.
- Cleanup trail: `DispatcherConfig.runtime` duplicates a fact `agents` owns and
  is read in the daemon only at start (`server.ts:429`). Deleting it touches
  onboard and diagnostics; out of scope, worth a record.

### 3.4 Commands

New `packages/dreamux/src/config/commands.ts`, contributed in
`command/catalog.ts` like every other domain; `CoreCommandHost` gains
`readonly config: ConfigService`. Proposed names, following
`scheduler.cron.*`: `config.agents.get` (no input; output `{ agents: [...] }`
in file shape, secrets empty) and `config.agents.replace` (input
`{ agents: [...] }`; output the same read projection). Neither is
dispatcher-scoped; neither touches `dispatchers`. Reachable from a Channel port
and `admin.sock` through `CoreCommandPort` like everything else; no CLI verb,
no authorization in Core (rulings).

Failure surface: validation errors are the loader's own `dreamux config error
in …` text, raised as the caller's mistake (`throwCallerMistake`); a file-write
failure is an internal error. Either way memory and file are unchanged.

## 4. Boundary — what does not change

Persisted shapes, paths, file modes; provider interfaces
(`AgentRuntimeProvider`, `ChannelProvider`, `AgentRuntimeStateSink`); the
Command port and registry; `dreamux onboard` (another process; the maintenance
guidance says stop the daemon first); `dreamux doctor`; dispatcher start
ordering; the `#63` non-blocking-inbound contract (Feishu gate work stays where
it is; only its storage call changes).

## 5. Lifecycle, concurrency, failure location

| File | Loaded | Unreadable file fails | Serialized by |
| --- | --- | --- | --- |
| routing document | session start | session start (as today) | store |
| cron jobs | scheduler start | scheduler start (as today) | store |
| Workflow run | recovery scan / run create | recovery (as today) | store |
| `identity.json` | materialize / one-shot | skipped as `null`; legacy throws (as today) | store |
| Team record | first collection use | skipped as `null` (as today) | store, plus TeamStore's queue for publication order |
| `access.json` | first gate operation | that operation, retried next (as today) | store (mutex deleted) |
| `chat-bots.json` | first peer-bot operation | parse → empty (as today); IO error → that operation (delta, §2.2) | store (**new**) |
| `config.json` | `dreamux serve` | process exit (as today) | store |

After a successful load nothing re-reads; a hand edit, damage, or deletion is
overwritten by the next write (ruled).

## 6. Compatibility

No shape, path, or mode changes, so no `BREAKING:` and no `Rebuild:`. Two
content notes: the first `config.agents.replace` re-serializes `config.json`
with two-space indentation and writes `agents` in submitted order (values
unchanged; `dispatchers` verbatim); and every moved file is now written through
`wx` temp + rename, which is what two of three helpers already did. Change
files: `minor`, plain notes (the Team-record and `workflow_status` behavior
changes, the new Commands). `@excitedjs/dreamux-utils` is published at 0.5.1
and is a dependency of the codex, claude-code, and feishu packages; removing
the exported `writeAtomic` is an API removal on a 0.x package — `minor`, plain
note, not upgrade-blocking. No in-repo caller remains after PR 1; an external
`npm:` provider importing it is possible and unknowable from here.

## 7. Staging (infrastructure first)

1. **PR 1 — primitive + Feishu.** `TransactionalStore` with its own tests;
   routing, `access.json`, `chat-bots.json` moved. Deletes exported
   `writeAtomic`, the inline copy, the access mutex use. Smallest stores,
   proves lazy-load failure location and the new serialization.
2. **PR 2 — Core stores.** identity, Team, cron, Workflow. Deletes
   `atomic-write.ts` and `json-document-store.ts` entirely. After this PR no
   second atomic-write helper exists anywhere (constraint: "must not all
   survive" is met as "none survive").
3. **PR 3 — Config Service.** loader split, service, Commands,
   `CoreCommandHost.config`, maintenance skill (`config-envelope.md`: ownership
   rule, stop-before-hand-edit-or-onboard, "restart" step replaced for
   `agents`; `feishu-access-v3.md`: memory-authoritative while running), KB
   (`state-config-and-files.md`, `service-topology.md` drift named in the
   requirement, `current-architecture.md`, product catalog entries below),
   change files.

Each PR passes build, lint, test, `typecheck:tests`. PR 2 can split identity +
Team from cron + Workflow if review size demands; the order inside does not
matter.

## 8. Product catalog entries touched

- Team lifecycle — "The Team record is the only existence fact" (running-daemon
  caveat, ruled).
- Team lifecycle — "A failed dissolve leaves a Team that still exists"
  (wording: "rebuilds from disk").
- Local state and upgrades — "Local runtime state is disposable" (add: files
  are not read while the daemon runs).
- No catalog entry describes how fresh `workflow_status` is (I searched the
  catalog for every Workflow mention), so the recorded consequence — it stops
  showing progress that is not yet written — contradicts no entry. Whether it
  deserves one is the TeamLeader's call at closeout.
- New entry: runtime `agents` configuration through Commands; `dispatchers` by
  hand with the daemon stopped.
- Supersedes the Minimize Core Provider Boundaries line that keeps
  configuration outside the Command catalog — name it in that task's record.

## 9. Verification by acceptance criterion

| Criterion | Evidence |
| --- | --- |
| Reads from memory, file before memory, failed write leaves memory | Primitive tests: after `load`, replace the file on disk and assert `current` unchanged; make the directory unwritable, assert `update` rejects and `current` is the old value and the file is the old file. One behavior test per owner through its real API (not the primitive's). |
| `chat-bots.json` serialized | Two overlapping `observeKnownBot` calls for different bots; both present in the file afterwards (fails on today's code). |
| Existing files load unchanged | Fixture files written by the current release for all eight files load, and a no-op round trip is byte-identical for JSON-encoded ones. |
| Unreadable `access.json` does not fail start | Start a session over a malformed `access.json`; start succeeds, first inbound fails, fix the file, next inbound succeeds. |
| Read returns `agents` with secrets empty | Through a Channel port invoker, not the service directly. |
| Failed validation / failed write changes nothing | Invalid provider block; unwritable config dir — assert file bytes and `config.agents` identity unchanged. |
| Removing a Dispatcher's `agentRuntime` id rejected | Loader message asserted. |
| Valid write in file on return and used by next launch | Write, read file, then start a TeamMate with a fake provider and assert the config it received; no restart. |
| Empty secret keeps stored value | File bytes contain the old secret after a write that sent `''`. |
| No Command touches `dispatchers` | Output schema has no such key; a hand-written `~/` `cwd` value survives a write unchanged. |
| Maintenance skill | Review of `config-envelope.md` and `feishu-access-v3.md` against the two required statements; `.agents/scripts/check.sh` for the KB side. |
| Gates | The four rush commands, reading the `==[` summary lines, not exit codes. |

## 10. Open questions that are the operator's

1. **Does "先确保落盘" include `fsync`?** Today nothing syncs. Recommendation:
   not in this task — the ruling contrasts write order, not power-loss
   durability, and it adds latency to every identity publish. After this change
   it is one line in one file.
2. **`chat-bots.json` IO-error delta** (§2.2): accept "fails that operation"
   (recommended), or keep "degrades to empty".
3. Re-confirm at development approval, as the requirement already schedules:
   validation by next-start rules, and `workflow_status` not showing unwritten
   progress.

## 11. Risks and what I could not verify

- **Biggest risk: `WorkflowRun`.** It is the only store whose code mutates the
  authoritative object in place across many call sites, in a file at the size
  gate, with journal ordering inside the same critical sections. It is the
  move most likely to regress and the one I would review hardest.
- The one-owner-per-file rule for identities is a convention outside
  materialized entities, as it is today. I did not trace every dissolve fence
  to prove a non-held member cannot be materialized mid-dissolve; the change
  does not widen that window, but it does not close it either.
- Not verified: that every `accessMutex.lock` body is purely
  load → decide → save (I read two of five); whether `dreamuxFeishuGate`
  returns the same reference when nothing changed (if not, the per-message
  write continues exactly as today); that re-running every Channel provider's
  `config.read` and `identity.get` during write validation is side-effect free
  (the loader already assumes so at start); how `Server` test construction
  should obtain a Config Service (eight test files build these objects
  directly); whether the Feishu SDK runs two chat-bots paths at once — made
  irrelevant by serializing them.
- Inventory check: I found nothing wrong in the requirement's store inventory.
  One addition: `AgentIdentityStore.create`, `TeamStore.create`, and
  `WorkflowRunStore.create` use a fourth primitive the inventory does not
  name, `writeFileExclusiveAtomic` (link-based no-clobber publish,
  `atomic-write.ts:39-63`); this proposal deletes it too.

## 12. Alternatives rejected

- **A store with built-in versioning / corrupt policy** (grow
  `JsonDocumentStore` a memory). Rejected: it cannot live in utils
  (`LegacyStateError`), and a policy enum is a taxonomy crossing a seam whose
  callee would treat no two branches alike.
- **A process-wide registry of stores keyed by path**, to make one-owner
  structural. Rejected: a new entity and an unbounded map for a collision
  nobody has named.
- **Collection support in the primitive** (directory scan, per-id documents).
  Rejected: Team, identity, and Workflow collections differ in what a directory
  entry means and in what "unreadable" means; the map is three lines in each
  owner.
- **Config store value = resolved `DreamuxConfig`, written with
  `stringifyConfig`.** Rejected: rewrites the operator's `dispatchers` on every
  `agents` write.
- **Threading a config reader through every holder** (§3.3 B).
- **Keeping `writeAtomic` exported for future callers.** Rejected: that is
  exactly "landing beside" the store.

## Cross-review

Round two. I read `solution-a.md` and `solution-c.md` in full and checked their
load-bearing claims against the source, not against §0–§12 above. Where this
section contradicts my first round, this section is my position; the first
round is left as written so the change is visible.

### CR-1. Errors in my own first round, found while checking the others

1. **A fourth exclusive-create caller exists and is out of scope for the
   store.** `workflow-service/journal.ts:58` publishes the journal's first line
   with `writeFileExclusiveAtomic`. My grep pattern (`writeFileAtomic`) cannot
   match `writeFileExclusiveAtomic`, so §1 "no link-based exclusive publish",
   §2.7 "deleted: whole file", and §11 "this proposal deletes it too" are
   wrong: the journal is an append-only log (non-goal), it is not a document,
   and it needs a no-clobber publish. C found this (C §3); A did not.
2. **My `decode(text | null)` signature silently rewrites IO error text.**
   `readDispatcherAccess` wraps a read failure as `Failed to read access.json:
   …` (`feishu-gate-io.ts:55`), the routing store as `failed to read <path>: …`
   (`routing/store.ts:83-85`). Under my signature the primitive does the read,
   so those messages become the primitive's. A's "the caller … supplies the
   initial loader" (A §3) keeps them byte-identical. Not a persisted-file
   change, but an unknowing one; withdrawn in CR-3.
3. **§3.3 cited "以代码量最小的方式来做" as a standing instruction.** Per the
   ledger it answered "谁、从哪里触发配置修改？". Re-weighed in CR-3.2 without it.

### CR-2. The other proposals

#### Solution A

Accepted, with what changes in my design:

- **The owner supplies the whole initial load; the primitive owns only
  commit.** Reason in CR-1.2. It also dissolves the `chat-bots.json` question
  (CR-3.5) without any policy hook. My options become
  `{ path, dirMode?, load(): Promise<T>, encode? }`.
- **A post-commit step inside the store's queue** (A §3 "Publication and
  failure"). I kept `TeamStore`'s `KeyedAsyncQueue` around `update` + publish
  and, for identity and config, leaned on "`update` resolves before the next
  queued update starts" — a microtask-ordering argument. One optional
  post-commit callback replaces both: Team's queue is deleted, and the
  ordering is a contract instead of reasoning. Verified it is what Team does
  today: `publishRecordState` awaits the roster after the write, inside
  `writes.run` (`team-collection/store.ts:176-204,216-224`).
- **The Feishu SDK overlap is real, not inferred.** Read at the cited path:
  `ws.on('message', async …)` (`node-sdk/lib/index.js:102466`), and an
  `EventEmitter` does not await its listener, so two frames interleave. The
  requirement's "inferred" can be upgraded to "read".
- **`lib/mutex.ts` is deletable.** `AsyncMutex` has exactly two importers, both
  for access (`feishu-channel.ts:37,142`, `feishu-session-ops.ts:39,73,91`).
- **Approval keeps its error *result* on a failed save**
  (`feishu-session-ops.ts:332-349`): the `update` rejection is caught there and
  turned into the same `status: 'error'` result. I had not said so.
- **`getRuntimeConfig` has no production caller.** Verified: only setters at
  `server.ts:179`, `onboard/run.ts:92,133`, `cli/doctor.ts:117`,
  `daemon/install.ts:101`. A third copy of the config, read by nobody; delete
  it in the Config PR.
- **`TeamService.record` and the Workflow live-over-disk overlay are second
  authorities to remove** (`team-service/index.ts:655-667`,
  `workflow-service/index.ts:185-218`, both verified). I had the first as a
  "candidate"; A is right that leaving it is the most likely way this refactor
  passes its tests and still fails its purpose.
- **The `fsync` contradiction** (A §10) — adopted in CR-3.7.

Rejected:

- **Process-lifetime retention of identity and Workflow records** — CR-3.1.
- **"Patch the shared object in place … can mutate settings already handed to
  running runtimes"** (A §10). Not true of either B or C: both *replace* the
  `agents` property with the freshly resolved map; a running runtime holds the
  old `ResolvedAgentConfig` object, which nothing mutates. The claim holds
  only for a deep in-place edit nobody proposed. (I still move toward A's
  conclusion in CR-3.2, on a different argument.)
- **Two PRs with every store in the first.** Seven stores plus A's ownership
  rewiring in one review is the size at which a surviving second authority —
  A's own named biggest risk — gets missed.

Factual gaps in A:

- A keeps exclusive publication "internal" to the store module (A §3, removal
  2) and never mentions `journal.ts:58`. As written, the journal loses its
  create primitive.
- A's product ledger changes "the next ordinary use rebuilds from disk" to
  "from committed owner records in-process" for **every** record kind. The
  operator's 2026-09-19 "一起迁" ruling named that cost for the Team record
  only (`rulings.md:70-86`). Extending it to identity, cron, and Workflow
  records is a catalog change no ruling covers.

#### Solution C

Accepted:

- **Exclusive creation survives** (C §3, §5.1), with the recorded contract I
  had not read: "a directory name stays occupied even when its identity is
  unreadable, and identity creation is no-clobber"
  (`packages/dreamux/src/service/CLAUDE.md:198`). My §2.3 delta ("would
  overwrite an unreadable file") contradicted a recorded contract for no gain.
- **The journal caller** (CR-1.1).
- **`config.agents.get` / `config.agents.set`** — CR-3.6.

Rejected:

- **`_accessMutex` stays "because it serializes decisions larger than one file
  write"** (C §5.6, citing `feishu-session-ops.ts:291-333`). I read all five
  lock bodies this round (`feishu-session-inbound.ts:116-118,183-190,247-262,
  296-351`, `feishu-session-ops.ts:293-367`). Every one is load → decide →
  save with no other await; the card send sits *between* LOCK-1 and LOCK-2,
  outside both. A lock around a serialized `commit` is two queues over one
  file. This also closes my first-round "read two of five" unknown.
- **The Team record does not move onto the primitive in C.** C §1 says "one
  `TransactionalDocument` per dispatcher"; C §5.2 then builds "a small owner
  class" with its own tail that calls `writeJsonAtomic` directly for each
  `record.json`. That is a fifth hand-rolled copy of file-then-memory beside
  the class written to end them, and it needs the raw replace-writer exported
  — the "landing beside" shape the requirement forbids
  (`requirement.md:233-236`). One `TransactionalStore` per Team in a map
  (A and B) uses the primitive as it is.
- **`stringifyConfig(validated)` as the write** (C §2.2 step 5, §14). It
  re-serializes `dispatchers` from the resolved view: `cwd` is written
  `expandHome`-expanded (`config.ts:456`) and omitted `enabled` /
  `workspace.enabled` are materialized (`config.ts:457-462`, `145-168`). C's
  own verification item 10 — "a set payload cannot alter dispatcher file
  content" — fails against C's design for any hand-written `~/` path. A and B
  hold the raw file object and write that.
- **Refreshing `dispatcher.runtime` "because they have live in-process
  readers"** (C §6.4). `provider-diagnostics.ts` has one importer in `src`, a
  type import from `onboard/types.ts:2`; onboard is another process. No daemon
  reader exists after `server.ts:429`.

Factual errors in C:

- Internal contradiction on `chat-bots.json`: C §3 — "A real IO error other
  than ENOENT rejects `load()` under both policies"; C §5.7 —
  `load({ corrupt: 'empty' })` "keeps ENOENT/parse/IO degradation". With the
  load moved to `initialize()`, the first reading turns an `EACCES` into a
  failed Channel start, which the requirement forbids.
- `corrupt: 'throw' | 'empty'` reintroduces the policy enum C §3 says it
  deletes, for one caller.
- C §5.2 "Before load, `get`/`list` throw 'used before loaded'": `TeamStore`
  is also reached outside the start sequence (`worktree-cleanup.ts:32`; and
  `host.dispatcher(id)` get-or-builds the aggregate for any Command, so I
  expect `team.list` can reach the store on a dispatcher that never started —
  expected from the host contract, not traced). A lazy, deduplicated load has
  the same failure location and no "used too early" state to hold.

### CR-3. Revised positions on the seven divergences

**3.1 Memory lifetime with no live owner.** Three different answers, because
they are three different facts:

- *Team record:* process lifetime, in `TeamStore`'s map. Ruled ("一起迁", cost
  named), and required anyway: name occupancy and request replay are answered
  from it. All three proposals agree.
- *Identity:* the document lives exactly as long as a live owner holds it;
  every ownerless operation is a one-shot store. Unchanged from round one, but
  now argued against both alternatives:
  - against A (retain forever): it is a per-entity structure that grows for
    the process lifetime, and A states it has no bound (A §3, §10) — the case
    whitepaper §1 rejects by name. What it buys is that a hand edit to a
    *closed, unmaterialized* entity's file is not read at its next reopen. The
    scope line says "moving the **live** agent identity"
    (`requirement.md:205-206`), and the catalog says a failed dissolve
    "rebuilds from disk". A's own evidence is correct — `TeamRuntimeRegistry`
    evicts (`runtime-registry.ts:296,399-404`) and the per-Team cron store is
    rebuilt (`collaborators.ts:110`) — but a re-read at re-materialization is
    whitepaper §2's "ordinary … lazy materialization", not a second authority:
    no memory existed to disagree with the file.
  - against C (no memory in `AgentIdentityStore`; the live document sits in
    `AgentRuntimeStateStore`, ownerless writes use a raw writer): it leaves
    two write mechanisms for one file and needs the replace-writer exported.
    A one-shot store is the same code path as the live one and keeps the
    writer private.
- *Workflow run:* same rule as identity — the live `WorkflowRun` holds the
  document; a finished run's `status`/`list` stays a one-shot read of a file
  nothing will write again (as C §5.4). I now also take A's removal of the
  live-over-disk overlay where a live run exists.

What this leaves for the operator is in CR-4.

**3.2 How readers observe a committed write — I change sides: thread a read
capability.** Without the misapplied ruling, the comparison is:

- In place has no silent failure today: a pattern search of `src/service` and
  `server.ts` for spreads or `structuredClone` of the config found none (a
  grep, not a proof). Its hazard
  is hypothetical, and A's "mutates running runtimes" objection is wrong
  (CR-2).
- But in place makes the Config Service hold a *second* resolved copy by
  design: the store's committed `{raw, config}` and the shared object it
  assigns into afterwards. Every other section of all three proposals deletes
  exactly that pattern — `AgentRuntimeStateStore.identity`,
  `TeamService.record`, `WorkflowRun.record`. Building a new instance of it in
  the same task is not a position I can defend.
- Threading makes the type say "this value changes": once the dependency is
  `{ current(): DreamuxConfig }`, a holder that was not converted does not
  compile. With in place the compiler is silent.
- Its cost is mechanical: the ~15 holders and the tests that pass a config
  literal wrap it as `{ current: () => config }`.

So: `ConfigService` implements the read capability, the holders take it, the
three `agents` readers call `current()` per operation, and
`setRuntimeConfig`/`getRuntimeConfig` are deleted. C remains the only proposal
for in-place assignment.

**3.3 Exclusive creation — survives, reversed from round one.** One
`publishFileExclusive(path, data)` exported from utils (the journal needs it
and is not a document), used by the store's `create(value)`, which runs in the
document's queue. Identity and Workflow-run creation use `create` and keep
today's refusal of an unreadable residue. Team creation still does not need
it: all three of its outcomes are decided by the in-memory map (valid record →
`null`; anything else → replace), so there it stays a serialized update. The
replace-writer stays private to the store. Net: three replace-writers → zero
public; one exclusive publisher → one, moved.

**3.4 Team publication ordering — A's post-commit step.** See CR-2.
`KeyedAsyncQueue` leaves `TeamStore`; `create` joins the Team's document
queue, which closes that known unknown the same way. A rejection from the
post-commit step rejects the caller while file and memory stay committed — what
`writes.run` does today.

**3.5 `chat-bots.json` — keep today's catch-all empty; my delta is
withdrawn.** A is right on authority: "moving a store does not move where an
unreadable file fails" (`requirement.md:225-227`) leaves no room for a
refactor-side tightening. With an owner-supplied loader, `loadChatBots`' body
*is* the loader, unchanged, and the primitive carries no policy. The data-loss
path still shrinks from every operation to the first load. Load stays lazy,
not at `initialize()`.

**3.6 Staging, names, contract.**

- Staging: three PRs as in §7 — Feishu stores with the primitive; Core stores;
  Config. The exclusive publisher moves to utils in PR 1; both Core helper
  files are gone by the end of PR 2. C's writer-cutover-first stage and A's
  single storage PR are both workable; mine optimizes for review size, given
  A's named risk.
- Names: `config.agents.get` / `config.agents.set` (C). Three-level names
  exist (`scheduler.cron.*`), the pair is symmetric, and `config.read`
  returning only `agents` hides the partial surface the operator himself
  pointed at ("一个配置文件只有一部分可以改").
- Contract: all three agree — no input / `{ agents }` in file-entry shape;
  secret-named keys `''` at any depth, whole value blanked even when not a
  string; `set` returns the same projection of what it committed; agents
  matched by `id`, never position; a changed provider does not erase a
  same-id secret (A). Closed input shape, so a `dispatchers` key is rejected
  (A).

**3.7 `fsync`.** Still the operator's question; recommendation unchanged (not
in this task), now with A's argument attached: syncing the temp file *before*
the rename is compatible with the store's contract (a failure there rejects
cleanly), while syncing the directory *after* the rename is not — the file has
already changed, so the operation can no longer truthfully reject with "neither
memory nor the file changed". If the operator wants more than today, the
pre-rename file sync is the only part that fits without a new "committed but
durability unknown" outcome.

### CR-4. What still divides the proposals materially

Technical — a merge has to choose:

1. **Identity and Workflow memory lifetime** (A retain forever; B
   owner-lifetime plus one-shot; C no identity-store memory). This sets the
   implementation boundary more than anything else: A rewires per-Team store
   ownership up to `TeamCollection` and replaces every fresh reader; B and C
   leave ownership where it is.
2. **Whether the raw replace-writer is exported** (C yes; A and B no). Follows
   from C's Team owner class and stateless identity store; it decides whether
   "one store kind" is structural or a convention.
3. **Config write source** — raw file object (A, B) or `stringifyConfig` (C).
   I consider this settled by C's own acceptance test; listed because C has
   not conceded it.
4. **Config reader** — threaded (A, now B) or in place (C).
5. **Access mutex** — deleted (A, B) or kept (C). Settled by reading the five
   lock bodies, in my view.

The operator's, not ours:

1. **Is "a hand edit is not read while the daemon runs" absolute, or does it
   mean "is not read while something in memory owns that file"?** That is the
   product fact under divergence 1. Absolute → A's retention, its unbounded
   memory, and its wider catalog change. Owner-scoped → B/C, and a hand edit
   to a closed, unmaterialized entity's file is read at its next reopen. My
   recommendation is owner-scoped; the ruling's wording covers the Team record
   only.
2. **`fsync`** (3.7).
3. Already scheduled for the development-approval playback: validation by
   next-start rules, and `workflow_status` no longer showing unwritten
   progress.
