# @excitedjs/agent-runtime-claude-code

The built-in **Claude Code** Dreamux plugin, always loaded by
[Dreamux](https://github.com/excitedjs/dreamux). Its default export is the
plugin factory: the plugin contributes the Claude Code `AgentRuntimeProvider`,
published behind the stable `builtin:claude-code` alias.

The provider it contributes implements the public `AgentRuntimeProvider`
contract from
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

Dreamux always loads this package's plugin, which contributes the provider
under `builtin:claude-code` through the neutral plugin `contribute(host)`
hook; core supplies host contracts through the neutral create context.
External callers can construct the bare provider directly, without going
through the plugin:

```ts
import { createClaudeCodeAgentRuntimeProvider } from '@excitedjs/agent-runtime-claude-code';
```

The factory takes no options. Runtime creation uses the neutral create context,
the configured Claude binary, and the package's native session constructor and
session id generator.

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
settle normally once they join it. Command-lifecycle admission is assumed
always supported: there is no capability check, no version gate, and no
single-input fallback mode. Native `cancelled` can describe a hard failure; it
does not imply a user stop. Consumed commands retain their result membership
through terminal lifecycle frames. An unconsumed command that is cancelled,
refused or discarded settles as failed. Every native error result remains
observable, including UUID-less errors and the `success` arm with
`is_error: true` carrying API error text.

A setup error can precede `started` and omit the input UUID. It reports a failed
native end with its error details but cannot identify a queued request. A later
named `cancelled` fails that request with its protocol state; the adapter does not
guess that a preceding unbound error belongs to it.

Core owns source deduplication, captured recipients and completion-token delivery.
The provider owns native admission: `failed` means the command was proven not
written, while `ambiguous` means a native write may have been accepted and must
not be retried automatically. Runtime stop synchronously fences new input,
terminates the supervised process group with absence proof, resolves unsettled
submissions as stopped, and drains already-started admission calls before it
resolves.

## Native sessions and transcripts

For a fresh runtime this package generates the native UUID before launch and
passes it through Claude Code's `--session-id`. The native identity is durably
published before input is written. Resume uses that same authoritative session
id. Recent activity reads locate Claude's native history independently of the
live process; transcript discovery never controls request settlement.

`readRecentActivity` is a cold bounded read that never starts a Claude process.
It returns neutral assistant/tool activity records and provider-owned opaque
cursors. It is not a completion source.

## Native session contract

The native session implements `submit()` returning
`RuntimeAdmission`; accepted submissions carry their own settlement promises.
The old `submitTurn()`/`steerTurn()` window interface is removed. Session specs
provide the pinned `sessionId` and optional `outputSchemaEnabled` result contract;
the exit handler receives its failure cause.

Session implementations own result validation and settlement. Their
`onProtocolEvent` callback reports native activity independently, without
deciding settlement in runtime or Core: `result` events report a turn's
terminal outcome, and an `interrupted` event can report an independently known
interruption boundary. Emitting a callback alone no longer settles a
request. These are breaking changes to the Claude-specific extension seam;
the neutral `AgentRuntime` and `RuntimeSubmission` contracts are unchanged.

## Direct stream RPC consumers

`ClaudeCodeStreamRpc` (package-internal; see `./rpc.ts`, no longer part of the
public barrel) has the same single `submit()` path, returning
`Promise<RuntimeAdmission>` in place of `submitTurn()` and `steerTurn()`. Accepted
handles own eventual settlement; callers no longer await an aggregate window.
Replace `failPending(error)` with `fail(error)` for transport failure or `stop()`
for deliberate teardown. A session retired after an unexpected exit retains
that failure for subsequent admission, even after cleanup calls `stop()`.

`ClaudeCodeStreamRpcOptions` now requires `sessionId` (a pinned native ID or
`null`) and accepts optional `outputSchemaEnabled` for result validation.
`reapOnTimeout(error)` receives the failure `Error`. Protocol callbacks are
observation only, as described above. Parsed `ResultEnvelope` and `TurnOutcome`
also expose `terminalReason`, a string or `null`, for native terminal diagnostics.
Direct RPC consumers follow this same request and settlement contract.

The default adapter uses consumption events because the observed background
folds omit both result UUID echo fields. Claude Code 2.1.263 marks
`command_lifecycle` as internal; it is not a documented stable SDK contract.
Compatibility tests and real native captures are distinguished in the task's
verification record.
