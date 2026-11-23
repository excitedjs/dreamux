# @excitedjs/agent-runtime-antigravity

External [Dreamux](https://github.com/excitedjs/dreamux) Agent Runtime provider
for Google Antigravity CLI (`agy`). The default export is the neutral provider
factory for `npm:@excitedjs/agent-runtime-antigravity`.

One provider supports two config-selected transports:

- `tmux` (default): drives the native agy TUI in a private tmux server. It
  requires a Unix platform and tmux.
- `acp`: keeps one resident ACP v1 session over the official
  `@agentclientprotocol/sdk` client and a directly supervised agy child.

The provider requires agy 1.5.15 or later. Authentication belongs to the
operator's existing agy installation: Dreamux does not implement Antigravity
OAuth, login, account pools, or rotation.

## Configuration

```json
{
  "id": "antigravity",
  "provider": "npm:@excitedjs/agent-runtime-antigravity",
  "config": {
    "transport": "tmux",
    "bin": "agy",
    "model": null,
    "effort": null,
    "extra_args": [],
    "extra_env": {}
  }
}
```

`transport` accepts `tmux` or `acp`. `effort`, when set, accepts `low`,
`medium`, `high`, `xhigh`, or `max`. The provider never falls back to the other
transport.

Both transports restore Core's opaque native conversation id exactly. A stable
Dreamux-managed native role is materialized under `~/.gemini/config/agents/`
so agy resume reloads the same role, system instructions, skills, and applicable
MCP configuration. The native full transcript supplies live evidence and bounded
cold activity reads.

The neutral `outputSchema` capability is unsupported and fails at runtime
creation with `UnsupportedAgentRuntimeFeatureError`; no prompt-only emulation or
transport fallback is used.

## Boundary

This package depends on `@excitedjs/dreamux-types`,
`@excitedjs/dreamux-utils`, and the ACP SDK. It never imports Dreamux Core.
Core supplies the workspace, role identity, system instructions, MCP servers,
skill sources, state/event sinks, logs, and volatile runtime directories through
the neutral provider contracts.
