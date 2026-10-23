# Technical solution

## Ownership

`agents[]` owns optional description, tags and developerInstructions. Parsing and
stringification preserve supplied values. Capability selection reads resolved
entries, omitting unspecified descriptions and empty tags. MCP publishes that
domain catalog unchanged, including a supplied empty description. Onboarding preserves
metadata on existing ids and does not copy it into a new id. Remove the unused
provider declaration/validation/snapshot chain instead of retaining two owners.

`RuntimeGeneration.resolveLaunch` reads the current entry at each Core launch and
appends nonempty instructions to both prompt alternatives, without mutating the
original. Providers still select one alternative. Running generations are not
live-reconfigured.

Each owning MCP module projects its own results; Command DTOs remain complete
except for the explicitly changed capability catalog and added status timestamps.
Ordinary-member messaging has its own MCP module and authority object; the owner
catalog routes member scopes there without adding a generic projection framework.
Replace the old MCP/Command byte-equality test with explicit independent expected
results from the same owner. Keep admin/Channel Command equivalence unchanged.
The owner, member and Team record-based delegates share catalog publication and
dispatch through `service/mcp/projection.ts`; argument parsing and admission stay
in their existing handlers. Owner/member roster rows have one MCP schema and
mapper, and both Team dissolve tools share one compact receipt declaration.
Team list/history schemas close their actual compact rows and cleanup
values; full Team status remains open.

## Wire behavior

Only the final SDK adapter selects the wire representation. Nonempty text is
the complete model-facing result, forwarded verbatim in one content block with
no JSON prefix or structuredContent. Tool owners write actionable facts before
their reminders: the actual TeamMate name and Dispatcher workspace/branch,
Team name/current status/leader/runtime/workspace policies, workflow run id, or
Feishu binding target and previous exact binding. A successful member send
explicitly states that the message was submitted while retaining its distinct
reply and owner-completion semantics. Non-submitted results keep their existing
structured status and errors. Team creation can return closed after its first
Leader self-dissolves; the text must report that actual status. Dynamic prose
values use one Markdown-safe quoted-value formatter, including arbitrary runtime
ids and workspace/source/branch values. Structured values remain unchanged.

Absent or empty text keeps structured output. Internal `{structured,text?}` and
errors remain unchanged. The shim preserves text unchanged, including empty
strings; the final adapter selects the representation without trimming text.
This supersedes the earlier JSON-plus-reminder and empty-text JSON-only choices
under the operator's 2026-10-23 direction to put facts directly into prose.

Core text-capable tools omit outputSchema. Feishu's existing successText hook
supplies the same fact for builtin/extension registration. Ordinary schemas and
validation remain. Internal Feishu definitions allow absent output schemas;
routing tools no longer declare schemas that registration would discard.
No new mode or redundant runtime validation is added.

External Channel providers and Feishu extensions own complete nonempty success
text, including all business facts the model needs; the adapter no longer
serializes their value beside that text. Returning undefined or an empty string
selects the structured result. Providers must omit outputSchema for any tool
that may return nonempty text. An unadapted schema-plus-text tool can
complete an action before SDK output validation fails. This is not a compatible
fallback or persisted-file upgrade blocker; release notes must state the change.

## Projections and missing facts

Creation returns actual addressing/workspace facts; submission returns admission
outcomes. Lists carry selection fields; details keep diagnostics, session ids
and workspace/cleanup facts. History keeps bounded closure context and cursors.
Last keeps activity records and distinct truncation/cursor facts, without count
echoes or a full entity snapshot. Workflow status preserves per-agent results and
errors and stable invocation indexes; workflow list is a compact index. Indexes
can have gaps after rejected invocations and cannot be inferred from array
position. Space get returns identity text.

History drops the redundant resume tool/name hint. The existing send operation
still reopens closed records; session ids remain available in status. No new
boolean promises that a runtime-native session can be resumed.

