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

The historical activity gap was reproduced against the current Claude reader:
non-participant attachments at the tail incorrectly excluded the last participant
from leaf selection. Only participants contribute child edges when selecting the
conversation leaf; the complete id map still supports traversal through other
native records. Synthetic fixtures cover the tail, sidechains and an intermediate
attachment. No private transcript data or home-search fallback is introduced.

## Verification

Use actual SDK calls for wire/schema cases; explicit MCP/Command expected values;
configuration roundtrip and launch/resume tests; and exact space identity tests.
Keep cleanup, errors, cursor/truncation and member reply semantics. Run all Rush
gates plus the KB check and review source/test diffs together. Protocol tests prove
wire output; client visibility requires client evidence. Historical raw messages,
machine paths and private transport identifiers do not belong in this record.
