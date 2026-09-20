# Requirement

## Initial request

Operator, 2026-09-17, as the second requirement beside
[Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md):

> 还有第二个需求，就是增加一套全新的 config 域下的 commands，支持运行时，
> channel 主动修改配置文件，主要覆盖的是 config.json 配置文件修改。修改后立即生效的逻辑

## Current alignment

- Status: Converged (2026-09-19). The operator reopened the 2026-09-17 Config Service shape and replaced it: every store is transactional, and the Commands read and write only `agents`. The rulings ledger names which 2026-09-17 decisions are superseded.
- Confirmed current behavior and evidence:
  - No Core Command, Channel, or MCP tool writes `config.json`. The only
    writer is `dreamux onboard` (a plain `writeFile`, not temp + rename). The
    documented manual edit is: confirm operator intent, write a sibling 0600
    temp file, atomically replace, run `dreamux doctor`, restart
    (`packages/dreamux/skills/dispatcher/dreamux-maintenance/references/config-envelope.md`).
  - Nothing in the daemon re-reads, watches, or reloads `config.json`.
    `dreamux serve` loads it once (`packages/dreamux/src/cli/server.ts`) and
    hands one mutable `DreamuxConfig` object by reference to `Server`,
    `Dispatchers`, every `DispatcherService`, and from there to the Channel,
    Team, and TeamMate services.
  - The file holds exactly two host sections. `agents[]`: `id`, `provider`,
    and an opaque provider `config` (`builtin:codex`: `bin`, `approval_policy`,
    `sandbox_mode`, `extra_args`, `extra_env`, timeouts; `builtin:claude-code`:
    `bin`, `model`, `permission_mode`, `remote_control`, `extra_args`,
    `extra_env`, timeout). `dispatchers[]`: `id`, `cwd`, `enabled`,
    `workspace.enabled`, `agentRuntime`, and `channels[]` of `id`, `provider`,
    and an opaque provider `config` (`builtin:feishu`: `app_id`,
    `app_secret`). Provider blocks are validated by each provider's own
    config reader.
  - When a change is seen today, by field:
    - read per operation from the shared object (seen by the next operation;
      a running runtime keeps its copy): `agents[id].config`/`provider` at the
      next runtime launch; `dispatchers[].workspace.enabled`, `cwd`, and the
      TeamMate default `agentRuntime` at the next spawn or Team create;
    - fixed when a dispatcher starts: `channels[].config` (Feishu credentials
      are copied into the session), the dispatcher's own agent runtime and cwd;
    - fixed at process start: dispatcher membership and `enabled`
      (`DispatcherStore` builds its rows once), the channel identity, and which
      provider implementations are loaded.
  - Restarting one dispatcher is not a product capability, and the code cannot
    do it today: `DispatcherService.stop` leaves its Agent `active` (only
    `stopForHost` runs), so a later `start` throws "cannot replace its Agent
    while prior teardown is incomplete" (`input-source-lifecycle.ts`), and the
    stop's admission fence is never reopened. Minimize Core
    Provider Boundaries removed `dispatcher.stop`: "Stopping or restarting one
    Dispatcher is not a product capability." The same record keeps
    configuration outside the Command catalog: "Daemon process bootstrap,
    configuration, onboarding, and diagnostics that are not current admin
    Commands remain direct host control-plane capabilities." This request
    changes that second decision.
  - Channel-owned settings are not in `config.json`: Feishu access policy and
    pairing live in the dispatcher's `access.json`; bindings, Collaboration
    Space policy, and document subscriptions live in the Channel's routing
    state.
  - Slash commands have no permission beyond the ordinary authorization to
    deliver a message in that conversation (product catalog).
  - How a bad configuration fails, traced on 2026-09-19 for the operator's
    concern that changing configuration at runtime can make the system
    unusable:
    - Read at every runtime launch: `agents`. `TeammateRuntimeOwner` resolves
      `config.agents[identity.agent_runtime]` inside each start attempt; a
      failed attempt rolls back and leaves no runtime, so the next submission
      starts again from the configuration current at that moment. Channel
      Commands reach Core through the Channel's port and do not pass through
      any Agent.
    - Read only when the process or a Dispatcher starts:
      - `dreamux serve` exits when `loadConfig` rejects the file, and when any
        enabled Dispatcher's `cwd` fails the workspace preflight
        (`Server.assertDispatcherWorkspaces`, aggregated, before any
        Dispatcher starts).
      - A Dispatcher starts its Channel sessions one by one; one session
        failing to start fails and rolls back the whole Dispatcher, closing
        every Channel it had, and the server logs "dispatcher failed to start"
        and continues with the others. The Feishu session fails its start when
        its WebSocket is not ready within the startup grace period.
      - Removing or disabling a Dispatcher removes its Channels at the next
        start.
    - The loader already rejects a Dispatcher `agentRuntime` that names no
      `agents[]` id, a duplicate channel provider in one Dispatcher, and an
      invalid provider block; it does not check credentials or whether a
      `cwd` is usable on the host.
  - Persistence inventory for the storage infrastructure direction (read-only
    survey on 2026-09-17, re-surveyed store by store on 2026-09-19; every
    claim below was read in source unless marked inferred). Grouped by shape:
    - Memory first, file written asynchronously: none. Every runtime state
      write is awaited, and a failure returns to its caller or ends its owner.
      (The volatile kind this once pointed at is not built: operator,
      2026-09-19, "不做（推荐）".)
    - Authoritative memory, file written before memory changes, mutations
      serialized by a promise tail:
      - The live agent identity: `AgentRuntimeStateStore`
        (`service/agent-entity/runtime-state.ts`) over `AgentIdentityStore`
        (`identity.json`). The identity store itself holds no memory and also
        writes entities that have no live owner: creation, the Dispatcher
        Agent's preparation before its service exists, and closing members
        that are not held during a dissolve.
      - The Feishu routing document (`FeishuRoutingStore`,
        `channel/feishu-channel/src/routing/store.ts`), loaded once per
        session; the file name carries the channel id, so no other writer
        exists.
    - Mixed: a Workflow run record (`WorkflowRun`) changes memory first and
      then awaits the write inside its serialized mutation; the terminal
      transition writes before memory. Its `journal.jsonl` is an awaited
      append-only log.
    - No memory; each operation reads the file, changes it, and writes it
      back:
      - The Team record (`TeamStore`). Its update merges against the file on
        purpose: "writing the caller's older snapshot back would resurrect a
        Team from a stale in-memory copy and silently reclaim a name that is
        free" (`service/team-collection/store.ts`). One instance per
        Dispatcher writes; `dreamux doctor` and the startup legacy check only
        read.
      - Cron jobs (`CronJobStore` over `JsonDocumentStore`), one instance per
        Dispatcher or Team scope, serialized by a promise tail. Only the
        daemon writes; `dreamux doctor` only reads.
      - Feishu `access.json`, serialized by the Channel's access mutex.
        Operators edit it by hand only with the daemon stopped (the
        dreamux-maintenance quiesce procedure).
      - Feishu `chat-bots.json`, written by the Channel only. Its four
        read-change-write paths share no lock; whether the Feishu SDK can run
        two of them at once is inferred, not read. `loadChatBots` turns every
        read error into an empty store, so a failed read followed by any save
        replaces the file with an empty one.
      - A Dispatcher runs at most one Channel per provider (the config loader
        rejects a duplicate provider), so no two Channel sessions share
        `access.json` or `chat-bots.json`.
    - Not stores: `run/restart-intent.json` is a one-shot hand-off the CLI
      writes and the daemon consumes once at start; `config.json` is written
      today only by `dreamux onboard` and becomes the Config Service's file.
    - `JsonDocumentStore` (`platform/json-document-store.ts`) is a versioned
      read plus an atomic write, with no memory; its callers are the cron job
      store and the Workflow run store. The service-topology-foundations plan
      to move the other single-document stores onto it was not carried out.
    - Atomic replace-write exists as Core `writeFileAtomic` (creates missing
      directories) and `@excitedjs/dreamux-utils` `writeAtomic` (requires the
      directory; used by the Feishu access and routing stores), plus an inline
      copy in `chat-bots-store.ts`. Nothing calls `fsync`. A Channel package
      may depend on `dreamux-types`, `dreamux-utils`, and its own transport
      package, never on `@excitedjs/dreamux`, so a store Channels use lives in
      `@excitedjs/dreamux-utils`.
    - Knowledge drift found on the way: the service-topology-foundations
      requirement still names removed stores (`ChannelBindingStore`,
      `TeamMateIdentityStore`, a persisting `DispatcherStore`), and
      `.agents/domains/service-topology.md` says collections do not build their
      own identity store while several services do.
