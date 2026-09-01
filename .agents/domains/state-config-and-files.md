# State, Config, And Files

What: the current ownership map and stable contract for every Dreamux local
file — operator config, durable server state, volatile run files, rebuildable
cache, logs, dispatcher workspaces, the managed service environment, and the 0.x
upgrade policy that governs changing any of their shapes.

Read this before changing path builders, persisted store schemas, config
loading, logs, worktree placement, or cleanup/uninstall behavior.

## Ownership

Dreamux local files split by volatility and ownership:

```text
~/.dreamux/
  config.json          operator-owned config
  run/                 volatile IPC/control files
  state/               durable server-owned state
  cache/               rebuildable artifacts
  logs/                diagnostics
```

Two environment overrides exist and they are not the same knob.
`DREAMUX_CONFIG_DIR` relocates where `config.json` is looked up and nothing
else; `DREAMUX_ROOT` relocates the whole Dreamux home, which is why every
`state/`, `run/`, `cache/`, and `logs/` path follows it and `access.json` in
particular is independent of `DREAMUX_CONFIG_DIR`.

Path builders belong in `/packages/dreamux/src/platform/paths.ts`. Volatile
runtime socket allocation belongs in
`/packages/dreamux/src/platform/runtime-sockets.ts`. Runtime packages derive
their own runtime-specific paths from the neutral path context. `~/.codex/`
remains Codex's own global auth/config/memory home: dispatcher app-server
processes follow Codex there and Dreamux creates no dispatcher-private
`CODEX_HOME`. Dreamux bundled skills are injected at runtime by role and are
never installed into a dispatcher workspace.

Not every file under `state/` is Core's. Each document names its owner below,
and only that owner decides whether a field can be maintained externally.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/runtime-sockets.ts`
- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/agent-runtime/codex/src/skill-roots.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`

## Contracts

### Operator Config

The path reported by `dreamux config path` is the only Dreamux operator config
source. It is normally `~/.dreamux/config.json`, may be relocated by
`DREAMUX_CONFIG_DIR`, and is mode `0600` because provider configs may contain
secrets.

It declares:

- `agents[]`: Agent Runtime provider configs, such as `builtin:codex` or
  `builtin:claude-code`.
- `dispatchers[]`: dispatcher `id`, explicit `cwd`, `enabled`, dispatcher-local
  `workspace.enabled`, configured `channels[]`, and an `agentRuntime` reference
  to an `agents[].id`.
- `dispatchers[].channels[]`: dispatcher-local channel id, Channel provider ref,
  and provider-owned channel config. Core owns no routing or Collaboration Space
  policy here. A leftover `collaborationSpace` block is a loud config error: the
  Channel that offers the product flow owns that policy, in its own state.

Legacy top-level `workspace.enabled` is not accepted. Set
`dispatchers[].workspace.enabled` on each dispatcher instead; omitted dispatcher
workspace policy defaults to enabled. A dispatcher `runtime` block is likewise
rejected with the rebuild instruction to declare a named `agents[]` entry.

`dreamux serve` fails loudly and creates no silent defaults when the config file
is missing, when its mode is not `0600`, when the JSON does not parse, when the
shape is rejected (unknown keys, a top-level `codex` block, a dispatcher
`runtime` block, a duplicate dispatcher id, a channel `collaborationSpace`
block), when a providerized entry cannot be loaded, or when an enabled
dispatcher has no explicit `cwd` — the last check lives with the workspace
contract in `dispatcher-workspace.ts`, not in the config reader. The operator
fix path is `dreamux onboard` or a manual rebuild.

Source:

- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/config/config-helpers.ts`
- `/packages/dreamux/src/service/dispatcher-workspace.ts`
- `/packages/dreamux/src/onboard/run.ts`

### Durable State Layout

`~/.dreamux/state/` is durable state, symmetric by agent entity:

```text
state/<dispatcher-id>/
  access.json
  chat-bots.json
  cron-jobs.json
  feishu-routing.<channel-slug>.<digest>.json
  identity.json
  teammate/<name>/
    identity.json
  team/<team-id>/
    identity.json
    record.json
    cron-jobs.json
    teammate/<name>/
      identity.json
    workflow/<run-id>/
      record.json
      journal.jsonl
  workflow/<run-id>/
    record.json
    journal.jsonl
