# MCP Protocol Conformance

- **Status:** Proposed
- **Date:** 2026-08-13
- **Baseline:** `6204d719cd0e1306af62380492fe5793b43a448b`
- **Affects:** `/packages/dreamux/src/mcp/`, `/packages/dreamux-types/src/channel.ts`, `/packages/channel/feishu-channel/src/tools/`, MCP descriptor assembly, and MCP protocol tests

## Intent

Replace Dreamux's five hand-written stdio JSON-RPC implementations with one
official-SDK-backed MCP server capability. Dreamux must expose its existing
model-facing TeamMate, Team, channel, cron, and collaboration-space tools as
standards-conforming MCP tools, while the admin socket remains the independent
product control-plane boundary.

The protocol implementation must follow the official MCP specification rather
than preserve accidental behavior for a particular client. Dreamux supports
exactly the official revisions `2025-06-18`, `2025-11-25`, and `2026-07-28`
through the official SDK's dual-era serving mode. Earlier revisions, malformed
traffic, invented revisions, and client-specific deviations do not receive
compatibility shims.

## Source Findings

Dreamux currently implements MCP framing independently in:

- `/packages/dreamux/src/mcp/teammate-mcp.ts`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/mcp/cron-mcp.ts`
- `/packages/dreamux/src/mcp/collaboration-space-mcp.ts`

That duplication has already produced observable protocol drift:

- the shims implement only the legacy `initialize`, `tools/list`, and
  `tools/call` flow and do not implement the 2026 `server/discover` and
  per-request metadata model;
- protocol negotiation is inconsistent: two shims manually accept selected
  revisions while three always return `2024-11-05`;
- unknown tools are converted into successful JSON-RPC responses carrying
  `isError: true` instead of the protocol-level error required by MCP;
- advertised `inputSchema` constraints and handler validation are separate
  implementations, so length, range, pattern, additional-property, and enum
  constraints can diverge;
- tools do not advertise `outputSchema`, and successful result text is a
  generic forwarding acknowledgement rather than the serialized structured
  result recommended for clients that consume only content blocks;
- `/packages/dreamux/src/mcp/task-dispatch-reminder.ts` inserts model guidance
  into `structuredContent`, so structured output is not a pure domain result;
- provider-owned channel tool descriptors cannot express output schemas or
  standard tool metadata through `/packages/dreamux-types/src/channel.ts`;
- five copies of protocol framing, error projection, and tool registration
  make future protocol upgrades an all-or-nothing synchronization risk.

The admin control plane is not the protocol defect. Its canonical methods in
`/packages/dreamux/src/admin/methods.ts` return normal JavaScript values and
enforce product authorization and descriptor-bound scope. MCP must remain an
adapter over that boundary rather than move MCP semantics into admin handlers.

## Standards Baseline

The normative target is the official MCP revisions `2025-06-18`,
`2025-11-25`, and `2026-07-28`, plus the official TypeScript SDK packages that
implement them:

- [MCP 2026-07-28 tool specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP 2026-07-28 version negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2026-07-28 stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [MCP 2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP 2025-06-18 tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Official TypeScript SDK server tool guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/servers/tools.md)
- [Official TypeScript SDK 2026 support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/support-2026-07-28.md)

The implementation uses `@modelcontextprotocol/server` rather than the legacy
aggregate `@modelcontextprotocol/sdk` package. Protocol parsing, schema
validation, version negotiation, modern result envelopes, discovery, request
cancellation, and JSON-RPC error framing belong to the SDK.

The selected `@modelcontextprotocol/server` runtime dependency and
`@modelcontextprotocol/client` test dependency must be the same exact official
release, without `^`, `~`, tag, Git, preview-registry, or fork references. The
selected release must include a complete initialization lifecycle gate: on a
connection-scoped non-HTTP legacy server, requests other than `initialize` and
`ping` fail until the server has both completed `initialize` and received
`notifications/initialized`. [Official TypeScript SDK PR #2122](https://github.com/modelcontextprotocol/typescript-sdk/pull/2122)
identifies the same defect, but its head at
`18fd2a3c4ac7acb51422072484544eb2039ec46d` is not sufficient: it gates only
until the negotiated protocol version is set while processing `initialize`, so
the interval between the initialize response and
`notifications/initialized` remains open. A selectable release must close that
interval as well.

Official release `2.0.0` is not selectable because its dual-era stdio entry
classifies a claim-less opening as legacy and serves pre-initialize
`tools/list`. Dreamux does not compensate with a transport wrapper, prototype
patch, fork, vendored SDK, private registry build, or hand-written JSON-RPC
lifecycle gate. Implementation cannot satisfy this specification until an
official release contains the complete behavior; the exact selected version is
then recorded in the package manifest and lockfile.

## Client Baseline Verification

The production Agent Runtime clients were inspected on 2026-08-13 before
selecting the revision floor:

- Codex CLI `0.147.0` opened with a standards-conforming `2025-06-18`
  `initialize` request and sent `notifications/initialized`;
- Claude Code `2.1.229` first sent a `2026-07-28` `server/discover` probe, then
  fell back to a standards-conforming `2025-11-25` initialization when the
  hand-written Dreamux shim did not support discovery; and
- neither runtime sent the non-standard bare `initialized` method accepted by
  the current shims.

The replacement must include live gates for the installed Codex and Claude Code
clients. A future runtime that cannot negotiate one of the three supported
revisions fails visibly through runtime diagnosis or startup; protocol-version
fields do not leak into the neutral `AgentRuntimeMcpServer` descriptor.

## Protocol Posture

Dreamux serves both official protocol eras from one tool definition graph:

- modern traffic uses the `2026-07-28` per-request metadata protocol and
  `server/discover` behavior provided by the SDK;
- legacy traffic uses only `2025-11-25` and `2025-06-18` through the SDK's
  official initialization handshake;
- every `McpServer` is constructed with `supportedProtocolVersions` set, in
  order, to `2026-07-28`, `2025-11-25`, and `2025-06-18` rather than the SDK's
  broader default list;
- an earlier legacy revision is not negotiated: the SDK returns its preferred
  supported legacy revision, `2025-11-25`, as the legacy specification
  requires, and a client that cannot use it must disconnect;
- an unsupported modern revision receives the SDK's `-32022` response with the
  supported modern revision list;
- a connection is pinned to one era by the official stdio serving entry and
  cannot switch eras later;
- on a legacy connection, only `initialize` and `ping` are callable until a
  successful `initialize` is followed by `notifications/initialized`;
  `tools/list` and `tools/call` receive the official SDK's invalid-request
  failure both before `initialize` and after its response but before the
  notification;
- no Dreamux code hand-writes or post-processes JSON-RPC envelopes, protocol
  version fields, modern `resultType`, discovery results, or cancellation
  responses.

Dual-era serving is standards compliance, not a client workaround. Dreamux does
not retain the SDK's earlier legacy revisions, its current unconditional
`2024-11-05` fallback, or the non-standard bare `initialized` notification.
An official SDK upgrade is accepted only when its discovery and negotiation
tests still advertise and negotiate exactly the three revisions above. A newly
added SDK-global modern revision remains unsupported until this contract is
deliberately revised.

## Shared MCP Server Capability

`/packages/dreamux/src/mcp/server.ts` becomes the sole stdio MCP transport and
registration owner. It receives only a server identity, already caller-bound
tool definitions and handler closures, an optional injected transport, EOF
lifecycle options, and an out-of-band logger. It does not import admin,
service, Channel provider, or caller-scope types.

It constructs a fresh official `McpServer` for the protocol era selected by
`serveStdio`, registers every tool from the same catalog, and calls
`serveStdio(buildMcpServer, { legacy: 'serve', transport })` explicitly. The
default transport is the official `StdioServerTransport`; tests may inject an
official linked in-memory transport or a `StdioServerTransport` over custom
streams. `serveStdio` alone owns the transport, so the runner does not also call
`server.connect()`. The runner owns input-end shutdown for custom streams so
tests and embedded callers can deterministically await completion. Only valid
MCP frames are written to stdout; operational diagnostics go through the
supplied logger and therefore to stderr or Dreamux log files.

Each domain MCP module owns only:

- its caller-specific tool visibility;
- model-facing names, titles, descriptions, annotations, and schemas;
- mapping validated tool arguments to canonical admin methods;
- descriptor-bound scope fields that the model cannot override; and
- projection of admin/domain failures into tool execution errors.

The existing five CLI commands and separate descriptor-scoped processes remain.
They provide tool visibility and capability isolation for dispatcher,
TeamLeader, channel, and scheduler scopes. Core and admin authorization remains
authoritative; a child-process boundary is not treated as an authorization
check. The refactor shares protocol machinery without merging caller scopes
into one broad server.

## Tool Contract

Every Dreamux-owned tool definition includes:

- a stable machine `name`;
- a human-facing `title`;
- a concise `description` that states the operation's actual completion point;
- a closed `inputSchema`;
- an `outputSchema` for its canonical successful public result;
- standard `annotations` that conservatively describe read-only and destructive
  behavior; and
- one handler that receives SDK-validated arguments.

Schemas remain JSON Schema as the neutral descriptor representation. The MCP
server wraps them through the SDK's `fromJsonSchema` adapter, so the same schema
is used for advertisement and runtime validation. Within an MCP adapter, that
advertised schema is the single validator for model-facing field shape.
Separate MCP-local parsers for ordinary field constraints are removed.

Admin handlers and Channel provider handlers remain independently authoritative
validators for their separately callable control-plane boundaries. That is not
duplicate MCP validation, and no SDK-parsed type or "already validated" trust
flag crosses the admin socket. Provider parsing remains as the typed boundary
for calls that can arrive through admin without MCP; it may also enforce
cross-field, target, or platform rules that JSON Schema cannot express.

Each Dreamux-owned tool keeps its output schema beside an explicit success
projector. The projector selects and constructs the canonical MCP result from
the admin value instead of blindly exposing an open admin DTO; additional admin
fields therefore do not break MCP output validation. Top-level output objects
are closed unless the tool intentionally exposes a JSON-valued extension field,
such as a workflow result, in which case that field's openness is explicit.
Submission-receipt projectors and their schemas are load-bearing: a mismatch
must be caught by tests before a side-effecting handler can report failure after
Dreamux has already accepted the operation.

Tool order is deterministic. Caller-specific visibility is determined before
registration, so an unavailable tool is absent from `tools/list` and calling
it produces the SDK's protocol-level unknown-tool error.

## Successful Results

Successful object results use both standard result channels:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"status\":\"submitted\",\"turn_id\":\"turn-1\"}"
    }
  ],
  "structuredContent": {
    "status": "submitted",
    "turn_id": "turn-1"
  }
}
```

