# Final technical solution

The single authoritative solution for this task. It merges the three
independent proposals and their cross-review
([A](/.agents/tasks/architecture/add-runtime-config-commands/technical-design/proposals/solution-a.md),
[B](/.agents/tasks/architecture/add-runtime-config-commands/technical-design/proposals/solution-b.md),
[C](/.agents/tasks/architecture/add-runtime-config-commands/technical-design/proposals/solution-c.md)),
adjudicated by the TeamLeader against the source, the
[requirement](/.agents/tasks/architecture/add-runtime-config-commands/requirement.md),
and the [rulings ledger](/.agents/tasks/architecture/add-runtime-config-commands/rulings.md).
Where this file and a proposal disagree, this file decides; the proposals
keep the detailed evidence (file and line) behind each choice. Paths are
relative to `packages/dreamux/src/` unless another package is named.

## 1. Shape in one paragraph

`@excitedjs/dreamux-utils` gains one `TransactionalStore<T>`: it owns one
file, loads it once through a loader its owner supplies, serializes every
mutation, writes the file (temporary file, atomic rename, mode `0600`) before
it replaces the in-memory value, and runs an optional after-commit step inside
the same queue. It is `FeishuRoutingStore`'s existing shape with the Feishu
parts removed. Every persisted runtime store moves onto it and loses its own
queue, its own write helper, and its per-access re-read. On top of it a
process-wide `ConfigService` owns `config.json` while the daemon runs, and two
Core Commands let a Channel read and replace the `agents` section. The volatile
store kind is not built.

## 2. The store primitive (`@excitedjs/dreamux-utils`)

New file `src/transactional-store.ts`, exported from `src/index.ts`. It imports
nothing from any other Dreamux package (the utils boundary), so it knows no
schema, version, legacy error, or path rule.

```ts
export interface TransactionalStoreOptions<T> {
  /** Absolute path of the one file this store owns. */
  path: string;
  /** The owner's initial read: what a missing, unreadable, or legacy file means. */
  load(): Promise<T>;
  /** Defaults to JSON with two-space indentation and a trailing newline. */
  encode?(value: T): string;
  /** Mode for a parent directory the store has to create; omitted = create with the process default. */
  dirMode?: number;
}

export class TransactionalStore<T> {
  load(): Promise<T>;               // once; concurrent callers share it; a failure is not cached
  get current(): T;                 // throws before a successful load
  update(
    change: (current: T) => T | Promise<T>,
    afterCommit?: (next: T, previous: T) => void | Promise<void>,
  ): Promise<T>;
  create(value: T): Promise<T>;     // create-only publish; rejects when the file exists
  remove(next: T): Promise<void>;   // unlink (ENOENT is success), then memory becomes `next`
  drain(): Promise<void>;           // resolves when everything queued so far has settled
}
```

Contract, each point with its reason:

- **Owner-supplied `load`.** Seven owners have seven meanings for "missing" or
  "unreadable" (fail loud, `null` = no record, empty default, secure default,
  legacy error). The owner keeps its read function and its error text
  byte-for-byte; the primitive has no policy enum. A failed load caches
  nothing, so the next operation retries — how an unreadable `access.json`
  behaves today.
- **`update` is the only way to change the value.** `change` sees the committed
  value and returns the next one; returning the same reference writes nothing.
  The file is written before memory is replaced. A throw from `change`, from
  encoding, or from the write leaves file and memory as they were and rejects
  the caller; the next queued update runs against the last success. `change`
  may await (provider validation, worktree preparation, journal append), and
  must not call a mutation of the same store (that would wait on itself).
- **`afterCommit` runs inside the queue, after the swap.** Two owners publish an
  event that must follow the commit it describes, in commit order: the Team
  record (`publishRecordState` awaits a roster, `service/team-collection/store.ts`) and
  the agent identity (`onPersisted`, `service/agent-entity/identity-store.ts`); both
  publish on an update only when the status changed, so the step receives the
  previous value too. Its
  failure rejects the caller while file and memory stay committed, which is
  what the Team queue does today. It is optional; no other owner passes it.
- **`create` keeps the no-clobber contract.** Identity creation refuses any
  existing file, readable or not ("identity creation is no-clobber",
  `service/CLAUDE.md`), and a Workflow run is created the same way. The
  create-only publish (complete temporary file, then a hard link that fails
  with `EEXIST`) lives in utils once, exported as `publishFileExclusive`,
  because the Workflow journal needs it and the journal is not a document.
