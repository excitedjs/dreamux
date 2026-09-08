# Glossary

Short definitions for overloaded Dreamux terms. Source code remains
authoritative for behavior; each entry links its owner page where one exists.

| Term | Meaning |
|---|---|
| Agent Runtime | Provider seam that launches and controls one agent session, regardless of role. Built-ins include `builtin:codex` and `builtin:claude-code`. Owner: [provider-runtime](domains/provider-runtime.md). |
| Channel | Provider seam that connects Dreamux to an external communication surface. It owns message parsing, routing, binding, targets, and presentation end to end; Core sees only `invoke(command, payload)` in and core events out. Owner: [channel](domains/channel.md). |
| Channel provider ref | Config string such as `builtin:feishu` or `npm:<package>#<export>` that resolves through the provider registry. |
| Channel id | Dispatcher-local `dispatchers[].channels[].id`; used to select a configured channel instance. |
| Channel target | A Channel-internal destination/source key (for Feishu: a p2p chat, a group, or one topic). Targets never cross the provider seam: the Channel resolves them and tells Core only a `team_name`, or nothing. Owner: [channel](domains/channel.md). |
| Binding | A Channel-owned expected route `(channel instance, opaque provider meta) → team`. Not verified against the platform, not Core state; rebinding is the Channel's own `bind_channel` with a different Team. Owner: [channel](domains/channel.md). |
| Collaboration Space | A Channel product flow that provisions a Team per chat/topic it manages via ordinary `team.create`. There is no Core space entity, contract, or Command — that container was deleted rather than migrated. Owner: [channel](domains/channel.md), [product catalog](product/README.md). |
| Command / Command registry | The one authoritative catalog of Core operations (`CoreCommandRegistry`): bounding, validation, resolution, execution. `admin.sock` and a Channel's in-process `invoke` are transport adapters over the same registry — no per-adapter table, allowlist, or exposure flag. Owner: [service-topology](domains/service-topology.md). |
| Core event / Core event source | The other half of the Channel seam: a dispatcher-scoped, read-only, revocable event source (`ChannelEventSource`) a Channel session subscribes to for allowlisted state facts. Owner: [channel](domains/channel.md). |
| Dispatcher | Long-lived agent owned by `dreamux serve`; it receives accepted channel input and can call Dreamux MCP tools. |
| Dispatcher Service | Core aggregate that owns dispatcher runtime lifecycle, TeamMate lifecycle, and Team lifecycle. It holds no binding table and no routing authority — routing is Channel-owned. Owner: [service-topology](domains/service-topology.md). |
| Durable fact / commit authority | A persisted owner record whose successful write is the one thing that makes an operation's outcome true (a Team's `record.json`, a routing store's committed document). Recovery reads durable facts only; unfinished in-memory work is expected to vanish. Owner: [state-config-and-files](domains/state-config-and-files.md). |
| Identity (`identity` input) | The optional model-visible role guidance passed to `teammate.spawn` / `team.create`, persisted as `identity_prompt`, and rendered as an append-only system-prompt fragment. Distinct from `name_prefix` (a requested label), `intent` (the persisted resume topic), `prompt` (one turn's input), and the structural runtime role. Dreamux defines no role enums — `architect` and friends are caller language, not core taxonomy. |
| Managed worktree | Dreamux-created Git worktree under `.workspace/worktree/`, requested by an explicit managed repo object. |
| MCP shim | Stdio server injected into an agent runtime and forwarding tool calls to Dreamux core or a provider session. It knows an admin socket and an opaque lease token and branches on no tool name. |
| Name claim | A Team's `record.json` is its own name claim: publishing it is an exclusive create, and that create is the whole acceptance protocol. There is no separate claim file. Owner: [state-config-and-files](domains/state-config-and-files.md). |
| Primary channel | First channel declared by a dispatcher; used as the default egress channel when no `channel_id` is provided. |
| Principal | Caller identity used by core services to scope visibility and permissions, for example dispatcher, team leader, team member, or internal team service. |
| Provider registry | Process-local registry/loader for `agentRuntime` and `channel` providers. |
| StatedFailure | A domain-authored failure carrying a stable code, the domain's own reason, and the next step it knows; rendered to the model as written. Every other thrown error keeps its native message under its own code or `INTERNAL`. Owner: `/packages/dreamux/src/mcp/failure-text.ts`, [model-facing-writing](domains/model-facing-writing.md). |
| Slash command | A `/name` token the Feishu channel recognizes at the start of a human message and executes itself. It is not a Core Command and never enters the Command registry: each one composes ordinary Commands and answers the conversation with a receipt, and no agent runtime ever sees it. Owner: [channel](domains/channel.md), [product catalog](product/README.md). |
| Team | Grouping of a TeamLeader and team-owned members, addressed by `team_name`. |
| TeamLeader | Team-owned agent that coordinates member work. It may claim a free conversation for its own Team through the Channel's own binding tools; nothing is handed to it by Core. |
| TeamMate | Named, semi-resident agent controlled by the dispatcher through the TeamMate MCP. |
| Turn interrupt (`interrupt`) | `AgentRuntime.interrupt` ends the turn a runtime is currently executing and leaves the runtime alive and resumable. Distinct from `stop`, which terminates the runtime process. A runtime with no turn in flight answers `idle` and is never started in order to be interrupted. Owner: [provider-runtime](domains/provider-runtime.md). |
| Work directory | Plain dispatcher-local directory used when TeamMate/Team creation omits a repo object: isolated under `.workspace/work/<name>/` by default, or the dispatcher cwd itself when that dispatcher's workspace policy is disabled. |
| Workspace mode | The one axis behind Work directory, Managed worktree, and `reuse-cwd`: who provides an agent's working directory and whether Dreamux may clean it up. Team-scoped members always borrow the Team's runtime cwd as a `reuse-cwd` loan. Owner: [service-topology](domains/service-topology.md). |