`structuredContent` is the exact public domain value validated against the
advertised `outputSchema`. The first text block is `JSON.stringify` of that
same value for model and legacy-client compatibility. It is not a generic
"forwarded" acknowledgement and is not a JSON string nested inside
`structuredContent`.

Model guidance is not business data. The general no-polling and
completion-delivery rule remains owned by the dispatcher and TeamLeader role
system prompts. Relevant tool descriptions state only the operation's actual
completion point. The dynamic reminder implementation in
`/packages/dreamux/src/mcp/task-dispatch-reminder.ts` is removed from both text
and `structuredContent`; the rule is not copied into MCP server instructions.

## Error Contract

The SDK owns protocol errors, including parse errors, invalid JSON-RPC
requests, unsupported methods, malformed `tools/call` request envelopes,
unknown or unavailable tools, unsupported modern revisions, and invalid modern
request metadata. Input-schema validation for a known registered tool follows
the official SDK behavior and returns a normal `CallToolResult` with
`isError: true`; it is not rewritten into a JSON-RPC error.

One MCP-adapter-owned execution projector catches failures from the canonical
admin call or a domain/caller rule evaluated after valid schema input. Each
domain MCP adapter maps an explicit allowlist of safe public errors by admin
method and error code into an MCP-local public tool error. The shared executor
formats only errors already marked public by that adapter; it does not import
or recognize `AdminClientError`. `INTERNAL`, catch-all `*_FAILED` errors, and
every unmapped admin or provider code/message are logged in full out of band
and become a fixed sanitized tool error with no `structuredContent`. Handler
exceptions are never left for the SDK to expose through raw `Error.message`
text.

