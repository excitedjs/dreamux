# @excitedjs/dreamux

The dreamux host server package. One long-running Node process hosts N
**Dispatchers**; each Dispatcher binds a Channel provider, an Agent Runtime
provider, and Dreamux-owned MCP surfaces for channel replies and TeamMate work.

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

- Public CLI bins: `dreamux` and `tm`. `dreamux` owns onboarding, serving,
  status, doctor, dispatcher commands, and config commands. `tm` is a wrapper
  around the package-local `@excitedjs/tm` dependency for dispatcher skills.
- A bundled dispatcher Codex skill, copied by `dreamux onboard` into
  `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md`.
- Providerized dispatcher declarations, a process-local Capability Registry,
  server-owned state/log paths, the `builtin:feishu` Channel provider, the
  `builtin:codex` and `builtin:claude-code` Agent Runtime providers, and
  dispatcher-scoped MCP shims for channel replies and TeamMate scheduling.
- A server-hosted TeamMate ledger with asynchronous scheduling, completion
  delivery, bounded retry, and read-only result retrieval.

## Phase 1 contract

- **One Node process, many Dispatchers.** Each Dispatcher has one configured
  channel in Phase 1. The config shape is already `channels[]`, but runtime
  routing still accepts exactly one channel per dispatcher.
- **Provider refs are explicit.** Wired builtin refs are `builtin:feishu`,
  `builtin:codex`, and `builtin:claude-code`. Npm package refs and package
  export refs are reserved syntax only in Phase 1; dreamux parses and rejects
  them clearly instead of loading or executing external code.
- **One dispatcher is one trust domain.** A bot may receive multiple chats, but
  all accepted messages share one dispatcher runtime context. Do not bind
  unrelated private chats to the same dispatcher.
- **Dispatcher cwd is explicit.** Codex-backed dispatchers use Codex's global
  default home (`~/.codex`) for auth, memory, and config. Claude Code-backed
  dispatchers use Claude Code's own CLI/auth behavior. The dispatcher skill is
  workspace-local under the dispatcher cwd.
- **Inbound state is in memory.** The server keeps only process-local turn
  queues, message dedupe, coalescing state, and received-reaction ownership.
  Restarting the server drops unprocessed inbound messages and may leave
  received reactions behind.
- **Outbound is MCP reply-only.** Assistant text emitted by Codex is never
  forwarded to Feishu automatically. The model must call the dispatcher-scoped
  channel MCP tools such as `reply` or `react`, and those tools exist only when
  the Channel provider exposes the capability.
- **TeamMate is server-hosted.** Scheduling accepts a task and returns a task id
  immediately. Completion is delivered later through the selected Agent Runtime
  provider; if push delivery fails repeatedly, the final result remains
  pull-able from the dispatcher-scoped TeamMate MCP tools.
- **No webhook surface in Phase 1.** Feishu inbound uses the SDK long-connection
  WebSocket path. Webhook-only verification/encryption fields are not part of
  the config schema.