- **Mode `0600` is an invariant, not an option.** Every file that moves is
  written `0600` today.
- **No `fsync`** (operator, 2026-09-20, "不加，维持现状"). "Written before memory
  changes" means an awaited temporary file and atomic rename.
- The replace-write stays private to the module. utils' exported `writeAtomic`
  is removed; nothing else writes a store's file.

## 3. Moving each store

### 3.1 Feishu routing document

`FeishuRoutingStore` keeps its file-name rule, validation, `updated_at` stamp,
released-document normalization (missing `subscriptions`), and its owner-only
directory check. Its private `document`, `tail`, write call, and `drain` body
become one held `TransactionalStore`. It still loads at session start.

### 3.2 Feishu `access.json`

- One store per Channel session, held where `_accessMutex` is held today. Its
  loader is today's `readDispatcherAccess` (missing file → secure default;
  unreadable or wrong shape → today's errors and text); its directory is still
  created `0700`.
- **Never loaded at start.** The first gate operation loads it; an unreadable
  file fails that operation and the next retries. It must not become a failed
  Channel or Dispatcher start (requirement constraint).
- The five `accessMutex.lock` bodies (`feishu-session-inbound.ts`, four;
  `feishu-session-ops.ts`, one) are each read, decide, optionally write, and
  return; two seats read all five. Each becomes one `update`, its result leaving
  through a closure. `AsyncMutex` for access, `lib/mutex.ts`,
  `saveDispatcherAccess`, and the `loadDispatcherAccess` alias are deleted.
- Pairing keeps its two stages: decide from the committed value, send the card
  outside any transaction, then merge the outcome against the latest committed
  value. Approval keeps returning its `status: 'error'` result when the save
  fails.

### 3.3 Feishu `chat-bots.json`

- One store per session. Its loader is today's `loadChatBots`, unchanged: any
  read or parse failure gives the empty default. That default becomes the
  store's value. Loaded at the first peer-bot operation, not at initialize.
- The four read-change-write paths (`observeKnownBot`, `trustIntroducedBots`,
  `clearBaselineIfCurrent`, `recordBotAdded`) become `update` calls, so they are
  serialized. The baseline-generation check runs inside the queue against the
  committed value. Two seats read in the installed Feishu SDK source that its
  message listener is `async` and not awaited, so two events can run these
  paths at once; the race is real.
- `saveChatBots`, its inline temporary-file write, and `tmpCounter` are deleted.
- Not changed: a non-`ENOENT` I/O error still degrades to empty. One seat
  proposed failing the operation instead; no scenario reaches an unreadable
  file the daemon itself writes at `0600`, and the requirement forbids moving
  where an unreadable file fails.

### 3.4 Agent identity

Record lifetime (operator, 2026-09-20, "只在有 owner 时留"): an identity is held
in memory while its entity is live; otherwise it is read from its file when
used.

- `AgentIdentityStore` stays the class bound to one entity directory and holds
  a `TransactionalStore<AgentEntityIdentity | null>`. Its loader is today's
  `read()` policy: missing → `null`; any other read error throws; legacy →
  rethrow; other parse failure → logged `null`.
- `create` uses the store's `create` (no-clobber, including an unreadable
  residue); the TeamLeader path's `replaceExisting` keeps replacing. `update`
  drops its caller-snapshot parameter and merges against the committed value.
  `onPersisted` becomes the `afterCommit` step.
- `AgentRuntimeStateStore` loses its `identity` copy, `mutationTail`, and
  `enqueue`; `current()` reads the identity store. It keeps the generation lease
  and `lastRuntimeStatus`. The lease re-check that ran inside the tail becomes a
  throw inside `change`, which aborts that update.
- `transact` becomes one `update` whose async `change` returns the re-prepared
  identity. `reprepareDeletedManagedWorktree` (`service/worktree/workspaces.ts`)
  returns its identity patch instead of calling `identities.update`; a direct
  port would wait on its own queue (`service/teammate-service/runtime-owner.ts`).
- **One store instance per live entity.** Where one entity is read and then
  materialized, the loaded instance is handed to the live owner instead of
  loading a second one (`service/teammate-collection/index.ts`). The Dispatcher Agent's
  identity store is built once by `Dispatchers` (which already caches a root
  identity reader) and handed to its `DispatcherService`, instead of built
  again there.
