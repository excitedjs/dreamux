# @excitedjs/agent-runtime-mimo-code

External Dreamux Agent Runtime provider for MiMo Code.

Use it through the existing provider reference grammar:

```json
{
  "agents": [
    {
      "id": "mimo",
      "provider": "npm:@excitedjs/agent-runtime-mimo-code",
      "config": {
        "permission_mode": "deny"
      }
    }
  ]
}
```

This package owns a private `mimo serve` process per Dreamux runtime instance,
binds it to loopback, uses an isolated per-runtime `MIMOCODE_HOME`, disables
MiMo analytics and external/default inheritance flags by default, and submits
normal turns through `POST /session/:sessionID/message`.

`completionInput()` is delivered as plain text and never receives the channel
XML envelope. `channelInput()` remains the only path that renders channel
metadata through Dreamux's neutral channel renderer.

Supported config keys:

- `bin`: MiMo CLI binary, default `mimo`.
- `model`: optional MiMo model selector.
- `agent`: optional MiMo agent selector.
- `extra_env`: string environment map merged after host env. Provider-owned
  isolation and auth variables are applied after it.
- `config_content` or `config_path`: optional operator-provided MiMo-native
  JSON object input. They are mutually exclusive. Dreamux-owned safety fields
  and MCP config are applied after this input.
- `permission_mode`: `deny` by default. `ask` and `auto-approve` are rejected
  until the provider owns a complete MiMo permission response loop.
- `startup_timeout_ms`: wait window for `mimo serve` startup URL discovery.
- `turn_timeout_ms`: bound for turn settlement and busy retry.
- `keep_home`: keep the isolated `MIMOCODE_HOME` after stop for debugging.

Dreamux-supplied MCP servers are authoritative and are written into MiMo's
native `mcp` config shape. Native MiMo MCP keys in this provider config or in
operator-provided native config are rejected so the runtime tool graph cannot be
widened behind Dreamux core.
