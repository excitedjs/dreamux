# Final solution: one native activity vocabulary from runtime to Channel

- Requirement: [requirement.md](/.agents/tasks/architecture/standalone-compaction-activity/requirement.md).
- Builds on [standalone-token-usage-activity](/.agents/tasks/architecture/standalone-token-usage-activity/technical-design/final.md):
  the same move — a runtime reports a fact, the display layer owns its line —
  applied to the two remaining provider-assembled display strings, then to the
  ids and to the type the fact travels in.
- Supersedes: the 2026-09-04 ruling that compaction ride an
  `assistant.message`; the id convention the token-usage task kept; the #367
  decision to keep a reshaped second activity type, whose premise (lossy,
  type-changing sanitisation) no longer holds.

## 1. The contract

### 1.1 One activity union

`TeammateActivity` is deleted. `RuntimeActivity`
(`packages/dreamux-types/src/agent-runtime.ts`) is the only activity type, and
`teammate.activity` carries it. It gains the two text-free kinds, loses
`callId`, and every member except `turn.ended` shares one base shape:

```ts
// Illustrative; the spelling follows the file's own idiom.
interface NativeActivity<K> { readonly kind: K; readonly occurredAt: number; readonly id: string }

type RuntimeActivity =
  | NativeActivity<'assistant.message'> & { text }
  | NativeActivity<'context.compacted'>
  | NativeActivity<'turn.interrupted'>
  | NativeActivity<'tool.call'> & { toolName; action; summary; invocation; items;
                                     status; arguments; result; error }
  | NativeActivity<'token.usage'> & { inputTokens; outputTokens; context }
  | { kind: 'turn.ended'; occurredAt; status; reason }
```

`turn.ended` has no id because two of its producers have no native source:
teardown and the end Core publishes for an input no runtime accepted.

The member docs merge the two types' docs. They keep, verbatim in meaning:
the `context.compacted` and `turn.interrupted` contracts from the first scope
(no text; the marker is not a terminal, precedes usage and the paired
interrupted end, is never on teardown; both live-only), the `token.usage`
cumulative-counter contract, and the `turn.ended` terminal contract. The union
doc gains one paragraph: a Channel receives this type with every text and JSON
payload member already redacted by Core.

### 1.2 Ids

