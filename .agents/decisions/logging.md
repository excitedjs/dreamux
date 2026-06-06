# Persistent file logging

- **Status:** In progress (implemented, pending PR merge)
- **Date:** 2026-06-05
- **Affects:** server runtime, Feishu channel, access gate, inbound/outbound,
  `/introduce`, `feishu-mcp` stdio shim, dispatcher lifecycle, logs layout
- **PR / Issue:** [#70](https://github.com/excitedjs/dreamux/issues/70)
  (Codex reviewed the proposal; verdicts and merge bar are in the issue
  comments)

## Context

Only the Codex app-server child's stdout/stderr persists to disk
(`codex/supervisor.ts` → `logs/codex-app-server/<id>.log`). Everything dreamux
itself decides — gate deliver/drop, trust-domain warnings, `/introduce`,
inbound submit, outbound `reply`/`react`, reaction-ledger errors, dispatcher
restart — is `console.error` only (48 call sites) and is lost when `serve` runs
as a daemon. `top-level-design.md` already reserves `logs/dreamux-server.log`
and `logs/feishu-channel/<id>.log`, and `paths.ts` exposes `serverLogPath()` /
`feishuChannelLogDir()`, but nothing writes them. Dropped messages and failed
introduces are therefore undiagnosable after the fact.

This was scoped as a **standalone PR**, deliberately separate from the Feishu
`/introduce` / bot-trust / reaction work, per the issue-first workflow below.

## Decision

Use **`pino`** as the host logger, built through a new factory
`src/runtime/logger.ts`, writing structured JSON to the
already-reserved files under `~/.dreamux/logs/`.

Settled choices (as implemented):

- **`pino.destination()` + `pino.multistream`**, never the worker-thread
  `pino.transport` — robust for the short-lived `feishu-mcp` stdio shim and for
  vitest.
- **`sync: true` everywhere.** The shim and tests need synchronous writes; the
  server avoids a flush-on-shutdown lifecycle. No line is lost on exit.
- **One pino instance per file.** A `child()` shares the parent stream, so the
  global `server` log (`logs/dreamux-server.log`) and each per-dispatcher
  channel log (`logs/feishu-channel/<id>.log`) are **separate instances**, built
  by an injected `channelLoggerFactory`. `child()` would only bind fields within
  one file.
- **Dual output, structured on both streams (v1).** When a file is configured,
  the logger writes JSON to BOTH the file and stderr via `multistream`, so a
  foreground `serve` stays visible. No `pino-pretty` and no stderr-reparsing
  stream in v1 (the fragile path) — structured-on-stderr is a deliberate UX
  choice (Codex open-question #2).
- **The `console.*` migration is NOT blanket** (Codex #2 / #5). Only
  long-running/diagnostic surfaces moved to the logger: `serve` (`cli/server.ts`)
  and the whole `server.ts` `[server]` diagnostic set, plus the dispatcher
  runtime/turn-manager `log` seam and the `feishu-mcp` diagnostic seam. CLI
  result output (`doctor`, `config show/path`, `server-ctl`, help/onboard/
  uninstall ledgers) stays on `console`/stdout — that is a CLI contract.
- **Level via `DREAMUX_LOG_LEVEL`, default `info`** (Codex #3); the factory also
  takes an explicit `level` option for tests. Not a `config.json` field
  (state/logs do not follow `DREAMUX_CONFIG_DIR`).
- **Files are `0o600`** — the factory does `mkdir` + `openSync(path,'a',0o600)`
  + `chmodSync(path,0o600)` (tightening a pre-existing wider file), then hands
  the fd to pino, matching `supervisor.ts`.
- **Secrets via pino `redact`** (`app_secret`, `*.app_secret`, `*.secret`,
  censored to `[REDACTED]`) — declarative and tested.
- **Message bodies are never passed to the logger.** Callers log ids only
  (`chat_id`/`message_id`/`sender_id`/reason), never `parsed_text` /
  `rawContent` / reply `text`. There is no body-verbose flag in v1; absence is
  the default and is asserted by a body-substring test (Codex #5).
- **The MCP stdio shims never write diagnostics to stdout** (stdout is the
  JSON-RPC transport). `feishu-mcp` diagnostics go to
  `logs/feishu-mcp/<id>.log` + stderr; `teammate-mcp` diagnostics go to
  `logs/teammate-mcp/<id>.log` + stderr. Both use the existing injectable `log`
  seam. Regression tests lock every stdout line to a JSON-RPC envelope across
  parse-error / unknown-method / admin-failure paths.

### Closed by #74: `feishu-transport` package logging

The transport package's own `[feishu-sdk]` / connection-lifecycle lines
(`reconnecting` / `reconnected` / `error` / startup-timeout) were **explicitly
deferred** from the #70 PR (Codex blocker #1) and are now folded in by
[#74](https://github.com/excitedjs/dreamux/issues/74).

`FeishuTransportOptions` gains an additive public `logger?` — a package-owned
minimal `TransportLogger` interface (`packages/channel/feishu-transport/src/transport/diagnostics.ts`),
**not** a reverse dependency on dreamux/pino. A per-instance
`createTransportDiagnostics(logger?)` derives the SDK logger (one object shared
by `lark.Client` / `EventDispatcher` / `WSClient`), the connection-lifecycle
sink, and the best-effort `diagnostic()` sink (doc-comment / metadata /
bot-info / socket-close failures). Instance-level, never a mutable global, so
several dispatchers in one process never cross-write each other's logs. With no
logger injected, the historical stderr behavior is preserved **byte-for-byte**
(the `[feishu-sdk]` prefix, the `[feishu-transport] <ISO> <line>` connection
lines, the best-effort `[feishu-transport] <message>` diagnostics — all to
stderr, never a byte to stdout). The Lark-SDK-on-stdout corruption guard is
unchanged: the default path stays on `console.error`, and the injected path
never targets stdout.

dreamux wires it through `Server`: the per-dispatcher `channelLog` is built
**before** the bot, adapted via `pinoToTransportLogger` (`runtime/logger.ts`),
and passed `createFeishuBot({ …, logger }) → createFeishuTransport(creds, { logger })`,
so transport SDK/connection lines land in `logs/feishu-channel/<id>.log`.
Safety boundary: the adapter only forwards the transport's own diagnostic
`source`/`err` fields — never `appSecret`, raw events, `rawContent`, parsed
text, or reply/card bodies — so routing into the channel log neither widens the
secret/body surface nor pollutes the MCP stdout stream.

Before #74 these lines were not lost, only unstructured: the transport routed
them to **stderr**, and a daemonized `dreamux serve` already redirects stderr to
`~/.dreamux/logs/daemon.stderr.log` (`onboard/service.ts` launchd
`StandardErrorPath` / systemd `StandardError=append:`). The default (no-logger)
path keeps exactly that behavior.

## Logging convention (for future code)

- Path builders stay in `runtime/paths.ts`; **construction** lives in
  `runtime/logger.ts`. Do not build a logger by raw-stringing a log path.
- Log enough to reconstruct a message's fate — `dispatcher_id`, `chat_id`,
  `message_id`, `sender_id`, decision, reason — but **never the message body**.
  Pass ids, not the event/object that carries `parsed_text` / `rawContent` /
  reply `text`.
- Two distinct sensitive-data surfaces: **runtime logs on local disk** may carry
  IDs (needed for diagnosis; not a commit); **committed text** (code, KB, test
  fixtures) is the public-repo red line — placeholder IDs only, never a real
  `ou_`/`oc_`/`cli_`.
- The logger factory takes an **explicit destination** so tests inject a tmp
  path. `paths.ts` `dreamuxRoot()` hardcodes `homedir()` and does **not** honor
  `DREAMUX_CONFIG_DIR` (only `config.ts` does, for the config file) — tests must
  inject, not rely on the env var.

## Issue-first workflow

Logging was planned **issue-first**: a GitHub issue (#70) carrying
requirements, technical proposal, rollout scope, test plan, and open design
questions was opened and reviewed **before** any code or PR. Open design
questions are tracked as issue comments for Codex review. New cross-cutting
infrastructure work in this repo should follow the same shape — open the issue,
settle the design in comments, then implement — rather than landing a PR first.

## Consequences

- New runtime dependency `pino` on `@excitedjs/dreamux` (a real runtime dep, not
  a dev tool — distinct from the PR #6 `tsx` red line).
- **No rotation in the first PR** — `dreamux-server.log` and per-dispatcher
  files grow unbounded until truncated. A rotation/retention decision is
  deferred.
- **Test-time stderr noise.** Tests that construct a `Server` without injecting
  a logger get a stderr-only default at `info`, so `rush test` reports
  "SUCCESS WITH WARNINGS" from the JSON lines on stderr — same class of stderr
  output the old `console.error` calls produced, not a failure.
- Tests gate the security defaults: redacted `app_secret`, message body absent
  from the persisted log (inbound drop/submit **and** outbound reply/react),
  `0o600` files (incl. tightening a wider pre-existing file), per-dispatcher
  capture isolation, level threshold, and the `feishu-mcp` stdout JSON-RPC
  contract across error paths.
- Outbound `reply`/`react` log both success (ids: `message_ids` / `reaction_id`,
  `emoji`) and failure (error summary) to the per-dispatcher channel log, never
  the reply `text`. The admin layer turning a failure into an `OUTBOUND_FAILED`
  / `REACTION_FAILED` response does **not** replace the persistent log
  (PR #75 review).

## Alternatives considered

- **`winston`** — heavier, larger surface; rejected for a CLI/server host.
- **`debug`** — no structured output, no file sink; insufficient.
- **`pino.transport` worker** — fragile for short-lived shim/test processes;
  rejected in favor of `pino.destination()`.
