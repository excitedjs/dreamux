# Agent Runtime providers

- **Status:** Accepted
- **Date:** 2026-06-06
- **Affects:** dispatcher runtime, Codex integration, Claude Code integration,
  MCP injection, TeamMate completion delivery
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110)

## Context

The current dispatcher runtime is Codex-specific. It starts a Codex app-server
child, performs the Codex handshake, owns one Codex thread, injects Feishu MCP
configuration, and submits accepted inbound messages as Codex turns.

Issue #110 makes Agent Runtime providerization part of the Epic. The confirmed
builtin runtimes are `builtin:codex` and `builtin:claude-code`. Claude Code is
not optional: without it, the abstraction could collapse into a Codex rename.

## Decision

Introduce an `AgentRuntimeProvider` architecture with builtin providers for:

- `builtin:codex`;
- `builtin:claude-code`.

The provider contract must cover:

- start, resume, stop, and health reporting;
- runtime-owned config validation;
- Dreamux MCP injection;
- inbound dispatcher turn submission;
- runtime-specific TeamMate completion delivery.

Dreamux injects only these MCP surfaces:

- Channel provider MCP descriptors;
- Dispatcher Service TeamMate scheduling MCP descriptors.

Other MCP servers remain user-configured directly in the selected Agent Runtime.
Dreamux core must not absorb arbitrary user MCP configuration into its own
config or registry.

The completion-delivery side of the interface must be shaped for both confirmed
runtimes before either implementation becomes the hidden default:

- Codex delivery uses an inbox plus a turn trigger.
- Claude Code delivery uses a task notification path.

The provider receives a Dispatcher Service completion envelope and owns the
runtime-specific mechanics that make the dispatcher observe it.

TeamMate completion delivery must align with the per-dispatcher state owner
before the delivery implementation lands. The delivery path must not be coupled
to transient turn-manager state that is expected to move into a dispatcher-level
state owner.

Implementation status:

- `builtin:codex` is wired through an `AgentRuntimeProvider` catalog. The
  server selects the provider from `dispatchers[].runtime.provider`, passes
  Dreamux-owned MCP server descriptors into it, and the Codex provider maps
  those descriptors to Codex `mcp_servers.*` CLI configuration before creating
  the Codex-backed dispatcher runtime.
- `builtin:claude-code` is wired through the same `AgentRuntimeProvider`
  catalog (#110 PR6). It is a real second runtime, not a Codex rename: it owns
  its own config shape (`DispatcherClaudeCodeConfig`), translates the
  Dreamux-owned MCP descriptors into Claude Code's JSON MCP config
  (`--mcp-config`) rather than Codex `mcp_servers.*` TOML flags, and runs a turn
  per headless `claude --print` invocation (no app-server, handshake, or restart
  loop). Process spawning is behind an injectable turn-runner seam; a missing
  `claude` binary fails loudly on the first turn, and a live contract test is
  opt-in via `DREAMUX_RUN_LIVE_CLAUDE_CODE` (loud skip otherwise, never silent).
- The shared interface already includes both confirmed TeamMate completion
  delivery shapes: Codex inbox-and-turn delivery and Claude Code task
  notification delivery. PR6 declares the `claudeCodeTaskNotification`
  capability and provides the runtime's delivery entry point; the executable
  completion delivery loop (ledger, retry, pull fallback) still belongs to the
  later server-hosted TeamMate PRs.

## Consequences

- The Codex adapter can preserve today's behavior while no longer defining the
  shape of every runtime.
- Claude Code work can proceed without changing Channel provider or TeamMate
  ledger contracts.
- Runtime-specific delivery failures can be reported back to Dispatcher Service,
  which owns retry and result retrieval.
- Codex auth, config, and memory remain under Codex's normal ownership. Dreamux
  must not create dispatcher-private Codex homes unless a later decision
  supersedes this one.

## Alternatives considered

- **Codex-only runtime interface first:** rejected because it would force Claude
  Code to retrofit delivery semantics later.
- **Put TeamMate completion delivery in Channel providers:** rejected. The
  completion is dispatcher context delivery, not channel outbound.
- **Let Dreamux own all user MCP configuration:** rejected. Dreamux only owns
  MCP surfaces it injects for its own channel and TeamMate capabilities.