Cancellation stops protocol response work according to the SDK contract. It
does not imply rollback of a Dreamux operation that was already durably
accepted by its owning service and does not unregister completion delivery for
an already submitted turn.

## Channel Provider Boundary

`/packages/dreamux-types/src/channel.ts` owns a runtime-neutral, JSON-compatible
structural MCP tool descriptor. It does not import any `@modelcontextprotocol/*`
package, but its descriptor can carry the standard metadata used by the generic
channel MCP server:

- `name`, `title`, `description`;
- `inputSchema`, `outputSchema`;
- `annotations` and optional standard presentation metadata.

`inputSchema` is a JSON Schema object. `outputSchema` is optional at the neutral
provider seam because MCP itself permits its omission and existing external
providers must remain loadable. When present, the shared server advertises it
and validates the result. Built-in Channel providers must supply one for every
tool.

The built-in Feishu provider replaces its generic open result envelope with one
canonical public result per tool:

- `reply` returns `{ message_ids: string[] }`;
- `react` returns `{ reaction_id: string }`; and
- `list_chat_bots` returns `{ chat_id, known, trusted }` identically from live
  and sessionless execution.

The Feishu provider owns platform-specific schemas, target parsing, execution,
and these per-tool public results. Core owns dispatcher/Team scope, channel
selection, TeamLeader egress authorization, and the admin conduit.