- User story: an operator using a web front end that reaches Dreamux through
  a Channel views and changes the agent runtime settings — which runtimes
  exist and how each launches (binary, model, permission and sandbox modes,
  arguments, environment) — while Dreamux runs, and expects the next runtime
  it launches to use them without restarting Dreamux. Dispatcher settings stay
  out of that surface, because a bad Dispatcher setting takes effect only at
  the next start and can make the front end itself unreachable (see the
  failure trace above).
- Desired outcome: One transactional store kind owns every persisted
  runtime document: the file is written durably before the in-memory value
  changes, and memory is authoritative while the daemon runs. Every existing
  store moves onto it. On top of it, a Config Service owns `config.json`
  while the daemon runs, and new Core Commands let a Channel read and replace
  the `agents` section, which applies from the next runtime launch.
- Desired behavior:
  - Storage:
    - The Team record, cron jobs, Feishu `access.json`, and
      `chat-bots.json` stop re-reading their file on every access; like the
      live agent identity, the Feishu routing document, and the Workflow run
      record, each keeps an authoritative in-memory value and writes the
      file before changing it. Writes to one file are serialized, including
      `chat-bots.json`.
    - A write that fails leaves memory unchanged and fails the operation
      that asked for it.
    - While the daemon runs, a hand edit, damage, or deletion of a file that
      a loaded owner holds is not read; the next write overwrites it. The Team
      record, cron jobs, the Feishu documents, and `config.json` are held for
      the life of their owner once loaded. An agent identity is held while its
      entity is live, and a Workflow run record while its run executes; a
      stopped member's identity and a finished run's record are read from
      their file when next used (operator, 2026-09-20, "只在有 owner 时留").
    - Every read of a live entity goes through its live owner. Today the
      TeamMate list and status and a Team's `leader_state` read the identity
      file even while that entity is live
      (`service/teammate-collection/index.ts`, `service/team-collection/read-model.ts`).
    - "Written before memory changes" means an awaited temporary file and
      atomic rename, as today; no `fsync` (operator, 2026-09-20, "不加，维持现状").
  - Config Commands:
    - Read returns the whole `agents` section. A value whose key names a
      secret (the rule `dreamux config show` already applies) is returned
      empty.
    - Write carries the whole `agents` section. An empty secret keeps the
      stored value; a non-empty one replaces it. The resulting configuration
      — the new `agents` with the `dispatchers` the process holds — is
      validated as a whole before anything changes.
    - Validation applies the rules the next start applies, so a write the
      next start would reject is rejected. Removing an `agents` id a
      Dispatcher's `agentRuntime` names is therefore rejected; removing one
      only existing Teams or TeamMates use is allowed, and they fail at their
      next launch.
    - A write that adds an agent whose provider the process has not loaded
      loads it through the same loader the start uses, as part of
      validation; a provider that fails to load rejects the write.
    - A valid write is written to the file, then replaces the in-memory
      configuration. The next runtime launch uses it; a runtime already
      running keeps its configuration until its next launch. A failed file
      write fails the Command and changes nothing.
    - `dispatchers` is not readable or writable through the Commands. It
      changes only by editing `config.json` by hand with the daemon stopped,
      and applies at the next start.
    - While the daemon runs, the Config Service is authoritative: every
      Command write rewrites the whole file from memory, so a hand edit made
      while the daemon runs — to either section — is overwritten by the next
      write. The same holds for `dreamux onboard` run while the daemon runs.
      The maintenance guidance says to stop the daemon before editing by hand
      or running onboard.