```

`teammate/` and `team/` hold only entity directories, because listing a
collection is a blind `readdir`: an owner's own Agent record, its Team record,
and its channel state all sit beside the collection, never inside it.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/state/dispatcher-store.ts`

### Agent Identity Records

Every Agent — the dispatcher's own, a dispatcher TeamMate, a TeamLeader, a Team
member — persists one `version: 1` `identity.json` of the same shape. The
dispatcher's own record sits at the dispatcher state root, structurally outside
the `teammate/` collection, so the `teammate.*` read chokepoints never enumerate
it. A TeamLeader's record sits at its Team root; Team members live under that
Team's own `teammate/` collection.

A record owns identity (`name`, `dispatcher_id`, `team_id`, `agent_runtime`),
lifecycle (`status`, `created_at`/`updated_at`, `closed_at`, `close_note`,
`last_error`), placement (`source_cwd`, `source_repo`, `cwd`, `runtime_cwd`,
`worktree`), guidance (`intent`, `identity_prompt`), admin-supplied
`skill_sources`, and the provider's own prior session id. It owns no rolling
conversation projection.

`session_id: string | null` is the current persisted session field. It is opaque
to Core, which stores it verbatim, checks it for presence, and hands it back to
the same provider without parsing, indexing, or branching on it. Absent or
`null` reads as `null` (no prior session); a present value that is not a
non-empty string fails loud. That type check is the only gate on the session,
because an id the provider can no longer find already degrades correctly to
"start a fresh session".

Reading rejects exactly five removed fields — `checkpoint`, `checkpoint_kind`,
`session_ref`, `display_name`, `close_status` — plus a pre-#148 record that
still references its runtime through `provider_ref`. A leftover `role` or
`transcript_locator` is inert residue that no path reads, validates, or deletes.
Role is deliberately not persisted at all: each of the four owners that can
materialize an Agent already knows which role it is, and a durable copy could
disagree with the directory the record actually lives in.

`skill_sources` must be present and an array; a record without it is invalid.
Entries are canonical absolute skill-root directories, so relative paths and
unreadable or missing directories are rejected, duplicate roots are collapsed,
and direct child skill-name collisions are rejected at the admin boundary. Only
admin-supplied roots are persisted — required bundled role roots stay code-owned
and are recomposed at launch — which is how a runtime relaunch or process
restart preserves authorized extra skill roots. `team_id`, `source_repo`,
`intent`, `identity_prompt`, `last_error`, `closed_at`, and `close_note` are
read leniently: a non-string (or missing) value reads as `null`.

Legacy identity records that point at old under-state worktree paths are read
verbatim; ordinary startup neither rewrites nor deletes them.

Dreamux persists no per-Turn archive. A per-entity `turn.jsonl` left by an older
release is inert residue: Dreamux never creates, stats, lists, opens, validates,
repairs, migrates, warns about, or automatically deletes it, and its presence,
contents, permissions, type, or parseability cannot block startup, reads,
lifecycle operations, Workflow, Team dissolve, or shutdown. Detailed history
belongs to the selected provider's native transcript; `last` performs a bounded
cold provider query and stores no copy, index, or cursor in Dreamux state.

Source:

- `/packages/dreamux/src/service/agent-entity/types.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/agent-runtime/skill-sources.ts`
- `/packages/dreamux/src/service/agent-entity/activity-reader.ts`

### Team Records

A Team's `record.json` is fully server-owned: identity, the TeamLeader creation
inputs, the workspace, `status`, `closed_at` / `close_note`, the accepted
`team.create` request identity and payload hash, the one shared worktree
identity, and `worktree_cleanup_force`. Do not edit or manufacture it by hand.

The record is also the Team's own name claim. Publishing it is an exclusive
create, and that create is the whole acceptance protocol: before it the
candidate name is free and a caller that loses the race simply picks another;
after it the record owns the name permanently, including after the Team closes.
There is no separate claim file.

It carries no dissolve operation — no operation id, no phase, no requester
generation, no handoff ids, no attempt count, no retry time. A dissolve is an
ordinary submission answered `{ accepted, team_name, status: "submitted" }`, and
the single record write that sets `closed` is the only durable step. A process
that dies mid-dissolve therefore leaves an open Team whose children reopen
lazily, and the dissolve can simply be asked again.

