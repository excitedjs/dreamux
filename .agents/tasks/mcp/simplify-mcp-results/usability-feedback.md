# Dispatcher usability feedback

## Provenance and scope

The Dispatcher supplied this read-only field report on 2026-10-23, identifying
the installed Dreamux version as `0.28.0-alpha.ga826d111d713`. The request was to
record it as input for improvement work. The counts and byte sizes below are
reported observations, not measurements reproduced by this change. No original
tool-call payloads accompanied the report.

The central observation is that smaller rows do not bound the number of rows:
single-resource reads improved, but accumulated closed resources still dominate
list responses. This note records follow-up candidates; it does not authorize
changing list defaults, adding pagination, or altering activity contracts.

## Reported observations

| Surface | Reported result or user need |
| --- | --- |
| `team.status` | Complete Team/leader state, workspace, worktree policy and cleanup result, and member count avoid a second read. |
| `teammate.status` | Repository details, session ID, runtime status, error and close note remain available. |
| `teammate.list` | 998 rows / 139,946 bytes: 976 closed, 22 stopped, none running. No status filter, limit, cursor or truncation marker. Finding active members requires fetching and filtering the full collection. |
| `team.list` | 420 rows / 101,392 bytes: 394 closed and 26 running. Compact rows retain useful leader state, member count and cleanup facts, but the result is unbounded. |
| `cron_list` | 4,130 bytes, including 3,368 bytes of complete prompts across three jobs. Reading the next execution time also retrieves all instructions. |
| `team.history` | A limit of three returned three items, with a usable next cursor. |
| `list_bindings` / `list_subscriptions` | Empty arrays add no unrelated output. |
| `get_collaboration_space` | The reporter saw `has_identity` instead of identity text and needed persisted routing data to preserve identity when rebinding. This conflicts with independently exercised installed handlers; see below. |
| `list_collaboration_spaces` | The reporter described `has_identity` in compact rows. This also conflicts with the checked installed handler. |
| `teammate.last` | Consecutive assistant messages lack turn boundaries, making multiple turns difficult to distinguish. |

## Source checks and discrepancies

### List size is unbounded; a 1,000-row ceiling is not established

The reporter suspected that 998 rows approached a roughly 1,000-row cap. The
checked [Agent store](/packages/dreamux/src/service/agent/store.ts) enumerates
all valid collection directories and reads their identities. The
[Agent collection](/packages/dreamux/src/service/agent/index.ts) filters for
ownership and maps statuses without a numeric limit. The
[Team store](/packages/dreamux/src/service/team/store.ts) and
[Team collection](/packages/dreamux/src/service/team/index.ts) likewise list
readable records without a numeric cap. MCP list descriptors have no pagination
inputs. The reported count alone is not evidence of silent truncation at 1,000.

### Space identity is already returned by the installed implementation

An independent read-only check exercised both repository handlers in
[the validated PR revision](https://github.com/excitedjs/dreamux/actions/runs/39926763644)
and the exact installed host/channel packages:
`@excitedjs/dreamux@0.28.0-alpha.ga826d111d713` and
`@excitedjs/feishu-channel@6.5.0-alpha.ga826d111d713`.
Real parse/handle functions received synthetic records with a string identity,
a null identity, and a missing space. No private routing records were read.

- `get_collaboration_space` returns `{ space, targets }`; `space.identity`
  preserves the string or null. There is no `has_identity` field.
- `list_collaboration_spaces` returns five fields per row: `space_name`,
  `chat_id`, `display`, `leader_agent_runtime`, and `repo_path`. Neither identity
  text nor `has_identity` is included.
- A missing space returns `{ space: null, targets: [] }`.
- Installed output schemas agree with these results. Attempts to register
  synthetic Dispatcher extensions with either built-in name were rejected;
  same-caller extension shadowing does not explain the discrepancy.

Owners: [space tools](/packages/channel/feishu-channel/src/tools/space-tools.ts)
and [extension registration](/packages/channel/feishu-channel/src/feishu-extensions.ts).
This proves the installed on-disk handlers, not the running daemon's loaded
modules or the reporter's original request. Preserve the original tool name,
arguments and raw result in a private diagnostic follow-up before attributing
the mismatch to a version, session or routing problem. Do not record identity
retrieval as a confirmed missing feature.

### Activity already distinguishes assistant and tool records

The [activity projection](/packages/dreamux/src/service/agent/activity.ts)
returns assistant records with `kind`, `text`, and `occurred_at`, and tool records
with `kind`, `name`, `status`, and `occurred_at` when tools are included. It has no
turn identifier. A role field that merely repeats `assistant_message` would not
resolve the reported turn-boundary problem. Any boundary fact must come from
the runtime activity seam rather than be inferred from timestamps in Core.

## Follow-up candidates in reported priority order

1. Add status filtering and bounded pagination to TeamMate/Team lists. Evaluate
   a non-closed or recent-items default, explicit total/truncation semantics, and
   a cursor. Default filtering is a behavior decision: retain an explicit way
   to find closed resources for recovery, and account for member roster scope.
2. Replace complete cron prompts in list rows with a bounded preview and
   `prompt_bytes`, with an explicit way to retrieve the full prompt before editing.
   The proposed preview length is approximately 200 characters. The current
   [scheduler MCP](/packages/dreamux/src/service/scheduler/mcp.ts) returns complete
   job results; do not remove the only full-prompt read without a replacement.
3. Resolve the space-identity observation mismatch. The requested identity read
   already exists in the checked installed implementation.
4. Evaluate provider-backed turn boundaries for `teammate.last`. Preserve
   existing records, pagination and tool observations. The separate proposed
   `transcript_path` capability remains unimplemented in this release.

No production behavior, configuration, installed package or service lifecycle
was changed while recording this input.