- Scope: the transactional store in `@excitedjs/dreamux-utils`; moving the
  live agent identity, the Team record, cron jobs, the Workflow run record,
  and the Feishu routing, `access.json`, and `chat-bots.json` stores onto it,
  replacing `JsonDocumentStore` and the existing atomic-write helpers; the
  Config Service; the `config` Core Commands; the host configuration readers
  that must read through the Config Service; their tests; the
  dreamux-maintenance skill; the knowledge base; and change notes.
- Non-goals:
  - A volatile (memory first, file later) store kind.
  - Changing `dispatchers` at runtime, or reading it through the Commands.
  - The Channel that serves the web front end.
  - Authorization inside Core.
  - A CLI verb.
  - Restarting a runtime because of a configuration change.
  - Append-only logs (the Workflow `journal.jsonl`), one-shot hand-offs
    (`run/restart-intent.json`), and caches.
- Constraints and invariants:
  - No persisted file changes shape, path, or mode: every file a released
    build wrote is read as it is, and a configuration written by the
    Commands loads at the next start exactly as a hand-written one does.
  - Moving a store does not move where an unreadable file fails. Today an
    unreadable `access.json` fails the operation that reads it and is not
    read at start; it must not become a failed Channel or Dispatcher start. Stores already read at start (the routing document, cron jobs)
    keep failing there.
  - Every change to the shape, validation, default, ownership, or meaning of
    a Dreamux config or persisted state file updates the dreamux-maintenance
    skill in the same change (repository rule).
  - `config.json` keeps mode `0600`.
  - The storage infrastructure replaces the existing atomic-write helpers
    rather than landing beside them: Core `writeFileAtomic`, utils
    `writeAtomic`, and the inline copy must not all survive next to a new
    store layer (repository entropy rule).

