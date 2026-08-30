# @excitedjs/dreamux

The dreamux host server package. One long-running Node process hosts N
**Dispatchers**; each Dispatcher binds one or more Channel providers, one Agent
Runtime provider selected through `agents[]`, and Dreamux-owned MCP surfaces for
channel replies, Teams, and TeamMate work.

This file is the **package-level** quick start. For the monorepo layout and
knowledge base, see the top-level [`README.md`](../../README.md) and
[`.agents/root.md`](../../.agents/root.md).

Design background:
[#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) ·
[#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) ·
[#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4) ·
[#18 Global bin onboarding](https://github.com/excitedjs/dreamux/issues/18) ·
[#36 MVP tracking](https://github.com/excitedjs/dreamux/issues/36) ·
[#71 Capability Registry](https://github.com/excitedjs/dreamux/issues/71) ·
[#98 compatibility stance](https://github.com/excitedjs/dreamux/issues/98) ·
[#110 plugin/provider Epic](https://github.com/excitedjs/dreamux/issues/110).

## What this package ships

- Public CLI bin: `dreamux`. It owns onboarding, serving, status, doctor,
  dispatcher commands, and config commands. TeamMate and Team orchestration are
  available through Dreamux-owned MCP surfaces.
- Bundled Dreamux skills injected at runtime by role (issues #209 and #313):
  core hands the Dispatcher `dispatcher-workflow` and `dreamux-maintenance`, the
  TeamLeader `team-workflow`, and both roles the shared `workflow` skill. The
  runtime applies those role-specific plus shared roots to its engine (Codex
  `skills/extraRoots/set`, Claude Code `--add-dir`). Role-specific roots remain
  disjoint, while the shared root is deliberately composed into both roles.
  For admin-created TeamLeaders, required-source normalization protects both
  `team-workflow` and `workflow` from custom skill-root shadowing. `dreamux
  onboard` does not install bundled skills into dispatcher workspaces.
- Providerized dispatcher declarations, a process-local provider registry,
  server-owned state/log paths, the `builtin:feishu` Channel provider, the
  `builtin:codex` and `builtin:claude-code` Agent Runtime providers, and
  role-gated MCP shims for channel replies, Teams, TeamMates, and cron.
- Server-hosted TeamMate and Team ledgers with asynchronous turn delivery,
  recovery reads, bounded retry, and cold provider-native transcript retrieval.

## Current Contract

- **One Node process, many Dispatchers.** `dispatchers[].channels[]` accepts
  multiple channels with unique dispatcher-local ids. A dispatcher may declare at
  most one channel per provider ref, and each channel provider validates its own
  config (issue #209 multi-channel config). Live routing runs one session per
  declared channel and routes inbound/egress by `(channel_id, target_key)`.
- **Provider refs are explicit.** Wired builtin refs are `builtin:feishu`,
  `builtin:codex`, and `builtin:claude-code`. External `npm:` refs are loaded
  through the same provider package loader when the package is installed and
  implements the selected provider kind.
- **One dispatcher is one trust domain.** A bot may receive multiple chats, but
  all accepted messages share one dispatcher runtime context. Do not bind
  unrelated private chats to the same dispatcher.
- **Dispatcher cwd is explicit.** Codex-backed dispatchers use Codex's global
  default home (`~/.codex`) for auth, memory, config, and native sessions.
  Claude Code-backed dispatchers use Claude Code's own CLI/auth/session
  behavior. Bundled skills are injected at runtime by role (not written into
  the dispatcher cwd).
- **Inbound state is in memory.** The server keeps only process-local turn
  queues, message dedupe, and coalescing state. Restarting the server drops
  unprocessed inbound messages.
- **Outbound is MCP reply-only.** Assistant text emitted by a runtime is never
  forwarded to a channel automatically. The model must call provider-specific
  channel MCP tools such as `reply` or `react`, and those tools exist only when
  the Channel provider exposes the capability.
- **Routing belongs to the Channel.** Which conversation reaches which Team is
  decided and stored by the Channel provider that owns the conversation, and is
  changed through that provider's own MCP tools. Dreamux Core has no binding
  table and no Collaboration Space container; a Channel names a Team when it
  submits, and Core takes it from there.
- **TeamMate is server-hosted.** `spawn` starts a named, semi-resident TeamMate
  and returns its concrete name; `send` submits follow-up turns and reopens a
  closed TeamMate. `last` reads the provider's recent Activity Records — bounded
  and pageable, including a turn that is still running — without starting a
  runtime; `history` remains an identity/lifecycle recovery view. Native
  session identifiers and transcript paths are never published.
- **No webhook surface in the current contract.** Feishu inbound uses the SDK long-connection
  WebSocket path. Webhook-only verification/encryption fields are not part of
  the config schema.

Explicitly **not** in the current contract: per-chat threads, durable inbound
buffers, automatic assistant-text outbound, HTTP MCP listeners by default,
reaction ledgers, streaming outbound, cross-machine coordination, and a web UI.

## Install / build / test

Use the monorepo (rush) path from the repo root. It is the only supported
install path because this package depends on workspace packages through the
pnpm `workspace:*` protocol:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

The bin launchers shell out to plain `node` against compiled `dist/` output;
no `tsx` is needed at runtime.

## Run the server

```bash
./bin/dreamux serve
```

The launcher works from any cwd and via symlinks.

The server keeps operator-edited config separate from server-owned state and
logs:

| Path | Purpose | Source of truth |
|---|---|---|
| `dreamux config path` (normally `~/.dreamux/config.json`) | User-editable provider config and local channel credentials, created by `dreamux onboard`; edit and restart to apply | the operator |
| `~/.dreamux/run/admin.sock` | Admin Unix socket (+ `admin.sock.lock`); volatile run file | the server |
| `~/.dreamux/run/restart-intent.json` | One-shot daemon restart marker; volatile run file | the server |
| `~/.dreamux/run/sockets/` | Fallback root for ephemeral Codex app-server rendezvous sockets (preferred root: `$XDG_RUNTIME_DIR/dreamux/sockets/`); random per start, never persisted | the server |
| `~/.dreamux/state/<id>/access.json` | Dispatcher-local Feishu access state: schema/runtime ledger are Channel-owned; policy fields and quiesced `allow_users` maintenance are operator-authorized | mixed |
| `~/.dreamux/state/<id>/identity.json` | Dispatcher root identity plus native runtime session/transcript checkpoint | the server |
| `~/.dreamux/state/<id>/teammate/<name>/identity.json` | Dispatcher TeamMate identity plus native runtime session/transcript checkpoint | the server |
| `~/.dreamux/state/<id>/team/<team-id>/` | Team record, TeamLeader identity, Team members, and Team-scoped Workflow state | the server |
| `~/.dreamux/cache/<id>/spill/` | Over-budget teammate completion spill files; rebuildable cache, only the path is inlined into a dispatcher turn | the server |
| `~/.dreamux/cache/<id>/` | Per-dispatcher provider cache root; providers own subdirectories such as Feishu attachment cache | the server |
| `~/.dreamux/cache/claude-code/` | Claude Code MCP config and skill adapters; rebuildable provider cache | the server |
| `~/.dreamux/logs/codex-app-server/<id>.log` | Codex app-server stdout/stderr | the server |
| `~/.dreamux/logs/channel/<id>.log` | Per-dispatcher channel logs | the server |
| `~/.dreamux/logs/teammate-mcp/<id>.log` | TeamMate MCP shim diagnostics | the server |
| `~/.codex/` | Codex global default home: auth, memory, and config | the operator / Codex |

`~/.dreamux/run/` and `~/.dreamux/cache/` are rebuildable while no server is
running. Durable `~/.dreamux/state/` is not a generic cleanup target; preserve
it unless an exact state owner and documented recovery contract say otherwise.
Dreamux does not create, read, validate, or repair per-entity `turn.jsonl`
files. Any such file left in a current entity directory is inert residue: its
presence, contents, permissions, or parseability never block startup or a
lifecycle operation, and no migration or cleanup is required.

## Configure dispatchers

For normal installs, run `dreamux onboard`. It writes `~/.dreamux/config.json`
with mode `0600`, creates state/log directories, and registers a user-level
service when supported. Bundled Dreamux skills are injected at runtime by role,
not written into the workspace.

Dispatcher declarations live in `config.json`:

```json
{
  "agents": [
    {
      "id": "flow",
      "provider": "builtin:codex",
      "config": {
        "bin": "codex",
        "approval_policy": "never",
        "sandbox_mode": "workspace-write",
        "extra_args": [],
        "extra_env": {
          "EXAMPLE_FLAG": "1"
        },
        "initialize_timeout_ms": 10000,
        "turn_timeout_ms": 600000
      }
    }
  ],
  "dispatchers": [
    {
      "id": "flow",
      "cwd": "<WORKSPACE>",
      "enabled": true,
      "channels": [
        {
          "id": "primary",
          "provider": "builtin:feishu",
          "config": {
            "app_id": "<APP_ID>",
            "app_secret": "<APP_SECRET>"
          }
        }
      ],
      "agentRuntime": "flow"
    }
  ]
}
```

`dreamux onboard` is provider-ref driven. Its interactive default selects
`builtin:codex` and `builtin:feishu`, but provider-specific config prompts are
owned by those provider packages. Non-interactive runs pass provider raw config
with `--agent-config-json` and `--channel-config-json`. Operator-owned config is
never silently rewritten: old
`dispatchers[].feishu` / `dispatchers[].codex` shapes fail loudly with rebuild
guidance, following issue #98.

There is no top-level `codex` block and no inline `dispatchers[].runtime` block.
Runtime settings live in named `agents[]` entries and a dispatcher selects one
with `dispatchers[].agentRuntime`. For `builtin:codex`, every config field
defaults, so any field can be omitted:

- `bin` → `"codex"` (resolved on `PATH`)
- `approval_policy` → `"never"`
- `sandbox_mode` → `"workspace-write"`
- `extra_args` → `[]`
- `extra_env` → `{}`
- `initialize_timeout_ms` → `10000`
- `turn_timeout_ms` → `600000` (accepted and defaulted by the current config
  reader, but not passed into `CodexRuntime`; it currently has no runtime effect)

Most operators never touch `bin` or `initialize_timeout_ms`. The optional
`CODEX_HOST_CODEX_BIN` environment variable is a host-level override of the
codex binary across **every** dispatcher (e.g. CI or a non-PATH install); when
unset, the selected `agents[].config.bin` is used.

Claude Code agents use a different runtime-owned config shape:

```json
{
  "agents": [
    {
      "id": "claude",
      "provider": "builtin:claude-code",
      "config": {
        "bin": "claude",
        "model": null,
        "permission_mode": null,
        "remote_control": false,
        "extra_args": [],
        "extra_env": {},
        "turn_timeout_ms": 600000
      }
    }
  ]
}
```

Claude Code runs as a resident stream-json process (`claude --print` with
stream-json input/output) and receives Dreamux MCP servers through a generated
MCP config file. Set `remote_control` to `true` on a named Claude Code agent to
enable Claude Code Remote Control for every dispatcher or TeamMate launched
through that agent runtime; Dreamux logs the returned Remote Control URL through
the runtime diagnostics log when Claude Code provides one. Remote Control is an
external Claude UI control surface, distinct from Dreamux `send` steering. If
`get_capabilities` reports `steer.supported: true` for a Claude Code runtime,
that describes Dreamux multi-send input semantics, not Remote Control. Dreamux
does not own or attribute spontaneous turns initiated from the Remote Control UI
in this release; avoid driving external UI turns and Dreamux turns concurrently.
It does not use Codex app-server, Codex handshake, or Codex home diagnostics.

Provider refs reserved for future external providers look like npm package refs
or package export refs, for example `npm:@example/dreamux-provider` and
`npm:@example/dreamux-provider#channel`. Dreamux does not install packages for
you; if the package is already resolvable, config load imports it and validates
the provider contract before starting dispatchers.

Edit and restart `dreamux serve` to apply dispatcher declaration changes.
Channel ids must be unique within a dispatcher, and each dispatcher may declare
at most one channel per provider ref. Feishu `app_id` uniqueness is not enforced
by core; sharing one bot identity across dispatchers is an operator choice.
Dispatcher ids use a path-safe character set so they map one-to-one to state
directories.

Access-gate allowlists are not part of `config.json`. The complete secure V3
default used to initialize a missing `~/.dreamux/state/<id>/access.json` is:

```json
{
  "version": 3,
  "dm_policy": "pairing",
  "group": {
    "policy": "follow-user",
    "allow_chats": [],
    "require_mention": true
  },
  "allow_users": [],
  "pending": {},
  "observed_chats": [],
  "warnings": [],
  "last_gate": {
    "at": 0
  }
}
```

`access.json` remains version 3. `version` is Channel/schema-owned.
`dm_policy`, `group.policy`, `group.allow_chats`, and
`group.require_mention` are operator policy. `allow_users` is shared authority:
live pairing/Owner approval may append it, and a quiesced operator may maintain
it. `pending`, `observed_chats`, `warnings`, and `last_gate` are Channel-owned
runtime ledger fields. Add real chat or sender ids only through the quiesced
field-specific maintenance workflow below; the secure default grants neither
chat nor sender authority.

For human group messages, `group.require_mention` runs first and `block` drops
all human traffic. Under `allowlist`, an unlisted chat drops and a listed chat
trusts every exactly classified human. Under `follow-user`, a listed chat has
the same trust; an unlisted chat follows the existing `dm_policy` /
`allow_users` / pairing path. Trusted chats bypass `dm_policy`, `allow_users`,
and pairing, including `dm_policy: "disabled"`, but never bypass the global
mention switch. `/introduce` stays sender-scoped and still requires
`allow_users`.

This meaning changes in place when the new server starts; V3 needs no rebuild.
Before deploying, review every non-empty `allow_chats` entry under both
`allowlist` and `follow-user`. Keep only groups whose human membership should
be trusted and whose passive known-bot observation should remain enabled.

The access path is always `~/.dreamux/state/<id>/access.json`;
`DREAMUX_CONFIG_DIR` and `dreamux config path` affect `config.json` only. For a
manual access edit, fully stop the owning Dispatcher, confirm it stopped,
re-read after stop, apply only the requested policy/shared-authority fields via
an owner-only sibling temporary file and atomic replacement at mode `0600`,
validate the complete current V3 shape without printing values, and then start
the Dispatcher. Preserve `version` and all Channel-owned ledger fields exactly.
A missing file after confirmed stop is valid current state: start from the full
secure V3 default shown above, create a missing state directory at `0700`, and
atomically create the first `0600` file. This is initialization, not a rebuild.

`dreamux config show`, `dreamux status`, `dreamux doctor`, and logs redact
secret-like config keys generically. There is no CLI raw mode for printing the
unredacted local file. `dreamux doctor` is not an access-state validator.

## Codex configuration precedence

The codex binary path resolves in this order, highest first:

1. `CODEX_HOST_CODEX_BIN` environment variable (optional host-level override).
2. The selected `agents[].config.bin` (default `"codex"`).

All other Codex values come from the selected `agents[].config` field when
`agents[].provider` is `builtin:codex`, falling back to the built-in Codex
provider defaults. There is no global `codex` layer. A dispatcher's
`extra_args` are its only source of `-c key=value` options; dreamux appends its
own Channel provider MCP and TeamMate MCP `-c` args after them, relying on
Codex's last-write-wins behavior. Per-dispatcher `extra_env` is merged over the
server process environment before spawning that dispatcher app-server; dreamux
still removes `CODEX_HOME` so Codex keeps using its global default home.

The managed-service unit does **not** pin `CODEX_HOST_CODEX_BIN`; it adds
provider-declared binary directories from provider diagnostics to the unit
`PATH`, so selected provider config such as `agents[].config.bin` resolves.
Existing units installed before this change may still carry the env var — there
it keeps acting as the override and nothing breaks.

## MCP surfaces

Each dispatcher injects Dreamux-owned MCP stdio servers into its selected Agent
Runtime provider. Codex receives runtime-specific `mcp_servers.*` arguments;
Claude Code receives a runtime-owned MCP config file.

The Channel provider contributes its provider-specific MCP server. For
`builtin:feishu`, the stdio shim does not read Feishu secrets. It serves the
provider's static `tools/list` metadata and forwards `tools/call` to the serve
process over the admin socket, where the live channel session handles the tool.
This is also the binding surface: `builtin:feishu` exposes `bind_channel`,
`unbind_channel`, and `list_bindings`, plus its own collaboration-space policy
tools, because only that provider knows what a chat, a topic, and a parent
group are.

The model-facing channel tools are supplied by the active Channel provider. Use
the provider's `tools/list` metadata as the current authority; the generic
Dreamux contract is that assistant text is not sent to a channel automatically.
For `builtin:feishu`, provider-owned examples include `reply`, `react`, and
`list_chat_bots`; these are Feishu provider tools, not generic Dreamux channel
tools.

The Dispatcher Service also contributes Dreamux-owned TeamMate, Team, and cron
MCP servers. Dispatcher-facing TeamMate tools are:

- `spawn`: start a resumable TeamMate and submit the first turn.
- `send`: submit a follow-up turn, reopening a closed TeamMate when resumable.
- `close`: close a named TeamMate and retain its history.
- `list`, `status`, `history`, `last`, `get_capabilities`: inspect and recover
  TeamMate state by concrete name.

`last` accepts `limit` (default 20, range 1 through 200), an opaque backward
pagination `cursor`, and `include_tools`. It returns provider-neutral assistant
messages and tool records oldest first, with `next_cursor` and `truncated`. Tool
arguments and tool output are never exposed, and it publishes no native IDs or
filesystem paths.

The same server also carries the Workflow tools `workflow_run`,
`workflow_status`, `workflow_stop`, and `workflow_list`.

Dispatcher-facing Team tools are `create`, `send`, `list`, `status`, `history`,
and `dissolve`. A TeamLeader receives only `dissolve`, scoped to its own Team.
`dissolve` answers with a submission receipt: the Team is stopped and closed
behind it, and dirty or unmerged work in a managed worktree leaves the Team open
instead. Cron tools are `cron_create`, `cron_list`, `cron_update`, and
`cron_delete`.

There is no dispatcher-facing `complete` tool. Completion ingest is a
server/admin seam, so a dispatcher model cannot fake a TeamMate completion.

## Built-In Feishu Verification Example

This example uses the built-in Feishu Channel provider; other providers use
their own config and visible-reply tools.

1. `dreamux onboard --dispatcher-id flow --dispatcher-cwd <WORKSPACE> --agent flow=builtin:codex --agent-config-json flow='{"bin":"codex"}' --channel primary=builtin:feishu --channel-config-json primary='{"app_id":"<APP_ID>","app_secret":"<APP_SECRET>"}'`
2. `dreamux serve` starts dispatcher `flow`.
3. Invite the bot to a Feishu group, send a mention that passes the access gate.
4. Dreamux renders the inbound into a `<channel source="feishu" …>` block from the neutral pieces the Channel supplied, and hands the runtime final text.
5. The runtime calls the Feishu channel MCP `reply` tool; the reply is delivered to Feishu.
6. Send another accepted message from a different chat in the same trust
   domain; it enters the same dispatcher runtime context.
7. Ask the dispatcher to spawn or send TeamMate work through the `teammate` MCP
   tools; completion delivery later arrives through the runtime-specific
   TeamMate completion path.
8. Restart the server and continue chatting; Codex `thread/resume` restores the
   thread when possible, but in-flight inbound messages are not durable. TeamMate
   final results already recorded in the ledger remain pull-able.

## Testing

```bash
node common/scripts/install-run-rush.js test
```

- `tests/smoke.test.ts` — fake-Codex dispatcher behavior: access gate,
  per-message turn/start inbound submission, process-local dedupe, MCP
  reply-only outbound, thread resume, app-server restart behavior, and
  approval fail-fast.
- `tests/bin-launcher.test.ts` — real launcher and repo-root shim behavior from
  arbitrary cwd and through symlinks.
- `tests/doctor.test.ts` — standalone doctor checks for config, Codex home,
  services, provider-owned runtime binaries, and dispatcher workspace skill
  state.
- `tests/agent-runtime-provider.test.ts`, `tests/channel-provider.test.ts`,
  `tests/registry.test.ts`, and `tests/provider-ref.test.ts` — provider ref,
  registry, Channel provider, and Agent Runtime provider coverage.
- `tests/teammate-ledger.test.ts`, `tests/teammate-delivery.test.ts`, and
  `tests/teammate-mcp.test.ts` — server-hosted TeamMate state, delivery, retry,
  and retrieval coverage.
- `tests/codex-live.test.ts` — real Codex app-server compatibility checks,
  plus the issue #63 mid-turn model gate. Set `DREAMUX_SKIP_LIVE_CODEX=1` only
  when no Codex binary is available locally. Public CI loud-skips the model
  gate unless `DREAMUX_RUN_LIVE_MODEL_GATE=1` is set in an environment with
  usable Codex model auth.
- `tests/claude-code-live.test.ts` — opt-in Claude Code live contract. Set
  `DREAMUX_RUN_LIVE_CLAUDE_CODE=1` only in an environment with a usable
  `claude` binary and auth.

## License

MIT.
