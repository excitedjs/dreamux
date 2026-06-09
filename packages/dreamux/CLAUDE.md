# @excitedjs/dreamux

The Dreamux host: the long-running server that hosts N dispatchers, plus the
CLI, onboarding, and daemon tooling. After the issue #135 realignment and the
issue #143 directory reorg, `src/` maps 1:1 onto the architecture's seams — keep
this map true.

## Directory layout (`src/`)

Two settled shape rules govern where code lives:

1. **Each builtin Agent Runtime owns its whole stack** under
   `agent-runtime/builtin/<name>/` (transport + runtime + provider + args +
   paths). The two builtins must not import each other.
2. **Runtime- and channel-specific concepts never leak into shared/core layers.**
   The services layer drives any runtime through one neutral interface; per-runtime
   specifics (codex thread/home/bin, claude stream, feishu chat_id/sender_id)
   stay behind the providing module.

| Path | What lives here | Why |
|---|---|---|
| `server.ts` | process entry + wiring only | builds registry/catalog/store/services, opens the admin socket, starts dispatchers; owns no teammate/channel/runtime orchestration |
| `agent-runtime/` | the AgentRuntime seam: contract (`types.ts`, `turn.ts`), `catalog.ts`, `external-provider.ts` loader, `load-config.ts` (caller-composed builtin registration), `index.ts` barrel | one runtime abstraction for every agent role — see [`agent-runtime/CLAUDE.md`](src/agent-runtime/CLAUDE.md) |
| `agent-runtime/builtin/codex/` | the whole `builtin:codex` stack: supervisor/rpc/events/handshake/types (transport), runtime, provider, args, codex-home, paths, turn-manager, approval | codex specifics close over here; nothing codex-named leaks out |
| `agent-runtime/builtin/claude-code/` | the whole `builtin:claude-code` stack: supervisor/rpc/stream/types, runtime, args, paths, mcp-config | claude specifics close over here |
| `dispatcher-service/` | the Dispatcher Service entity — see [`dispatcher-service/CLAUDE.md`](src/dispatcher-service/CLAUDE.md) | holds the dispatcher agent + orchestrates teammates |
| `dispatcher-service/dispatcher/` | `DispatcherAgentService` (slots / start / resume / stop / restart-notice / channel session / role MCP injection) + dispatcher base prompt | dispatcher agent lifecycle is tied to the server |
| `dispatcher-service/teammate/` | `TeamMateAgentService` + identity-store + runtime-state + types + teammate MCP descriptor | agent-centric teammates (no `task`): spawn/send/close + forward-only history (send reopens a closed teammate; no separate `resume` verb, #155) |
| `channel/feishu/` | the built-in Feishu bidirectional channel: bot, session, gate, message, mcp-surface, chat-bots, introduce | Feishu owns its MCP end-to-end; it is **not** a registry provider |
| `channel/plugin.ts` | TS interface reservation for future subscription-style channel plugins (github/jira) | interface-only this phase; not loaded or run |
| `registry/` | provider registry/loader + provider-ref grammar | resolves `builtin:` / `npm:` refs; exactly two kinds: `channel`, `agentRuntime` |
| `mcp/` | stdio MCP shim processes (`feishu-mcp`, `teammate-mcp`) | thin JSON-RPC bridges that forward to the admin socket |
| `admin/` | admin Unix-socket server + protocol + methods | cross-process control; methods are thin and delegate to the Dispatcher Service |
| `config/` | operator config schema / parse / validate (`config.ts`) | the only operator-editable config source |
| `platform/` | runtime-neutral infrastructure: `paths.ts` (sole neutral path builder), `logger`, `secrets`, `package-bin`, `process` | shared and runtime-agnostic; per-runtime paths live in each builtin's `paths.ts` |
| `state/` | server-owned dispatcher state: `dispatcher-store`, `dispatcher-id` | `status.json` etc. — rebuildable recovery state (#98) |
| `cli/` `onboard/` `daemon/` | operator-facing surfaces | CLI command tree, onboarding, native user-level service manager |

## Responsibilities

- Own the `dreamux` and `tm` package bins.
- Ship `CHANGELOG.md` / `CHANGELOG.json` inside the package (`files`) so
  `dreamux changelog` reads the installed version offline. Any user-visible
  upgrade blocker carries a rush change file (root `CLAUDE.md` "Changelog
  responsibility"). Never hand-edit the generated changelog files.
- Load operator config (`config/`) and own server state (`state/`) and logs.
- Launch, resume, stop, and supervise dispatcher agent runtimes through the
  Agent Runtime provider seam — not by hard-coding any one runtime.
- Own teammate orchestration (scheduling, lifecycle, history, completion
  delivery) inside the Dispatcher Service.

## Boundaries

- **Do not leak runtime specifics into shared/core layers.** codex/claude
  thread/home/bin/socket/stream concepts stay inside
  `agent-runtime/builtin/<name>/`. The shared contract, `state/`, `platform/`,
  `server.ts`, and the Dispatcher Service stay runtime-neutral.
- **Do not leak channel *routing* into the runtime contract.** Routing/identity
  *decisions* — which chat to reply to, who the sender is, message threading —
  belong to the channel layer; a runtime must never branch or reply-target on
  `chat_id` / `sender_id` / message ids. Reply targeting stays in the channel
  layer (the Feishu reply MCP tool takes `chat_id` as an explicit parameter).
  What a runtime turn MAY carry, beyond neutral text + a dedupe id, is **opaque
  display passthrough**: `InboundTurnInput.attrs` is an opaque key/value bag the
  runtime renders verbatim into its model-visible channel block (the native
  `<channel source="…" …>` envelope) but never interprets. Each runtime owns
  assembling its own channel block from these neutral pieces (issue #164); the
  channel layer no longer pre-renders the message XML. See
  [`.agents/decisions/channel-input-runtime-assembly.md`](../../.agents/decisions/channel-input-runtime-assembly.md).
- Direct Lark SDK / Feishu JSAPI calls belong in `@excitedjs/feishu-transport`;
  the built-in Feishu channel under `channel/feishu/` owns its MCP surface and
  handlers end-to-end (the server does not carry `*FromMcp` handlers).
- Do not reintroduce a `task` abstraction in the teammate layer; teammates are
  named, resumable agents.
- Do not create dispatcher-private `CODEX_HOME` directories for the MVP.
- Do not commit internal Feishu identifiers, secrets, private paths, internal
  domains, or real resource keys.

## Testing focus

- Assert that the Dispatcher Service drives any runtime through the neutral
  AgentRuntime interface; runtime-specific behavior is tested inside each
  builtin.
- Keep fixtures public-safe: placeholder chat, message, user, app, and resource
  identifiers.
