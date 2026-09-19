# Requirement

## Initial request

Operator, 2026-09-17, as the second requirement beside
[Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md):

> 还有第二个需求，就是增加一套全新的 config 域下的 commands，支持运行时，
> channel 主动修改配置文件，主要覆盖的是 config.json 配置文件修改。修改后立即生效的逻辑

## Current alignment

- Status: Clarifying. The storage infrastructure scope is decided. The operator reopened the Config Service requirement on 2026-09-19 ("config service 重新想想。我觉得我那天想错了"); every Config Service item below stands only as the 2026-09-17 record until it is re-confirmed.
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
  - Persistence inventory for the storage infrastructure direction (read-only
    survey on 2026-09-17, re-surveyed store by store on 2026-09-19; every
    claim below was read in source unless marked inferred). Grouped by shape:
    - Memory first, file written asynchronously: none. Every runtime state
      write is awaited, and a failure returns to its caller or ends its owner.
      The volatile kind therefore has no existing store to take over; the
      Config Service's `agents` section is its first user.
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
- Desired outcome: A dedicated Config Service owns `config.json` while the
  daemon runs. A Channel reads and replaces the whole configuration through
  new `config` Core Commands; `agents` changes apply immediately, `dispatchers`
  changes apply after the next process restart, and the write result says which
  changes are waiting for that restart.
- Desired behavior:
  - Read: the Commands return the whole configuration. A secret value is not
    returned; the caller sees it as empty.
  - Write: the caller submits the whole configuration. It is validated as a
    whole before anything changes. An empty secret keeps the stored value; a
    non-empty one replaces it.
  - `agents` — every addition, removal, and change — applies immediately: the
    in-memory value changes first and the file is written asynchronously.
    A runtime already running keeps its configuration until its next launch.
    Removing an id still used by an existing entity is allowed; that entity
    fails at its next launch.
  - `dispatchers` — every addition, removal, and change — applies only after
    the next process restart: the write changes the file, and the running
    process keeps reading the values it started with. Nothing is restarted
    automatically.
  - The write result lists the written changes that wait for a restart.
  - A failed asynchronous file write is logged; nothing else handles it.
  - While the daemon runs, the Config Service is authoritative: a hand edit of
    `config.json` is not read, and the next write overwrites it. The
    maintenance guidance says to change configuration through the Commands
    while the daemon runs, and to stop the daemon before editing by hand.
- Scope: the Config Service, the `config` Core Commands, the host
  configuration readers that must read through it, their tests, the
  dreamux-maintenance skill, the knowledge base, and change notes.
- Non-goals:
  - The Channel that serves the web front end.
  - Authorization inside Core.
  - A CLI verb.
  - Restarting a Dispatcher or a runtime because of a configuration change,
    including making a newly added Dispatcher startable before a restart.
  - Recovering from a failed file write.
- Constraints and invariants:
  - Every change to the shape, validation, default, ownership, or meaning of
    `config.json` updates the dreamux-maintenance skill in the same change
    (repository rule).
  - A configuration written by the Commands loads at the next start exactly as
    a hand-written one does; the file format does not change.
  - The file keeps mode `0600`.
  - The storage infrastructure replaces the existing atomic-write helpers
    rather than landing beside them: Core `writeFileAtomic`, utils
    `writeAtomic`, and the inline copy must not all survive next to a new
    store layer (repository entropy rule).

## Acceptance criteria

- A read through a Channel port returns the whole current configuration with
  every secret value empty.
- A write that fails validation changes neither memory nor the file.
- A valid write that changes an `agents` entry is used by the next runtime
  launch without a restart, and the file eventually holds it.
- A valid write that submits a secret as empty leaves the stored secret
  unchanged in the file.
- A valid write that changes `dispatchers` is in the file, is not seen by the
  running process, is listed in the write result as waiting for a restart, and
  is in effect after the process restarts.
- A failed asynchronous file write is logged.
- The dreamux-maintenance skill states the Config Service ownership rule.
- Build, lint, test, and `typecheck:tests` pass.

## Decisions and unknowns