`id` is the provider's own id for the object the activity reports, taken
whole: no prefix, suffix, counter, or composition. It is not unique per
activity: a tool call's start and result share the call id, and one turn's
`token.usage` and `turn.interrupted` share that turn's id. A consumer that
needs one identity per row derives it from the kind (and a tool call's status)
together with `id`; §4 is the one consumer that does.

| Activity | Claude Code | Codex |
| --- | --- | --- |
| `assistant.message` | the assistant line's `uuid` | agent message item `id` |
| `tool.call` (start and result) | `tool_use.id` / `tool_result.tool_use_id` | tool item `id` (= `call_id`) |
| `context.compacted` | the `compact_boundary` line's `uuid` | context compaction item `id` |
| `token.usage` | the `result` line's `uuid` | `turnId` |
| `turn.interrupted` | the `result` line's `uuid` | `turnId` |

### 1.3 The four Core events, in camelCase

Every member of `TeamStateEvent`, its `TeamStateTeammateSummary`,
`TeammateStateEvent`, `TeammateActorScope`, `TeammateInputEvent`, and
`TeammateActivityEvent` is spelled in camelCase: `schemaVersion`,
`occurredAt`, `teamName`, `teammateName`, `leaderName`, `sourceId`. Values do
not change (`'team_leader'`, `'teammate_completion'` are values, not member
names). The seal checks `schemaVersion` and `occurredAt`. No other type
changes spelling. The package's 13 other snake_case types are left for
[#447](https://github.com/excitedjs/dreamux/issues/447), as the operator chose
the smallest scope; four of them change what leaves the process when renamed
(Team MCP result keys and the persisted Team-create hash), so they need their
own design.

`TeammateInputEvent` also drops `redacted`, for the same reason as the
activity members: Core writes it and no production code reads it.

## 2. Runtimes

### 2.1 Claude Code

- Assistant text takes its line's `uuid`; a tool call and its result take the
  call id; compaction takes the `compact_boundary` line's `uuid`.
- The parsed `result` line keeps its own `uuid` (the envelope's `uuid`
  member, not `user_message_uuid`, which the parser already reads as
  `userMessageUuid` and which names an inbound message), and the `result` and
  `interrupted` protocol events carry it beside `outcome`: it is a fact about
  the line, and `TurnOutcome` also feeds push-back, which has no use for it.
  `interrupted.outcome` becomes required; its one producer (`rpc.ts`) always
  sets it. `token.usage` and `turn.interrupted` take that `uuid`.
- A missing native id follows the rule the file already applies to a
  `tool_use` block without an id: that activity is not reported. The Agent SDK
  types every one of these ids as required, and every line observed carries
  one; this is the existing narrowing of untyped JSON, not a new fallback.
  `turn.ended` is emitted as today either way.
- `NativeActivityState.activitySequence` and the `stream-${seq}` fallback are
  deleted; the state keeps only the tool map.
- Recorded limit: an assistant line has carried exactly one content block in
  every observation, so one text block per line has one id. A line with two
  text blocks would report two `assistant.message`s with the same id; nothing
  is added to defend that unobserved shape.

### 2.2 Codex

Every id is already on the item or the turn: `itemActivity` returns `item.id`
for agent messages, tool calls, and compactions, and `interruptedActivity` and
`tokenUsageActivity` return `turnId`. The existing rule that an item without an
id reports nothing stays. Emission points and order do not change.

## 3. Core

- `conversation-projection.ts` stops reshaping. Its per-kind switch returns
  the same `RuntimeActivity` with payload members redacted in place, keeping
  the compile-time `never` check: `text`, `summary`, `invocation`, each of
  `items`, `error`, and `reason` through `redactText`; `arguments` and
  `result` through `redactJson`, which keeps JSON as JSON. `redacted` results
  are discarded. Ids, counters, statuses, and `occurredAt` pass through.
  `jsonText` and the `error ?? result` fold are deleted.
- The `teammate.activity` envelope takes `occurredAt` from the activity as it
  does today; the seal needs it on every event, so the value appears twice.
- The Core producers of the four events (`team-collection/store.ts`,
  `team-service/roster-projection.ts`, `dispatcher-service/index.ts`,
  `conversation-projection.ts`) and the internal users of
  `TeamStateTeammateSummary` (roster reader, runtime registry, team service)
  move to the camelCase members.

## 4. Feishu

- The CoT layer reads `RuntimeActivity` directly
  (`Extract<RuntimeActivity, { kind: 'tool.call' }>` and so on) and every
  member of the four events in camelCase.
- The CoT layer is not the only reader. The session's single subscription in
  `feishu-channel.ts` also reads `team.state`: on `status: 'closed'` it passes
  the event's team name to `forgetTeamRoutes`, which removes that Team's
  persisted routes and document subscriptions. It reads `teamName` after the
  change, the cleanup path stays as it is, and a test locks that a closed
  `team.state` still removes the routes. The route record format does not
  change.
- Display ids. `textMessageEvents` takes the row's display namespace beside
  its source, so `opaqueDisplayId(namespace, source)` never sees two rows with
  the same pair: `message` for `assistant.message`, `compacted`,
  `interrupted`, `usage`, `input` for an input echo, `receipt` for the opening
  label a new card shows, and `end` for an end reason. A tool row keeps
  `opaqueDisplayId('call', id)`, its result `opaqueDisplayId('result', id)`,
  and `openCalls` is keyed by `id`. The namespaces are lowercase words, like
  the three that exist today; no other `messageId` charset has been checked
  against Feishu.
- The input echo, opening receipt, and end-reason rows keep Feishu's own
  `randomUUID()` source: no runtime reports them, and the ruling concerns
  provider ids. The end reason goes straight through the display-text path
  instead of fabricating an `assistant.message` with a `redacted` flag.
- Tool payloads arrive as `JsonValue`. An object or array is pretty-printed as
  JSON; a string follows today's path, including pretty-printing a string that
  is JSON text; any other scalar shows as its JSON text. A failed call shows
  `error` when it has one and `result` otherwise — the choice Core made before.

## 5. Change inventory

| Package | Change |
| --- | --- |
| `@excitedjs/dreamux-types` | §1: merged union with base shape and id doc, `TeammateActivity` deleted from `teammate.ts` and the index, four events in camelCase, `TeammateInputEvent.redacted` deleted. |
| `@excitedjs/agent-runtime-claude-code` | §2.1: native ids, `result` `uuid` carried on the protocol events, counter deleted, `interrupted.outcome` required. |
| `@excitedjs/agent-runtime-codex` | §2.2: native ids. |
| `@excitedjs/dreamux` | §3: redact-in-place projection, camelCase producers and seal, roster internals. |
| `@excitedjs/feishu-channel` | §4: `RuntimeActivity` reader, display namespaces, tool payload presentation, end-reason row, camelCase event readers. |
| Tests | Every exact-object and fixture assertion moves to native ids, camelCase events, and the merged type; the Feishu delivery lock is rewritten (§6, §8). |
| Rush changes | The five change files on this branch are new (`A` against `next`) and are edited in place: `minor`, plain notes. These are API contract changes to `@excitedjs/dreamux-types` and do not block an upgrade: no persisted file changes. The `dreamux-types` note names each change an external integrator must follow: the camelCase members of the four events, `TeammateActivity` removed in favour of `RuntimeActivity`, `callId` removed, `redacted` removed, and ids now native. |
| Knowledge | provider-runtime: the union, base shape, id contract, and per-runtime id sources. Channel: the catalog's member spelling, `teammate.activity` carrying `RuntimeActivity` redacted in place, no `redacted` flag, and the display namespaces. Product catalog: unchanged beyond the first scope. |

Unchanged: stream parsing beyond the `result` `uuid`, emission points and
order, every `turn.ended` status, card terminals, label text, the cold readers
(their `AgentActivityRecord` carries no id or call id), redaction rules and
coverage, persisted state, and every snake_case type outside the four events.

## 6. Rendering

Every row carries the same role, content, position, and opening behaviour as
before; only the opaque display ids change, because their inputs change. They
are card-local, held in memory only (the CoT state is not persisted), and a
daemon stop ends open cards before the Channel closes, so no card mixes ids
from before and after. The compaction and interrupt rows are no longer
event-for-event equal to an `assistant.message` with the same id — they sit in
their own namespaces by design — so the delivery lock compares everything but
`messageId`, and adds the case the namespaces exist for: a usage row and an
interrupt row with one shared id both appear.

## 7. Rejected alternatives

- **Runtime-assembled ids, counters, or ids Feishu invents** for runtime rows:
  the operator's ruling.
- **Make a native id unique per activity in the runtime** (`${uuid}:usage`):
  the concatenation the ruling rejects. Per-row uniqueness is a display need,
  so the display layer derives it.
- **Keep two types and only drop `call_id`**: superseded by the merge ruling.
- **A branded "redacted" type** to keep a type-level proof that a Channel sees
  only redacted activity: a mechanism with no named failure. The projection is
  the only publisher of `teammate.activity`, and redaction coverage is locked
  by the projection tests.
- **Join a line's text blocks into one message** so a line `uuid` can never
  repeat: defends a shape never observed.
- **Drop `occurredAt` from the payload** to avoid the duplicate: it would
  reshape the runtime's fact again, which is what the merge removes.
- **Derive the interrupt line from `turn.ended`**, **one generic notice kind**,
  **carry Claude's `compact_metadata`**: rejected in the first scope, for the
  reasons in §6 below.

## 8. Verification plan

- Runtime tests, exact objects: Claude assistant text, tool start and result,
  compaction (live and background), and an interrupted `result` with and
  without usage, all under native ids from fixture lines that carry `uuid`;
  Codex the same under item ids and `turnId`; both teardown locks unchanged.
  No test asserts a counter-shaped id.
- Projection tests: each kind comes out as the same kind with payloads
  redacted (a secret in text, arguments, result, and error is rewritten) and
  ids, counters, and `occurredAt` untouched; the four events in camelCase; the
  seal accepts `schemaVersion: 1` with a finite `occurredAt` and drops the
  rest.
- Feishu tests: compaction and interrupt rows equal an assistant row with the
  same content and role in every member but `messageId`, onto an open card and
  when opening one; a usage and an interrupt row sharing one id both land; a
  tool start and result pair by `id`; a failed call shows its error; an object
  result, a JSON-text string result, and a plain string result render as
  before.
- Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
  `.agents/scripts/check.sh`.
- Coverage limit: no live Feishu probe; card behaviour is asserted through the
  projected events.

## 9. Review adjudication

### Round 1 (first scope)

Solution review: the Devbox reviewer on Issue #445, in place of three
solution-review TeamMates, as the work group allows. Verdict: no blocking
issue.

- Accepted: the `turn.interrupted` type doc states the four facts in §1.1
  (marker not terminal; before usage and the end, paired; never on teardown;
  live-only), not only the Issue.
- Accepted: the labels move verbatim, and the rendering claim is locked by a
  delivery test rather than by two separate "reached the card" assertions.
- Rejected: a code comment declaring the labels byte-equal to the former
  runtime constants. The test is the lock; a comment naming code that no
  longer exists describes history.
- Accepted: the channel domain's second paragraph (what enters a card) is
  updated, not only the vocabulary list.
- Adjusted: the reviewer asked for a dated `Since this was recorded` section
  under the 2026-09-04 ruling. That rule governs historical text; the
  provider-runtime page states current behavior, so its paragraph is rewritten
  to the new carrier and keeps the 2026-09-04 quote verbatim, marked as
  superseded by the 2026-09-18 words.
- Not an issue: the reviewer found no task record on `next`. The record exists
  on this task's branch, indexed in the architecture README, and lands with
  the pull request.
- Accepted (non-blocking): one fixed-label helper shared by the two new
  acceptors.

First-scope alternatives, kept for §7: deriving the interrupt line from
`turn.ended` would put it after the usage line and on teardown ends; one
generic kind would add a catch-all whose members share no semantics and make
every consumer switch twice; `compact_metadata` has no Codex counterpart and
no consumer.

### Round 2 (native ids, merged type, camelCase events)

Solution review: the Devbox reviewer on Issue #445 again. Verdict: no blocking
issue. The reviewer checked the three points it was asked to weigh — the
missing-id rule, namespaces in place of event identity, redaction-only Core —
against the code. It also stated that the four events have no consumer
outside the Feishu CoT adapter and presentation (incomplete; see the last
bullet), and confirmed that Team MCP's `TeamSummary` is built from
`TeamRecord` and not from the event summary type (so the #447 boundary holds)
and that `redacted` has no production reader. It supports the
`teammate.input` `redacted` ride-along.

- Accepted: the opening receipt row (`receipt:${randomUUID()}` in
  `openReceipt`) was missing from the namespace list; §4 names it.
- Accepted, corrected: the reviewer warned that the parser already has a
  `uuid` field for the inbound message. The parsed field is
  `userMessageUuid` (and `rpc.ts` holds it in a local named `uuid`); the
  warning stands, and §2.1 names the envelope's own `uuid` explicitly.
- Rejected: a debug log where an assistant line without a `uuid` is dropped.
  No such line has been observed and the SDK types the member as required; the
  existing rule for a `tool_use` block without an id has no log either. A log
  for an unobserved shape is the defense this repository does not add.
- Accepted: the rush change notes name every contract change an external
  integrator must follow (§5).
- Corrected after review: the reviewer stated the four events have no
  consumer outside the CoT adapter and presentation. The developer found one
  before writing code: the route cleanup on a closed `team.state` in
  `feishu-channel.ts`. It is inside the approved scope ("every Feishu reader
  of the four events"); §4 names it.
