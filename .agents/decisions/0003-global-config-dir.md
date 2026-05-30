# 0003 — Global config in `~/.dreamux/config.toml`

- **Status:** Accepted
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
- format-stable (preserves user comments / formatting on reload)
- failure-loud (parse error tells the operator exactly which line to fix)
- backward-compatible (env vars and per-dispatcher fields keep working
  without an upgrade prompt)

## Decision

Create `~/.dreamux/config.toml` at server startup if absent, populated with
a heavily-commented default. Subsequent boots read the file verbatim — we
never rewrite it. Format is TOML to match codex's own
`~/.codex/config.toml`. Parser is `smol-toml` (small, maintained, zero deps,
ESM, surfaces line/column on errors).

Path overrides:

- Default config dir: `~/.dreamux/`
- Override via `DREAMUX_CONFIG_DIR` env (mostly for tests)

Precedence for every config-able value (highest wins):

1. Environment variables — `CODEX_HOST_RUNTIME_DIR`,
   `CODEX_HOST_ADMIN_SOCKET`, `CODEX_HOST_CODEX_BIN`. Escape hatch for
   CI / one-off debug runs.
2. Per-dispatcher fields — `dispatchers.codex_args_json` (`approvalPolicy`,
   `extraArgs`). Already existed; still authoritative for one dispatcher.
3. `~/.dreamux/config.toml` — global defaults the operator edits by hand.
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

Per-dispatcher `extraArgs` are **appended** to global `codex.extra_args`,
not overwritten — relies on codex's "last write wins" semantics for
repeated `-c key=value`, so a per-dispatcher entry effectively overrides
a same-key global default. See `src/runtime/codex-args.ts`.

Secrets (per-dispatcher `bot_secret_ref`) deliberately stay in env vars
(issue #2 Q9). Sensitive material does not flow through this config file.

## Consequences

**Costs / constraints:**

- One new runtime dependency: `smol-toml`. Small (~10 KB), ESM, zero
  transitive deps. Worth the cost vs. hand-rolling a TOML subset parser.
- On every server boot we now read a file in `~/.dreamux/`. Negligible.
- The file is created with mode `0600`. Operators expecting world-readable
  configs need to chmod after the fact (and document why).
- Two directories now matter: `~/.dreamux/` (user-editable) and
  `~/.codex-host/` (server state). README + decision-0001 link the two so
  newcomers see the split.

**Foot-guns:**

- A typo in the TOML file fails server startup with a `file:line` pointer
  but does **not** auto-revert to defaults. That's deliberate — silent
  fallback would mask the very mistakes the file is supposed to surface.
  Documented in the file's own header comment.
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
- **JSON or YAML instead of TOML**: rejected. TOML matches codex's own
  `~/.codex/config.toml`, comments are first-class (operators will edit
  this by hand), and smol-toml has a small, dependency-free footprint.
- **No fallback to built-in defaults; require all keys present**:
  rejected. Forward-compat for adding new keys would force every operator
  to re-add fields after every upgrade. Built-in defaults make new keys
  show up with a sensible value and a comment in the file header
  pointing to the upgrade note.
- **Rewrite the file on schema bumps to add new keys**: rejected. We'd
  have to merge user edits with the new template. Operators expect their
  file to be the source of truth — extending the file is a follow-up
  decision per upgrade.
