# Requirement

## Initial request

- Operator, 2026-09-20: "agents 配置现在其实是有点问题的. 你先帮我梳理一下两个 provider
  继承了什么必须的配置，以及他们自己又扩展了什么配置", then "我打算给 model 和
  effort 提成一级参数。可以是 defaultModel 和 defaultEffort ，我计划增加一个
  /model 和 /effort 两个 slash 去给这个 runtime 在运行中切模型和 effort。"

## Current alignment

- Status: Draft; clarification has not converged.
- Desired outcome: model and reasoning effort become first-class runtime
  parameters instead of provider-private config, and an operator can switch
  both on a running runtime from the conversation.
- Desired behavior: Not yet confirmed.
- Scope: Not yet confirmed.
- Non-goals: Not yet confirmed.
- Constraints and invariants: Not yet confirmed.

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
- Not verified: whether a mid-session effort change is honoured in a
  `--print` session. The same reference says a non-interactive `/effort` can
  report `Not applied` while a model's default-effort hold is in effect, and
  advises `--effort` at launch instead. Whether that hold also blocks the
  control-request path is untested.
- Codex: pending — read of the Codex app-server source in progress.

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

## Open questions for the operator

1. Which runtime does `/model` act on, given commands resolve only to the bound
   Team or the Dispatcher?
2. Does a switch persist (and where), or last until the runtime restarts?
3. Does it affect the in-flight turn or only the next one?
4. What does `defaultEffort` mean for the existing `ultrathink` behavior, whose
   rule is that the next ordinary submission restores ordinary effort?
5. What happens on a provider or model that does not support the requested
   model or effort?
6. Do `defaultModel` / `defaultEffort` sit in the `agents[]` envelope (a new
   neutral concept Core owns) or stay inside each provider's config block?

## Acceptance criteria

- Not yet confirmed.

## Decisions and unknowns

- Confirmed operator decisions: this is a new task, not part of
  `add-runtime-config-commands` (operator, 2026-09-20, "新开一个任务（推荐）").
- Blocking unknowns: the six open questions above.
