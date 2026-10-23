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
  tests establish that tool-authored actionable facts and the original reminder
  travel in one content block, without structuredContent or a JSON prefix.
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

The first whole-diff review found no remaining product blocker. Domain/Command facts,
owner admission, cleanup/lifecycle checks and stated errors retain their tests;
MCP expectations are independent explicit projections rather than comparisons
that could let both adapters be wrong together.

The subsequent external review found two gaps in the delivered draft, both fixed:

- Bound Leader status now checks Team openness inside its existing Leader-tool
  admission. A deterministic test holds the second worktree assessment after
  dissolve admission and before the closed write: Leader status and member
  list/send all reject, repeated dissolve still joins, and Dispatcher detail
  reads still work before and after closure. Shared `TeamService.status()` stays
  a projection because creation may legitimately return a Team whose initial
  Leader already self-dissolved; its existing regression test remains intact.
- The shim now preserves `text: ''`, which earlier layers already retained.
  The original admin-socket/shim/SDK test confirmed JSON-only content; the
  2026-10-23 authored-text refinement supersedes that representation with the
  structured value when text is empty, while keeping the shim's lossless pass.
  The SDK client transport in this test is in-memory, not child-process stdio.

A follow-up source review accepted both corrections without a new blocker.

For the operator-authorized authored-text refinement, the architect checked
the plan against actual producers. Creation text retains the Team's current
status even after initial self-dissolve; member send explicitly says submitted;
Feishu text distinguishes an exact previous binding from inherited routing.
Empty text selects the existing structured branch in the final adapter only.
Public Channel and Feishu extension contracts now require nonempty success text
to carry all actionable facts. The transport adds no JSON copy or new mode.

The subsequent whole-diff review found no new production blocker. Its stale
release-note finding was resolved by regenerating the three affected packages'
combined notes through Rush. Reminder tests retain the existing automatic-push
and no-polling assertions; new receipt facts are checked independently rather
than rebuilding the production formatter in the expectation. The fresh full
repository gates passed with 2,914 tests and six opt-in real-model cases skipped.

The operator's request for the detailed plan is answered by the exact field
matrix in the final solution, alongside the historical evidence rather than
an unmeasured token-savings percentage.

## Validation boundary

The protocol suites use the actual MCP SDK and real admin-socket shim. They cover
verbatim authored results, conditional absent/empty-text results, ordinary schema validation and
the SDK rejection of a text result whose provider still advertises an output
schema. Runtime tests cover initial launch and resume with fresh configuration.
Space tests check exact identity text, null and missing-space behavior.

Final repository gate results are recorded in the task README. Real-model gates
are opt-in and were not enabled; these checks do not certify live model behavior
or every installed Codex/Claude client. No deployed daemon or live settings were
changed.

## Style review corrections (2026-10-23)

The operator requested: "拉一下最新评论，把那些代码风格问题都修一下"
(Fetch the latest comments and fix the code-style issues.) The latest PR review
contains ten inline comments and one additional stale ownership comment. The
pre-edit architect review verified each against the rebased PR source.

- Quote names, paths, refs and runtime ids as Markdown-safe prose; JSON scalar
  quoting alone left links and backticks active. The pure formatter has one owner
  in dreamux-utils, shared by Core and Feishu without a Channel-to-Core dependency.
  URL autolinks, emphasis and entities stay literal; structured facts are unchanged.
- Publish the domain capability catalog directly, preserving a supplied empty
  description. Replace the stale pre-refactor provider-shaped test fixture.
- Share the two MCP dissolve receipt schemas without narrowing Command results.
- Give the owner/member compact roster schema and mapper one owner.
- Replace three identical record-delegate interfaces, finders and catalog
  wrappers with one implementation; handler admission and parsing order stay put.
- Close Team list/history schemas around their actual compact rows, including
  cleanup results; detailed Team status retains its open DTO contract.
- Correct workflow and TeamMate request comments to distinguish Command result
  ownership from MCP projections.
- Remove unused Feishu routing output schemas and allow definitions to omit
  them, while preserving registration behavior for existing extensions.
- Share only the routing target phrase; quote actual and previous Team names
  without changing routing facts, no-op behavior or notification guidance.
- Explain the alternate prompt representations without changing launch/resume
  instruction application or adding provider-specific conditions.

These corrections add no activity-path capability and perform no live service
upgrade, configuration write, or restart. Validation below applies to this
follow-up rather than treating earlier CI as evidence of the current diff.

Final style-review validation:

- Rush build, lint, test and typecheck:tests passed on the completed change.
  Across the eight test packages, 2,989 tests passed; six opt-in real-model cases
  were not enabled. No live service or native model-consumption claim is made.
- The first full run exposed a history fixture relying on two operations landing
  in different milliseconds. Its close operation now uses a distinct clock value,
  restored in finally; the original first/second page, full-note search and detail
  assertions remain intact. Production history sorting did not change.
- The independent architect reviewed the whole change and final deltas with no
  remaining findings. Direct Markdown-parser checks confirmed literal values;
  these are parser evidence, not a live Feishu-client visual check.
- Real SDK checks accept the compact Team list/history projections and reject an
  added internal field. Receipt fixtures cover literal rich-text inputs and keep
  the original structured facts, including Feishu chat/thread and binding names.
- Knowledge validation passed: 59 task records and 396 reachable files. Three
  ordinary minor change files cover Core, shared utils and Feishu; no migration
  or persisted-format change is introduced.
