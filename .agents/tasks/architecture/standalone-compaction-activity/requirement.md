# Requirement

## Initial request

The operator, in the Feishu work group on 2026-09-18, after #442 moved token
usage out of the message event: 「上一个pr已经给usage 从 message 事件里拆出来了，
我感觉compact 也可以拆出来。」 Then, on the interrupt marker: 「interrupted 也一并
拆了」.

With the first implementation approved on #446, the operator widened the same
change in three steps:

- On activity ids, after asking 「你真的不打算给 RuntimeActivity 抽成一个基类嘛？」
  and 「这个现在递增生成的ID有人用吗？我其实很不喜欢这种自造ID」:
  「不不不不不,这个ID让飞书来自己造更恶心.但是它拼接成自增ID也很恶心.最好的做法是
  直接用原生 Provider 生成的 ID，比如 toolcall 就用 toolcall ID。」
- On the projected activity type, asked whether it follows those changes:
  「这两个类型可以合并吗？」
- On field spelling, once merging was chosen: 「应该是全都改成驼峰。外层也是」.

## Confirmed current behavior and evidence

Measured on `next` after #442 and #444 merged.

### Compaction and interrupt carriers (first scope)

- Compaction. Both built-in runtimes publish a context compaction as an
  ordinary `assistant.message` whose `text` is the provider-owned label
  `COMPACTED SESSION`: Claude Code on the `system`/`compact_boundary`
  stream-json envelope, Codex on the completion of a `contextCompaction` item.
  The summary the runtime wrote is never shown. Being an `assistant.message`,
  the line opens a Feishu CoT card when none is open.
