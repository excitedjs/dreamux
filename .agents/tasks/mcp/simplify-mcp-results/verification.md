# Verification and historical evidence

## Historical consumption audit

DeepSeek reviewed 71 Claude sessions containing 649 Team/TeamMate calls and
153 Codex sessions containing 2,853 MCP-bearing executions. These are different
units and are not added into a single call total. The sample is local history,
not a claim about every client or provider.

- Across 2,611 capability runtime rows, spawn ids repeated the row ids;
  availability was true, unsupported reasons and public config were null, and
  tags were empty. Two conversations read runtime configuration to recover
  missing selection guidance. Configuration-owned descriptions and tags now
  provide that guidance.
- Models used session ids to locate native transcripts when status could not
  establish activity. Session ids remain in details. Record timestamps are
  exposed for age/recovery, explicitly not as last-activity or liveness facts.
- A Leader read persisted Team and agent records because its Team catalog
  exposed only dissolve. The bound status tool now supplies its own Team
  summary; member details remain available through teammate tools.
- A historical Claude activity snapshot returned zero records even though its
  transcript already contained messages and tools. Replaying that in-progress
  snapshot with the current reader reproduced the defect. Participant-only
  child edges fix leaf selection while retaining all records for ancestry.
  Three synthetic tests cover a non-participant tail, a sidechain and an
  attachment between participants; no real transcript is checked in.
- Many historical handoff results lacked visible reminders. Later reads were
  correlated with some such calls; this does not establish causation. SDK wire
  tests now establish that business JSON and the original reminder travel in
  one content block, without structuredContent.
- There were no current collaboration-space calls or workflow missing-field
  examples in the sample. Space identity follows the explicit operator request;
  workflow pruning is source-backed, not claimed as historical proof.

Missing observed reuse is not proof that a field is useless. Diagnostics,
workspace/cleanup outcomes, recovery intent, activity cursor/truncation and
workflow invocation indexes remain available where they support an action.
Changing a runtime's configured home can still make an older native session
unavailable there; no filesystem-discovery fallback is added.

## Independent review

The architect reviewed the whole source and assertion diff, including the final
member-scope extraction and Claude reader change. Accepted findings were fixed:

1. Onboarding now preserves metadata for both the selected existing runtime and
   unrelated entries; a new id does not inherit another runtime's metadata.
2. Workflow agent indexes remain in status because failed invocations can leave
   gaps, and an unmaterialized agent may have neither a name nor a label.
3. Status fixtures include real timestamps without a double type assertion.
4. Descriptor checks cover both owner and member send tools, despite their
   identical public names.
5. Linux CI exposed an existing lifecycle-test teardown race: persisted Team
   `closed` precedes child destruction. The reuse-cwd test now also awaits the
   existing `TeamService.closed` signal before checking completion suppression
   and removing its files. Receipt/status assertions remain, and no retry,
   sleep or product-lifecycle change is added. The adjacent workflow test already
   uses this completion boundary.

The final source review found no remaining product blocker. Domain/Command facts,
owner admission, cleanup/lifecycle checks and stated errors retain their tests;
MCP expectations are independent explicit projections rather than comparisons
that could let both adapters be wrong together.

## Validation boundary

The protocol suites use the actual MCP SDK and real admin-socket shim. They cover
content-only results, conditional no-text results, ordinary schema validation and
the SDK rejection of a text result whose provider still advertises an output
schema. Runtime tests cover initial launch and resume with fresh configuration.
Space tests check exact identity text, null and missing-space behavior.

Final repository gate results are recorded in the task README. Real-model gates
are opt-in and were not enabled; these checks do not certify live model behavior
or every installed Codex/Claude client. No deployed daemon or live settings were
changed.
