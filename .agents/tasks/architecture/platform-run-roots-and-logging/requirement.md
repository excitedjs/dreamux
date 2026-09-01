# Backfilled decision records: platform run roots and logging records

> Backfilled 2026-09-01 from the dissolved `.agents/decisions/` tree on
> operator instruction: task records are the single derivation layer. Each
> section preserves one record verbatim (original heading, status, and date;
> headings demoted one level for nesting). Later reality is recorded only in
> dated "Since this was recorded" subsections; historical text is never edited.

## runtime-run-root

## Volatile run root and ephemeral runtime sockets

- **Status:** Accepted. Supersedes the historical socket-placement baseline for
  `state/admin.sock`, `state/restart-intent.json`, and `server.json`. Current
  stable path guidance is consolidated in
  [State, config, and files](/.agents/domains/state-config-and-files.md).
- **Date:** 2026-06-10
- **Affects:** `~/.dreamux` layout, admin IPC path contract, Codex app-server
  socket placement, completion spill + attachment cache placement,
  `dreamux serve` startup, `dreamux uninstall`
- **PR / Issue:** Epic issue #182, PR-1 (run/sockets) and PR-2 (cache/spill)

### Decision

`~/.dreamux` splits volatile run files and rebuildable cache from durable state:

```text
~/.dreamux/
  run/                     volatile; safe to clear while no server runs
    admin.sock             stable cross-process admin IPC endpoint (+ .lock)
    restart-intent.json    one-shot daemon restart marker
    sockets/               fallback root for runtime rendezvous sockets
  cache/<dispatcher-id>/   rebuildable artifacts (PR-2); safe to clear
    spill/                 over-budget teammate completion spill files
    feishu-attachments/    inbound attachment downloads
  state/                   durable server-owned state only
```

Path builders stay centralized: neutral builders in
`/packages/dreamux/src/platform/paths.ts` (`runRoot()`, `adminSocketPath()`,
`restartIntentPath()`, `cacheRoot()`, `dispatcherCompletionSpillDir()`,
`dispatcherFeishuAttachmentCacheDir()`); volatile socket allocation in
`/packages/dreamux/src/platform/runtime-sockets.ts`.

#### Cache tree (PR-2)

Completion spill and the Feishu attachment cache are rebuildable artifacts, not
durable state, so they live under `cache/`, not `state/`:

- **Completion spill** moved out of shared `/tmp` (a path surfaced verbatim in
  dispatcher-visible text should not be a world-writable temp file). The neutral
  `agent-runtime/completion-body.ts` stays runtime-agnostic — it never names a
  dispatcher id — and receives the owning dispatcher's spill dir through the
  runtime's `AgentRuntimePathContext.completionSpillDir`. The launcher resolves
  that to the **operator** dispatcher's cache even for a teammate/team-leader
  runtime (whose own `dispatcher_id` is a composite runtime id), so one
  operator's spill groups under one `cache/<id>/spill`. The spill file is read
  by no process; only its path is inlined.