Team `status` is `starting | running | closed`. The one thing a close can leave
behind is physical: a managed `delete-on-close` checkout that could not be
reclaimed is committed on the closed record as `cleanup_state:
"cleanup-pending"` together with the caller's `worktree_cleanup_force`
authorization. That pair is the entire recovery input — a later start reclaims
it from the record alone, without materializing a Team, and a failure writes no
second fact, so the same pending state stands for the next start instead of a
retry ledger. The authorization is cleared with the work it authorized, and the
Agents that ran inside the directory hold no copy of the fact, so nothing
downstream is notified.

Source:

- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/team-collection/worktree-cleanup.ts`

### Channel-Owned State

Three files under the dispatcher state root belong to the Feishu Channel, not to
Core. Core supplies the per-dispatcher state root and nothing else.

`feishu-routing.<channel-slug>.<digest>.json` is one Channel session's routing
authority, owned end to end by `@excitedjs/feishu-channel`: the filename (a slug
of the configured channel id plus a 12-hex digest of that id, so two configured
channels can never collide), the schema, and what counts as a valid document are
all the Channel's. It holds `bindings[]`, the target routes actually installed,
each naming its Team and whether it came from an explicit bind or from Space
provisioning, and `spaces[]`, the registered Collaboration Space policies with
their creation facts and a policy `generation`. Work in flight is deliberately
absent: automatic provisioning is process-local, so an unfinished one is lost
with the process and its target simply arrives unmatched afterwards. An
incompatible document fails loud and the operator recreates the rows through the
Channel's own `bind_channel` / `bind_collaboration_space` tools.

`access.json` is the deliberate mixed-ownership exception. Its path is fixed
under the state root, independent of `DREAMUX_CONFIG_DIR`. `version` is
Channel/schema-owned; `dm_policy` and `group.*` are operator policy;
`allow_users` is shared between live pairing/Owner approval and a quiesced
operator; `pending`, `observed_chats`, `warnings`, and `last_gate` are Channel
runtime ledger. The Channel writes it owner-only and creates a missing state
directory at `0700`. The exact manual-maintenance procedure — quiesce, post-stop
re-read, owner-only atomic patch, restart — is owned by
`/packages/dreamux/skills/dispatcher/dreamux-maintenance/`, not by this page.

`chat-bots.json` is the Feishu known/trusted peer bot store, `version: 1`,
owner-only and atomically written by the same provider.

Source:

- `/packages/channel/feishu-channel/src/routing/store.ts`
- `/packages/channel/feishu-channel/src/routing/document.ts`
- `/packages/channel/feishu-channel/src/chat-bots-store.ts`
- `/packages/channel/feishu-channel/src/feishu-gate-io.ts`

### Scheduler And Workflow Records

`cron-jobs.json` holds durable scheduled-task definitions owned by the scheduler
service; a Team owns its own file at its Team root.

A Dynamic Workflow run persists a `version: 1` `record.json` plus an append-only
`journal.jsonl`, at dispatcher scope or under the owning Team. A normal terminal
transition writes `completed`, `failed`, or `stopped`; startup first adopts an
already-committed terminal journal fact when present and otherwise converts a
leftover `running` record to `stopped`. Journals are server-written JSONL and
are not replayed by the current runtime.

Source:

- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux/src/service/workflow-service/store.ts`
- `/packages/dreamux/src/service/workflow-service/journal.ts`

### Removed Local Layouts

The current file contract intentionally excludes these historical layouts and
state mechanisms:

- no `runtime_dir`;
- no SQLite-backed dispatcher state;
- no `~/.codex-host/` Dreamux runtime home;
- no dispatcher-private `CODEX_HOME`;
- no persisted inbound message queue;
- no persisted reaction or COT presentation ledger;
- no persisted runtime socket path;
- no workspace-local `.codex/skills` installation;
- no dispatcher-root `status.json` recovery authority (`identity.json` is the
  Dreamux agent-entity recovery state);
- no durable `runtime/<name>/` scratch under the dispatcher state root (runtime
  scratch is volatile and lives under `run/`).