## Acceptance criteria

- Each moved store serves reads from memory while its owner holds it, writes
  its file before changing memory, and on a failed write leaves memory
  unchanged and fails the operation.
- A hand edit to a live entity's identity file does not change what list,
  status, or `leader_state` report while that entity is live.
- Writes to `chat-bots.json` are serialized.
- Every existing state file and `config.json` from the current release loads
  unchanged.
- An unreadable `access.json` does not fail the Channel's start.
- A read through a Channel port returns the whole `agents` section with every
  secret value empty.
- A write that fails validation, or whose file write fails, changes neither
  memory nor the file.
- A write that removes an `agents` id a Dispatcher's `agentRuntime` names is
  rejected.
- A valid write that changes an `agents` entry is in the file when the
  Command returns and is used by the next runtime launch without a restart.
- A valid write that submits a secret as empty leaves the stored secret
  unchanged in the file.
- No Command reads or writes `dispatchers`.
- The dreamux-maintenance skill states the Config Service ownership rule and
  the stop-before-hand-edit guidance.
- Build, lint, test, and `typecheck:tests` pass.

## Decisions and unknowns

- Operator rulings: [rulings ledger](/.agents/tasks/architecture/add-runtime-config-commands/rulings.md)
  — every ruling verbatim, with superseded ones named.
- Assumptions: None.
- Blocking unknowns: None.
- Recorded as scope and constraint by the TeamLeader and played back, not
  operator decisions: the Workflow run record (mixed today) moves onto the
  transactional store, so `workflow_status` no longer shows progress that is
  not yet written; and moving a store does not move where an unreadable file
  fails.
- Follow-ups:
  - A Command that restarts one Dispatcher; outside this task.
