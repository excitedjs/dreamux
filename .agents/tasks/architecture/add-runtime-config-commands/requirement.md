# Requirement

## Initial request

Operator, 2026-09-17, as the second requirement beside
[Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md):

> 还有第二个需求，就是增加一套全新的 config 域下的 commands，支持运行时，
> channel 主动修改配置文件，主要覆盖的是 config.json 配置文件修改。修改后立即生效的逻辑

## Current alignment

- Status: Reopened; the operator widened the direction to a storage infrastructure refactor.
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
- Interpretations recorded without objection when they were played back on the
  2026-09-17 card:
  - The caller is a web front end reaching Core through a Channel's Core port.
  - The Commands are also reachable over `admin.sock`; no CLI verb is added.
- Assumptions: None.
- Blocking unknowns:
  1. Whether the storage infrastructure refactor belongs to this task or to its
     own task that this one builds on.
  2. Which existing persisted stores move onto the new infrastructure, and in
     which package it lives.
- Follow-ups:
  - A Command that restarts one Dispatcher; outside this task.