- Confirmed operator decisions (2026-09-17):
  - Record this as its own task, separate from the Dispatcher Command task.
  - Entry, asked "谁、从哪里触发配置修改？": "只暴露给Channel。现在会有web端通过
    Channel 修改配置的需求，如果不能只暴露给 Channel，还必须暴露给 CLI 的话，那也可以。
    以代码量最小的方式来做"
  - Scope, asked "第一版要能改 config.json 的哪些部分？": "整个文件都能改" — the
    offered option included adding and removing `agents`, `dispatchers`, and
    `channels`, and Feishu `app_id` / `app_secret`.
  - "立即生效", asked with A (write, then restart the whole daemon) against B
    (apply in process; restart only an affected Dispatcher, reversing the
    #350 decision that single-Dispatcher restart is not a product
    capability): "B 进程内热更新".
  - Authorization: "由 Channel 自己鉴权" — Core adds no caller identity or
    permission check.
  - Reading: "读取这个机制,密钥就不返回.调用方表现为input 是空的，但是可以写入".
  - The Channel serving the web front end: "不在，只做 Core Command".
  - Write contract: "整份写回，空=保留原值" — a write carries the whole
    configuration; an empty secret keeps the stored value, a non-empty one
    replaces it.
  - A changed `agents[]` entry: "下次拉起时生效" — running runtimes are not
    restarted.
  - Fields that apply only when a Dispatcher starts (asked with Feishu
    credentials, the Dispatcher's own runtime and cwd, and `enabled` as
    examples): "不自动重启。重启这个东西应该做一个新的command。不在本期需求范围内"
  - Removing an `agents[]` id still used by an existing entity: "允许写入".
  - Adding a Dispatcher, asked whether `dispatcher.start` should reach it at
    once: "不要，等进程重启".
  - Removing a running Dispatcher, answered with a design direction: "这个场景有点
    多呀,我觉得可以系统性地解决一下这个问题.有些配置如果必须重启才能生效，那就让它始终只从
    内存中读值。然后改配置就只去改文件，就可以实现重启后生效了。有些需要立即生效的情况，我感觉你
    需要类似 TeamMate 的 Identity 机制。修改内存值之后，异步去落盘。我有点忘记了，但最开始确实
    是希望设计成这样。"
  - Listing the changes that wait for a restart: "这个也系统性地解决一下吧：Config 有一个
    专门的 Config Service 吧。。是不是就比较好解决这个问题了"
  - Persistence failure: "短期也不要考虑什么落盘失败之类的了。落盘失败了就写日志，到时候再
    排查。"
  - Code check on the cited model: the agent identity store
    (`packages/dreamux/src/service/agent-entity/runtime-state.ts`) serializes
    mutations and writes the identity file durably before it replaces the
    in-memory snapshot; each update resolves only after the write. The
    direction above asks for the in-memory value first and an asynchronous
    write, which is the reverse order.
  - Field classification, asked with a finer per-field split: "简单区分，agents
    全都立即生效，dispathcers 全都重启生效。"
  - Listing the changes that wait for a restart: "列出".
  - Hand edits while the daemon runs: "运行中以 Config Service 为准" — the
    offered option said a hand edit is not read, the next write overwrites it,
    and the maintenance skill says to use the Commands while running and to
    stop the daemon before editing by hand.
  - Storage infrastructure, raised after the requirement above converged:
    "那我感觉这里可以来一波大重构，单独拆分出一套存储基建来，一个是事务性存储，就是现在
    team identity 这种的，先确保落盘，再改内存值的，一个是易失性存储，就是先改内存值，
    然后再落盘的。" The solution-path card sent before this message was
    dismissed in favor of discussion.
  - Sequencing: "先把需求1 做了。需求1 改动看起来比较可控。然后需求2 你先记录到 task
    记录里，1 合入后我们再推进2".
- Confirmed operator decision (2026-09-19), after the TeamLeader recommended
  splitting the storage infrastructure into its own prerequisite task:
  "不拆了，不管怎么样都会是顺着做。" — the storage infrastructure refactor
  belongs to this task, and the work runs in order: the infrastructure first,
  then the Config Service on top of it.
- Confirmed operator decision (2026-09-19), on a card after the store
  inventory above was played back. Asked "③ 那四个每次读文件的存储（Team 记录、
  cron、access.json、chat-bots.json），这次也改成内存为准，迁到事务性存储吗？", the
  operator chose "一起迁（推荐）". The option said: afterwards only the
  transactional and volatile kinds remain, and the `chat-bots.json`
  overwrite race goes with it; the costs are a larger change, the Team
  record's guarantee against resurrecting a dissolved Team moving from a
  merge against disk to a single in-memory owner, and a file damaged or
  deleted by hand while the daemon runs no longer failing loud but being
  overwritten by the next write. The rejected option moved only the stores
  that already hold authoritative memory.
  - Consequence recorded by the TeamLeader, not a ruling: the Feishu routing
    store moves under either option, so the store infrastructure lives in
    `@excitedjs/dreamux-utils`.
  - Product catalog entry this touches: "The Team record is the only
    existence fact" (Team lifecycle). While the daemon runs, a Team record
    deleted or damaged by hand no longer frees the name before a restart.
- Operator, 2026-09-19, after the card above: "config service 重新想想。我觉得
  我那天想错了" — the Config Service requirement is reopened; which part is
  being reconsidered is not yet known.
- Interpretations recorded without objection when they were played back on the
  2026-09-17 card:
  - The caller is a web front end reaching Core through a Channel's Core port.
  - The Commands are also reachable over `admin.sock`; no CLI verb is added.
- Assumptions: None.
- Blocking unknowns:
  1. The reopened Config Service requirement: which of the 2026-09-17
     decisions the operator is reconsidering, and what replaces them.
- Follow-ups:
  - A Command that restarts one Dispatcher; outside this task.
