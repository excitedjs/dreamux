# Requirement

## Initial request

- Operator, 2026-09-20: "agents 配置现在其实是有点问题的. 你先帮我梳理一下两个 provider
  继承了什么必须的配置，以及他们自己又扩展了什么配置", then "我打算给 model 和
  effort 提成一级参数。可以是 defaultModel 和 defaultEffort ，我计划增加一个
  /model 和 /effort 两个 slash 去给这个 runtime 在运行中切模型和 effort。"

## Current alignment

- Status: Converged on the rulings below; awaiting the operator's confirmation
  of this playback.
- Desired outcome: model and reasoning effort become first-class runtime
  parameters instead of provider-private config, and an operator can switch
  both on a running runtime from the conversation.

### Desired behavior

1. **Configuration.** An `agents[]` entry may carry `defaultModel` and
   `defaultEffort` beside `id`, `provider` and `config`. Both are optional.
   They are what a runtime of that entry starts with when the entity has no
   value of its own.
2. **Core owns the two concepts.** The neutral runtime contract carries a model
   and an effort to the provider, lets a caller change them on a live runtime,
   and lets a caller ask what the runtime supports. Core does not define the
   legal values: an effort is a string it passes through and validates against
   what the runtime reports.
3. **Per-entity persistence.** Once switched, the value lives in that entity's
   identity record and outranks the entry's defaults from then on, across
   restarts. Nothing rewrites it when the entry's defaults change.
4. **Commands.** `/model` and `/effort` act on the Team bound to the
   conversation — its leader — or on the Dispatcher when the conversation is
   not bound to a Team.
   - With no argument: list what the runtime supports and what is in use.
   - With an argument: validate against what the runtime reports; refuse an
     unsupported value and name the available ones, writing nothing; otherwise
     apply it to the live runtime and record it in the identity.
   - A turn already running keeps the model and effort it started with; the
     change takes effect from the next turn.
   - If the entity is not running, the command starts it the way a first
     message would, then applies the switch.
   - On a runtime whose provider does not implement the capability, the command
     says so and writes nothing.
5. **Claude Code's `agents[].config.model` is removed**, being unused.
6. **`ultrathink` stays Codex-only in Dreamux**, and nothing is added for
   Claude Code.

### Scope

The `agents[]` entry shape and its loader; the neutral agent-runtime contract;
both builtin providers; two optional identity fields; the Core Commands the
Channel calls; the two slash commands; the maintenance skill and knowledge
updates; the change file.

### Non-goals

- Naming a model or effort at `teammate.spawn` (short term, not ruled out
  later), and therefore no consolidation of the `agents[]` entries that differ
  only by model or effort.
- Addressing an individual TeamMate inside a Team.
- A command that resets an entity back to the entry's defaults.
- Extending `ultrathink`, or any keyword handling, to Claude Code.
- Changing how `permission_mode`, `approval_policy` or `sandbox_mode` are
  configured, and implementing the capability for any runtime provider
  published outside this repository.

### Constraints and invariants

- The identity record gains two optional fields and no existing field changes,
  so no manual rebuild is required. An older build still reads such a file and
  drops the fields on its next write.
- Removing `config.model` means a config that still sets it fails to load, so
  the change file leads with `BREAKING:` and a `Rebuild:` line naming the exact
  edit — unless the loader instead names `defaultModel` in an error that the
  solution phase decides is enough.
- Core stays behind the neutral provider contract: no Claude Code or Codex
  specific name, value or enum reaches it.
- The slash commands are two rows in the existing Channel table calling Core
  Commands through the existing port; no second dispatch site, and the file's
  700-line cap still applies.
- The maintenance skill is updated in the same change: the config envelope
  reference for the two new keys, and the state reference for the two new
  identity fields.
- No internal identifier, gateway variable or private model name from the
  operator's install reaches this repository.

## Confirmed current behavior

Read from source on 2026-09-20. Everything here is what exists today, not what
the change should do.

### What an `agents[]` entry is

- An entry accepts exactly three keys — `id`, `provider`, `config` — and any
  other key is rejected (`packages/dreamux/src/config/config.ts`, `readAgents`).
  Only `id` and `provider` are required; the whole `config` block may be
  omitted.
- Core does not know a single field inside `config`. It hands the raw block to
  the provider's own `config.read` capability and stores what comes back
  (`config.ts` `readAgents`; the capability is
  `AgentRuntimeConfigCapability` in
  `packages/dreamux-types/src/agent-runtime.ts`).
- So the only configuration the two providers share today is that envelope.
  There is no common field, and no neutral concept of a model.

### What Core supplies at launch, outside config

