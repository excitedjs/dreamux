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

- One public CLI bin: `dreamux`. Implemented commands in this slice include
  `dreamux onboard`, `dreamux serve`, `dreamux status`, `dreamux doctor`,
  `dreamux dispatcher ...`, and `dreamux config path|show`.
- A SQLite-backed runtime (`dispatchers` + `inbound_buffer`) plus the
  Feishu / Codex adapters that drive each dispatcher.

## What this MVP does (P0)

- **One Node process, many Dispatchers.** Each Dispatcher = 1 Feishu Bot
  (independent appId/secret) + 1 long-lived Codex `app-server` child + 1
  Codex thread.
- **Single-thread, multi-chat fan-in.** A bot can be invited into multiple
  groups and DMs; every inbound message goes into the same Codex thread.
  Outbound replies are routed by the inbound's `source_chat_id`.
- **No dispatcher↔worktree binding.** Codex picks the worktree at `tm`-call
  time. The Codex daemon's cwd is `~/.codex-host/dispatchers/<id>/cwd/`
  (intentionally empty), while its private `CODEX_HOME` is
  `~/.codex-host/dispatchers/<id>/codex-home/`.
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

The server uses two separate home directories — by design (see
[the global-config decision](../../.agents/decisions/global-config-dir.md)):

| Path | Purpose | Source of truth |
|---|---|---|
| `~/.dreamux/config.toml`                 | User-editable global config — auto-created on first boot with sensible defaults; edit and restart to apply | the operator |
| `~/.codex-host/state.db`                 | SQLite (dispatchers + inbound buffer)      | the server |
| `~/.codex-host/admin.sock`               | Admin Unix socket (`0600`)                 | the server |
| `~/.codex-host/dispatchers/<id>/cwd/`    | Codex app-server cwd                       | the server |
| `~/.codex-host/dispatchers/<id>/codex-home/` | Dispatcher-private `CODEX_HOME` for Codex config, plugin cache, and app-server control state | the server |
| `~/.codex-host/dispatchers/<id>/codex-home/app-server-control/as.sock` | Codex app-server Unix socket | the server |
| `~/.codex-host/dispatchers/<id>/*.log`   | Codex stdout / stderr                      | the server |

`rm -rf ~/.codex-host` is a safe recovery — your config in `~/.dreamux/`
survives. `runtime_dir` and `admin_socket` paths in the config can move
the `~/.codex-host` half anywhere you like.

## Configure a dispatcher

```bash
# Bot secret comes from an env var the server process can see.
export BOT_SECRET_FLOW='<bot-secret>'

./bin/dreamux dispatcher add \
  --id flow \
  --bot-app-id <APP_ID> \
  --bot-secret-ref env:BOT_SECRET_FLOW

# Inspect / restart
./bin/dreamux dispatcher list
./bin/dreamux dispatcher status --id flow
./bin/dreamux dispatcher start  --id flow   # if not auto-started
```

## MVP verification path (issue #2 §"MVP 验收脚本")

1. `dreamux dispatcher add --id flow --bot-app-id <APP_ID> --bot-secret-ref env:BOT_SECRET_FLOW`
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

Precedence for every config-able value (highest wins): env var →
per-dispatcher field → `~/.dreamux/config.toml` → built-in default.
See [the global-config decision](../../.agents/decisions/global-config-dir.md).

### Global: `~/.dreamux/config.toml`

Auto-created on first boot with this default (excerpt — open the file
itself for the inline comments explaining each key):

```toml
runtime_dir = "~/.codex-host"
# admin_socket = "~/.codex-host/admin.sock"   # default: <runtime_dir>/admin.sock

[codex]
bin = "codex"
approval_policy = "never"        # never | auto | auto-approve | on-failure
sandbox_mode = "workspace-write" # read-only | workspace-write | danger-full-access
extra_args = []
initialize_timeout_ms = 10000

[outbound]
retries = 3
retry_delay_ms = 1000
```

Edit and restart `dreamux serve`. Parse errors fail-fast with a
`file:line` pointer.

### `codex_args_json` (per-dispatcher, overrides global)

JSON object stored in `dispatchers.codex_args_json`:

```json
{ "approvalPolicy": "never", "sandboxMode": "workspace-write", "extraArgs": ["--model", "gpt-5"] }
```

| Field            | Default   | Notes                                                |
| ---------------- | --------- | ---------------------------------------------------- |
| `approvalPolicy` | inherits `[codex] approval_policy` from `~/.dreamux/config.toml`, else `"never"` | Must be one of `never`/`auto`/`auto-approve`/`on-failure`. Otherwise startup fails fast (issue #2 §"实现陷阱"). |
| `sandboxMode`    | inherits `[codex] sandbox_mode`, else `"workspace-write"` | Must be one of `read-only`/`workspace-write`/`danger-full-access` (codex 0.134 enum). Validated at dispatcher startup. |
| `extraArgs`      | appended *after* global `codex.extra_args` | codex's "last write wins" semantics for `-c key=value` mean a per-dispatcher entry effectively overrides a same-key global. |

### Env vars (highest precedence — escape hatch)

| Var                          | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `CODEX_HOST_RUNTIME_DIR`     | Override `runtime_dir`                             |
| `CODEX_HOST_ADMIN_SOCKET`    | Override admin Unix socket path                    |
| `CODEX_HOST_CODEX_BIN`       | Override `codex.bin`                               |
| `DREAMUX_CONFIG_DIR`         | Override `~/.dreamux` (where `config.toml` lives)  |
| `BOT_SECRET_<NAME>`          | Bot secrets referenced by `env:BOT_SECRET_<NAME>`  |
| `DREAMUX_SKIP_LIVE_CODEX`    | Opt out of the live codex 0.135 integration test (loud skip) |

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
node common/scripts/install-run-rush.js test   # smoke + bin-launcher + codex-0135-live
```

- `tests/smoke.test.ts` — fake-codex-driven dispatcher behavior:
  happy path, FIFO, crash recovery (running → unknown), thread/resume
  failure, outbound retry without turn re-run, approval fail-fast.
- `tests/bin-launcher.test.ts` — spawns the real `dreamux` bash launcher
  and repo-root shim from arbitrary cwds and through symlinks; static
  "no tsx" assertion; manifest assertion for the single global bin.
- `tests/doctor.test.ts` — covers standalone doctor checks for
  dispatcher-private `CODEX_HOME` state, including managed-service auth
  visibility.
- `tests/codex-0135-live.test.ts` — spawns a real `codex app-server`
  (skipped loudly when `codex` is missing or wrong version; opt-in via
  `DREAMUX_SKIP_LIVE_CODEX=1`).

## License

MIT.
