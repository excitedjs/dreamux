# Global config in `~/.dreamux/config.json`

- **Status:** Superseded by [top-level-design](top-level-design.md); historical context only
- **Date:** 2026-05-28
- **Affects:** server startup, Codex CLI invocation, config ownership
- **PR / Issue:** feat/global-config-dir

## Context

This record originally introduced a user-editable dreamux config file so
operators did not have to repeat Codex defaults and local Feishu credentials in
source code or service environment variables.

Current implementation guidance lives in [top-level-design](top-level-design.md).
The current MVP keeps the same high-level ownership split but replaces the
older runtime/config shape:

- `~/.dreamux/config.json` is the only operator-editable dreamux config source.
- Dispatcher declarations live in the top-level `dispatchers` array.
- Server-owned state lives under `~/.dreamux/state/`.
- Server-owned logs live under `~/.dreamux/logs/`.
- Dispatcher app-server processes use Codex's global default home
  (`~/.codex`) for auth, memory, and config.

## Current Rules

`dreamux serve` fails loudly when `config.json` is missing or invalid. It does
not silently create defaults at server startup. `dreamux onboard` creates or
updates the file with mode `0600`.

The current config shape contains:

- Global Codex defaults under `codex`.
- Dispatcher declarations under `dispatchers`.
- Per-dispatcher Feishu `app_id` and `app_secret`.
- Per-dispatcher Codex overrides under `dispatchers[].codex`.

Per-dispatcher access gate allowlists do not live in `config.json`; the current
runtime reads them directly from `~/.dreamux/state/<dispatcher>/access.json`.

Webhook-only verification/encryption fields are not part of the MVP config
schema. SQLite-backed state, durable inbound buffers, and automatic
assistant-text outbound are also not part of the current runtime contract.

`dreamux config show`, `status`, `doctor`, and logs must redact Feishu secrets.
There is no CLI raw mode for printing the unredacted local config.

## Precedence

Codex-related values are resolved in this order, highest first:

1. Environment variables, such as `CODEX_HOST_CODEX_BIN`.
2. Per-dispatcher `dispatchers[].codex` fields, including `extra_env`.
3. Global `codex` fields in `~/.dreamux/config.json`.
4. Built-in defaults compiled into `src/runtime/config.ts`.

Per-dispatcher `extra_args` are appended after global `codex.extra_args`, which
matches Codex's last-write-wins behavior for repeated `-c key=value` options.
Per-dispatcher `extra_env` is merged over the server process environment before
spawning that dispatcher's Codex app-server.

## Consequences

The useful part of this older decision remains: config is operator-owned and
separate from disposable server state. The current top-level design owns the
exact schema and runtime path contract.

Operators can recover from bad server state by removing `~/.dreamux/state/` and
`~/.dreamux/logs/` without losing Feishu credentials or Codex auth.

## Alternatives Considered

- **Put config under server-owned state:** rejected because state must be
  removable without losing operator settings.
- **TOML or YAML instead of JSON:** rejected for dreamux-owned config. JSON
  keeps local secret storage and redaction logic simple and explicit. Codex may
  still maintain its own TOML config under `~/.codex`.
- **Require every key to be present:** rejected. Built-in defaults keep new
  config keys forward-compatible.