`AgentRuntimeCreateContext` (`packages/dreamux-types/src/agent-runtime.ts`)
carries identity (including the opaque resume session id), the parsed config,
`cwd`, the system prompt, the resolved MCP server list, skill sources,
disabled features, an optional output schema, `injectEnv`, the neutral path
context, the state and activity sinks, and a logger. Spawn environment order is
fixed: `process.env`, then Core's `injectEnv`, then the provider's own
`config.extra_env`.

### The two provider config blocks

Both packages define seven fields, all optional, all defaulted
(`packages/agent-runtime/claude-code/src/config.ts`,
`packages/agent-runtime/codex/src/config.ts`):

- Same name in both, with no shared schema behind them: `bin`, `extra_args`,
  `extra_env`, `turn_timeout_ms`.
- Claude Code only: `model` (becomes `--model`), `permission_mode` (becomes
  `--permission-mode`, four accepted values), `remote_control`.
- Codex only: `approval_policy` (default `never`), `sandbox_mode` (default
  `workspace-write`), `initialize_timeout_ms`. Approval policy and sandbox mode
  reach the child as `-c key=value` overrides ahead of `extra_args`, so an
  `extra_args` override of the same key wins
  (`packages/agent-runtime/codex/src/args.ts`, `codexArgsToCli`).
- Codex's `turn_timeout_ms` is read, defaulted and validated, and then used
  nowhere: no reference outside its own `config.ts`. Claude Code's field of the
  same name is a live idle timeout.
- Onboarding asks for `bin` and nothing else, in both providers
  (`provider.ts`, `onboard.collect` in each package).

### Where model and effort live today

- Claude Code: `agents[].config.model` is the only place, and it becomes
  `--model` at spawn (`claude-code/src/args.ts`).
- Codex: no model field exists in Dreamux config at all. The model comes from
  Codex's own `~/.codex/config.toml`, or from an `-c model=…` entry the
  operator writes into `extra_args`.
- Effort: no Dreamux config field for either provider. Codex effort is chosen
  per submission — a submission containing `ultrathink` asks for the current
  model's highest supported effort, and the next ordinary submission restores
  ordinary effort (product catalog, "Codex reasoning effort"; implemented in
  `codex/src/reasoning-effort.ts` and passed as the `effort` param of
  `turn/start` in `codex/src/events.ts`).
- One `agents[]` entry is the whole unit of choice: a spawn names an
  `agents[].id` and cannot override any field of it
  (`service/agent-entity/agent-config.ts`, `resolveAgent`). Two models of the
  same provider therefore need two entries.
- An agent entity's identity record holds `agent_runtime` (the entry id) and no
  model or effort (`service/agent-entity/types.ts`).
- The identity reader does not reject unknown keys: it enforces required
  fields, a legacy-format check, and a blocklist of removed fields
  (`readIdentity`, `assertNoRemovedRecordFields` in
  `service/agent-entity/identity-store.ts`). Adding an optional field is
  therefore readable by an older build, which ignores it — and drops it on its
  next write.

### What each runtime can change while it runs

- Claude Code: the resident session speaks a control-request protocol that
  includes `set_model`, `list_models`, `apply_flag_settings` (the setter the
  SDK's `applyFlagSettings` uses, and where an effort level would go),
  `set_permission_mode` and `update_settings`. Verified by reading the
  subtypes out of the installed `claude` 2.1.277 binary, and against the Agent
  SDK reference, which documents `setModel()`, `supportedModels()` and
  `applyFlagSettings()` as available in streaming input mode — the mode this
  provider runs. Dreamux already sends one control request today
  (`remote_control`, `claude-code/src/control-rpc.ts`).
- Claude Code effort levels are `low | medium | high | xhigh | max`. A level the
  active model does not support silently clamps to the highest supported level
  at or below it, with no warning under `stream-json` output (model-config
  reference).
- The `list_models` response carries, per model, `supportsEffort` and
  `supportedEffortLevels` (a subset of the five levels), so the effort levels a
  given model accepts are enumerable at runtime. Read from the installed
  binary. Codex's `model/list` is the symmetric capability.
- Not verified: whether a mid-session effort change is honoured in a
  `--print` session. The same reference says a non-interactive `/effort` can
  report `Not applied` while a model's default-effort hold is in effect, and
  advises `--effort` at launch instead. Whether that hold also blocks the
  control-request path is untested.
- Codex (read from the Codex app-server source, `codex-rs/`):
  - Model can be set on `thread/start` and `thread/resume` (`model`), on
    `turn/start` ("Override the model for this turn and subsequent turns",
    stable), on `thread/settings/update` (experimental) and on
    `turn/settings/update` (experimental, scoped to one running turn).
  - Effort has no field on `thread/start` or `thread/resume` — those report the
    resolved effort back but only accept it through the raw `config` override
    map (`model_reasoning_effort`). It is a first-class param on `turn/start`
    ("this turn and subsequent turns"), on `thread/settings/update` and on
    `turn/settings/update`.
  - A `turn/start` that arrives while a turn is running is folded into that
    turn as a steer: the persistent thread settings are updated, the running
    turn keeps the model and effort it started with, and the next turn to open
    its own context is the first to use the new values.
  - `model/list` is stable and returns each model with its
    `supportedReasoningEfforts` and `defaultReasoningEffort`.
  - An unrecognised model does not fail the call: Codex falls back to default
    metadata and emits a warning event. An unrecognised effort string
    deserialises into an open `Custom` variant, and no validation against the
    model's supported list was found on the client-facing paths (one exists
    only for the model-invoked `spawn_agent` tool). A live probe on 2026-09-19
    did see a 400 for an unsupported effort, which came from the backend at
    turn execution, not from this local validation.
  - What the Dreamux provider uses today: only `turn/start.effort`, resolved
    from `model/list`, `config/read` and the thread-start response
    (`codex/src/reasoning-effort.ts`, `codex/src/events.ts`). It never sends a
    model, and never uses either settings-update method.

