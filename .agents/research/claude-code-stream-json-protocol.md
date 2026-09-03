# Claude Code stream-json: what the wire carries, and what Dreamux reads

> **Frozen investigation snapshot (2026-09-03).** Evidence behind the ruling
> that a Claude Code `user` envelope is never displayed
> ([split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/requirement.md)).
> Do not update the body; the current facts live in
> [provider-runtime](/.agents/domains/provider-runtime.md).

**Question.** A TeamLeader on Claude Code loaded three skills and each
SKILL.md body appeared on its Feishu COT card as long markdown. What does the
CLI actually emit on stdout under `--output-format stream-json`, how does the
runtime read it, and where do the two disagree?

**Method.** Three sources, weighed in this order:

1. A live probe of the installed CLI (2.1.259): `claude -p --output-format
   stream-json --verbose --allowedTools=Skill` asked to load `team-workflow`
   from the same skills cache the daemon uses.
2. The published SDK wrapper of the same release,
   `@anthropic-ai/claude-agent-sdk@0.3.259` — `sdk.d.ts` (the typed stdout and
   stdin contract) and `sdk.mjs` (the SDK's own stdout dispatch and stdin
   builders) — read by a research agent whose report cites both files line by
   line. The `claude` binary itself is compiled and was not read.
3. The official documentation, read by a second research agent — see
   [Documentation](#documentation) below.

The SDK wrapper is a weaker witness than the wire: its `readMessages()`
dispatch handles frames (`transcript_mirror`, `post_turn_summary`,
`task_summary`, `autocompact_state`) that its own `.d.ts` never declares, so
"not in `sdk.d.ts`" means "not in the published TypeScript contract", never
"the CLI does not do this".

## 1. What the wire showed

The exact line sequence for one `Skill` call, on 2.1.259:

```
{"type":"assistant", message.content: [{type:"tool_use", name:"Skill", input:{skill:"team-workflow"}}]}
{"type":"user",      message.content: [{type:"tool_result", content:"Launching skill: team-workflow"}]}
{"type":"user",      message.content: [{type:"text", text:"Base directory for this skill: …\n\n# Team Workflow\n…"}]}   ← 5529 chars, the whole SKILL.md
{"type":"assistant", message.content: [{type:"text", text:"done"}]}
{"type":"result", subtype:"success", …}
```

The third line is the CLI's own context injection. It carries `role: user`, a
plain `text` block, and **no field that marks it as injected** — no `isMeta`,
no `isSynthetic`. On the CLI's on-disk transcript the same record *is* stamped
`isMeta: true`; that flag never reaches stdout.

The same probe's `init` line advertised
`capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"]`
and `claude_code_version: "2.1.259"`. That is the live answer to §4 below.

## 2. The stdout envelope set (SDK 0.3.259 types)

The full stdout contract is `StdoutMessage = SDKMessage | SDKActiveGoalMessage
| SDKControlResponse | SDKControlRequest | SDKControlCancelRequest |
SDKKeepAliveMessage`. `uuid` and `session_id` sit on every `SDKMessage` member
except `keep_alive`; the three control envelopes carry neither.
`parent_tool_use_id` sits only on what can originate inside a subagent turn:
`assistant`, `user`, `stream_event`, `tool_progress`.

Top-level `type` values: `assistant`, `user` (plus the `isReplay: true`
variant, emitted only under `--replay-user-messages`), `result`
(`success` | `error_during_execution` | `error_max_turns` |
`error_max_budget_usd` | `error_max_structured_output_retries`; `errors[]`
exists only on the error shapes, `result` text only on success),
`stream_event` (only under `--include-partial-messages`), `rate_limit_event`,
`tool_progress`, `tool_use_summary`, `active_goal`, `prompt_suggestion`,
`conversation_reset`, `auth_status`, `control_request`, `control_response`,
`control_cancel_request`, `keep_alive`.

`system` subtypes (29 declared): `init`, `hook_started`, `hook_progress`,
`hook_response`, `compact_boundary`, `status`, `api_retry`, `task_started`,
`task_progress`, `task_notification`, `task_updated`, `files_persisted`,
`background_tasks_changed`, `commands_changed`, `thinking_tokens`,
`session_state_changed`, `worker_shutting_down`, `notification`,
`memory_recall`, `permission_denied`, `mirror_error`,
`model_refusal_fallback`, `model_refusal_no_fallback`, `informational`,
`local_command_output`, `plugin_install`, `elicitation_complete`,
`control_request_progress`; plus `post_turn_summary` and `task_summary`, which
`sdk.mjs` dispatches but `sdk.d.ts` never declares. The union's own comment:
"Consumers should ignore types and subtypes they do not recognize: the set
grows over time."

## 3. The `user` envelope

`SDKUserMessage` declares, beyond `type` / `message` / `parent_tool_use_id`:
`isSynthetic?`, `tool_use_result?` (the tool's structured Output object, a
sibling of the `tool_result` block), `priority?`, `origin?`, `shouldQuery?`,
`timestamp?`, `uuid?`, `session_id?`, `subagent_type?`, `task_description?`.
Its doc comment: a client writes a `user` message to submit a prompt; the CLI
emits `user` messages "for content it adds itself, chiefly the `tool_result`
blocks answering the assistant's `tool_use` blocks."

Three facts follow, each checked:

- **Nothing on the type distinguishes CLI-injected text from human input.**
  `isMeta`, `isCompactSummary`, `isSidechain` appear in `sdk.mjs` only in code
  that reads the on-disk session JSONL, which `sdk.d.ts` itself calls
  "CLI-internal and not part of the SDK API surface". `origin.kind` classifies
  provenance across sessions and channels, not tool-adjacent injection.
- **The SDK does not filter `user` lines.** `readMessages()` intercepts only
  control traffic, `keep_alive` and `transcript_mirror`; every `user` line,
  whatever its flags, reaches the consumer unchanged.
- **Stdin is never echoed.** Neither the SDK nor Dreamux passes
  `--replay-user-messages`, so an operator's own input never appears on stdout
  at all. A `user` line on stdout is therefore always the CLI's: a tool result,
  or context it injected.

The `Skill` tool has no entry in `sdk-tools.d.ts` at all; the strings
`Launching skill` and `Base directory for this skill` occur nowhere in the SDK
package. The injection is the binary's behaviour, seen only on the wire.

## 4. Lifecycle and capabilities

`command_lifecycle` and `msg_lifecycle_v1` are absent from the SDK's types and
code. `command_lifecycle` appears twice, in prose, on
`SDKControlInterruptRequest.cancel_queued` ("follows up with a command_lifecycle
'cancelled' frame"), which confirms a per-command lifecycle frame with a
`cancelled` terminal exists on the real wire and nothing more. The capability
list `sdk.d.ts` documents is `interrupt_receipt_v1`,
`interrupt_cancel_queued_v1`, `queued_notifications`, framed as an open set.

The live probe settles what the wrapper cannot: 2.1.259 advertises
`msg_lifecycle_v1` (§1). Dreamux's six-state enum and top-level
`{type: "command_lifecycle", command_uuid, state}` shape rest on the 2.1.231
live probe recorded in provider-runtime's settlement section, not on any
published type. That is the correct weighting; the SDK wrapper simply does not
model this part of the protocol.

## 5. Divergences found, and what became of each

| # | Dreamux read | The wire / the contract | Disposition |
|---|---|---|---|
| 1 | Any `text` block became `assistant.message`, whatever envelope carried it. | `text` blocks are legal in both roles; only `tool_use` is assistant-only and `tool_result` user-only. A `user` line's text is the CLI's own injection (§1, §3). | **Promoted, fixed.** The display line reads the envelope: `assistant` yields text and tool calls, `user` yields tool results only, and its text yields nothing. Operator ruling 「所有的 user 消息都隐藏即可」. |
| 2 | Every unmodelled line (`user`, `stream_event`, `rate_limit_event`, 25+ `system` subtypes) was forwarded to the display line as `kind: 'other'`, where it silently yielded nothing. | Those are distinct typed messages with their own fields. | **Promoted, fixed** as far as the seam goes: `user` is its own `ParsedLine` kind, the seam is typed to `assistant` \| `user` (`ClaudeActivityLine`), and the RPC forwards nothing else. Whether any `system` subtype (`permission_denied`, `compact_boundary`, `task_notification`) should reach the card is a product decision — **deferred**, no requirement stated. |
| 3 | The Remote Control enable reads its URL from `response.session_url ?? response.connect_url`. | The request shape (`subtype: "remote_control", enabled: true`) matches the SDK's own `enableRemoteControl()`; neither response field name occurs anywhere in the SDK, whose code reads `bridge_session_id`. | **Deferred.** Needs one live enable to see the real response; if the names are wrong, every successful enable logs "succeeded without a URL". |
| 4 | Blocks with a non-null `parent_tool_use_id` (a subagent's) are displayed as the agent's own. | The field exists exactly to tell them apart. The headless guide narrows what arrives: by default only a subagent's `tool_use` and `tool_result` blocks are emitted; its text needs `--forward-subagent-text`, which Dreamux does not pass. So today a subagent's tool rows land on the leader's card as the leader's own; its words do not (docs-sourced, not probed). | **Deferred**, product decision: how a card should show a subagent's activity. |
| 5 | `--append-system-prompt` is passed as a CLI flag. | The SDK sends `appendSystemPrompt` inside the `initialize` control request instead, with `systemPromptSnapshot` resume-stability semantics. Both are real CLI surface. | **Out of scope.** No requirement; noted for the day cross-resume prompt stability matters. |
| 6 | The Feishu client rendered the injected 7.6 KB body from its second 4096-byte delta onward, and dropped the preceding tool row and skill body, with no append failure logged. | Unknown; the COT message API does not read events back. | **Out of scope** by ruling (「不用管这个不全的问题」): the text that triggered it is no longer sent. The 4096-byte per-event budget itself has no recorded source (#347 introduced it). |

## Documentation

A second research agent read the official documentation on 2026-09-03: the
TypeScript Agent SDK reference (the one page that documents the full
`SDKMessage` union, 35 shapes), the headless guide, the CLI reference, the
skills reference, the streaming guides, and the CLI changelog. Its report is
not retained in the repo; this section keeps what bears on the rows above.

**What the docs confirm.**

- A `user` line on stdout is `SDKUserMessage`, with `parent_tool_use_id`,
  `tool_use_result`, `isSynthetic`, `shouldQuery` and `origin` as documented
  fields. `--replay-user-messages` is documented as "re-emit user messages
  from stdin back on stdout for acknowledgment", which is the documented form
  of §3's third fact: without it, stdin is never echoed.
- Skill loading: "the rendered `SKILL.md` content enters the conversation as
  a single message and stays there across later turns." The wire `type` of
  that message, and the `Base directory for this skill` preamble, are stated
  nowhere; §1 remains the only witness that it is a `user` text block.
- Subagents (headless guide, "Follow subagent messages"): "Messages from
  subagents appear in the stream as `assistant` and `user` messages whose
  `parent_tool_use_id` field is the ID of the tool call that spawned the
  subagent", and "by default, Claude Code emits only subagent `tool_use` and
  `tool_result` blocks. Pass `--forward-subagent-text` to also emit subagent
  text and thinking blocks." This narrowed row 4.
- `result.user_message_uuid` is documented as the echo of the one message a
  turn answers, omitted for later frames of the same turn, subagent frames,
  synthetic turns, and the zeroed result after a crashed worker. That matches
  the RPC's use of it as an optional attribution hint. The four error
  subtypes in §2 are the complete documented set.
- `init.capabilities` is documented as an open set to feature-detect against
  ("ignore values you don't recognize"); the docs name only
  `interrupt_receipt_v1` and `interrupt_cancel_queued_v1`.

**What the docs do not cover.** Each of these rests on a live probe alone,
which the runtime's own comments already say:

- `command_lifecycle` frames, the six states, and `msg_lifecycle_v1` occur in
  no documentation page and nowhere in the changelog. The RPC's command
  attribution and drain model has no published contract behind it.
- The control wire: one sentence confirms the
  `{type: "control_request", request_id, request}` envelope; the
  `control_response` shape, the `remote_control` enable request, and the
  `can_use_tool` subtype are never spelled out. Row 3 therefore cannot be
  settled from the docs; a live enable is the only witness.
- `error_during_execution` is documented as a `result` subtype, not as the
  artifact an interrupt leaves behind; the RPC's three-field pattern match
  for it stays probe-derived.
- `isMeta` appears in no document. The docs describe `isSynthetic` only
  through `origin.kind: "unclassified"`: such a message is "framed to the
  model as a non-user source rather than treating it as human input."

Nothing in the docs contradicts a row above; the one change they produced is
the narrowing of row 4.

## Sources

- Live probe: installed `claude` 2.1.259, stream-json output captured on
  2026-09-03 (not retained in the repo).
- `@anthropic-ai/claude-agent-sdk@0.3.259`: `sdk.d.ts`, `sdk.mjs`,
  `sdk-tools.d.ts`; the research agent's line-cited report is not retained in
  the repo — this page keeps what changed a decision.
- Official documentation under `code.claude.com/docs/en/`: `agent-sdk/typescript`,
  `headless`, `cli-reference`, `skills`, `agent-sdk/streaming-output`,
  `agent-sdk/streaming-vs-single-mode`; and the CLI `CHANGELOG.md` on GitHub.
  Fetched 2026-09-03; the audit report is likewise not retained.
- `/packages/agent-runtime/claude-code/src/stream.ts`
- `/packages/agent-runtime/claude-code/src/rpc.ts`
- `/packages/agent-runtime/claude-code/src/runtime-submissions.ts`
- `/packages/agent-runtime/claude-code/src/types.ts`

## Disposition (2026-09-03)

- **Promoted:** rows 1 and 2 of §5 — shipped with the ruling, recorded in
  [provider-runtime](/.agents/domains/provider-runtime.md) and
  [product](/.agents/product/README.md).
- **Deferred:** rows 3 and 4, and the `system`-subtype half of row 2 — each
  needs either a live check or an operator ruling before it is work.
- **Out of scope:** rows 5 and 6.