- **Feishu attachment cache** moved out of `state/<id>/` into
  `cache/<id>/feishu-attachments/` (see
  [feishu-inbound-attachments](/.agents/tasks/channel/feishu-access-foundations/requirement.md#feishu-inbound-attachments)).

`dreamux uninstall` removes `cache/` alongside `run/`, `state/`, and `logs/`.
No automatic migration of the old `/tmp` spill files or `state/<id>/
feishu-attachments/` dirs — the changelog notes them as manually deletable.

#### Two socket classes, two contracts

- **`admin.sock` is a stable path contract.** Packaged CLI commands and MCP
  shims resolve it through `adminSocketPath()`; it stays at a fixed
  `run/admin.sock` and fails loudly when an extreme `$HOME` blows the
  `sun_path` budget. Moving it is a cross-process change: an old shim and a
  new server disagree on the path (mixed-version caveat in the changelog).
- **Runtime sockets are ephemeral rendezvous endpoints.** A Codex app-server
  socket exists only so dreamux can start
  `codex app-server --listen unix://<path>` and connect with
  `ws+unix://<path>`; resume/checkpoint never depends on the path. Each
  runtime start allocates a fresh short random name
  (`allocateRuntimeSocketPath`), picking the first of these that fits the
  `sun_path` budget, in preference order:
  1. `$XDG_RUNTIME_DIR/dreamux/sockets/` (operator input — shared-tmp values
     like `/tmp` are rejected);
  2. `~/.dreamux/run/sockets/`;
  3. `<os-private-temp>/dreamux/sockets/` — the per-user OS temp dir **only when
     it is private, not world-shared `/tmp`** (issue #182 final gate). On macOS
     `os.tmpdir()` is the per-user `$TMPDIR` (`/var/folders/<…>/T`, owner-only)
     and is far shorter than a long per-run durable `$HOME`, so it keeps Codex
     sockets within budget when there is no `$XDG_RUNTIME_DIR` and
     `~/.dreamux/run/sockets/` is over budget (the macOS CI failure mode). On
     Linux `os.tmpdir()` is `/tmp` (shared) and is rejected, so this candidate
     never reintroduces a world-shared tmp socket. The temp dir is resolved from
     `TMPDIR`/`TMP`/`TEMP` then `os.tmpdir()`.
  Shared `/tmp` / `/var/tmp` are never used; if no candidate fits the budget,
  allocation fails loudly. The old descriptive `state/<id>/codex.sock` path
  and its digest-named fallback are deleted.

#### Invariants

- **Owner-only run dirs.** Dreamux-owned run/socket dirs are adopted through
  `ensureOwnerOnlyDir` (`platform/owner-only-dir.ts`), not a bare
  `mkdir(mode: 0o700)`: mode-on-create does nothing to a dir that already
  exists, so the helper also rejects a symlinked leaf, fails loud on a dir
  owned by another uid, and tightens a pre-existing group/world-traversable
  dir to 0700. Operator-owned parents (`$XDG_RUNTIME_DIR` itself) are never
  passed to it.
- **Mixed-version single-server guard.** The new server locks
  `run/admin.sock.lock`, but a still-running OLD-version server locks the
  legacy `state/admin.sock.lock` — a different path the new lock cannot see.
  Before binding, the new server probes the legacy lock
  (`assertNoLegacyAdminServer`) and fails loud if a *live* holder is found, so
  two servers never run at once (which would also break the sweep's
  single-server premise). Detection only: a stale/dead-PID legacy lock is
  ignored, and the legacy file is never read for migration, removed, or
  rewritten. The CLI injects the real legacy path; the changelog tells
  operators to stop the old daemon before upgrading.
- **No persistence.** Runtime socket paths live in supervisor/runtime memory
  only — never in identity, history, ledger, checkpoint, `status.json`, or any
  public status surface. There is deliberately **no live socket registry**
  (operator decision on issue #182): diagnostics rely on failure logs and live
  process context.
- **Supervisor owns the lifecycle.** mkdir (0700 parent), stale-socket removal
  before bind, socket removal on stop/reap — unchanged from the previous
  design.
- **Startup sweep.** `dreamux serve` clears the runtime-socket dirs wholesale
  once the admin lock is held (single-server guarantee makes every entry a
  dead crash orphan). The sweep is injected by the CLI
  (`Server` option `runtimeSocketSweep`), so tests and embedded servers never
  touch the operator's run root. This is the new root's own volatility
  contract, **not** a cleanup of old-layout files — dreamux ships no automatic
  migration/pruning of the old layout (changelog documents manual cleanup).
- **`server.json` is gone.** The path builder had no production consumer; it
  was removed rather than carried as a dead declaration.

### Why

A long TeamLeader name blew the 103-byte socket budget because the socket path
embedded the human-readable runtime tree
(`state/<dispatcher>/teammate/runtime/<name>/codex.sock`). Human-readable
identity belongs in status/history/ledger surfaces, not in volatile socket
paths; random bounded names remove the whole path-length failure class and the
digest-fallback complexity. Splitting `run/` from `state/` gives every file a
single volatility class, which the rest of epic #182 (cache, worktrees, logs)
builds on.

---

## logging

## Persistent file logging

- **Status:** In progress (implemented, pending PR merge)
- **Date:** 2026-06-05
- **Affects:** server runtime, Feishu channel, access gate, inbound/outbound,
  `/introduce`, `feishu-mcp` stdio shim, dispatcher lifecycle, logs layout
- **PR / Issue:** [#70](https://github.com/excitedjs/dreamux/issues/70)
  (Codex reviewed the proposal; verdicts and merge bar are in the issue
  comments)

### Context

Only the Codex app-server child's stdout/stderr persists to disk
(`codex/supervisor.ts` → `logs/codex-app-server/<id>.log`). Everything dreamux
itself decides — gate deliver/drop, trust-domain warnings, `/introduce`,
inbound submit, outbound `reply`/`react`, reaction-ledger errors, dispatcher
restart — is `console.error` only (48 call sites) and is lost when `serve` runs
as a daemon. The current stable file contract reserves host and channel log
locations under `~/.dreamux/logs/`, and `paths.ts` exposes `serverLogPath()` /
`feishuChannelLogDir()`, but nothing writes them. Dropped messages and failed
introduces are therefore undiagnosable after the fact.

This was scoped as a **standalone PR**, deliberately separate from the Feishu
`/introduce` / bot-trust / reaction work, per the issue-first workflow below.

### Decision

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

#### Closed by #74: `feishu-transport` package logging

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

### Logging convention (for future code)

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

### Issue-first workflow

Logging was planned **issue-first**: a GitHub issue (#70) carrying
requirements, technical proposal, rollout scope, test plan, and open design
questions was opened and reviewed **before** any code or PR. Open design
questions are tracked as issue comments for Codex review. New cross-cutting
infrastructure work in this repo should follow the same shape — open the issue,
settle the design in comments, then implement — rather than landing a PR first.

### Consequences

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

### Alternatives considered

- **`winston`** — heavier, larger surface; rejected for a CLI/server host.
- **`debug`** — no structured output, no file sink; insufficient.
- **`pino.transport` worker** — fragile for short-lived shim/test processes;
  rejected in favor of `pino.destination()`.

### Since this was recorded (2026-09-01)

Merged long ago. The logger lives at `/packages/dreamux/src/platform/logger.ts` (not `src/runtime/logger.ts`), using pino multistream with `sync: true` and `0o600`; path helpers expose the neutral `channelLogPath(id)` rather than `feishuChannelLogDir()`.

