# @excitedjs/agent-runtime-claude-code

The built-in **Claude Code** Agent Runtime provider for
[Dreamux](https://github.com/excitedjs/dreamux), published behind the stable
`builtin:claude-code` alias.

It implements the public `AgentRuntimeProvider` contract from
[`@excitedjs/dreamux-types`](../../dreamux-types) against a resident `claude`
stream-json child: process supervision, the stream-json wire protocol (line
framing, result aggregation, control-request replies), pending-request idle
deadlines, MCP config translation (`--mcp-config`), teammate completion delivery
as a plain user turn, bounded native transcript pagination, and Claude Code
doctor diagnostics.

## Boundary

This package uses `@excitedjs/dreamux-types` and shared `@excitedjs/dreamux-utils`.
It never imports
`@excitedjs/dreamux` core. Everything host-specific — per-dispatcher paths, the
durable state sink, the process `PATH` seeded from the host package bins — is
supplied by the Dreamux host through the neutral `AgentRuntimeCreateContext` and
the provider factory options. The package owns only Claude Code engine mechanics
and its own runtime config parsing; it reconstructs no Dreamux host
layout/path/log contracts. Shared process supervision and state-write fencing
come from `@excitedjs/dreamux-utils`.

## Loading

Dreamux core resolves `builtin:claude-code` through the generic provider loader
and supplies host contracts through the neutral create context. The package
default-exports that provider factory, so
`loadExternalAgentRuntimeProviders({ refs: ['builtin:claude-code'] })` can load it
through the same package-loader path as external `npm:` providers.

## Resident session and request settlement

The public runtime boundary returns one `RuntimeSubmission` handle per accepted
send. Every input follows the same native write path; admission resolves after
write acknowledgement or positive native evidence. RPC holds one table of
unanswered requests and settles them directly from native results or command
cancellation/refusal. There is no enclosing request window or aggregate drainage.

A native result answering requests creates one immutable `RuntimeCompletion`
shared by those requests. Folded inputs share that object; queued inputs wait
for their own result. Consumption lifecycle and a matching submitted result UUID
are positive attribution evidence. A completed lifecycle frame may precede or
follow its result and does not decide when another input can be submitted.

Background native turns may run without a submission. Their activity and result
boundaries remain observable, but they settle no unrelated request and do not
terminate the resident process. Explicit inputs steered into a background turn
settle normally once they join it. Concurrent input requires lifecycle evidence;
sessions without it retain single-input compatibility. Native cancellation
settles the affected request as stopped, and refusal/discard settles it as failed.

Core owns source deduplication, captured recipients and completion-token delivery.
The provider owns native admission: `failed` means the command was proven not
written, while `ambiguous` means a native write may have been accepted and must
not be retried automatically. Runtime stop synchronously fences new input,
releases pending capability/write waiters, terminates the supervised process
group with absence proof, resolves unsettled submissions as stopped, and drains
already-started admission calls before it resolves.

## Native sessions and transcripts

For a fresh runtime this package generates the native UUID before launch and
passes it through Claude Code's `--session-id`. The native identity is durably
published before input is written. Resume uses that same authoritative session
id. Recent activity reads locate Claude's native history independently of the
live process; transcript discovery never controls request settlement.

`readRecentActivity` is a cold bounded read that never starts a Claude process.
It returns neutral assistant/tool activity records and provider-owned opaque
cursors. It is not a completion source.

## Custom session factories

A custom `ClaudeCodeSessionFactory` now implements `submit()` returning
`RuntimeAdmission`; accepted submissions carry their own settlement promises.
The old `submitTurn()`/`steerTurn()` window interface is removed. Session specs
provide the pinned `sessionId` and optional `outputSchemaEnabled` result contract;
the exit handler receives its failure cause.

Session implementations own result validation and settlement. Their
`onProtocolEvent` callback reports native activity independently: result events
retain `commandUuids` for observation, and an `interrupted` event reports a
native cancellation boundary. Emitting a callback alone no longer settles a
request. These are breaking changes to the Claude-specific extension seam;
the neutral `AgentRuntime` and `RuntimeSubmission` contracts are unchanged.

The default adapter uses consumption events because the observed background
folds omit both result UUID echo fields. Claude Code 2.1.263 marks
`command_lifecycle` as internal; it is not a documented stable SDK contract.
Compatibility tests and real native captures are distinguished in the task's
verification record.