- **Reads of a live entity go through its live owner.** Today
  `TeammateCollection.list` and `status` read the identity file before
  consulting the live entity, and the Team read model's `leader_state` builds a
  fresh identity reader. After this change each consults the live owner first
  and reads the file only for an entity that is not live. Ownerless operations
  (creation, a dissolve closing a member nobody holds, scans of entities that
  are not live) use a one-shot store: construct, one operation, drop.

### 3.5 Team record

Team records are held for the life of the collection once loaded (ruling
2026-09-19, "一起迁").

- `TeamStore` holds `Map<teamId, TransactionalStore<TeamRecord | null>>`,
  filled by one directory scan on first use (lazy and shared, so a Command
  reaching a Dispatcher that never started still works). Each loader is
  today's `get` policy: a missing, unreadable, or invalid record is `null`,
  "no Team".
- `get` and `list` answer from memory and stay `async`, so their call sites do
  not change. `update` takes a Team id and a patch and merges against the
  committed value; a `null` entry is `TeamNotFoundError` as today.
- `create` runs in that Team's store queue and is decided by memory: a valid
  record means the name is taken (`null`, the caller tries another name);
  otherwise the record is written, replacing any invalid residue. These are
  today's outcomes; the exclusive publish and its fallback overwrite go.
- `publishRecordState` becomes the `afterCommit` step. The store's
  `KeyedAsyncQueue` (`writes`) is deleted. The collection's separate request
  lifecycle queue (keyed by request id) stays; it serializes different work.
- `TeamService.record` (a second in-memory copy written and then copied back)
  is removed; the service reads the Team's store.
- The anti-resurrection guarantee moves from "merge against disk" to "one
  in-memory owner per Dispatcher, merging against its committed value". The
  test that pins the old behavior,
  `packages/dreamux/tests/team-collection-read-path.test.ts` (disk corruption
  mid-daemon makes `update` fail), is replaced deliberately by one asserting
  that the loaded record governs; this is the ruled behavior change, not a
  weakened test.
- The startup legacy-cron preflight (`server.ts`, `detectLegacyCronStores`,
  before any Dispatcher starts) and `dreamux doctor` construct a `TeamStore`
  today only to list open Teams and find their cron files. They call an
  extracted read-only scan instead, the same one the store's first load uses,
  so no second holder of Team records exists.

### 3.6 Cron jobs

`CronJobStore` holds a `TransactionalStore<CronJobFile>` whose loader is the
version check `JsonDocumentStore` did plus `parseCronJobFile`, both raising
`LegacyStateError` with today's messages. It still loads at scheduler start.
Its `writes` tail is deleted. `deleteStoreFile` is `remove(empty)`; a
`setFired` queued behind a delete finds no job and writes nothing. The legacy
detection used by startup and `dreamux doctor` stays a one-shot read.

### 3.7 Workflow run record and journal

Record lifetime as for identity: a run's record is held while the run
executes; a finished run is read from its file.

- `WorkflowRunStore` hands out one store per run; `create` uses the store's
  `create`. `WorkflowRun` holds its run's store.
- Every `this.record.x = …; await this.mutate(() => store.write(this.record))`
  becomes one `update` returning the next record, with the journal append
  inside `change` where it sits inside `mutate` today. `mutationTail` and
  `mutate` are deleted; `finalize` awaits `drain()`. `AgentCall.record`, a live
  alias into the record's array, becomes an index.
- `workflow_status` and `workflow_list` read a running run's committed value
  and a finished run's file, so they no longer show progress that is not yet
  written (recorded consequence).
- The journal stays an append-only log outside the store; its create uses
  utils' `publishFileExclusive`.
- `run.ts` is 687 lines against the 700-line gate. If the rewrite crosses it,
  the record transitions move into their own module rather than trimming.

## 4. Config Service

### 4.1 Loader split

`readConfigFile` (`config/config.ts`) today checks existence and mode, reads,
parses, then loads the referenced providers and runs `mergeWithDefaults`. The
last two become an exported `resolveConfig(raw, file, providerRegistry,
overrides)`. The file read, the offline commands (`doctor`, `onboard`), and the
Config Service all call it, so a write the next start would reject is rejected
by the same code — no second validator (operator's cost concern, answered in
the ledger).

### 4.2 The service

- `config/service.ts`, one instance per process, opened in `cli/server.ts`
  where `loadConfig` is called today and handed to `Server`.
