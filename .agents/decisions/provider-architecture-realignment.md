# Provider architecture realignment

- **Status:** Accepted (remediation tracked in issue #135; not yet implemented)
- **Date:** 2026-06-08
- **Affects:** Agent Runtime providers, TeamMate worker providers, Dispatcher
  Service, Capability Registry, Channel providers, MCP injection, `server.ts`
- **PR / Issue:** [issue #135](https://github.com/excitedjs/dreamux/issues/135);
  refines/supersedes the architectural claims in
  [provider-references-and-capability-registry](provider-references-and-capability-registry.md),
  [agent-runtime-provider](agent-runtime-provider.md),
  [channel-provider](channel-provider.md), and
  [server-hosted-teammate](server-hosted-teammate.md)

## Context

`#110` introduced the plugin / provider / capability abstraction and `#126`
extended it to TeamMate worker execution. A review against the original design
intent found both Epics drifted from the same root: things that should not be
plugin seams were modeled as providers, the one runtime abstraction was forked
into two, and the load-bearing Dispatcher Service was never given an entity.
This record fixes the target so future work stops reverse-engineering intent
from code.

## Decision

The target architecture is:

- **One `AgentRuntime` abstraction** serves every agent role — dispatcher,
  teammate, team-leader, and (future) team member. Roles are NOT distinct
  runtime types; a role is the same runtime launched by the Dispatcher Service
  with a **role-specific injected MCP tool set** plus a **role-specific system
  prompt**. The `TeamMateWorkerProvider` parallel tree
  (`/packages/dreamux/src/teammate/worker/`) is removed. The runtime interface
  must cover inbound/turn submission, steering, resume, stop/close, and
  upward result delivery. The "one task = one turn, reap" worker model is
  replaced by a semi-resident, resumable session that the dispatcher controls.
- **Dispatcher Service is a real module**, not a role smeared across
  `/packages/dreamux/src/server.ts` and `/packages/dreamux/src/teammate/`. It is
  launched by the server, holds the dispatcher agent (lifecycle tied to the
  server: started at boot, resumed on restart), and owns TeamMate scheduling,
  spawn, dispatch, lifecycle (the dispatcher agent commands it over MCP; the
  service holds the teammate runtime instances), and delivery of results back
  into the dispatcher agent.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** A
  teammate / team-leader agent is simply not injected the "spawn TeamMate" tool;
  it is injected inter-agent communication tools instead (agent↔dispatcher,
  agent↔team-leader, agent↔agent).
- **Exactly two plugin seams: `agentRuntime` and `channel`.** The `'service'`
  provider kind is removed — Dispatcher Service is a dreamux core capability and
  must not be modifiable by external plugins.
- **External provider loading is made real for the `agentRuntime` seam.** The
  `npm:` ref grammar must actually load external/closed-source or third-party
  runtimes (e.g. opencode, gemini cli, and runtimes that cannot be vendored into
  this open repo), not just reserve syntax.
- **The `channel` plugin seam is interface-only this cycle.** Define the TS
  interface with proper reservations for subscription-style channels (github /
  jira) that inject arbitrary channel MCP and push subscribed events to agents;
  do not implement external channel loading yet.
- **Feishu is pulled out of the plugin seam.** It is a built-in *bidirectional
  conversational* channel, a different category from subscription-style channel
  plugins; its chat→agent binding model is expected to change with the Team
  work (different group chats binding to different team-leaders rather than all
  to the dispatcher). The current `ChannelConnection = FeishuBot` and 1:1
  dispatcher binding are temporary.
- **The Capability Registry is demoted to a provider registry / loader.** It
  resolves `builtin:` and `npm:` refs to provider implementations and is a
  server-owned singleton. The capability *mirror* (registry-declared
  capabilities duplicated by provider methods, kept in sync by a drift test) is
  removed; capability is a single provider-owned declaration that core actually
  reads — to compose the channel tool surface, and to know per-runtime support
  (resume / steer / completion-delivery shape).
- **Channel tool handlers move out of core.** A channel plugin owns its MCP
  end-to-end (tool definitions + handlers); core injects the descriptor and
  provides the connection, and no longer carries `*FromMcp` handlers in
  `server.ts`.

## Consequences

- Several `#110` / `#126` decisions are refined: the registry stops being a
  "capability registry", `agentRuntime` and `channel` are the only provider
  kinds, and TeamMate execution is no longer a separate provider tree.
- `server.ts` loses the ~12 `*TeamMate*FromMcp` methods, channel `*FromMcp`
  handlers, and hard-spliced MCP injection — they move into the Dispatcher
  Service and the channel/runtime plugins.
- Hard-coded `BUILTIN_*_REF` branching across core (`server.ts`,
  `/packages/dreamux/src/runtime/config.ts`,
  `/packages/dreamux/src/cli/doctor.ts`) is expected to shrink as core consumes
  provider implementations instead of provider-specific names.
- This is an upgrade blocker by the root `CLAUDE.md` changelog rule once
  implemented: it touches provider config semantics, state/runtime layout, and
  bundled MCP/skill surfaces. The implementing PRs must ship `rush change`
  notes.

## Future extension points (not in scope, but the design must not preclude them)

- A **Team Service** under the Dispatcher Service: the dispatcher creates a team
  of a team-leader plus 3–4 member agents that communicate, debate, and
  challenge each other; the dispatcher connects only to the team-leader.
- Feishu's many-to-many group-chat → team-leader binding rework.
