# State, Config, And Files

This page is the stable contract for Dreamux local files: operator config,
server state, volatile run files, rebuildable cache, logs, workspaces, and
upgrade behavior.

Read this before changing path builders, persisted store schemas, config
loading, logs, worktree placement, or cleanup/uninstall behavior.

## Ownership Split

Dreamux local files split by volatility and ownership:

```text
~/.dreamux/
  config.json          operator-owned config
  run/                 volatile IPC/control files
  state/               durable server-owned state
  cache/               rebuildable artifacts
  logs/                diagnostics
```

`~/.codex/` remains Codex's own global auth/config/memory home. Dreamux does
not create dispatcher-private `CODEX_HOME` directories.

Path builders belong in `/packages/dreamux/src/platform/paths.ts`. Volatile
runtime socket allocation belongs in
`/packages/dreamux/src/platform/runtime-sockets.ts`. Runtime packages derive
their own runtime-specific paths from the neutral path context.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/runtime-sockets.ts`
- `/packages/dreamux-types/src/agent-runtime.ts`

## Operator Config

The path reported by `dreamux config path` is the only Dreamux operator config
source. It is normally `~/.dreamux/config.json`, may be relocated by
`DREAMUX_CONFIG_DIR`, and is mode `0600` because provider configs may contain
secrets.

The current config shape is:

- top-level `agents[]`;
- top-level `dispatchers[]`;
- explicit dispatcher `cwd`;
- inline dispatcher `channels[]`;
- dispatcher `agentRuntime` reference to an `agents[].id`.

`dreamux serve` fails loudly when config is missing, invalid, not `0600`, or in
an old shape. It does not silently create defaults at startup. The operator fix
path is `dreamux onboard` or manual rebuild.

Source:

- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/onboard/run.ts`

## Removed Local Layouts

The current file contract intentionally excludes these historical layouts and
state mechanisms:

- no `runtime_dir`;
- no SQLite-backed dispatcher state;
- no `~/.codex-host/` Dreamux runtime home;
- no dispatcher-private `CODEX_HOME`;
- no persisted inbound message queue;
- no persisted reaction ledger;
- no persisted runtime socket path;
- no workspace-local `.codex/skills` installation;
- no dispatcher-root `status.json` recovery authority (`identity.json` is the
  Dreamux agent-entity recovery state; detailed history stays in the
  provider-native transcript);
- no durable `runtime/<name>/` scratch under the dispatcher state root (runtime scratch is volatile and lives under `run/`).

Removed paths may be detected to produce fail-loud diagnostics, but current
readers must not treat them as source data, auto-migrate them, or delete them.

Source:

- `/packages/dreamux/src/service/legacy-state.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/agent-runtime/codex/src/skill-roots.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`

## 0.x Upgrade Policy

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

Source:

- `/packages/dreamux/src/service/legacy-state.ts`
- `/packages/dreamux/src/platform/json-document-store.ts`
- `/packages/dreamux/src/state/dispatcher-store.ts`

## Durable State

`~/.dreamux/state/` is durable server-owned state. The current dispatcher tree is
symmetric by agent entity:

```text
state/<dispatcher-id>/
  access.json
  chat-bots.json
  channel-bindings.json
  cron-jobs.json
  identity.json
  teammate/<name>/
    identity.json
  team/<team-name>/
    name-claim.json
    identity.json
    record.json
    cron-jobs.json
    teammate/<name>/
      identity.json
```

The dispatcher root `identity.json` is the dispatcher agent's entity state and
sits structurally outside the `teammate/` collection. TeamLeader state lives at
the Team root; Team member state lives under that Team's member collection.
Every identity owns lifecycle/worktree/intent/role guidance plus the
runtime-native `session_id` and nullable opaque `transcript_locator`; it owns no
rolling conversation projection. `name-claim.json` is the Team namespace's
permanent ownership record: a complete sibling temp file is published with an
atomic no-clobber hard link before a Team or collaboration-target side effect,
so readers never observe a partial claim. The claim is never removed, including
after dissolve. There is no separate `status.json` recovery authority and no
durable `runtime/<name>/` scratch under the dispatcher state root — runtime
scratch is volatile and lives under `run/`.

Dreamux persists no per-Turn archive. A per-entity `turn.jsonl` left by an older
release is inert residue: Dreamux never creates, stats, lists, opens, validates,
repairs, migrates, warns about, or automatically deletes it. Its condition
cannot block startup or any read/lifecycle operation. Detailed history belongs
to the selected provider's native transcript. `last` performs a bounded cold
provider query and stores no copy, index, or cursor in Dreamux state.

Each Team `record.json` is fully server-owned. Its nullable `dissolve` object is
the TeamCollection authority for one accepted operation: operation id,
requester kind and TeamLeader generation when applicable, collaboration-target
handoff ids, first accepted note/time, current phase, public-safe error,
cleanup-attempt count, and next retry time. Valid phases are
`waiting_for_team_idle`, `closing_resources`, `worktree_cleanup_pending`,
`complete`, and `failed`. Do not edit, remove, or manufacture this object by
hand; active records and pending cleanup are reconciled at Dispatcher startup.