- State: `TransactionalStore<{ raw: RawConfigFile; config: DreamuxConfig }>`
  over `config.json`; `encode` writes `raw` only. Holding the raw file object
  keeps a hand-written `dispatchers` section exactly as written — `~` paths
  unexpanded, omitted defaults still omitted — where re-serializing the
  resolved value (`stringifyConfig`) would rewrite it on every `agents` write.
- Opening runs today's checks in today's order with today's messages (legacy
  TOML, missing file, file mode), then `load()`; a failure still stops
  `dreamux serve`.
- **Readers.** The service implements `{ current(): DreamuxConfig }`, and every
  holder of the shared `DreamuxConfig` takes that capability instead. The three
  `agents` readers (`service/agent-entity/agent-config.ts` per launch,
  `service/teammate-collection/index.ts` runtime inventory,
  `service/agent-entity/activity-reader.ts`) call `current()` per operation. Holders
  that only need what is fixed at start read it the same way. Rejected:
  assigning the new value into the existing shared object — it works with
  today's readers, but it makes the service keep a second resolved copy beside
  its committed value, the pattern this task deletes from identity, Team, and
  Workflow, and a holder that was not converted would compile.
- The unused global holder in `platform/paths.ts` (`setRuntimeConfig`,
  `getRuntimeConfig`, `resetRuntimeConfig`; the getter has no production
  caller) is deleted with its call sites.

### 4.3 Reading and replacing `agents`

- **Read** returns a deep copy of `raw.agents` in file shape. Every value whose
  key satisfies `isSecretKeyName` (the rule `dreamux config show` uses) is
  returned as `''` — the whole value, at any depth, even when it is not a
  string. It does not use `redactSecretKeyValues`, which writes `'<redacted>'`.
- **Replace**, as one `update`:
  1. Match each submitted agent to a committed agent **by `id`**, never by
     position. At every secret-named key whose submitted value is `''`, keep the
     committed value at the same JSON path. A new id, or a key with no committed
     value, keeps the submitted value. A changed provider does not erase a
     same-id secret.
  2. Candidate raw = the committed raw with `agents` replaced.
  3. `resolveConfig(candidate)`: loads any newly referenced provider into the
     live registry through the start's loader, and validates both sections,
     including every Dispatcher's `agentRuntime` reference. A throw rejects the
     Command with nothing written.
  4. Return `{ raw: candidate, config: resolved }`; the store writes `0600` and
     then swaps. The Command returns the read projection of what it committed.
- A provider that loaded but whose candidate was then rejected stays in the
  registry, unreachable; a dynamic import cannot be undone and no unload path
  is added. A provider whose last agent is removed is not unloaded either — a
  running runtime may still use it.
- The next runtime launch reads `current()`; a running runtime keeps what it
  launched with. Two writes serialize on the store and each builds from the
  committed value.

### 4.4 Commands

`config/commands.ts`, contributed in `command/catalog.ts` like every domain;
`CoreCommandHost` gains `readonly config: ConfigService`.

| Command | Input | Output |
| --- | --- | --- |
| `config.agents.get` | none | `{ agents: [...] }`, file-entry shape, secrets `''` |
| `config.agents.replace` | `{ agents: [...] }`, closed; `[]` allowed | the same projection of the committed value |

Neither is Dispatcher-scoped; neither accepts or returns `dispatchers`. Both
are reachable through a Channel port and `admin.sock` like every Command; no
CLI verb, no authorization in Core. A validation error is the loader's own
`dreamux config error in …` text, raised as a caller mistake; a failed file
write is an internal error. Either way memory and file are unchanged.

## 5. Failure locations and lifetimes

| File | Loaded | Unreadable file fails | Held in memory |
| --- | --- | --- | --- |
| routing document | session start | session start (as today) | session |
| `access.json` | first gate operation | that operation, retried next (as today) | session |
| `chat-bots.json` | first peer-bot operation | never: empty default (as today) | session |
| cron jobs | scheduler start | scheduler start (as today) | scheduler scope |
| Team record | first collection use | never: `null` = no Team (as today) | collection |
| `identity.json` | materialization, or one-shot | `null`; legacy throws (as today) | while the entity is live |
| Workflow run | run create / recovery scan | recovery (as today) | while the run executes |
| `config.json` | `dreamux serve` | process exit (as today) | process |

While an owner holds a file, a hand edit, damage, or deletion is not read and
the next write overwrites it.

## 6. What is deleted