Explicitly **not** in Phase 1: per-chat threads, durable inbound buffers,
automatic assistant-text outbound, HTTP MCP listeners by default, reaction
ledgers, streaming outbound, external npm provider loading, multi-channel
routing, cross-machine coordination, and a web UI.

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
| `~/.dreamux/config.json` | User-editable config and Feishu bot secrets, created by `dreamux onboard`; edit and restart to apply | the operator |
| `~/.dreamux/run/admin.sock` | Admin Unix socket (+ `admin.sock.lock`); volatile run file | the server |
| `~/.dreamux/run/restart-intent.json` | One-shot daemon restart marker; volatile run file | the server |
| `~/.dreamux/run/sockets/` | Fallback root for ephemeral Codex app-server rendezvous sockets (preferred root: `$XDG_RUNTIME_DIR/dreamux/sockets/`); random per start, never persisted | the server |
| `~/.dreamux/state/<id>/status.json` | Dispatcher runtime status and runtime thread/session id | the server |
| `~/.dreamux/state/<id>/access.json` | Dispatcher-local access-gate state | the server |
| `~/.dreamux/state/<id>/claude-code-mcp.json` | Claude Code MCP config generated from Dreamux-owned descriptors | the server |
| `~/.dreamux/state/<id>/teammate/` | TeamMate task ledger, results, and delivery retry state | the server |
| `~/.dreamux/cache/<id>/spill/` | Over-budget teammate completion spill files; rebuildable cache, only the path is inlined into a dispatcher turn | the server |
| `~/.dreamux/cache/<id>/feishu-attachments/` | Feishu inbound attachment cache; re-fetchable, safe to delete | the server |
| `~/.dreamux/logs/codex-app-server/<id>.log` | Codex app-server stdout/stderr | the server |
| `~/.dreamux/logs/feishu-channel/<id>.log` | Feishu channel logs | the server |
| `~/.dreamux/logs/teammate-mcp/<id>.log` | TeamMate MCP shim diagnostics | the server |
| `~/.codex/` | Codex global default home: auth, memory, and config | the operator / Codex |
| `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md` | Dispatcher skill copied by `dreamux onboard`; reported but not deleted by `dreamux uninstall` | dreamux installer |

`rm -rf ~/.dreamux/run ~/.dreamux/cache ~/.dreamux/state ~/.dreamux/logs` is a
run/cache/state/log recovery path (only while no server is running); dreamux
config and global Codex auth survive.

## Configure dispatchers

For normal installs, run `dreamux onboard`. It writes `~/.dreamux/config.json`
with mode `0600`, creates state/log directories, installs the workspace skill,
and registers a user-level service when supported.

Dispatcher declarations live in `config.json`:

```json
{
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
      "runtime": {
        "provider": "builtin:codex",
        "config": {
          "bin": "codex",
          "approval_policy": "never",
          "sandbox_mode": "workspace-write",
          "extra_args": [],
          "extra_env": {
            "EXAMPLE_FLAG": "1"
          },
          "initialize_timeout_ms": 10000
        }
      }
    }
  ]
}
```

`dreamux onboard` currently writes the default `builtin:feishu` +
`builtin:codex` shape. Operator-owned config is never silently rewritten: old
`dispatchers[].feishu` / `dispatchers[].codex` shapes fail loudly with rebuild
guidance, following issue #98.

There is no top-level `codex` block. Codex settings are per-dispatcher under
`dispatchers[].runtime.config` when `runtime.provider` is `builtin:codex`.
Every field defaults, so any field in it can be omitted:

- `bin` → `"codex"` (resolved on `PATH`)
- `approval_policy` → `"never"`
- `sandbox_mode` → `"workspace-write"`
- `extra_args` → `[]`
- `extra_env` → `{}`
- `initialize_timeout_ms` → `10000`

Most operators never touch `bin` or `initialize_timeout_ms`. The optional
`CODEX_HOST_CODEX_BIN` environment variable is a host-level override of the
codex binary across **every** dispatcher (e.g. CI or a non-PATH install); when
unset, each dispatcher's `runtime.config.bin` is used.

Claude Code dispatchers use a different runtime-owned config shape:

```json
{
  "runtime": {
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
`npm:@example/dreamux-provider#channel`. They are not runnable in Phase 1:
dreamux does not install, import, or execute them.

Edit and restart `dreamux serve` to apply dispatcher declaration changes.
`app_id` values must be unique across all declared dispatchers, including
disabled ones. Dispatcher ids use a path-safe character set so they map
one-to-one to state directories.

Access-gate allowlists are not part of `config.json`. Configure them in
`~/.dreamux/state/<id>/access.json`:

```json
{
  "version": 2,
  "allow_users": ["<USER_ID>"],
  "group": {
    "policy": "follow-user",
    "allow_chats": ["<CHAT_ID>"],
    "require_mention": true
  },
  "observed_chats": [],
  "warnings": [],
  "last_gate": null
}
```

