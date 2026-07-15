# Glossary

Short definitions for overloaded Dreamux terms. Source code remains
authoritative for behavior.

| Term | Meaning |
|---|---|
| Agent Runtime | Provider seam that launches and controls one agent session, regardless of role. Built-ins include `builtin:codex` and `builtin:claude-code`. |
| Channel | Provider seam that connects Dreamux to an external communication surface and owns provider-specific tools and target resolution. |
| Channel provider ref | Config string such as `builtin:feishu` or `npm:<package>#<export>` that resolves through the provider registry. |
| Channel id | Dispatcher-local `dispatchers[].channels[].id`; used to select a configured channel instance. |
| Channel target | Provider-normalized destination/source key used for routing and binding, such as a Feishu group chat target. |
| Task Channel Host | Optional strict Channel capability that durably accepts task attempts, provisions one Team/worktree aggregate, and emits Core-derived execution telemetry without conversational delivery. |
| Host event stream | Per-dispatcher-channel ordered task telemetry stream with stable host identity, monotonic generation/sequence, snapshot/replay, and consecutive-prefix acknowledgement. |
| Dispatcher | Long-lived agent owned by `dreamux serve`; it receives accepted channel input and can call Dreamux MCP tools. |
| Dispatcher Service | Core Dreamux module that owns dispatcher runtime lifecycle, TeamMate lifecycle, Team lifecycle, and channel binding/routing. |
| TeamMate | Named, semi-resident agent controlled by the dispatcher through the TeamMate MCP. |
| Team | Grouping of a TeamLeader and team-owned members, addressed by `team_name`. |
| TeamLeader | Team-owned agent that can receive a bound channel target and coordinate TeamMate/member work. |
| Binding | Core Team MCP state that hands a channel target to a TeamLeader until transferred back. |
| Principal | Caller identity used by core services to scope visibility and permissions, for example dispatcher, team leader, team member, or internal team service. |
| Provider registry | Process-local registry/loader for `agentRuntime` and `channel` providers. |
| MCP shim | Stdio server injected into an agent runtime and forwarding tool calls to Dreamux core or a provider session. |
| Primary channel | First channel declared by a dispatcher; used as the default egress channel when no `channel_id` is provided. |
| Work directory | Plain dispatcher-local directory used when TeamMate/Team creation omits a repo object: isolated under `.workspace/work/<name>/` by default, or the dispatcher cwd itself when that dispatcher's workspace policy is disabled. |
| Managed worktree | Dreamux-created Git worktree under `.workspace/worktree/`, requested by an explicit managed repo object. |