### How model and effort are selected in practice

Read from the operator's own install on 2026-09-20, as evidence for what the
change has to replace. No identifier from that file is reproduced here.

- Twelve `agents[]` entries, none of which sets `config.model`. That is the
  evidence behind the ruling that the field is unused.
- Claude Code entries select their model with `--model` inside `extra_args`.
- Codex entries select both model and effort with `-c key=value` pairs inside
  `extra_args`, so several entries exist that differ only in which model or
  which effort they pin. Collapsing those duplicates is the practical win this
  task is after.
- Some Claude Code entries select their model through gateway environment
  variables in `extra_env` instead of a flag. Claude Code's documented
  precedence puts an in-session `/model`, then `--model`, above
  `ANTHROPIC_MODEL`, so a switch still reaches those entries; behind a gateway
  it "passes any string through without checking", so the enumerable list
  those entries can offer may be narrower.
- One entry uses a runtime provider published outside this repository, so a
  neutral model/effort capability is not a two-provider question.

### The `ultrathink` keyword in Claude Code

The ruling above keeps Dreamux out of this path, and that outcome holds. The
reason recorded with it does not: Claude Code matches the keyword in its own
client, not on the server. The installed binary carries the test
`/\bultrathink\b/i`, an `ultrathink_effort` setting, an `ultrathink-active`
state, and the reminder text it injects into the turn. So a submission
containing the word already raises that turn's effort on a Claude Code runtime
without Dreamux doing anything — which is why adding nothing is the right
outcome regardless of where the matching happens.

### How a slash command works today

- The catalog is one table in the Feishu Channel package
  (`packages/channel/feishu-channel/src/feishu-slash-commands.ts`, `COMMANDS`):
  `/bind`, `/dissolve`, `/help`, `/stop`, `/teams`. Adding a command is adding a
  row; the package's own rules forbid adding a second dispatch site.
  `/introduce` is a separate mechanism with its own detection.
- Detection requires a human sender, and in a group requires the bot to be
  mentioned (`detectFeishuSlashCommand`).
- A handler may call Core Commands through `context.invoke`, which reaches the
  same admitted Command port the admin socket uses — same catalog, same schema
  (`packages/dreamux/src/channel/core-port.ts`).
- A handler learns what it acts on from the conversation's routing plan
  (`packages/channel/feishu-channel/src/routing/index.ts`, `plan`): either the
  Team bound to this conversation, a Collaboration Space to provision, or the
  Dispatcher. **There is no per-TeamMate granularity** — a TeamMate inside a
  Team has no conversation binding, so a command cannot name one.
- A reply is `text`, `card` or `silent`, rendered by the inbound path.

## Confirmed operator decisions

Quoted from the answer cards; nothing here is paraphrased into a wider rule.

- 2026-09-20, task scope: "新开一个任务（推荐）" — this is its own task, not part
  of `add-runtime-config-commands`.
- 2026-09-20, what the commands act on: "绑定的 Team 的 leader；未绑定就切
  Dispatcher（推荐）". The card stated that a command resolves only to the
  conversation's bound Team or the Dispatcher, and that a TeamMate inside a
  Team cannot be named.
- 2026-09-20, where the fields live: "agents[] 外壳的一级字段（推荐）". The card
  stated the cost: Core gains the concepts of a model and an effort level, the
  neutral contract gains a capability, and a provider that does not support
  them needs an answer.
- 2026-09-20, persistence: "写进该实体的身份记录，重启继续生效" — the switch
  becomes that entity's own persisted setting, above the `agents[]` default.
  (This was not the recommended option; the recommendation was a
  restart-forgets-it switch.)