Historical scripts fetched identity timestamps and the Leader's own Team summary.
Expose record created_at/updated_at in TeamMate status (not activity times) and
add zero-argument bound Team status for the Leader through the actual Team owner.
Existing teammate tools already provide the member roster/details; do not repeat
them inside Team status or introduce a message-history store.
The bound Leader status checks Team openness inside `admitLeaderTools`, matching
the existing Leader Channel entry order. Shared Team status remains a projection:
Dispatcher inspection and successful creation whose initial leader already
self-dissolved must still be able to return a closed summary. Dissolve retains
its separate repeated-request admission behavior.

The historical activity gap was reproduced against the current Claude reader:
non-participant attachments at the tail incorrectly excluded the last participant
from leaf selection. Only participants contribute child edges when selecting the
conversation leaf; the complete id map still supports traversal through other
native records. Synthetic fixtures cover the tail, sidechains and an intermediate
attachment. No private transcript data or home-search fallback is introduced.

## Exact MCP projections

### Bounded lists and activity metadata

`service/mcp/list-page.ts` owns MCP-only status filtering and pagination for
Team, owner TeamMate, and member TeamMate lists. It reuses the existing history
limit/cursor primitives: default 20, maximum 100, opaque offset cursor. Inputs
are `status?`, `limit?`, and `cursor?`; default `non_closed` excludes only closed,
while `all` and exact statuses preserve explicit discovery. Rows keep domain
ordering. Member scope removes itself before filtering/counting/slicing and
keeps its owner separately. `total` is the matching count before pagination;
`next_cursor: null` means this page has no remaining rows. No redundant truncated
flag is added. Callers retain the same status filter while paging; these are
fresh reads, not frozen snapshots. Core/Command full lists remain unchanged,
so output is bounded but the underlying collection still scans all records.

`last` keeps records and pagination and adds nullable `transcript_path` through
the existing provider page, Core result, Command, and MCP. Providers may omit
`transcriptPath`; Core emits null. Both builtin readers return the actual
canonical path only on successful reads. Codex returns the current tail rollout,
possibly `.jsonl.zst`, even when a page includes ancestor lineage records. This
is not a complete list of source files. Failed reads keep existing errors;
locate failure does not invent a candidate path. Configuration-home drift remains
unresolved; there is no cross-home search, new persisted fact, or error contract.

The earlier provider-private-ID rule remains intact for admission and settlement.
The activity usability requirement adds a narrow observation exception: Core
passes an opaque ID without interpretation, persistence or submission mapping.
Activity records optionally include native `turn_id`. Codex reads only native
start/context IDs, scopes them to each scanned segment, and clears context at
matching completion/abort. Unknown window context remains unknown. Claude user
UUIDs are prompt identities, not native turns: multiple prompts can fold into
one result. Its conditional duration checkpoints can aggregate deferred turns,
so neither supplies a reliable turn ID or end marker. Claude therefore omits
turn_id; records, cursor and truncation retain their existing semantics. No
redundant role field or manufactured boundary is introduced.

### Cron inventory

`cron_list({id?, include_prompt?})` returns `{jobs:[{id,title?,cron,tz,enabled,
recurring,next_run_at,last_fired_at,prompt_preview,prompt_bytes,prompt?}]}`.
Preview is the first 200 Unicode code points; bytes measures the full UTF-8
prompt. `include_prompt:true` adds its full top-level prompt; `id` is an exact
filter and an unknown id returns an empty array. MCP omits action/kind and
created/updated timestamps. Input and rows stay closed. Scheduler Command,
DTO, state, create and update results remain unchanged. This is an output
reduction, not a new indexed store lookup.

### Implemented result values

Except for the capability catalog, status timestamps and activity metadata, these are
MCP-only projections of complete Command/domain records. The tables list the
internal compact business values: on nonempty text branches their actionable
facts are authored in prose instead of exposing these objects on the wire.
`?` marks optional fields. List/history rows retain their existing outer arrays;
history and activity pages retain `next_cursor`.