`access.json` is v2-only. `allow_users` is the single global allowlist of
sender open_ids, shared by direct messages and the group `follow-user` policy.
`group.policy` is one of `block`, `allowlist`, or `follow-user`; under
`allowlist` the gate consults `allow_chats`, under `follow-user` it ignores
`allow_chats` and gates on `allow_users`. dreamux 0.x does not migrate older
shapes: an unsupported or missing `version` fails loud at startup. To reset,
delete the file (secure default: no one authorized) and recreate it in this v2
shape.

The server reads `access.json` directly at runtime and preserves runtime
observations and warnings in the same file.

`dreamux config show`, `dreamux status`, `dreamux doctor`, and logs redact
`app_secret`. There is no CLI raw mode for printing the unredacted local file.

## Codex configuration precedence

The codex binary path resolves in this order, highest first:

1. `CODEX_HOST_CODEX_BIN` environment variable (optional host-level override).
2. The dispatcher's `dispatchers[].runtime.config.bin` (default `"codex"`).

All other Codex values come from that dispatcher's `runtime.config` field when
`runtime.provider` is `builtin:codex`, falling back to the built-in defaults in
`src/runtime/config.ts`. There is no global `codex` layer. A dispatcher's
`extra_args` are its only source of `-c key=value` options; dreamux appends its
own Channel provider MCP and TeamMate MCP `-c` args after them, relying on
Codex's last-write-wins behavior. Per-dispatcher `extra_env` is merged over the
server process environment before spawning that dispatcher app-server; dreamux
still removes `CODEX_HOME` so Codex keeps using its global default home.

The managed-service unit does **not** pin `CODEX_HOST_CODEX_BIN`; it adds the
onboarded codex binary's directory to the unit `PATH` so each dispatcher's
`runtime.config.bin` resolves. Existing units installed before this change may
still carry the env var — there it keeps acting as the override and nothing
breaks.

## MCP surfaces

Each dispatcher injects Dreamux-owned MCP stdio servers into its selected Agent
Runtime provider. Codex receives runtime-specific `mcp_servers.*` arguments;
Claude Code receives a runtime-owned MCP config file.

The Channel provider contributes its channel MCP server. For `builtin:feishu`,
the stdio shim does not read Feishu secrets. It forwards outbound tool calls to
the serve process over the admin socket, and the serve process owns the Feishu
client plus process-local received-reaction cleanup state.

The model-facing tools include:

- `reply`: send a Feishu reply to a target message or chat.
- `react`: add a model-owned reaction to a Feishu message.

If the model only emits assistant text, nothing is sent to Feishu.

The Dispatcher Service also contributes a TeamMate MCP server. Its
dispatcher-facing tools are:

- `schedule`: accept a TeamMate task and return immediately with a task id.
- `list_tasks`: list recent tasks without result bodies.
- `get_task`: fetch one task including status, result, delivery state, and
  history.
- `pull_result`: fetch a retained final result, including after push delivery
  failed.

There is no dispatcher-facing `complete` tool. Completion ingest is a
server/admin seam for future worker/operator paths, so a dispatcher model cannot
fake a TeamMate completion. TeamMate callers marked as `teammate` cannot
schedule more TeamMates.

## Phase 1 verification path

1. `dreamux onboard --dispatcher-id flow --dispatcher-cwd <WORKSPACE> --bot-app-id <APP_ID> --bot-app-secret <APP_SECRET>`
2. `dreamux serve` starts dispatcher `flow`.
3. Invite the bot to a Feishu group, send a mention that passes the access gate.
4. The selected runtime assembles the inbound into a `<channel source="feishu" …>` block (the channel layer hands it neutral structured pieces; #164).
5. The runtime calls the Feishu MCP `reply` tool; the reply is delivered to Feishu.
6. Send another accepted message from a different chat in the same trust
   domain; it enters the same dispatcher runtime context.
7. Ask the dispatcher to schedule TeamMate work through the `teammate` MCP
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
  per-message turn/start inbound submission, process-local dedupe, reaction
  tri-state, MCP reply-only outbound, thread resume, app-server restart
  behavior, and approval fail-fast.
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