`legacy-state.ts` is the one module that still knows the removed leaf names. It
probes them so `dreamux serve` aborts and `dreamux doctor` names the path to
delete: `channel-bindings.json` and `collaboration-spaces.json` at the
dispatcher root (removed Core routing and Space state — a Channel now owns both,
in its own file), `teammate/identities`, `teammate/records`, `teammate/turns`,
`teammate/sessions.jsonl`, `teammate/history`, `team/records`,
`team/channel-bindings.json`, and `team/ledger`. The `teammate/` and `team/`
directories themselves stay valid, which is why detection probes leaves rather
than parents.

Source:

- `/packages/dreamux/src/service/legacy-state.ts`
- `/packages/dreamux/src/platform/paths.ts`

### JSON Document Stores

Versioned single-document JSON stores should use `JsonDocumentStore<TDoc>`. The
base owns read/write mechanics:

- a missing file returns the concrete store's `empty()` document;
- a version mismatch fails loud as `LegacyStateError`, naming the file and the
  delete-to-rebuild fix;
- a malformed document fails loud the same way by default, and only an
  explicitly `warn-rebuild` store warns and returns `empty()` instead;
- writes are atomic, owner-only mode `0600`, pretty JSON with a trailing
  newline.

The base owns no paths and no schemas: path builders stay in `platform/paths.ts`
and each concrete store owns its validation and domain methods. Append-only
JSONL stores that remain in the current contract (Workflow journals) stay
concrete-store responsibilities, and agent transcript formats and discovery
belong to the runtime provider package.

Source:

- `/packages/dreamux/src/platform/json-document-store.ts`
- `/packages/dreamux/src/platform/atomic-write.ts`

### Run Files And Runtime Sockets

`~/.dreamux/run/` is volatile and safe to clear when no server is running. It
holds `admin.sock` and its lock, `restart-intent.json` (a one-shot marker the
freshly started server reads once and deletes), and a `sockets/` fallback root
for runtime rendezvous sockets.

`admin.sock` is a stable cross-process path contract, so an over-budget path
fails loudly rather than moving. Runtime sockets are the opposite: fresh, random
per start, and live only in process memory. Allocation prefers
`$XDG_RUNTIME_DIR/dreamux/sockets/`, then `~/.dreamux/run/sockets/`, then a
private per-user OS temp directory; shared `/tmp` and `/var/tmp` are not valid
socket roots.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/runtime-sockets.ts`
- `/packages/dreamux/src/admin/socket.ts`

### Cache

`~/.dreamux/cache/<dispatcher-id>/` is rebuildable and safe to clear while no
server is running:

- `spill/`: over-budget TeamMate completion payloads, surfaced to the dispatcher
  model as text and read back by no process;
- `feishu-attachments/`: bounded inbound Feishu attachment downloads.

Cache files are not durable state and are not recovery records.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/channel/feishu-channel/src/feishu-message.ts`

### Logs

`~/.dreamux/logs/` is diagnostics, not durable state, and is split by component:
the server log `dreamux-server.log`, per-dispatcher Channel diagnostics under
`channel/`, and Dynamic Workflow lifecycle logs under `workflow/`. A runtime
composes its own subpaths under the same root — Codex app-server logs use
`logs/codex-app-server/<dispatcher>.log`. Host logging is pino JSON through
`platform/logger.ts`; message bodies are not logged and secrets are redacted.

There is deliberately no per-server MCP log. A shim is launched with a socket
path and an opaque lease token and cannot name a dispatcher to open a log for,
and the delegate that decides and fails runs inside the server, so the
authoritative diagnostics are already in the server log. Shim-local transport
failures go to stderr, which the runtime that spawned it captures. MCP stdout is
reserved for stdio protocol frames, so transport, schema, handler, and shutdown
diagnostics go only to those component loggers or stderr and are never persisted
as MCP state.

Source:

- `/packages/dreamux/src/platform/logger.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

### Dispatcher Workspace

Each dispatcher has an explicit `cwd`. Dreamux-managed TeamMate and Team work
areas live under that dispatcher workspace, never under `~/.dreamux`:

```text
<dispatcher cwd>/.workspace/work/<name>/              repo omitted, workspace.enabled true
<dispatcher cwd>/                                     repo omitted, workspace.enabled false
<dispatcher cwd>/.workspace/worktree/<repo-slug>/<slug>/   repo: { mode: 'managed' }
```

When the `.workspace/` boundary is used it self-ignores with a `*` `.gitignore`
so generated work areas never become repo content, and a `.gitignore` that does
not safely ignore everything is repaired. Startup also fails loud when the
configured `cwd` is missing, is not a directory, or is not read/write/exec
accessible.

Source:

- `/packages/dreamux/src/service/dispatcher-workspace.ts`
- `/packages/dreamux/src/service/worktree/paths.ts`
- `/packages/dreamux/src/service/worktree/manager.ts`
- `/packages/dreamux/src/service/worktree/workspaces.ts`

### Managed Service PATH And Working Directory

`dreamux onboard` and `dreamux daemon install` render a systemd user service or
launchd plist with an explicit `PATH`, and resolve bare provider/agent binaries
under that same effective PATH. `buildServicePath()` in `platform/paths.ts` is
the single source of its order: stable Dreamux-owned dirs (selected Node bin,
resolved provider bin dirs, dreamux bin dir), then the operator's captured
interactive-session `PATH` in its original order, then fresh-install fallbacks
(`$XDG_BIN_HOME`, `$HOME/.local/bin`, portable platform system dirs, and the
Homebrew candidate only when an async presence probe finds it). Entries
de-duplicate on first occurrence, so re-running `daemon install` after switching
nvm/pyenv/Homebrew regenerates the unit. These builders read no ambient
environment: `env`, `homeDir`, and `platform` are resolved once by the caller,
persisted into the install answers, and used for both the resolve-time and the
service-unit PATH.

Both service kinds use `stateRoot()` as their working directory, and
`installUserService()` creates that directory before either service manager
registers or starts the service, so `dreamux daemon install --start` works even
when onboarding never created server state. A dry run records the planned
creation in the transparent file ledger without touching the filesystem.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/onboard/service.ts`
- `/packages/dreamux/src/onboard/service-node.ts`
- `/packages/dreamux/src/daemon/install.ts`
- `/packages/dreamux/src/onboard/ledger.ts`

### 0.x Upgrade Policy

Dreamux 0.x does not carry silent migrations for incompatible config, state,
cache, or workspace-local file shapes. A reader should either accept the current
schema or fail loudly with exact rebuild/delete/onboard guidance.

Rules:

- authorization/access state fails loud on incompatible shape;
- TeamMate/Team recovery records fail loud rather than infer user-meaningful
  facts;
- explicitly rebuildable server state may warn and rebuild only when documented;
- removed layouts may be detected for diagnostics, but not read as source data,
  rewritten, or deleted;
- incompatible shape, version, or path changes need a Rush change file with
  `BREAKING:` and concrete `Rebuild:` guidance;
- an explicitly operator-approved same-shape semantic change may retain its
  version only when the note starts with `BREAKING:`, immediately gives a
  `Review:` warning, explicitly says no rebuild is needed, and contains no
  `Rebuild:` instruction. The V3 Feishu `allow_chats` trust reinterpretation is
  the accepted instance of this exception.

Any change to the shape, validation, default, ownership, or meaning of a config
or persisted state file also updates
`/packages/dreamux/skills/dispatcher/dreamux-maintenance/` in the same change.

Source:

- `/packages/dreamux/src/service/legacy-state.ts`
- `/packages/dreamux/src/platform/json-document-store.ts`

## Invariants

- One owner per path shape: host-owned builders in `platform/paths.ts`, volatile
  socket allocation in `platform/runtime-sockets.ts`, runtime-specific
  derivation inside the runtime package that uses it.
- The volatility split is load-bearing. Nothing under `run/` or `cache/` may be
  a recovery input, and a runtime socket path is never written into identity,
  history, status, or any public surface.
- A removed field earns rejection only when a released build wrote it AND
  accepting the record would silently discard a fact this reader cannot see.
  Every other leftover is inert residue, because each rejection costs the
  operator a rebuild.
- Core never owns a Channel's state. Core supplies the per-dispatcher state
  root; the Channel owns the filename, the schema, and the policy inside it —
  and `access.json` keeps mixed ownership only because every field's owner is
  named.
- The managed-worktree placement guard canonicalizes with `realpath`, so a
  workspace that symlinks into `~/.dreamux` is rejected too.
- Dreamux stores no conversation history of its own, which is why no state file
  here holds a transcript, an index, or a cursor into one.

History: [/.agents/tasks/architecture/README.md](/.agents/tasks/architecture/README.md)
