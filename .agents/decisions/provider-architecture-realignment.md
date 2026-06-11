# Provider architecture realignment

- **Status:** Accepted (remediation tracked in issue #135; implemented through
  the PR F external Agent Runtime loading cut)
- **Date:** 2026-06-08
- **Affects:** Agent Runtime providers, TeamMate agent state, Dispatcher
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
  covers single-instance operations only: start/resume/stop, inbound/turn
  submission, steering capability, last/context reads, and upward result
  delivery. Dispatcher orchestration verbs such as `spawn`, `close`, and
  `list` stay on the Dispatcher Service and must not be instance methods on
  `AgentRuntime`. The "one task = one turn, reap" worker model is
  replaced by a semi-resident, resumable session that the dispatcher controls.
- **Dispatcher Service is a real module**, not a role smeared across
  `/packages/dreamux/src/server.ts` and `/packages/dreamux/src/teammate/`. It is
  launched by the server, holds the dispatcher agent (lifecycle tied to the
  server: started at boot, resumed on restart), and owns TeamMate spawn, send,
  close, read/recovery verbs, and teammate runtime instances (issue #155 removed
  the standalone `resume` verb; `send` now reopens a closed teammate). The
  dispatcher agent commands it over MCP.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** A
  teammate / team-leader agent is simply not injected the "spawn TeamMate" tool;
  it is injected inter-agent communication tools instead (agent↔dispatcher,
  agent↔team-leader, agent↔agent).
- **Exactly two plugin seams: `agentRuntime` and `channel`.** The `'service'`
  provider kind is removed — Dispatcher Service is a dreamux core capability and
  must not be modifiable by external plugins.
- **External provider loading is made real for the `agentRuntime` seam.** The
  `npm:` ref grammar must actually load external/closed-source or third-party
  runtimes that cannot be vendored into this open repo, not just reserve
  syntax.
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
  resolves `builtin:` and `npm:` refs to provider implementations. The config
  loader creates or receives one registry instance, loads external runtime
  providers into that instance, validates config through it, and passes the same
  instance into server startup. No default builtin singleton may become a
  separate fallback that rejects already-loaded `npm:` refs. The capability
  *mirror* (registry-declared capabilities duplicated by provider methods, kept
  in sync by a drift test) is removed; capability is a single provider-owned
  declaration that core actually reads — to compose the channel tool surface,
  and to know per-runtime support (resume / steer / completion-delivery shape).
  Runtime catalogs are registry views: they resolve descriptors from the
  registry and read the implementation already registered there, rather than
  maintaining a second provider map.
- **Channel tool handlers move out of core.** A channel plugin owns its MCP
  end-to-end (tool definitions + handlers); core injects the descriptor and
  provides the connection, and no longer carries `*FromMcp` handlers in
  `server.ts`.

### TeamMate layer (agent-centric)