| Deleted | Where |
| --- | --- |
| `writeFileAtomic`, `writeFileExclusiveAtomic` (whole file) | `platform/atomic-write.ts` |
| `JsonDocumentStore` and its unused `warn-rebuild` branch (whole file) | `platform/json-document-store.ts` |
| exported `writeAtomic` | `dreamux-utils/src/fs.ts` |
| inline temporary-file write, `tmpCounter`, `saveChatBots` | `feishu-channel/src/chat-bots-store.ts` |
| `saveDispatcherAccess`, `loadDispatcherAccess`, access `AsyncMutex`, `lib/mutex.ts` | `feishu-channel/src` |
| `mutationTail`, `enqueue`, duplicate `identity` | `service/agent-entity/runtime-state.ts` |
| `tail`, `document`, write call | `feishu-channel/src/routing/store.ts` |
| `writes`, `runExclusive` | `service/scheduler/store.ts` |
| `mutationTail`, `mutate`, `AgentCall.record` alias | `service/workflow-service/run.ts` |
| `writes` queue, re-read-and-merge, exclusive-publish branches | `service/team-collection/store.ts` |
| `TeamService.record` copy | `service/team-service/index.ts` |
| caller-snapshot parameter of `AgentIdentityStore.update` / `TeamStore.update` | both stores |
| global config holder | `platform/paths.ts` |

Added: the store, `publishFileExclusive`, the Config Service, `resolveConfig`
as an export, two Commands. Nothing old survives beside the new: after the
Core stage no second write helper exists anywhere.

## 7. Compatibility and change notes

No persisted file changes shape, path, or mode, so no `BREAKING:` and no
`Rebuild:`. Plain `minor` notes: the Team-record, identity, and
`workflow_status` behavior while the daemon runs; the new Commands;
`@excitedjs/dreamux-utils` removing `writeAtomic` and adding the store and
`publishFileExclusive` (0.x, `minor`; an external provider importing
`writeAtomic` is possible and not knowable from here). The first
`config.agents.replace` re-serializes `config.json` with two-space indentation
and the submitted agent order; values are unchanged and `dispatchers` is
written as held.

## 8. Product catalog entries touched

- Team lifecycle — "The Team record is the only existence fact": holds across
  restarts; while the daemon runs a record deleted or damaged by hand no longer
  frees the name (ruled).
- Team lifecycle — "A failed dissolve leaves a Team that still exists": the
  Team record is rebuilt from the loaded record, which equals the file because
  the file is written first. Identity and Workflow wording is unchanged: they
  are still read from disk once their owner ends.
- Local state and upgrades — while an owner holds a file, the daemon does not
  read hand edits to it.
- New entry: runtime `agents` configuration through Commands (read with secrets
  empty, whole-section replace, empty keeps the secret, next launch), and
  `dispatchers` by hand with the daemon stopped.
- No catalog entry describes `workflow_status` freshness; the recorded
  consequence contradicts none.
- The Minimize Core Provider Boundaries record that keeps configuration outside
  the Command catalog is superseded for `agents`; that task's record names it.

## 9. Delivery: three pull requests, in order

