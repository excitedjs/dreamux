# Global config in `~/.dreamux/config.json`

- **Status:** Accepted, amended by PR #34
- **Date:** 2026-05-28
- **Affects:** server startup, codex CLI invocation, outbound retry policy, paths.* helpers
- **PR / Issue:** feat/global-config-dir

## Context

Pre-config, every dispatcher had to repeat the same `approval_policy=never`
inside its `codex_args_json`, every operator had to remember
`CODEX_HOST_CODEX_BIN`, and every retry/timeout tuning was a source-level
constant that needed a rebuild. The runtime data dir (`~/.codex-host/`)
also did double duty as "where you'd edit settings if there were any" —
mixing user-editable configuration with server-owned state (SQLite, sockets,
logs) makes `rm -rf ~/.codex-host` recovery dangerous.

We needed a user-editable global config that is:

- separate from runtime state (so blowing away state can't lose settings)
- failure-loud (parse error tells the operator exactly which line to fix)
- backward-compatible (env vars and per-dispatcher fields keep working
  without an upgrade prompt)
- able to store local channel secrets created by onboarding without relying on
  managed-service environment injection

## Decision

Create `~/.dreamux/config.json` at server startup if absent. Subsequent boots
merge missing keys with built-in defaults in memory. `dreamux onboard` writes
the file with mode `0600` and upserts only the current
`feishu.bots.<dispatcher-id>` entry when the JSON file already exists; existing
global settings and other bot secrets are preserved.

Older installs that have only `~/.dreamux/config.toml` fail fast with an
explicit migration message. dreamux does not silently create default JSON over
legacy TOML because doing so can hide the previous `runtime_dir` and dispatcher
database.

Path overrides:

- Default config dir: `~/.dreamux/`
- Override via `DREAMUX_CONFIG_DIR` env (mostly for tests)

Precedence for every config-able value (highest wins):

1. Environment variables — `CODEX_HOST_RUNTIME_DIR`,
   `CODEX_HOST_ADMIN_SOCKET`, `CODEX_HOST_CODEX_BIN`. Escape hatch for
   CI / one-off debug runs.
2. Per-dispatcher fields — `dispatchers.codex_args_json` (`approvalPolicy`,
   `extraArgs`). Already existed; still authoritative for one dispatcher.
3. `~/.dreamux/config.json` — global defaults and Feishu bot secrets the operator edits by hand.
4. Built-in defaults compiled into the binary (`src/runtime/config.ts`
   `BUILT_IN_DEFAULTS`).

Fields sunk into the config (this PR):

| Key | Default | What it replaces |
|---|---|---|
| `runtime_dir` | `~/.codex-host` | Hard-coded default in `paths.runtimeRoot` |
| `admin_socket` | (derived from `runtime_dir`) | Hard-coded default in `paths.adminSocketPath` |
| `codex.bin` | `codex` | Hard-coded default in `supervisor.ts` |
| `codex.approval_policy` | `never` | Per-dispatcher boilerplate in every `codex_args_json` |
| `codex.sandbox_mode` | `workspace-write` | New: codex 0.134's three-way sandbox choice (`read-only` / `workspace-write` / `danger-full-access`). Was previously only settable via raw `codex.extra_args = ["-c", "sandbox_mode=..."]` with no validation; promoted to a first-class key. |
| `codex.extra_args` | `[]` | Per-dispatcher boilerplate; also new — no way to set a machine-wide default before |
| `codex.initialize_timeout_ms` | `10000` | Hard-coded constant in `handshake.ts` |
| `outbound.retries` | `3` | Hard-coded constant in `turn-manager.ts` |
| `outbound.retry_delay_ms` | `1000` | Hard-coded constant in `turn-manager.ts` |
| `feishu.bots.<id>.app_id` | none | Onboarded Feishu app id for dispatcher `<id>` |
| `feishu.bots.<id>.app_secret` | none | Onboarded Feishu app secret for dispatcher `<id>` |

Per-dispatcher `extraArgs` are **appended** to global `codex.extra_args`,
not overwritten — relies on codex's "last write wins" semantics for
repeated `-c key=value`, so a per-dispatcher entry effectively overrides
a same-key global default. See `src/runtime/codex-args.ts`.

Dispatcher rows store `bot_secret_ref=config:<dispatcher-id>` for onboarded
bots; the actual Feishu app secret lives in `feishu.bots.<dispatcher-id>`.
`dreamux config show` redacts `app_secret` by default. Operators must pass
`--raw` explicitly to print the unredacted local file.

## Consequences

**Costs / constraints:**

- On every server boot we now read a file in `~/.dreamux/`. Negligible.
- The file is created with mode `0600`. Operators expecting world-readable
  configs need to chmod after the fact (and document why).
- Two directories now matter: `~/.dreamux/` (user-editable) and
  `~/.codex-host/` (server state). README + the Rush + pnpm decision link the two so
  newcomers see the split.

**Foot-guns:**

- A typo in the JSON file fails server startup
  but does **not** auto-revert to defaults. That's deliberate — silent
  fallback would mask the very mistakes the file is supposed to surface.
  Use `dreamux config show --raw` when redaction cannot parse a broken file.
- A legacy `config.toml` without `config.json` fails startup/onboard instead of
  being ignored. Manual migration is required so the old runtime directory and
  dispatcher database remain visible.
- `codex.sandbox_mode = "danger-full-access"` paired with
  `approval_policy = "never"` is effectively giving every bot user shell
  access at the operator's privilege level — only set it when the trust
  model already covers that (e.g. a tm-cross-worktree flow that needs to
  chdir out of the dispatcher's cwd). `workspace-write` is the safer
  default and what the auto-created file ships with.
- `runtime_dir` and `admin_socket` paths support a leading `~/` for the
  user's home; bare relative paths pass through unchanged. We considered
  rejecting relative paths up front but left them alone so downstream
  errors (file-not-found) keep their original wording.
- Env vars still win. An operator who exported `CODEX_HOST_CODEX_BIN` in
  their shell and forgot will keep getting that codex regardless of what
  the config file says. Logged at startup via the `[server] loaded global
  config from …` line — env values are not echoed (they could be paths
  with sensitive context).

## Alternatives considered

- **Put config in `~/.codex-host/config.toml`**: rejected. The whole
  point of the split is that `~/.codex-host/` is server state and
  `rm -rf`-safe; mixing settings in there re-creates the original problem.
- **TOML or YAML instead of JSON**: JSON is now used for dreamux-owned config.
  Codex may still maintain its own `~/.codex/config.toml`, but dreamux does not
  write TOML config files. JSON keeps Feishu secret storage and redaction logic
  simple and explicit.
- **No fallback to built-in defaults; require all keys present**:
  rejected. Forward-compat for adding new keys would force every operator
  to re-add fields after every upgrade. Built-in defaults make new keys
  show up with a sensible value and a comment in the file header
  pointing to the upgrade note.
- **Rewrite the file on schema bumps to add new keys**: rejected. We'd
  have to merge user edits with the new template. Operators expect their
  file to be the source of truth — extending the file is a follow-up
  decision per upgrade.