Dreamux core continues to forward raw provider arguments through
`channel.invoke_tool`. Core neither names Feishu tools nor interprets their
provider-specific result fields. Provider handlers independently validate those
arguments at the admin boundary. The shared MCP server validates a returned
value against the provider-supplied output schema before emitting it.

Descriptor assembly validates every provider tool catalog before encoding it:
descriptor shape, unique names, JSON serialization, JSON Schema object shape,
and SDK schema registration must fail loud. The `channel-mcp` CLI likewise
fails when `--channel-tools-b64` is missing, malformed, or does not decode to a
valid non-empty catalog; it never silently substitutes an empty tool list.

Rush change files cover the public metadata/result changes in
`@excitedjs/dreamux`, `@excitedjs/dreamux-types`, and
`@excitedjs/feishu-channel`. Only `@excitedjs/dreamux` gains the
`@modelcontextprotocol/server` runtime dependency and the matching
`@modelcontextprotocol/client` development dependency. Both are exact versions.

## Submitted Work And MCP Tasks

`teammate.spawn`, `teammate.send`, `team.create`, `team.send`, and
`workflow_run` complete when Dreamux has accepted or submitted the requested
work and can return its durable or runtime-native receipt. Their tool result is
that submission receipt. The later agent or workflow completion is a separate
Dreamux lifecycle event delivered through the existing completion router and
runtime-native input injection, not an unsolicited server-to-client MCP
message.

The MCP Tasks extension is therefore not used to pretend that one of these
submission calls remains incomplete. Tasks become relevant only if Dreamux
later adds an MCP operation whose own result is the eventual downstream agent
result and whose lifecycle is exposed through the Tasks methods. Such a change
requires a separate contract because it changes cancellation, retention,
polling, and result-ownership semantics.

## Test Contract

The repeated `JsonLineReader` harness is implementation machinery for the
hand-written shim and may be deleted. Replacement tests use the official v2
`Client` and `InMemoryTransport.createLinkedPair()` against `serveStdio` with
an injected transport for both pinned modern and legacy protocol cases. Separate
`StdioServerTransport` custom-stream or child-process tests cover EOF shutdown
and stdout purity. No test recreates protocol parsing or response framing.

The replacement suite must cover:

- modern `2026-07-28` discovery and per-request metadata handling;
- successful negotiation and calls at `2025-11-25` and `2025-06-18`;
- a `2024-11-05` initialize request receiving the preferred supported legacy
  counter-offer rather than negotiating the old revision;
- unsupported modern-version rejection with `-32022`;
- rejection or non-recognition of the non-standard bare `initialized` method;
- rejection of `tools/list` and `tools/call` before `initialize`;
- rejection of both methods after a successful initialize response but before
  `notifications/initialized`, followed by successful listing and invocation
  only after that notification on the same standards-conforming connection;
- discovery advertising only `2026-07-28`, including after every SDK upgrade;
- deterministic caller-specific `tools/list` results;
- advertised input and output schemas plus runtime validation;
- object-valued `structuredContent` with equivalent serialized JSON text;
- protocol error versus `isError` separation;
- no reminder or other model guidance inside structured output;
- provider-owned channel descriptors and result validation;
- descriptor-bound dispatcher, Team, TeamLeader, channel, and cron authority;
- custom-stream EOF shutdown and stdout purity; and
- cancellation behavior without rollback of already accepted domain work.