Operator ruling: one task, infrastructure first ("不拆了，不管怎么样都会是顺着
做。"). Each pull request passes build, lint, test, and `typecheck:tests`, plus
`.agents/scripts/check.sh` for its knowledge changes, and carries the
maintenance-skill and knowledge updates for what it moves.

1. **Store and Feishu.** The primitive and `publishFileExclusive` with their
   own tests; routing, `access.json`, and `chat-bots.json` moved; utils'
   `writeAtomic`, the inline chat-bots writer, and the access mutex deleted.
   Smallest stores first; proves lazy load and failure location.
2. **Core stores.** Identity (including the live-owner read paths), Team,
   cron, Workflow, and the journal's create. `atomic-write.ts` and
   `json-document-store.ts` deleted.
3. **Config.** `resolveConfig`, the Config Service, reader threading, the
   Commands, the global holder deleted; `config-envelope.md` and the
   maintenance skill routing; change notes.

Between pull requests the task record lands as `blocked` with the next stage
named as its blocker — the same shape this record had while it was sequenced
after the Dispatcher Command task — and as `done` with the third.

## 10. Verification by acceptance criterion

| Criterion | Evidence |
| --- | --- |
| Each moved store reads memory while held, writes first, fails without changing memory | Primitive tests on real temporary files: replace the file on disk after load and assert `current` is unchanged; make the write fail and assert memory and file bytes are unchanged and the next update succeeds; `afterCommit` order across queued updates. One behavior test per owner through its own API. |
| A hand edit to a live entity's identity does not change list, status, or `leader_state` | Damage a live member's and a live leader's `identity.json`; the three reads still report the live values. |
| `chat-bots.json` writes serialized | Two overlapping `observeKnownBot` calls for different bots; both are in the file (fails on today's code). |
| Existing files load unchanged | Fixtures in the current release's format for all eight files load; a no-op round trip is byte-identical where the encoder is JSON. |
| Unreadable `access.json` does not fail the Channel's start | Start a session over a malformed file; start succeeds, the first gate operation fails, the file is fixed, the next succeeds. |
| Read returns `agents` with secrets empty | Through a Channel port; nested objects and arrays, non-string secret values; no `dispatchers` key. |
| Failed validation or failed write changes nothing | Invalid provider block; unwritable directory; file bytes and `current()` unchanged; a later valid write succeeds. |
| Removing a Dispatcher's `agentRuntime` id is rejected | The loader's message, through the Command. |
| A valid write is in the file on return and used by the next launch | Replace through a Channel port, read the file, launch a TeamMate with a fake provider and assert what it received; a running runtime is not restarted. A provider not loaded before is loaded and launched. |
| Empty secret keeps the stored value | File bytes keep the old secret; agent array reordered; a new id with `''`. |
| No Command reads or writes `dispatchers` | Closed input rejects the key; a hand-written `~/` `cwd` survives a write byte-for-byte. |
| Maintenance skill | `config-envelope.md` states Config Service ownership and stop-before-hand-edit-or-onboard; `feishu-access-v3.md` states memory authority while running. |
| Gates | The four Rush commands, read from their summary lines. |

Load-bearing regressions kept: the dissolve-members and dissolve-recovery
cases (held, unheld, already-closed members; a deleted cron store stays
deleted); runtime-generation rejection including a callback queued before a
lease is revoked; managed-worktree reopening (the nested-queue case); cron
delete racing a fire in both orders; routing's binding-plus-subscription
removal in one commit; access approval racing pairing-card delivery; the
issue #63 non-blocking inbound gate, unchanged. The Team read-path test is the
one replaced deliberately (§3.5).

## 11. Risks

- **A second authority survives.** Fresh identity readers, `TeamService.record`,
  and Workflow's aliases can all pass ordinary persistence tests and still
  disagree with the owner. Pre-review counts them by name.
- **`WorkflowRun` is the costliest move:** the only store mutated in place at
  many sites, with journal ordering inside the same critical sections, in a
  file at the size gate.
- **Provider import side effects** at write time cannot be rolled back; the
  loader already assumes provider config readers are side-effect free at start.
- **Team records are held for the daemon's life**, so memory grows with every
  Team ever loaded (ruled; no cap is added).

## 12. Adjudication record

Where the seats disagreed after cross-review, and why this file chose as it did:

| Point | Chosen | Reason |
| --- | --- | --- |
| Record lifetime with no live owner | owner-scoped (B, C) | Operator ruling 2026-09-20. A's live-reader finding is kept regardless (§3.4). |
| Config readers | thread `current()` (A, B) | In-place assignment keeps a second resolved copy; C's counter was diff size only. |
| Exclusive create | kept (all three after review) | The journal needs it; identity no-clobber is a recorded contract. |
| Team publication order | `afterCommit` in the store (B, C) | Two owners need post-commit publication (Team roster, identity `onPersisted`), so it is not a special case; it lets Team's queue go. A preferred keeping Team's queue to avoid a generic hook; with two users that objection does not hold. |
| Team store shape | one store per Team in a map (A, B) | C's owner class with its own tail was a fifth hand-rolled copy; C did not rebut. |
| Access mutex | deleted (A, B) | Two seats read all five lock bodies; each fits one `update`. |
| `chat-bots.json` I/O error | unchanged, empty (A, B) | No named scenario; the requirement forbids moving failure locations. |
| Config write source | raw file object (all three after review) | `stringifyConfig` rewrites a hand-written `dispatchers`. |
| Command names | `config.agents.get` / `replace` (A, C) | "replace" states whole-section semantics. |
| `fsync` | none | Operator ruling 2026-09-20. |
| Delivery | three pull requests (all three) | Review size, given the second-authority risk. |
