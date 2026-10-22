# Technical solution

## Ownership

`agents[]` owns optional description, tags and developerInstructions. Parsing and
stringification preserve supplied values. Capability selection reads resolved
entries, omitting unspecified descriptions and empty tags. Onboarding preserves
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

## Wire behavior

Only the final SDK adapter selects the wire representation. With text present,
serialize compact business JSON and append original text in one content block;
omit structuredContent. Otherwise keep structured output. Internal
`{structured,text?}` and errors remain unchanged.
The shim preserves an empty text string as present: it produces JSON-only
content, not structuredContent, on the actual admin-socket path as well.

Core text-capable tools omit outputSchema. Feishu's existing successText hook
supplies the same fact for builtin/extension registration. Ordinary schemas and
validation remain. No new mode or redundant runtime validation is added.

External Channel providers must omit outputSchema for any tool that may return
text. This changes their old contract: an unadapted schema-plus-text tool can
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

Except for the capability catalog and added status timestamps, these are
MCP-only projections of complete Command/domain records.
`?` marks optional fields. List/history rows retain their existing outer arrays;
history and activity pages retain `next_cursor`.

| TeamMate tool | Result | Removed from this response |
| --- | --- | --- |
| `get_capabilities` | `agent_runtimes: [{id, description?, tags?}]` | `verbs`; runtime `spawn`, `runtime_available`, `unsupported_reason`, `public_config` |
| `spawn` | `name, status, error?`; Dispatcher also gets `repo: {path, branch}` | Full teammate snapshot; Team members already share the Team workspace |
| `send` (owner/member) | `status, error?` | Full owner-side teammate snapshot; member-side name echo |
| `close` | `status, repo: {path, cleanup_state}` | Full teammate snapshot |
| `list` | Rows: `name, status, agent_runtime, intent` | Full teammate snapshots; member scope retains `owner: {name, status}` |
| `history` | Rows: `name, status, agent_runtime, intent, source_repo, updated_at, close_note_preview` | `created_at, runtime_status, closed_at, close_note, cleanup_state, resume` |
| `last` | `status, runtime_status, last_error, records, next_cursor, truncated` | Full teammate snapshot and `requested_records, returned_records` |
| `status` | Full `teammate` detail plus `created_at, updated_at` | None |

TeamMate detail keeps `session_id`, complete repo policy/outcome, runtime status,
last error and full closure note. `truncated` cannot be inferred from a cursor.
The full closure note remains searchable even though history returns its preview.

| Team tool | Result | Removed from this response |
| --- | --- | --- |
| `create` | `team_name, status, leader_name, leader_agent_runtime, source_repo, runtime_cwd, worktree_mode, worktree_cleanup_mode` | Remaining summary details: 22 top-level fields become 8 |
| `send` | `status, error?` | `turn_id`; Command receipts retain it |
| `list` | Rows: `team_name, status, intent, source_repo, leader_state, member_count, worktree_cleanup` | `leader_name, leader_agent_runtime, created_at, updated_at, closed_at` |
| `history` | Rows: `team_name, status, intent, source_repo, updated_at, closed_at, close_note_preview, worktree_cleanup` | `leader_name, leader_agent_runtime, leader_state, member_count, created_at, close_note` |
| `dissolve` (Dispatcher/Leader) | `status: submitted` | Constant `accepted` and addressed/bound `team_name` |
| `status` (Dispatcher/Leader) | Full existing 22-field TeamSummary | None; Leader gains a zero-argument own-Team entry |

Team detail retains independent Team/Leader intent, lifecycle, closure and runtime
facts, including `leader_session_id`, plus workspace policy and cleanup outcomes.
Submitting dissolve does not report teardown completion.

| Workflow tool | Result | Removed from this response |
| --- | --- | --- |
| `workflow_run` | `run_id`, unchanged business value | Only the advertised output schema changes for its reminder |
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