Team `status` remains independently `starting | running | closed`. A closed Team
may have dissolve phase `worktree_cleanup_pending`, which means routes and
runtimes are durably closed while the server still owns physical managed
worktree cleanup. The shared `cleanup-pending` state is written to Team,
TeamLeader, and member identities before deletion; the single Team operation
later propagates its terminal or retained result to every borrower.

`collaboration-spaces.json` is also fully server-owned. A closing target may
hold one exact `team_dissolve_operation_id`, one generation-specific
`team_dissolve_handoff_id`, and its finalization intent. The corresponding Team
operation holds a list of target handoff ids because multiple target consumers
may join the same dissolve. These fields are lock-handoff correlation, not an
independent target-side dissolve state machine.

Feishu `access.json` is the deliberate mixed-ownership exception to the general
server-state description. Its fixed path is
`~/.dreamux/state/<dispatcher-id>/access.json`, independent of
`DREAMUX_CONFIG_DIR`. `version` is Channel/schema-owned; `dm_policy` and
`group.*` are operator policy; `allow_users` is shared authority; `pending`,
`observed_chats`, `warnings`, and `last_gate` are Channel runtime ledger. Manual
maintenance keeps the owner fully quiesced and preserves schema/ledger fields
through an independent operator's atomic owner-only patch.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/state/dispatcher-store.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/agent-entity/turns-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/channel/feishu-channel/src/chat-bots-store.ts`

## JSON Document Stores

Versioned single-document JSON stores should use `JsonDocumentStore<TDoc>`.
The base owns read/write mechanics:

- missing file returns the concrete store's `empty()` document;
- version mismatch fails loud by default;
- malformed docs become `LegacyStateError` by default;
- writes are atomic, owner-only mode `0600`, pretty JSON with trailing newline.

The base does not own paths or schemas. Path builders stay in `platform/paths.ts`
and each concrete store owns validation and domain methods.

Append-only JSONL stores that remain in the current contract (for example
Workflow journals) stay concrete-store responsibilities. Agent transcript
formats and discovery belong to their runtime provider package.

Source:

- `/packages/dreamux/src/platform/json-document-store.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/agent-entity/transcript-reader.ts`

## Run Files And Runtime Sockets

`~/.dreamux/run/` is volatile and safe to clear when no server is running.

Current run files:

- `admin.sock` and lock;
- `restart-intent.json`;
- `sockets/` fallback root for runtime rendezvous sockets.

`admin.sock` is a stable cross-process path contract. Runtime sockets are fresh,
random, ephemeral rendezvous endpoints. Runtime socket paths are never persisted
to identity, history, checkpoint, status, or public status surfaces.

Runtime socket allocation prefers `$XDG_RUNTIME_DIR/dreamux/sockets/`, then
`~/.dreamux/run/sockets/`, then a private per-user OS temp directory. Shared
`/tmp` and `/var/tmp` are not valid socket roots.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/runtime-sockets.ts`
- `/packages/dreamux/src/admin/socket.ts`

## Cache

`~/.dreamux/cache/<dispatcher-id>/` is rebuildable and safe to clear while no
server is running.

Current cache children:

- `spill/`: over-budget TeamMate completion payloads;
- `feishu-attachments/`: bounded inbound Feishu attachment downloads.

Cache files are not durable state and are not recovery records.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/channel/feishu-channel/src/feishu-message.ts`
- `/packages/dreamux-types/src/agent-runtime.ts`

## Logs

`~/.dreamux/logs/` is diagnostics, not durable state. Host logging uses pino
JSON through `platform/logger.ts`; message bodies are not logged and secrets are
redacted. Runtime logs are component-owned under the shared logs root.

MCP stdio shims write diagnostics to log files and stderr, never stdout, because
stdout is the JSON-RPC transport.

Source:

- `/packages/dreamux/src/platform/logger.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## Dispatcher Workspace

Dreamux-managed TeamMate/Team work areas live under the dispatcher workspace,
not under `~/.dreamux`:

```text
<dispatcher cwd>/.workspace/work/<name>/
<dispatcher cwd>/                # when dispatchers[].workspace.enabled is false
<dispatcher cwd>/.workspace/worktree/<repo-slug>/<slug>/
```

Managed worktree creation fails loud if the physical path would live under
`~/.dreamux`.

Source:

- `/packages/dreamux/src/service/dispatcher-workspace.ts`
- `/packages/dreamux/src/service/worktree/`
- `/packages/dreamux/src/platform/paths.ts`

## Decision Trail

- [Runtime run root](../decisions/runtime-run-root.md)
- [Providerized config and state compatibility](../decisions/providerized-config-state-compatibility.md)
- [Json document store](../decisions/json-document-store.md)
- [Logging](../decisions/logging.md)
- [Global config dir](../decisions/global-config-dir.md)
- [Feishu trusted allow-chats semantics](../decisions/feishu-allow-chats-trust-semantics.md)
