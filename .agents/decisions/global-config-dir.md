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

- Dispatcher declarations under `dispatchers` (the only top-level key besides
  nothing else — there is no top-level `codex` block).
- Per-dispatcher Feishu `app_id` and `app_secret`.
- Per-dispatcher Codex settings under `dispatchers[].codex`
  (`bin`, `approval_policy`, `sandbox_mode`, `extra_args`, `extra_env`,
  `initialize_timeout_ms`), each with a built-in default so the whole `codex`
  object — and any field in it — can be omitted. This is the only Codex
  configuration entry point; a leftover top-level `codex` block is rejected
  loudly on load.

`dispatchers[].codex.bin` (default `"codex"`) is the codex binary path; the
`CODEX_HOST_CODEX_BIN` environment variable is an optional host-level override
above it, not the source. `initialize_timeout_ms` (default `10000`) is that
dispatcher's handshake timeout. Both are rarely set; the defaults work
unconfigured.

Per-dispatcher access gate allowlists do not live in `config.json`; the current
runtime reads them directly from `~/.dreamux/state/<dispatcher>/access.json`.

Webhook-only verification/encryption fields are not part of the MVP config
schema. SQLite-backed state, durable inbound buffers, and automatic
assistant-text outbound are also not part of the current runtime contract.

`dreamux config show`, `status`, `doctor`, and logs must redact Feishu secrets.
There is no CLI raw mode for printing the unredacted local config.

## Precedence

The codex binary path resolves in this order, highest first:

1. `CODEX_HOST_CODEX_BIN` environment variable (optional host-level override).
2. The dispatcher's `dispatchers[].codex.bin` (default `"codex"`).

All other Codex values come straight from that dispatcher's
`dispatchers[].codex` field, falling back to the built-in defaults (constants in
`src/runtime/config.ts`: `DEFAULT_CODEX_BIN`, `DEFAULT_APPROVAL_POLICY`,
`DEFAULT_SANDBOX_MODE`, `DEFAULT_INITIALIZE_TIMEOUT_MS`).

There is no global `codex` layer between the per-dispatcher fields and the
built-in defaults. A dispatcher's `extra_args` are the only source of repeated
`-c key=value` options (dreamux appends its own Feishu MCP `-c` args after
them, relying on Codex's last-write-wins behavior). Per-dispatcher `extra_env`
is merged over the server process environment before spawning that
dispatcher's Codex app-server.

The managed-service unit does not pin `CODEX_HOST_CODEX_BIN`; it seeds the unit
`PATH` with the onboarded codex binary's directory so each dispatcher's
`codex.bin` resolves. Units installed before this change may still carry the
env var, where it keeps acting as the host-level override.

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
