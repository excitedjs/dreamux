# @excitedjs/agent-runtime-claude-code

The built-in **Claude Code** Agent Runtime provider for
[Dreamux](https://github.com/excitedjs/dreamux), published behind the stable
`builtin:claude-code` alias.

It implements the public `AgentRuntimeProvider` contract from
[`@excitedjs/dreamux-types`](../../dreamux-types) against a resident `claude`
stream-json child: process supervision, the stream-json wire protocol (line
framing, turn aggregation, control-request replies), per-turn idle-deadline
handling, MCP config translation (`--mcp-config`), teammate completion delivery
as a plain user turn, and Claude Code doctor diagnostics.

## Boundary

This package depends on `@excitedjs/dreamux-types` **only**. It never imports
`@excitedjs/dreamux` core. Everything host-specific — per-dispatcher paths, the
durable state sink, the process `PATH` seeded from the host package bins — is
supplied by the Dreamux host through the neutral `AgentRuntimeCreateContext` and
the provider factory options. The package owns only Claude Code engine mechanics
and its own runtime config parsing; it reconstructs no Dreamux host
layout/path/log contracts. Generic OS/validation/turn helpers it needs are
vendored under `src/internal/`.

## Loading

Dreamux core resolves `builtin:claude-code` to this package and constructs the
provider through its own core-owned adapter, which maps core's host-shaped create
context onto the neutral one and supplies the host contracts. The package also
default-exports a generic provider-loader factory, so
`loadExternalAgentRuntimeProviders({ refs: ['builtin:claude-code'] })` can load it
through the same package-loader path as external `npm:` providers.
