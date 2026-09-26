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
   are providers indistinguishable from npm providers — only the ref→package-name
   resolution differs. `builtin:feishu` resolves to the provider the
   always-loaded Feishu plugin contributes (`src/plugin/`). Every provider-specific concept
   (codex thread, codex home, codex bin, claude stream, feishu app_id) lives in the
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
| `agent-runtime/` | the AgentRuntime seam, all neutral: `catalog.ts` (registry-backed `AgentRuntimeProviderCatalog`, a pure registry lookup; builtin descriptors are registered by `registry/builtins.ts`), `capabilities.ts` (Core's one validated capability snapshot per loaded provider — the loader takes it, the catalog reuses it), `external-provider.ts` (the loader `config/`'s `loadConfig` drives for `builtin:` and `npm:` refs alike), `skill-sources.ts` (the runtime-neutral skill-source parse), `host-paths.ts` (the host's implementation of the neutral `AgentRuntimePathContext`), `host-context.ts` (the neutral disabled-feature names — core's logger and runtime-state sink are already neutral, so nothing adapts them), `index.ts` barrel. Contract types live in `@excitedjs/dreamux-types` — core imports them directly and keeps no in-core type-declaration or turn-model module | one neutral abstraction for every agent role; core never names a concrete runtime |
| `service/` | the Dispatcher Service module (issue #233 restructure): one service class per file/dir, with `index.ts` the package-internal barrel — see [`service/CLAUDE.md`](src/service/CLAUDE.md) | holds the dispatcher agent + orchestrates teammates |
| `service/dispatcher-service/` | the per-dispatcher aggregate (`index.ts` = `DispatcherService`) + its agent-side parts: the dispatcher agent as a contained `TeammateService` (`agent.ts` factory), the role→MCP delegate decision (`mcp-delegates.ts`), dispatcher base prompt, and runnable-channel guard. Agent runtime lifecycle (start/resume/stop) lives in the shared `TeammateService`; `DispatcherService` keeps restart-notice injection, cross-service orchestration, MCP assembly, and completion routing. `service/dispatchers/` holds the process-level `Dispatchers` collection. The dispatcher-cwd policy (`ensureDispatcherWorkspace`, issue #182) lives at the `service/` root in `dispatcher-workspace.ts` — a cross-cutting helper shared by server preflight, the dispatcher service, `dreamux doctor`, and the `worktree/` layer | the dispatcher *has an* agent (Phase 5, #233); there is no separate `DispatcherRuntimeService` |
| `service/channel-service/` | the dispatcher-local Channel service (`index.ts`) plus its Channel MCP delegates, and `core-port.ts` (the in-process `invoke` + event port a Channel session is given). It builds, holds, hands out, and closes live channel instances, and nothing else: no binding table, no route owner, no target resolution, no egress check | routing is Channel-owned; core neither stores a Channel's decision nor rebuilds it |
| `service/agent-entity/` + `service/teammate-collection/` (+ `service/teammate-service/`, `service/completion-router/`) | Neutral agent entity identity/turn/runtime-state stores and shared types live in `agent-entity`; `TeammateCollection` owns only teammate/member collection behavior, factory paths, and router registration; `TeammateService` owns one agent entity runtime. `service/team-collection/` + `service/team-service/` hold `TeamCollection` / `TeamService`; `service/worktree/` is a shared helper at the module root | agent-centric teammates (no `task`): spawn/send/close + forward-only history (send reopens a closed teammate; no separate `resume` verb, #155) |
| `channel/` | the bidirectional conversational ChannelProvider seam, all neutral: `catalog.ts` (`ChannelProviderCatalog`) and `external-channel-provider.ts` loader | the channel engine (session/bot/gate/message/tool-parsing/identity) lives in the provider package and never imports core; core is a blind channel-MCP conduit — a runtime-bound delegate describes the provider's own tools and forwards validated calls to the neutral `ChannelSession` / `ChannelProvider` seam — and owns no routing, binding, or collaboration-space state |
| `registry/` | provider registry/loader + provider-ref grammar | resolves `builtin:` / `npm:` refs; runnable catalogs currently cover `channel` and `agentRuntime` |
| `mcp/` | the official-SDK stdio protocol owner (`server.ts`), the single Agent-facing stdio shim (`shim.ts`), and transport-level catalog validation (`catalog.ts`). The shim knows an admin socket and an opaque lease token and nothing else: it asks `mcp.describe` what to advertise and forwards every call to `mcp.toolcall`, and branches on no tool name | one protocol implementation; each domain owns its tools through an in-server delegate, so adding or renaming a tool never touches the transport |
| `command/` | canonical Command registry, schema/validation/errors, generic payload readers, and `mustDispatcherId` | one definition per Command, adapted by both `admin.sock` and the in-process Channel `invoke`; what a domain payload field means stays in the module that owns the fact; kernel-tier, so it names no concrete domain type |
| `server/` | Command-catalog composition: `command-catalog.ts` (`createCoreCommandRegistry`, building each domain's narrow resolver from the full host), `command-host.ts` (`CoreCommandHost`, `mustDispatcher`, `mustDispatcherRow`) | the one place allowed to know every domain type; a domain-owned `commands.ts` never imports it — it takes only the resolver the catalog derives |
| `admin/` | admin Unix-socket server + NDJSON protocol + client | cross-process transport for those Commands; it owns none of them |
| `config/` | operator config schema/parse/validate (`config.ts`) and provider/plugin loading (`load.ts`) | the only operator-editable config source |
| `platform/` | runtime-neutral infrastructure with no domain knowledge: path builders (`paths.ts`, the sole neutral path builder; `home-paths.ts`, this host's home-directory prefixes for redaction; `runtime-sockets.ts`, volatile socket allocation), `logger.ts`, `package-bin.ts`, the error base (`errors.ts`) and `fs-errors.ts`, `dispatcher-id.ts` (id-format validation), `command-runner.ts` (the `CommandRunner` shell-command abstraction onboarding/service-install/provider-diagnostics run through), `instance-lock.ts` (pidfile single-instance lock), `json-value.ts` (the JSON-compatibility boundary for provider-supplied values, plus `deepFreeze`), `jsonl.ts` (append one JSONL row), `history-page.ts` (the paging/preview/grep primitives every domain history reader shares), and the generic concurrency/lifecycle primitives every service-tier owner builds on: `closed-fact.ts` (durable-close broadcast), `deduplicate.ts` (join concurrent calls), `in-flight-work.ts` (admission counter), `serial-queue.ts` (keyed async queue), `shutdown-errors.ts` (aggregate shutdown failures) | shared and runtime-agnostic; per-runtime path derivation lives in each provider package |
| `state/` | server-owned dispatcher state: `dispatcher-store` | config-backed dispatcher projections |
| `cli/` `onboard/` `daemon/` | operator-facing surfaces | CLI command tree, onboarding, native user-level service manager |

## Responsibilities

- Own the `dreamux` package bin.
- Ship `CHANGELOG.md` / `CHANGELOG.json` inside the package (`files`) so
  `dreamux changelog` reads the installed version offline. Any user-visible
  upgrade blocker carries a rush change file (root `CLAUDE.md` "Changelog
  responsibility"). Never hand-edit the generated changelog files.
- Load operator config (`config/`) and own server state (`state/`) and logs.
- Launch, resume, stop, and supervise dispatcher agent runtimes through the
  Agent Runtime provider seam — not by hard-coding any one runtime.
- Own teammate orchestration (scheduling, lifecycle, history, completion
  delivery) inside the Dispatcher Service.
- Own the canonical Command catalog and expose it identically to `admin.sock`
  and to an in-process Channel's `invoke` port.
- Expose `channel.list` through the admin socket and a Channel's in-process
  `invoke` port only, for dispatcher-scoped public Channel metadata: `channel_id`,
  provider ref, opaque `identity` (empty when absent), and `live`, in configuration order.
  `DispatcherService.listChannels()` reads configured and live Channels without
  starting sessions or exposing provider configuration. There is no public CLI
  wrapper: the public CLI is reserved for host lifecycle operations.

## Boundaries

- **Layering.** `.dependency-cruiser.cjs` declares this package's `src/`
  import-direction rules (no-circular plus a layer order over today's real
  directories) and runs as part of `npm run lint`, warn-only while the code
  organization refactor is in progress. See that file for the layer list and
  rule set — this is the one place they are defined.
- **Do not leak runtime specifics into shared/core layers.** codex and claude
  concepts — thread, home, bin, socket, stream — stay inside their provider package
  (`@excitedjs/agent-runtime-codex` / `-claude-code`). The shared contract,
  `state/`, `platform/`, `server.ts`, and the Dispatcher Service stay
  runtime-neutral, and core never names a provider's config fields.
- **Do not leak channel *routing* into the runtime contract.** Routing/identity
  *decisions* — which chat to reply to, who the sender is, message threading —
  belong to the channel layer; a runtime must never branch or reply-target on
  `chat_id` / `sender_id` / message ids. Reply targeting stays in the channel
  layer (the Feishu reply MCP tool takes `chat_id` as an explicit parameter).
  A Channel supplies opaque display attributes and faithful body text, and
  `TeammateService` renders the one provenance envelope Core owns; the Agent
  Runtime seam receives final text and nothing else, so no runtime sees a
  source taxonomy, a channel identifier, or a rendering decision.
- Direct Lark SDK / Feishu JSAPI calls belong in `@excitedjs/feishu-transport`;
  the built-in Feishu channel package (`@excitedjs/feishu-channel`) owns its
  session, tool backing, caller-scoped tool catalog, reply/react wire mapping,
  and all of its routing: which conversation reaches which Team, its own
  durable binding document, and its collaboration-space provisioning policy.
  Core keeps only the generic, channel-agnostic MCP conduit: one stdio shim
  advertises whatever a runtime-bound delegate describes and forwards every
  validated call back to it, which routes to the provider's `ChannelSession` /
  `ChannelProvider` seam. Core has no binding table and no Collaboration Space
  container.
- Do not reintroduce a `task` abstraction in the teammate layer; teammates are
  named, resumable agents.
- Do not create dispatcher-private `CODEX_HOME` directories for the MVP.
- Do not commit internal Feishu identifiers, secrets, private paths, internal
  domains, or real resource keys.

## Testing focus

Which kind of unit test to write, and which kind is banned, is covered by
[Unit testing](/.agents/domains/unit-testing.md) — read it before writing or
modifying a test in this package. This directory's own notes:

- Assert that the Dispatcher Service drives any runtime through the neutral
  AgentRuntime interface; runtime-specific behavior is tested inside each
  provider package.
- Keep fixtures public-safe: placeholder chat, message, user, app, and resource
  identifiers.
