# @excitedjs/agent-runtime-claude-code

The built-in **Claude Code** Agent Runtime provider for
[Dreamux](https://github.com/excitedjs/dreamux), published behind the stable
`builtin:claude-code` alias.

It implements the public `AgentRuntimeProvider` contract from
[`@excitedjs/dreamux-types`](../../dreamux-types) against a resident `claude`
stream-json child: process supervision, the stream-json wire protocol (line
framing, turn aggregation, control-request replies), per-turn idle-deadline
handling, MCP config translation (`--mcp-config`), teammate completion delivery
as a plain user turn, bounded native transcript pagination, and Claude Code
doctor diagnostics.

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

## Turn lifecycle

The public runtime boundary returns one stable `RuntimeTurn` object for a
logical Claude command set. Inputs merged before session creation and supported
live steering reuse that exact object. Command UUIDs are private wire aliases;
when `msg_lifecycle_v1` is available, all aliases must reach a terminal command
state and a final result must be captured before the object settles. Live steer
fails loudly without that capability. Runtime stop fences queued session work,
terminates the supervised process group with absence proof, and resolves every
unsettled public object as stopped.

Source deduplication is provider-private. A source is reserved while its native
admission is in flight, committed only after acceptance or an ambiguous
post-write failure, and released after a proven pre-write failure. Concurrent
uses of the same reserved source share the same admission outcome. Accordingly,
`failed` means the command was proven not written, while `ambiguous` means a
native write may have been accepted and must not be retried automatically.
Runtime stop synchronously fences new input, releases pending capability/write
waiters, and drains all already-started admission calls before it resolves.

## Native sessions and transcripts

For a fresh runtime this package generates the native UUID before launch,
passes it through Claude Code's `--session-id`, and deterministically derives
the native transcript under
`<CLAUDE_CONFIG_DIR-or-~/.claude>/projects/<project>/<session-id>.jsonl`.
The validated canonical path is persisted with the checkpoint before admission
can be reported. Resume keeps the authoritative native session id and can
rediscover a moved transcript across Claude Code project directories. No
SessionStart Hook, callback process, placeholder file, or auxiliary IPC bridge
is used to discover `transcript_path`.

`readTranscript` is a cold bounded read that never starts a Claude process. It
applies native rewrite lineage, returns completed provider-neutral
message/tool blocks in chronological order, and owns opaque cursors, query and
rewrite mismatch detection, payload redaction/truncation, and the fixed host
output budget. Native command/session IDs and filesystem paths never appear in
transcript pages.
