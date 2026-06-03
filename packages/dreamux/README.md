# @excitedjs/dreamux

The Codex-host server package. One long-running Node process hosts N
**Dispatchers**; each Dispatcher binds **1 Feishu bot + 1 Codex thread**.

This file is the **package-level** quick start. For the monorepo layout
and harness pieces, see the top-level
[`README.md`](../../README.md) and
[`.agents/root.md`](../../.agents/root.md).

Design background:
[#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) ·
[#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) ·
[#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4) ·
[#18 Global bin onboarding](https://github.com/excitedjs/dreamux/issues/18).

## What this package ships

- Public CLI bins: `dreamux` and `tm`. `dreamux` owns onboarding, serving,
  status, doctor, dispatcher administration, and config commands. `tm` is a
  wrapper around the package-local `@excitedjs/tm` dependency for dispatcher
  skills.
- A bundled dispatcher Codex skill, copied by `dreamux onboard` into
  `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md`.
- A SQLite-backed runtime (`dispatchers` + `inbound_buffer`) plus the
  Feishu / Codex adapters that drive each dispatcher.

## What this MVP does (P0)

- **One Node process, many Dispatchers.** Each Dispatcher = 1 Feishu Bot
  (independent appId/secret) + 1 long-lived Codex `app-server` child + 1
  Codex thread.
- **Single-thread, multi-chat fan-in.** A bot can be invited into multiple
  groups and DMs; every inbound message goes into the same Codex thread.
  Outbound replies are routed by the inbound's `source_chat_id`.
- **Dispatcher cwd is explicit, Codex state stays global.** The Codex
  daemon's cwd is configured during `dreamux onboard` or
  `dreamux dispatcher add --codex-cwd`. Dispatcher app-server processes
  use Codex's global default home (`~/.codex`) for auth, memory, and config.
  The dispatcher skill is workspace-local under the dispatcher cwd. dreamux
  keeps only app-server sockets/logs/SQLite under its runtime directory.
- **FIFO + at-most-once.** One running turn per dispatcher. After a server
  crash, `running` inbound rows are flipped to `unknown` (the user is told
  to confirm or resend); `awaiting_outbound` rows are safely retried.
- **Trusted-local only.** No chat allowlist, `approval-policy=never`. Any
  other deployment must uplift access control first — see
  [issue #2 §"信任模型"](https://github.com/excitedjs/dreamux/issues/2).

Explicitly **not** in MVP: approval cards, streaming outbound, per-chat
threads, tm registry isolation, cross-machine coordination, web UI.

## Install / build / test

Use the monorepo (rush) path from the repo root — it is the only supported
install path. This package depends on `@excitedjs/feishu-transport` via the
pnpm `workspace:*` protocol, which `npm` cannot resolve, so
`cd packages/dreamux && npm install` no longer works (see
[the install-model decision](../../.agents/decisions/install-model.md)):

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

CI exercises this path, so a broken `rush.json` or lockfile fails CI.

The bin launchers shell out to plain `node` against the compiled `dist/`
output; **no `tsx` is needed at runtime** (PR #6).

## Run the server

```bash
./bin/dreamux serve
```

The launcher works from any cwd and via symlinks (PR #6 + bin-launcher tests).

The server keeps operator-edited config separate from state and logs — by
design (see [the top-level design](../../.agents/decisions/top-level-design.md)):

| Path | Purpose | Source of truth |
|---|---|---|
| `~/.dreamux/config.json`                 | User-editable config and Feishu bot secrets — created by `dreamux onboard`; edit and restart to apply | the operator |
| `~/.dreamux/state/state.db`              | Legacy SQLite state until the MVP state cleanup lands | the server |
| `~/.dreamux/state/admin.sock`            | Admin Unix socket (`0600`)                 | the server |
| dispatcher `codex_cwd`                   | Codex app-server cwd, configured during onboard or dispatcher registration | the operator |
| `~/.codex/`                              | Codex global default home: auth, memory, and config | the operator / Codex |
| `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md` | Dispatcher skill copied by `dreamux onboard`; reported but not deleted by `dreamux uninstall` | dreamux installer |
| `~/.dreamux/state/<id>/access.json`      | Dispatcher-local access gate state: allowed DMs, optional group/chat follow-user allowlists, observed chats, and trust-domain warnings | the server |
| `~/.dreamux/state/<id>/codex.sock`       | Codex app-server Unix socket              | the server |
| `~/.dreamux/logs/codex-app-server/<id>.log` | Codex app-server stdout                 | the server |

`rm -rf ~/.dreamux/state ~/.dreamux/logs` is a state/log recovery path — your
dreamux config and global Codex auth survive. `runtime_dir` and `admin_socket`
keys in older config files no longer move the effective state or socket paths.

## Configure a dispatcher

```bash
./bin/dreamux dispatcher add \
  --id flow \
  --bot-app-id <APP_ID> \
  --bot-secret-ref config:flow \
  --codex-cwd /path/to/dispatcher/workspace

# Inspect / restart
./bin/dreamux dispatcher list
./bin/dreamux dispatcher status --id flow
./bin/dreamux dispatcher start  --id flow   # if not auto-started
```

For normal installs, prefer `dreamux onboard`; it writes
`feishu.bots.<dispatcher-id>.app_secret` into `~/.dreamux/config.json` and
registers the dispatcher with `bot_secret_ref=config:<dispatcher-id>`.
`dreamux config show` redacts these secrets. There is no CLI raw mode for
printing the unredacted local file.

## MVP verification path (issue #2 §"MVP 验收脚本")

1. `dreamux onboard --dispatcher-id flow --dispatcher-cwd <WORKSPACE> --bot-app-id <APP_ID> --bot-app-secret <APP_SECRET>`
2. `dreamux serve` — dispatcher `flow` goes to `ready`
3. Invite the bot to a Feishu group A, send `hi`
4. Server delivers it into the Codex thread; reply goes back to group A
5. Invite the same bot to a DM, ask "do you remember the 'hi' from earlier?"
6. Same thread, so the reply confirms — and goes back to the DM
7. Ask the bot to "run the test suite via tm and summarize"
8. Codex shells out to `tm`, reads stdout/stderr, replies into the source chat
9. Repeat with a **different** worktree to prove dispatcher↔worktree decoupling
10. `pkill node` to crash the server, then restart it
11. Continue chatting — Codex `thread/resume` restores context

## Configuration reference

Precedence for Codex-related config values (highest wins): env var →
per-dispatcher field → `~/.dreamux/config.json` → built-in default.
See [the global-config decision](../../.agents/decisions/global-config-dir.md).

### Global: `~/.dreamux/config.json`

Created by `dreamux onboard` with this shape:

```json
{
  "runtime_dir": "~/.dreamux/runtime",
  "admin_socket": null,
  "codex": {
    "bin": "codex",
    "approval_policy": "never",
    "sandbox_mode": "workspace-write",
    "extra_args": [],
    "initialize_timeout_ms": 10000
  },
  "outbound": {
    "retries": 3,
    "retry_delay_ms": 1000
  },
  "feishu": {
    "bots": {
      "flow": {
        "app_id": "<APP_ID>",
        "app_secret": "<APP_SECRET>"
      }
    }
  }
}
```

Edit and restart `dreamux serve`. JSON parse errors fail fast. If an older
install still has only `~/.dreamux/config.toml`, dreamux refuses to create
default JSON over it; manually create `config.json` preserving the old
`runtime_dir` and other settings, add the needed `feishu.bots` entries, then
move the legacy TOML file aside.

The `runtime_dir` and `admin_socket` keys are legacy compatibility fields.
Current runtime paths are fixed under `~/.dreamux/state` and
`~/.dreamux/logs`.

### `codex_args_json` (per-dispatcher, overrides global)

JSON object stored in `dispatchers.codex_args_json`:

```json
{ "approvalPolicy": "never", "sandboxMode": "workspace-write", "extraArgs": ["--model", "gpt-5"] }
```

| Field            | Default   | Notes                                                |
| ---------------- | --------- | ---------------------------------------------------- |
| `approvalPolicy` | inherits `codex.approval_policy` from `~/.dreamux/config.json`, else `"never"` | Must be one of `never`/`auto`/`auto-approve`/`on-failure`. Otherwise startup fails fast (issue #2 §"实现陷阱"). |
| `sandboxMode`    | inherits `[codex] sandbox_mode`, else `"workspace-write"` | Must be one of `read-only`/`workspace-write`/`danger-full-access` (codex 0.134 enum). Validated at dispatcher startup. |
| `extraArgs`      | appended *after* global `codex.extra_args` | codex's "last write wins" semantics for `-c key=value` mean a per-dispatcher entry effectively overrides a same-key global. |

### Env vars (highest precedence — escape hatch)

| Var                          | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `CODEX_HOST_RUNTIME_DIR`     | Legacy; no longer changes effective runtime paths  |
| `CODEX_HOST_ADMIN_SOCKET`    | Legacy; no longer changes the admin socket path    |
| `CODEX_HOST_CODEX_BIN`       | Override `codex.bin`                               |
| `DREAMUX_CONFIG_DIR`         | Override `~/.dreamux` (where `config.json` lives)  |
| `BOT_SECRET_<NAME>`          | Legacy/manual bot secrets referenced by `env:BOT_SECRET_<NAME>` |
| `DREAMUX_SKIP_LIVE_CODEX`    | Opt out of the live Codex app-server integration test (loud skip) |

## What this MVP does **not** do

(see [issue #2 §"明确不在 MVP 范围"](https://github.com/excitedjs/dreamux/issues/2))

- Multiple threads per dispatcher
- Per-chat memory
- Approval / Feishu approval cards
- Streaming assistant deltas
- tm CLI changes (`tm --json`, registry namespace)
- Cross-machine coordination
- Web UI / Prometheus
- Migration from old claudemux dispatcher state
- access gate / chat allowlist / pairing (D12 + Trust Model)

## Testing

```bash
# from the repo root (the only supported path — see the install-model decision)
node common/scripts/install-run-rush.js test   # smoke + bin-launcher + codex-live
```

- `tests/smoke.test.ts` — fake-codex-driven dispatcher behavior:
  happy path, FIFO, crash recovery (running → unknown), thread/resume
  failure, outbound retry without turn re-run, approval fail-fast.
- `tests/bin-launcher.test.ts` — spawns the real `dreamux` bash launcher
  and repo-root shim from arbitrary cwds and through symlinks; static
  "no tsx" assertion; manifest assertion for the supported global bins.
- `tests/doctor.test.ts` — covers standalone doctor checks for
  global Codex home state, including managed-service auth
  visibility.
- `tests/codex-live.test.ts` — spawns a real `codex app-server`. CI installs
  `@openai/codex@latest` before running tests so this compatibility check is
  not skipped by default and tracks the current Codex CLI. Local developers can
  still opt out explicitly with `DREAMUX_SKIP_LIVE_CODEX=1` when no Codex
  binary is available.

## License

MIT.
