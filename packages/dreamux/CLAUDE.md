# @excitedjs/dreamux

The Dreamux host: the long-running server that hosts N dispatchers, plus the
CLI, onboarding, and daemon tooling. After the issue #135 realignment, the
issue #143 directory reorg, and the issue #209 package split (runtimes and the
Feishu channel extracted to their own packages; core left holding only the
neutral provider seams), `src/` maps 1:1 onto the architecture's seams — keep
this map true.

## Directory layout (`src/`)

Two settled shape rules govern where code lives:

1. **Core holds no builtin implementations (#209 cleanup).** Pluginization is
   polymorphism: core calls only the two neutral interfaces published in
   `@excitedjs/dreamux-types` (`AgentRuntimeProvider`, `ChannelProvider`) and is
   unaware of which class implements them. `builtin:codex` / `builtin:claude-code`
   / `builtin:feishu` are providers indistinguishable from npm providers — only
   the ref→package-name resolution differs. Every provider-specific concept
   (codex thread/home/bin, claude stream, feishu chat_id/app_id) lives in the
   owning **package** (`@excitedjs/agent-runtime-codex`, `-claude-code`,
   `@excitedjs/feishu-channel`), never in core. The packages depend on
   `@excitedjs/dreamux-types` only and never import core. There is no
   `agent-runtime/builtin/` or `channel/feishu/` directory in core.
2. **Runtime- and channel-specific concepts never leak into shared/core layers.**
   The services layer drives any provider through its neutral interface; core
   never names a provider's config fields, paths, or transport. A dispatcher's
   display identity is the channel provider's self-reported `getIdentity`
   (surfaced as the neutral `channel_identity`), not an `app_id` core reads.

| Path | What lives here | Why |
|---|---|---|
| `server.ts` | process entry + wiring only | builds registry/catalog/store/services, opens the admin socket, starts dispatchers; owns no teammate/channel/runtime orchestration |
| `agent-runtime/` | the AgentRuntime seam, all neutral: `catalog.ts` (registry-backed `AgentRuntimeProviderCatalog` + builtin registration), `external-provider.ts` loader, `load-config.ts` (composes builtin agentRuntime + channel registration), `host-context.ts` / `host-paths.ts` (host adapters that bridge core's store/logger/path layout onto the neutral `@excitedjs/dreamux-types` create context), `bundled-skill-sources.ts`, `index.ts` barrel. Contract types live in `@excitedjs/dreamux-types` — core imports them directly (no in-core `types.ts` / `turn.ts`) | one neutral abstraction for every agent role; core never names a concrete runtime |
| `dispatcher-service/` | the Dispatcher Service entity — see [`dispatcher-service/CLAUDE.md`](src/dispatcher-service/CLAUDE.md) | holds the dispatcher agent + orchestrates teammates |
| `dispatcher-service/dispatcher/` | `DispatcherAgentService` (slots / start / resume / stop / restart-notice / channel session / role MCP injection) + dispatcher base prompt | dispatcher agent lifecycle is tied to the server |
| `dispatcher-service/teammate/` | `TeamMateAgentService` + identity-store + runtime-state + types + teammate MCP descriptor | agent-centric teammates (no `task`): spawn/send/close + forward-only history (send reopens a closed teammate; no separate `resume` verb, #155) |
| `channel/` | the bidirectional conversational ChannelProvider seam, all neutral: `catalog.ts` (`ChannelProviderCatalog`) and `external-channel-provider.ts` loader | the channel engine (session/bot/gate/message/tool-parsing/identity) lives in the provider package and never imports core; core is a blind channel-MCP conduit — the generic `channel.invoke_tool` admin method routed to the neutral `ChannelSession` / `ChannelProvider` seam — plus neutral routing/binding/auth |
| `@excitedjs/dreamux-types` `SubscribeChannelProvider` | public TS contract reservation for future one-way subscription channels (GitHub/Jira issue or PR feeds) | type-only this phase; core has no runnable loader/catalog yet. Subscription channels do not have `chat_id`, Team binding, reply/react, or conversational target ownership |
| `registry/` | provider registry/loader + provider-ref grammar | resolves `builtin:` / `npm:` refs; runnable catalogs currently cover `channel` and `agentRuntime`; `subscribeChannel` is a type-level reservation until a subscription loader/lifecycle exists |
| `mcp/` | stdio MCP shim processes (`channel-mcp`, `teammate-mcp`, `team-mcp`) — the generic `channel-mcp` shim serves provider-supplied `tools/list` metadata locally and forwards `tools/call` to `channel.invoke_tool`; channel binding (`bind_channel` / `transfer_back`) is a core Team capability on the Team MCP, #209 | thin JSON-RPC bridges that forward to the admin socket |
| `admin/` | admin Unix-socket server + protocol + methods | cross-process control; methods are thin and delegate to the Dispatcher Service |
| `config/` | operator config schema / parse / validate (`config.ts`) | the only operator-editable config source |
| `platform/` | runtime-neutral infrastructure: `paths.ts` (sole neutral path builder), `runtime-sockets` (volatile socket allocation), `logger`, `package-bin`, `atomic-write`, `fs-errors` | shared and runtime-agnostic; per-runtime path derivation lives in each provider package |
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
  thread/home/bin/socket/stream concepts stay inside their provider package
  (`@excitedjs/agent-runtime-codex` / `-claude-code`). The shared contract,
  `state/`, `platform/`, `server.ts`, and the Dispatcher Service stay
  runtime-neutral, and core never names a provider's config fields.
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
  the built-in Feishu channel package (`@excitedjs/feishu-channel`) owns its
  session, tool backing, MCP server descriptor, and reply/react wire mapping
  end-to-end (the server does not carry `*FromMcp` handlers). Core keeps only the
  generic, channel-agnostic MCP conduit: the `channel-mcp` stdio shim serves
  provider-supplied `tools/list` metadata locally and forwards `tools/call` to
  the neutral `channel.invoke_tool` admin method, which routes to the provider's
  `ChannelSession` / `ChannelProvider` seam.
- Do not reintroduce a `task` abstraction in the teammate layer; teammates are
  named, resumable agents.
- Do not create dispatcher-private `CODEX_HOME` directories for the MVP.
- Do not commit internal Feishu identifiers, secrets, private paths, internal
  domains, or real resource keys.

## Testing focus

- Assert that the Dispatcher Service drives any runtime through the neutral
  AgentRuntime interface; runtime-specific behavior is tested inside each
  provider package.
- Keep fixtures public-safe: placeholder chat, message, user, app, and resource
  identifiers.