- 2026-09-20, coexistence with `ultrathink`: "恢复到 identity.json 最后一次变更
  之后的那一档" — the ordinary effort a submission returns to is the level
  currently recorded in the entity's identity.
- 2026-09-20, when a switch takes effect: "下一轮才换（推荐）" — the turn already
  running keeps its model and effort; no experimental method is used to change
  a turn in flight.
- 2026-09-20, validating a requested value: "先校验，不支持就拒绝并列出可选值
  （推荐）" — the command checks what the runtime reports and refuses an
  unsupported value, naming the ones that are available, rather than letting
  it silently clamp or fall back.
- 2026-09-20, Claude Code's existing `agents[].config.model`: "应该从来没有人用
  过这个字段，就当他不存在". Treated as removed, so the loader's unknown-key
  error is what a config still carrying it gets.
- 2026-09-20, a bare command: "列出可选值和当前值（推荐）".
- 2026-09-20, naming a model or effort at spawn: "我觉得短期先按 entry id 选比较
  好，但是也不排除将来我想要扩展这块。主要是让 teamleader 去指定这个玩意儿，用起来
  实在是太麻烦了" — out of scope for now; a spawn still selects an `agents[]`
  entry, and the duplicate entries that differ only by model or effort stay.
  Not ruled out later.
- 2026-09-20, a command aimed at a stopped entity: "如果是停着的，我理解设置
  model 直接给 teammate 拉起来就可以了，就像是发了第一句话一样" — the command
  starts the entity the way a first message would, then applies the switch.
- 2026-09-20, a provider without the capability: "明确报「该 runtime 不支持」
  （推荐）" — nothing is written in that case.
- 2026-09-20, the `ultrathink` keyword: "只对 codex生效，claude code 是支持
  ultrathink 的，只不过这个特性在 llm 服务端，不需要在agent runtime 这层做任何
  处理" — Dreamux keeps its keyword handling Codex-only and adds nothing for
  Claude Code. (The decision stands as quoted; the mechanism is not
  server-side — see the correction under confirmed behavior.)
- 2026-09-20, returning to the configured default: "不处理，切完了就和配置文件无
  关了，恢复的时候 identity.json 会盖过 agent profile 的default model 和 default
  effort" — no reset command, and the identity value outranks the entry's
  defaults from then on.

## Inferences awaiting confirmation

Labelled as inferences, not rulings. Each is confirmed at the
development-approval playback before any code or review cites it.

- A command that changes a live runtime also writes the identity, so the two
  never disagree.
- Core does not define the set of legal effort levels. The two runtimes do not
  agree on one (Claude Code's five named levels against the per-model list
  Codex reports), so the value is carried as a string and checked against what
  the runtime reports, which is what the validation ruling already implies.
- Starting a stopped entity for a switch launches it with its existing value
  and applies the new one afterwards, rather than launching with an unchecked
  value. Since the switch takes effect on the next turn either way, this is
  not observable, and it avoids starting a runtime on a value that validation
  then rejects.
- The reply is plain text, like every command except `/teams`.
- Precedence at launch is the operator's ruling above, stated in full: the
  identity's recorded value, else the entry's `defaultModel` / `defaultEffort`,
  else whatever the runtime defaults to on its own.
- Consolidating the duplicate `agents[]` entries is explicitly *not* a benefit
  of this change while spawn cannot name a model or effort.

## Open questions for the operator

None. The requirement is played back for confirmation before the solution
phase opens.

## Acceptance criteria

1. An entry carrying `defaultModel` / `defaultEffort` loads; an entry without
   them loads exactly as today; a config still carrying `config.model` fails
   with a message that names what to write instead.
2. A fresh entity launches on the entry's defaults. After a switch, its next
   launch uses the recorded value even when the entry's default says otherwise.
3. A bare `/model` and a bare `/effort` list what the runtime supports and what
   is in use, on both builtin runtimes.
4. An unsupported value is refused, the available values are named, the
   identity is unchanged, and the live runtime keeps what it had.
5. A valid switch during a running turn leaves that turn's model and effort
   alone and applies to the next turn; the identity holds the new value.
6. A switch aimed at a stopped entity starts it and applies; the identity holds
   the new value.
7. In a Team-bound conversation the target is that Team's leader; in an unbound
   conversation it is the Dispatcher.
8. On a provider that does not implement the capability, the command reports
   that and writes nothing.
9. Codex `ultrathink` behavior is unchanged, including that ordinary effort now
   means the level recorded in the identity.
10. The maintenance skill documents both config keys and both identity fields.

## Decisions and unknowns

- Confirmed operator decisions: recorded in their own section above.
- Blocking unknowns: the open questions above.