- Interrupt. Both runtimes publish `[Request interrupted by user]` the same way,
  pushed only on a *native* interrupted terminal (claude's `interrupted`
  protocol event; codex's `turn/completed` with `status: "interrupted"`), in
  the order marker, `token.usage`, `turn.ended` `interrupted`. Teardown ends
  report `turn.ended` `interrupted` with no marker.
- Both facts are live-only: the cold readers return their own record
  vocabulary (`AgentActivityRecord`), not `RuntimeActivity`, and carry no ids.
- The knowledge base recorded the superseded carrier ruling, 2026-09-04:
  「我觉得没必要给他单独加一个新的 activity 类型，你直接在 provider 里，多推一个
  assistant message，内容就这一行。」

### Activity ids

Every activity except `turn.ended` carries an `id`, assembled by the runtime:

| Activity | Claude Code today | Codex today |
| --- | --- | --- |
| `assistant.message` | `${message.id}:text:${blockIndex}` | `${turnId}:${itemId}:completed` |
| `tool.call` | `${message.id}:${toolUseId}:started` / `:result` | `${turnId}:${itemId}:started` / `:completed` |
| `context.compacted` | `stream-${seq}:compacted` | `${turnId}:${itemId}:completed` |
| `token.usage` | `stream-${seq}:usage` | `${turnId}:usage` |
| `turn.interrupted` | `stream-${seq}:interrupted` | `${turnId}:interrupted` |

`seq` is a per-session counter (`NativeActivityState.activitySequence`), which
also names an assistant envelope without a `message.id` (`stream-${seq}`).
`tool.call` additionally carries `callId`, the native call id (Claude
`tool_use.id`, Codex item id). No record says why Codex ids carry the turn id.

Native ids exist for every one of these facts:

- Claude Code. The Agent SDK reference types `uuid` as required on assistant,
  result, and `compact_boundary` messages, and `message.id` as the API message
  id. A live `claude -p --output-format stream-json` run on 2.1.276 showed every
  stdout line with its own `uuid`, each assistant line carrying exactly one
  content block (thinking, text, and tool use on separate lines), and the lines
  of one API message sharing `message.id`. 7,157 assistant entries across 60
  local transcripts all carry a `uuid` and none carries more than one content
  block. A tool call's id is `tool_use.id`, echoed as `tool_result.tool_use_id`.
  The terminal `result` line's `uuid` is not carried past the parser today.
- Codex (source at a8964cb1ba, 2026-09-15). The app-server builds every tool
  item with `id = call_id` (`app-server-protocol/src/protocol/item_builders.rs`);
  an agent message's id is the model's response item id, or a fresh
  `Uuid::new_v4()` when it has none (`core/src/event_mapping.rs`); a context
  compaction item's id is `Uuid::now_v7()` (`protocol/src/items.rs`). Usage and
  the interrupted terminal are reported per turn, keyed by `turnId`.

The one consumer of these ids is the Feishu CoT layer, which hashes them into
card-local display ids: `opaqueDisplayId('message', event_id)` for every text
row, `opaqueDisplayId('call', call_id)` for a tool row, and
`opaqueDisplayId('result', event_id)` for its result. A display id only has to
be unique within one card. Feishu also generates two ids of its own for rows no
runtime reports: `input:${randomUUID()}` for an input echo and
`end:${randomUUID()}` for an end reason.

### Two activity types

`RuntimeActivity` (`dreamux-types/src/agent-runtime.ts`, camelCase) is what a
runtime reports; `TeammateActivity` (`dreamux-types/src/teammate.ts`,
snake_case) is what `teammate.activity` carries after Core's conversation
projection. Its doc states the member names "match `RuntimeActivity`'s on
purpose: this is the same fact with its payloads made safe to display, not a
second vocabulary". The split was decided in #367 because "sanitisation is lossy
and type-changing (`JsonValue` becomes a bounded string plus truncation and
redaction flags)"
([task record](/.agents/tasks/architecture/split-streaming-display-from-pushback/technical-design/final.md)).
Neither premise holds any more: redaction walks the JSON value and returns JSON
(`@excitedjs/dreamux-utils` `redactJson`, since #412), and Core bounds nothing.
What still differs:

- Spelling: snake_case members, and `action` renamed `tool_action`.
- `redacted`: written on every member by Core, read by no production code.
  `teammate.input` carries the same flag, also unread.
- Tool payloads: Core `JSON.stringify`s the redacted value into
  `arguments_json` / `result_json`; Feishu `JSON.parse`s it back to
  pretty-print.
- `error` and `result`: Core folds them into one `result_json` (`error ??
  result`), a presentation choice.
- `occurredAt`: dropped from the payload; the event envelope carries
  `occurred_at`.
- `call_id` beside `event_id`.

The four `ChannelCoreEvent` kinds (`team.state`, `teammate.state`,
`teammate.input`, `teammate.activity`) spell their members in snake_case
(`schema_version`, `occurred_at`, `team_name`, `teammate_name`, `leader_name`,
`source_id`), and the seal checks `schema_version` and `occurred_at` on every
event. The bus is in-process: events are never serialized, and the Feishu
Channel is their only consumer. No record gives a reason for the spelling.

## Current alignment

- Status: Converged.
- Desired outcome: no provider assembles display text or invents an id. A
  runtime reports what happened under the id its provider gave that object;
  the Feishu CoT layer owns every label and derives its own display ids from
  those native ids. One activity vocabulary, one spelling, from the runtime
  to the Channel.
- Desired behavior:
  - Compaction and interrupt are their own text-free kinds
    (`context.compacted`, `turn.interrupted`), emitted at today's native
    points and order, never on a teardown end, rendered by the Feishu CoT
    layer as the unchanged `COMPACTED SESSION` and
    `[Request interrupted by user]` lines, each opening a card when none is
    open.
  - Every activity id is the provider's own id for the object the activity
    reports: no concatenation, no counter. Two activities about the same
    object share it (a tool call's start and result; a turn's usage and
    interrupt marker). `turn.ended` carries no id.
  - `tool.call` carries no `callId`; its `id` is the call id.
  - Every activity except `turn.ended` shares one base shape: `kind`,
    `occurredAt`, `id`.
  - `TeammateActivity` is gone: `teammate.activity` carries `RuntimeActivity`,
    with its text and JSON payload members redacted in place.
  - The four Core events spell every member in camelCase, and the seal checks
    `schemaVersion` and `occurredAt`.
  - The Feishu card looks the same as before for every row.
- Scope: `dreamux-types` (the activity union, the four Core events), both
  built-in runtimes, the Core conversation projection, the Core event
  producers and seal, the Feishu CoT rendering and every Feishu reader of the
  four events, their tests, rush change files, and the knowledge pages that
  describe any of these.
- Non-goals: the cold read path; the runtime's compaction summary or metadata;
  label text; `turn.ended` statuses and card terminals (a teardown end keeps
  reading 任务中断); Feishu's own ids for rows no runtime reports (input echo,
  end reason); snake_case outside the four Core events — the other 13
  snake_case types in `@excitedjs/dreamux-types`, MCP tool payloads, CLI
  output, and persisted state and config keep their spelling here (the
  package's remaining types are
  [#447](https://github.com/excitedjs/dreamux/issues/447)).
- Constraints and invariants: every card row renders as it did; live-only;
  persisted files unchanged; redaction coverage unchanged (every text and JSON
  payload member is redacted before it reaches a Channel).

## Acceptance criteria

- Neither built-in runtime emits an `assistant.message` whose text it
  assembled for compaction or an interrupt; each emits the new kind at the
  same point and in the same order, and no teardown end carries the marker.
- Every activity id either runtime reports is a native provider id taken
  whole: Claude line `uuid`, `tool_use.id`, and `result` `uuid`; Codex item id
  and `turnId`. No runtime keeps an id counter.
- `tool.call` has no `callId`, and no `TeammateActivity` type exists.
- Every member of the four Core events is camelCase.
- The Feishu card renders compaction, interrupt, usage, assistant text, tool
  rows, inputs, and end reasons as before, and a turn's usage and interrupt
  lines, sharing one native id, both appear.
- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`, and
  `.agents/scripts/check.sh` pass.

## Decisions and unknowns

- Confirmed operator decisions (Feishu work group, 2026-09-18):
  - Compaction becomes its own activity, superseding the 2026-09-04 ruling
    quoted above (card answer: 「确认替代，拆出来」).
  - A new task record, building on
    [standalone-token-usage-activity](/.agents/tasks/architecture/standalone-token-usage-activity/README.md)
    (card answer: 「新建任务」).
  - The interrupt marker is split out too: 「interrupted 也一并拆了」.
  - Its carrier is its own activity kind, keeping today's trigger set and
    position, accepting that an interrupt is then stated both by that kind and
    by `turn.ended` status `interrupted` (card answer: 「B 独立 activity 类型」).
  - Card end states stay as they are. The operator's follow-up
    (「interrupt 应该是任务中断，那种原生的失败就变成了任务失败。。任务失败就可以
    定义为一个异常情况」) already matches the code for native interrupts and
    native failures; the one divergent case, a teardown end, keeps
    `interrupted` after comparing code volume (card answer: 「保持任务中断」).
  - Native ids, in the words quoted under the initial request. On the per-kind
    table of native ids and the shared base type, the card answer was
    「并进 #446」; on the now-redundant call id, 「删掉 callId，统一用 id」.
    This supersedes the id convention the token-usage task kept
    ("id convention stays `${turnId}:usage`",
    [requirement](/.agents/tasks/architecture/standalone-token-usage-activity/requirement.md)).
  - The two activity types merge (card answer: 「合并成一份」), in #446 (card
    answer: 「并进 #446」). This supersedes the #367 decision to keep a
    reshaped second type, whose premise is quoted above.
  - Spelling: 「应该是全都改成驼峰。外层也是」, with "the outer layer" confirmed
    as all four Core events (card answer: 「四种 Core 事件全改」).
  - On the rest of the package. The operator asked 「这个仓库为什么会混用下划线
    和驼峰呢？我理解Dreamux Type这个包里面至少应该全都是驼峰」, then 「如果改动范围
    太大的话，我们再商量一下。其实只要选一个改动范围最小的就可以了」, and asked
    whether camelCase or snake_case is cheaper. No naming rule is recorded in
    lint or docs. camelCase was shown cheaper and the only direction that can
    unify the package (MCP-defined members such as `inputSchema` and every
    method name are camelCase), and the scope stays the four events (card
    answer: 「只改四种事件」). The other 13 snake_case types in
    `@excitedjs/dreamux-types` are recorded for later in
    [#447](https://github.com/excitedjs/dreamux/issues/447); four
    of them are visible outside the process (`TeamSummary` and
    `TeamSubmitResult` are the JSON keys Agents read from Team MCP tools;
    `TeamCreateCommand` and its repo request feed the persisted Team-create
    idempotency hash).
  - The `redacted` flag on `teammate.input` goes with the one on activities,
    for the same reason (Core writes it, no production code reads it) (card
    answer: 「顺手删掉」).
- Inferences, labeled: none outstanding.
- Blocking unknowns: none.