The teammate layer follows the agent-centric dispatcher model proven in the
sibling open-source repo claudemux
(https://github.com/excitedjs/claudemux/tree/main/plugins/claudemux/src) —
see its `verbs/` (spawn/resume/history), `persistence/history-index.ts` and
`identity-store.ts`, `engines/types.ts`, and `engines/teammate-record.ts`.

- **No `task` abstraction.** A teammate is a persistent, resumable agent
  identified by a stable name — not a one-shot task runner. The current
  `/packages/dreamux/src/teammate/ledger.ts` task state machine (`task_id`,
  `schedule`, `run_task`, `execute_task`) is removed. Task decomposition and
  assignment stay in the dispatcher agent (its own todolist-style tools); the
  teammate layer only knows teammate identities.
- **Dispatcher-facing verbs, no unified suffix:** `spawn`, `send`, `close` for
  lifecycle; `history`, `list`, `status`, `last`, `get_capabilities` for
  read/recovery. `history` is the recovery search surface, served from the
  per-name records; `last` reads a teammate's most recent settled turn(s) by
  concrete name from the per-name turns archive (issue #188 reworked both and
  removed the obsolete `ctx` and raw `history_events` verbs; issue #199 Slice 3
  moved both off the session ledger — see top-level-design). `spawn`/`send` return after submitting
  the runtime turn; the dispatcher recovers through history/last instead of a
  task result ledger. (Issue #155 dropped the original standalone `resume`
  verb — see below.)
- **send subsumes resume (issue #155).** The original design carried a separate
  `resume` verb to bring back a prior teammate session with its history; that is
  gone. `send` now reopens a teammate that is not live — including a `close`d one
  — by rebuilding the resume checkpoint from the record's runtime-native
  `session_id` plus the runtime's own declared checkpoint kind (issue #199 Slice
  3; the kind is never persisted), then submits, so `close` is a reversible
  soft-stop. Read-only verbs never reopen a closed teammate.
- **History reads the record, not an event stream (issue #199 Slice 3).**
  `history` / `list` / `status` project the per-name `records/<name>.json`
  recovery record — identity plus a rolling summary (turn count, last-seen,
  last prompt/assistant previews) maintained on each turn. The only JSONL store
  is the per-name `turns/<name>.jsonl` archive (compact submit/settled rows)
  that `last` folds; there is no separate forward-only history event index, and
  neither store write may fail a lifecycle verb. Per-runtime checkpoint
  mechanics are absorbed by the runtime implementation behind one `resume()`
  runtime surface.
- **Identity and state location.** A teammate is a flat name plus a base record
  (agent runtime id, dispatcher owner, source/runtime cwd, optional managed
  worktree metadata, runtime-native `session_id`, status, close metadata). State
  is server-owned under `~/.dreamux/state/<dispatcher>/teammate/`; paths go
  through `/packages/dreamux/src/platform/paths.ts`. (Issue #199 Slice 3 settled
  the layout on the per-name `records/<name>.json` recovery record plus the
  per-name `turns/<name>.jsonl` archive, retiring the `sessions.jsonl` session
  ledger and the persisted `checkpoint` object — see top-level-design.)
- **Ownership.** The Dispatcher Service owns TeamMate identity and history
  through focused modules under
  `/packages/dreamux/src/dispatcher-service/teammate/`.

## Consequences

- Several `#110` / `#126` decisions are refined: the registry stops being a
  "capability registry", `agentRuntime` and `channel` are the only provider
  kinds, and TeamMate execution is no longer a separate provider tree.
- `server.ts` loses the ~12 `*TeamMate*FromMcp` methods, channel `*FromMcp`
  handlers, and hard-spliced MCP injection — they move into the Dispatcher
  Service and the channel/runtime plugins.
- PR C extracted a thin `DispatcherService`; PR D replaces the old task/worker
  implementation with agent-centric TeamMate verbs. `server.ts` wires the
  service, admin/MCP handlers validate params and delegate to it, and the
  service owns TeamMate identity, history, lifecycle, and live runtime map.
- PR D deletes `/packages/dreamux/src/teammate/ledger.ts`,
  `/packages/dreamux/src/teammate/delivery.ts`,
  `/packages/dreamux/src/teammate/wait-broker.ts`,
  `/packages/dreamux/src/teammate/worker-execution.ts`,
  `/packages/dreamux/src/teammate/worker-logs.ts`, and
  `/packages/dreamux/src/teammate/worker/`. There is no parallel
  `TeamMateWorkerProvider` tree or `task_id` API after this cut.
- PR E removes the runnable ChannelProvider path. Feishu is wired as the
  built-in bidirectional channel through
  `/packages/dreamux/src/channel/feishu-channel.ts` and
  `/packages/dreamux/src/channel/feishu-mcp-surface.ts`; the deleted
  `/packages/dreamux/src/channel/channel-providers.ts` and
  `/packages/dreamux/src/channel/feishu-provider.ts` paths are not replaced by
  another provider map. The remaining `/packages/dreamux/src/channel/provider.ts`
  file is a TypeScript reservation for future subscription channel plugins only.
- PR E also closes the dispatcher-agent ownership debt: `DispatcherService`
  delegates dispatcher runtime/channel lifecycle to
  `/packages/dreamux/src/dispatcher-service/dispatcher/service.ts`, which owns
  live dispatcher slots, start coalescing, stop, runtime lookup, restart-notice
  injection, and Feishu channel MCP dispatch. `/packages/dreamux/src/server.ts`
  is wiring only.
- PR F implements `npm:` Agent Runtime loading: dynamic import, provider factory
  validation, same-registry registration, provider-owned capability
  declarations, and fail-loud startup errors.
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
