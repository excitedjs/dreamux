# @excitedjs/agent-runtime-kimi-code

External Dreamux Agent Runtime provider for Kimi Code.

This package implements the public `AgentRuntimeProvider` contract from
`@excitedjs/dreamux-types` by supervising the public `kimi acp` stdio server.
It is intentionally an `npm:` provider rather than a Dreamux builtin while Kimi
Code's public integration surface is ACP-only and its TypeScript SDK remains
unpublished.

Example config:

```json
{
  "agents": [
    {
      "id": "kimi",
      "provider": "npm:@excitedjs/agent-runtime-kimi-code",
      "config": {}
    }
  ]
}
```

The first implementation supports resident ACP sessions, plain text
`completionInput`, channel-rendered `channelInput`, MCP stdio injection, and
resume checkpoint mapping. Dreamux append-only system prompt fragments are
materialized into a runtime-owned `KIMI_CODE_HOME/AGENTS.md`, and Dreamux skill
sources are linked under `KIMI_CODE_HOME/skills`. Kimi Code system prompt
replacement is not supported because the public `kimi acp` CLI does not
currently expose that hook.