| TeamMate tool | Result | Removed from this response |
| --- | --- | --- |
| `get_capabilities` | `agent_runtimes: [{id, description?, tags?}]` | `verbs`; runtime `spawn`, `runtime_available`, `unsupported_reason`, `public_config` |
| `spawn` | `name, status, error?`; Dispatcher also gets `repo: {path, branch}` | Full teammate snapshot; Team members already share the Team workspace |
| `send` (owner/member) | `status, error?` | Full owner-side teammate snapshot; member-side name echo |
| `close` | `status, repo: {path, cleanup_state}` | Full teammate snapshot |
| `list` | `teammates, total, next_cursor`; rows: `name, status, agent_runtime, intent` | Full teammate snapshots; member scope retains `owner: {name, status}` |
| `history` | Rows: `name, status, agent_runtime, intent, source_repo, updated_at, close_note_preview` | `created_at, runtime_status, closed_at, close_note, cleanup_state, resume` |
| `last` | `status, runtime_status, last_error, records, next_cursor, truncated, transcript_path` | Full teammate snapshot and `requested_records, returned_records` |
| `status` | Full `teammate` detail plus `created_at, updated_at` | None |

TeamMate detail keeps `session_id`, complete repo policy/outcome, runtime status,
last error and full closure note. `truncated` cannot be inferred from a cursor.
The full closure note remains searchable even though history returns its preview.

| Team tool | Result | Removed from this response |
| --- | --- | --- |
| `create` | `team_name, status, leader_name, leader_agent_runtime, source_repo, runtime_cwd, worktree_mode, worktree_cleanup_mode` | Remaining summary details: 22 top-level fields become 8 |
| `send` | `status, error?` | `turn_id`; Command receipts retain it |
| `list` | `teams, total, next_cursor`; rows: `team_name, status, intent, source_repo, leader_state, member_count, worktree_cleanup` | `leader_name, leader_agent_runtime, created_at, updated_at, closed_at` |
| `history` | Rows: `team_name, status, intent, source_repo, updated_at, closed_at, close_note_preview, worktree_cleanup` | `leader_name, leader_agent_runtime, leader_state, member_count, created_at, close_note` |
| `dissolve` (Dispatcher/Leader) | `status: submitted` | Constant `accepted` and addressed/bound `team_name` |
| `status` (Dispatcher/Leader) | Full existing 22-field TeamSummary | None; Leader gains a zero-argument own-Team entry |

Team detail retains independent Team/Leader intent, lifecycle, closure and runtime
facts, including `leader_session_id`, plus workspace policy and cleanup outcomes.
Submitting dissolve does not report teardown completion.

| Workflow tool | Result | Removed from this response |
| --- | --- | --- |
| `workflow_run` | `run_id`, also stated in its authored text | No JSON copy or advertised output schema for the text result |
| `workflow_stop` | `status` | `run_id` echo |
| `workflow_list` | Rows: `run_id, status, phase, created_at` | Full run records including agent results |
| `workflow_status` | `run_id, status, phase, last_log, result, error, created_at, updated_at, ended_at, agents` | `version, dispatcher_id, team_id, caller_kind, script_hash, max_concurrency` |

Workflow status agent rows keep `index, name, label, status, phase, result, error`;
only their `created_at, settled_at` fields are removed. Stable invocation index
is not an array position.

| Feishu space tool | Result | Removed or replaced |
| --- | --- | --- |
| `bind_collaboration_space` | `space_name, chat_id` | Full `space` policy wrapper |
| `unbind_collaboration_space` | `unbound` | `space_name` echo |
| `list_collaboration_spaces` | Rows: `space_name, chat_id, display, leader_agent_runtime, repo_path` | `has_identity, repo_base_ref, created_at, updated_at` |
| `get_collaboration_space` | Full `space` policy and `targets` | Boolean `has_identity` becomes stored identity text or null |

The space detail still includes repository base ref and timestamps. An absent
space remains `{space: null, targets: []}`. Long identity text appears only in
the detail read. These four space tools do not emit success text, so their
output schemas remain advertised.

## Verification

Use actual SDK calls for wire/schema cases; explicit MCP/Command expected values;
configuration roundtrip and launch/resume tests; and exact space identity tests.
Keep cleanup, errors, cursor/truncation and member reply semantics. Run all Rush
gates plus the KB check and review source/test diffs together. Protocol tests prove
wire output; client visibility requires client evidence. Historical raw messages,
machine paths and private transport identifiers do not belong in this record.
