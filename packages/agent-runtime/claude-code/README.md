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

The public runtime boundary returns one `RuntimeSubmission` handle per accepted
send. Each native result creates one immutable `RuntimeCompletion` shared by the
submissions it answers. Folded inputs share that completion object; queued inputs
wait for their own result. RPC derives the answered command group from started
commands and matching result UUID evidence. Request-window drainage separately
waits for terminal lifecycle states and the attributed results.

Background native turns may run without a submission. Their activity and result
boundaries remain observable, but they settle no unrelated request and do not
terminate the resident process. Explicit inputs steered into a background turn
settle normally once they join it. Live steering fails loudly without
`msg_lifecycle_v1`; lifecycle-less sessions retain single-input compatibility.

Core owns source deduplication, captured recipients and completion-token delivery.
The provider owns native admission: `failed` means the command was proven not
written, while `ambiguous` means a native write may have been accepted and must
not be retried automatically. Runtime stop synchronously fences new input,
releases pending capability/write waiters, terminates the supervised process
group with absence proof, resolves unsettled submissions as stopped, and drains
already-started admission calls before it resolves.

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

## Custom session factories

A custom `ClaudeCodeSessionFactory` that emits `onProtocolEvent` results must
include `commandUuids`: the submitted commands answered by that result. Use an
empty array for a native turn with no related submission. Folded inputs share
one result and its command group; a queued input is included only in the result
that answers it. The default session computes this group from native command
lifecycle and matching result UUID evidence. The turn's original trigger does
not decide completion delivery. This Claude-specific callback requirement does
not change the neutral `AgentRuntime` or `RuntimeSubmission` contracts.
