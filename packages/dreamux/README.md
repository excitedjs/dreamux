# @excitedjs/dreamux

The Codex-host server package. One long-running Node process hosts N
**Dispatchers**; each Dispatcher binds **1 Feishu bot + 1 Codex thread**.

This file is the **package-level** quick start. For the monorepo layout and
knowledge base, see the top-level [`README.md`](../../README.md) and
[`.agents/root.md`](../../.agents/root.md).

Design background:
[#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) ·
[#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) ·
[#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4) ·
[#18 Global bin onboarding](https://github.com/excitedjs/dreamux/issues/18) ·
[#36 MVP tracking](https://github.com/excitedjs/dreamux/issues/36).

## What this package ships

- Public CLI bins: `dreamux` and `tm`. `dreamux` owns onboarding, serving,
  status, doctor, dispatcher commands, and config commands. `tm` is a wrapper
  around the package-local `@excitedjs/tm` dependency for dispatcher skills.
- A bundled dispatcher Codex skill, copied by `dreamux onboard` into
  `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md`.
- Config-backed dispatcher declarations, server-owned state/log paths, a
  Feishu long-connection inbound channel, Codex app-server lifecycle
  management, and a dispatcher-scoped Feishu MCP shim for model replies.

## MVP contract

- **One Node process, many Dispatchers.** Each Dispatcher = 1 Feishu Bot
  (`app_id`/`app_secret`) + 1 long-lived Codex `app-server` child + 1 Codex
  thread.
- **One dispatcher is one trust domain.** A bot may receive multiple chats, but
  all accepted messages share one Codex thread. Do not bind unrelated private
  chats to the same dispatcher.
- **Dispatcher cwd is explicit, Codex state stays global.** Dispatcher
  app-server processes use Codex's global default home (`~/.codex`) for auth,
  memory, and config. The dispatcher skill is workspace-local under the
  dispatcher cwd.
- **Inbound state is in memory.** The server keeps only process-local turn
  queues, message dedupe, coalescing state, and received-reaction ownership.
  Restarting the server drops unprocessed inbound messages and may leave
  received reactions behind.
- **Outbound is MCP reply-only.** Assistant text emitted by Codex is never
  forwarded to Feishu automatically. The model must call the dispatcher-scoped
  Feishu MCP tools such as `reply` or `react`.
- **No webhook surface in MVP.** Feishu inbound uses the SDK long-connection
  WebSocket path. Webhook-only verification/encryption fields are not part of
  the config schema.

Explicitly **not** in MVP: per-chat threads, durable inbound buffers,
automatic assistant-text outbound, HTTP MCP listeners by default, reaction
ledgers, streaming outbound, tm registry isolation, cross-machine
coordination, and a web UI.

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
| `~/.dreamux/state/server.json` | Server status snapshot | the server |
| `~/.dreamux/state/admin.sock` | Admin Unix socket | the server |
| `~/.dreamux/state/<id>/status.json` | Dispatcher runtime status and Codex thread id | the server |
| `~/.dreamux/state/<id>/access.json` | Dispatcher-local access-gate state | the server |
| `~/.dreamux/state/<id>/codex.sock` | Codex app-server Unix socket | the server |
| `~/.dreamux/logs/codex-app-server/<id>.log` | Codex app-server stdout/stderr | the server |
| `~/.dreamux/logs/feishu-channel/<id>.log` | Feishu channel logs | the server |
| `~/.codex/` | Codex global default home: auth, memory, and config | the operator / Codex |
| `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md` | Dispatcher skill copied by `dreamux onboard`; reported but not deleted by `dreamux uninstall` | dreamux installer |

`rm -rf ~/.dreamux/state ~/.dreamux/logs` is a state/log recovery path; dreamux
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
      "feishu": {
        "app_id": "<APP_ID>",
        "app_secret": "<APP_SECRET>"
      },
      "codex": {
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
  ]
}
```

There is no top-level `codex` block: Codex settings are per-dispatcher under
`dispatchers[].codex`. Every field defaults, so the whole `codex` object — and
any field in it — can be omitted:

- `bin` → `"codex"` (resolved on `PATH`)
- `approval_policy` → `"never"`
- `sandbox_mode` → `"workspace-write"`
- `extra_args` → `[]`
- `extra_env` → `{}`
- `initialize_timeout_ms` → `10000`

Most operators never touch `bin` or `initialize_timeout_ms`. The optional
`CODEX_HOST_CODEX_BIN` environment variable is a host-level override of the
codex binary across **every** dispatcher (e.g. CI or a non-PATH install); when
unset, each dispatcher's `codex.bin` is used.

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
2. The dispatcher's `dispatchers[].codex.bin` (default `"codex"`).

All other Codex values come from that dispatcher's `dispatchers[].codex` field,
falling back to the built-in defaults in `src/runtime/config.ts`. There is no
global `codex` layer. A dispatcher's `extra_args` are its only source of
`-c key=value` options; dreamux appends its own Feishu MCP `-c` args after them,
relying on Codex's last-write-wins behavior. Per-dispatcher `extra_env` is
merged over the server process environment before spawning that dispatcher
app-server; dreamux still removes `CODEX_HOME` so Codex keeps using its global
default home.

The managed-service unit does **not** pin `CODEX_HOST_CODEX_BIN`; it adds the
onboarded codex binary's directory to the unit `PATH` so each dispatcher's
`codex.bin` resolves. Existing units installed before this change may still
carry the env var — there it keeps acting as the override and nothing breaks.

## MCP reply flow

Each dispatcher injects a Feishu MCP stdio server into its Codex app-server.
The stdio shim does not read Feishu secrets. It forwards outbound tool calls to
the serve process over the admin socket, and the serve process owns the Feishu
client plus process-local received-reaction cleanup state.

The model-facing tools include:

- `reply`: send a Feishu reply to a target message or chat.
- `react`: add a model-owned reaction to a Feishu message.

If the model only emits assistant text, nothing is sent to Feishu.

## MVP verification path

1. `dreamux onboard --dispatcher-id flow --dispatcher-cwd <WORKSPACE> --bot-app-id <APP_ID> --bot-app-secret <APP_SECRET>`
2. `dreamux serve` starts dispatcher `flow`.
3. Invite the bot to a Feishu group, send a mention that passes the access gate.
4. Server injects a `<feishu_message>` block into the Codex thread.
5. Codex calls the Feishu MCP `reply` tool; the reply is delivered to Feishu.
6. Send another accepted message from a different chat in the same trust
   domain; it enters the same Codex thread.
7. Ask the bot to run teammate work through the bundled `tm` wrapper.
8. Restart the server and continue chatting; Codex `thread/resume` restores the
   thread when possible, but in-flight inbound messages are not durable.

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
  services, and dispatcher workspace skill state.
- `tests/codex-live.test.ts` — real Codex app-server compatibility checks,
  plus the issue #63 mid-turn model gate. Set `DREAMUX_SKIP_LIVE_CODEX=1` only
  when no Codex binary is available locally. Public CI loud-skips the model
  gate unless `DREAMUX_RUN_LIVE_MODEL_GATE=1` is set in an environment with
  usable Codex model auth.

## License

MIT.