Existing tests that protect role visibility, name/address contracts, channel
target authority, clean-worktree dissolve acceptance, and other product
invariants remain load-bearing. They may be rewritten to use the shared test
harness, but their assertions must not be weakened merely because the
transport implementation changed. In particular, the exact tool/field and
provider-neutral wording gates in
`/packages/dreamux/tests/mcp-contract-whitelist.test.ts` must be migrated, not
deleted. The old unknown-version-to-`2024-11-05` assertion in
`/packages/dreamux/tests/teammate-mcp.test.ts` is intentionally replaced by the
three-revision negotiation gates; the `2025-06-18` E2E assertion remains but
moves through the official SDK harness.

## Scope

The change includes:

- the official SDK dependency and one shared stdio MCP server capability;
- migration of all five Dreamux MCP modules to shared registration and result
  projection;
- complete Dreamux-owned tool metadata and successful-result schemas;
- expansion of the neutral Channel provider descriptor and built-in Feishu
  descriptors;
- removal of duplicated hand-written protocol code and structured reminder
  mutation;
- protocol-conformance and preserved product-contract tests;
- current architecture and provider-boundary documentation in
  `.agents/reference/current-architecture.md`,
  `.agents/reference/repo-structure.md`,
  `.agents/reference/state-and-paths.md`,
  `.agents/reference/channel-runtime.md`,
  `.agents/reference/model-facing-writing.md`,
  `.agents/reference/scheduled-tasks.md`,
  `.agents/domains/dispatcher-orchestration.md`, and
  `.agents/domains/channel-routing-and-binding.md`; and
- required Rush change files.

## Hard Constraints

- The admin socket remains MCP-agnostic. Do not add MCP envelopes, SDK types,
  content blocks, protocol versions, or tool metadata to
  `/packages/dreamux/src/admin/`.
- The neutral `ChannelProvider` seam does not import any
  `@modelcontextprotocol/*` SDK package.
- Agent Runtime providers continue to receive MCP server descriptors and do
  not own Dreamux tool definitions or result projection.
- Descriptor-bound authority is applied after validated model input and cannot
  be overridden by additional properties.
- Do not retain fallback JSON-RPC parsing, version negotiation, or response
  construction beside the official SDK.
- Do not preserve generic forwarding acknowledgement text or guidance fields
  in structured output for compatibility.
- Do not delete or weaken domain and lifecycle tests whose assertions remain
  valid after the transport replacement.
- Package source continues to obey the repository's asynchronous-I/O and
  runtime-dependency rules.

## Out Of Scope

- changing admin method names, envelopes, timeout semantics, or result DTOs;
- combining the five scoped MCP processes into one server with a broader tool
  surface;
- adding HTTP/SSE/Streamable HTTP transport;
- introducing MCP resources, prompts, elicitation, sampling, or Tasks;
- changing Team, TeamMate, workflow, scheduler, collaboration-space, or
  Channel business behavior; and
- client-specific workarounds for hosts that do not implement an official MCP
  revision.

## Acceptance

The proposal is complete when:

- no Dreamux MCP module hand-writes JSON-RPC parsing, negotiation, framing, or
  protocol errors;
- all five scoped MCP entries use the same official-SDK-backed server runner;
- standards-conforming clients at exactly `2026-07-28`, `2025-11-25`, and
  `2025-06-18` can list and call the appropriate tools, while older legacy
  revisions are not negotiated;
- unknown tools and malformed protocol traffic fail through official protocol
  errors, known-tool schema failures use the SDK's `isError` result, and
  admin/domain failures remain sanitized tool execution errors;
- every successful tool call returns structured JSON plus equivalent JSON text
  and passes its advertised output schema;
- Feishu channel tools use the same structured result contract through the
  neutral provider descriptor;
- no model guidance contaminates structured output;
- installed Codex and Claude Code clients pass live MCP connection gates;
- product authorization and lifecycle invariants remain at least as strong as
  the baseline;
- Rush build, lint, test, built CLI smoke, and `.agents/scripts/check.sh` pass;
  and
- the exact implementation head is approved by the resident architecture,
  lifecycle, and complexity reviewers.
