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

`transport` accepts `tmux` or `acp`. `model` and `effort`, when set, accept any
non-empty string and pass through to the native CLI or ACP session options. The
provider never falls back to the other transport. Both transports launch with
`--dangerously-skip-permissions` without setting `--sandbox`, and ACP cancels
unexpected `session/request_permission` callbacks fail-fast.

Both transports use agy's default agent, not a generated custom-agent. ACP
receives prompt append and MCP descriptors natively; tmux discovers Core-provided
rules, skills, and MCP configuration from a provider-cache `.agents` directory
through `--add-dir`. These additions preserve the user's existing native
customizations and never write user skill directories. Native `disabledTools`
is not emulated or blocked.

Both transports restore Core's opaque native conversation id exactly. ACP
publishes a fresh id during start; default TUI conversations can be lazy, so a
fresh tmux runtime publishes its real id on first input before confirming native
admission. The native full transcript supplies live evidence and bounded cold
activity reads.

The neutral `outputSchema` capability is unsupported and fails at runtime
creation with `UnsupportedAgentRuntimeFeatureError`; no prompt-only emulation or
transport fallback is used.

## Boundary

This package depends on `@excitedjs/dreamux-types`,
`@excitedjs/dreamux-utils`, and the ACP SDK. It never imports Dreamux Core.
Core supplies the workspace, role identity, system instructions, MCP servers,
skill sources, state/event sinks, logs, and volatile runtime directories through
the neutral provider contracts.
