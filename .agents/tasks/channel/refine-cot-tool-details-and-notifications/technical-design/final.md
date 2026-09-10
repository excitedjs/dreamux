# Technical solution

## Current correction: divider spacing (2026-09-10)

Use the minimal-change fast path. Prefix the existing Channel-owned
`RESULT_DIVIDER` literal with U+00A0, the no-break space already used by
`preserveSpacing`. Keep the divider as its own text segment. Update the existing
result-segment expectations; introduce no helper, export, or shared contract.
The existing whole-event byte fitting includes the added character.

Run Rush build, lint, test, and typecheck:tests, knowledge checks, and change-file
validation. Request independent review of the concrete diff. A green payload
test verifies the transmitted string; client rendering requires live inspection.

## Current correction: result status labels (2026-09-10)

The current result-status amendment supersedes the success and failure label
rules below. The Channel's existing non-list result assembly always emits the
separate `\n\n---` divider after any arguments. It follows the divider with actual output when
present, otherwise with Complete or Failed from the call's status. Remove the
success-only empty-segment fallback and the conditional header, because every
non-list result now has this common structure. Keep list selection, the existing
event-size fallback, and byte fitting unchanged. No new mechanism or ownership
boundary is needed.

The final pre-merge refinement removes the literal RESULT word from that
segment. It changes no segment ordering or status condition.

Verify successful and failed text and JSON output, both outcomes without output
with and without arguments, the existing list/fallback cases, and event byte fitting.
Run Rush build, lint, test, and typecheck:tests, plus knowledge and change-file
validation. Use the minimal-change fast path and independent final review.

## Display ownership

The operator restored parameter display and explicitly ruled: "参数全给我放开，
不要做脱敏了". This supersedes the brief parameter-display withdrawal and the
proposed redaction repair. Keep runtime-specific interpretation in provider
`tool-display.ts` modules. The clean next baseline already supplies invocation
and tool_action; those facts suffice for Channel's code-language choice.
Providers keep their existing invocation extraction and shell unwrapping; they
do not need a new code-language classification for this display feature.
No new language field crosses RuntimeActivity or TeammateActivity. For the
approved native argument projection, the Codex
provider maps the native webSearch query/action fields into its existing argument
fact. Keep this protocol-specific extraction inside the provider; do not recover
queries from the display summary or add a cache.

At the existing Core conversation projection boundary, serialize structured
arguments without running the redactor and preserve the invocation string
unchanged. This applies equally to shell commands, scripts, and generic/MCP
arguments. Do not add a Channel-specific bypass flag or a configuration option.
Summaries, items, results, and input/assistant bodies remain under their existing
redaction rules. Completion producer names are host identity metadata, carried
unchanged like the actor scope's teammate_name. This is an explicitly selected
exception for argument details, not a global removal of redaction.

Retain Channel's baseline action-based tool names and title composition:
read/list_files/search/edit use Read/List/Search/Edit before a summary, while
run uses its summary without a prefix and Bash as its untitled name. The existing
edit action covers Write too. Tools without an action use the supplied summary
literally as title, or the supplied tool name when untitled. Remove the 80-byte
name cap under the subsequent explicit operator ruling. Keep the original title
fitting and final native event-size check; the operator rejected the added shared
title/name budget. Keep action icons. Do not add a provider field or infer another
action to restore these words.
A nonempty item list is the entire result presentation, regardless of status.
Other rows always select nonempty invocation before arguments_json, regardless
of notation, as explicitly ruled for R3. Channel uses its existing tool_action
fact: run invocation uses bash code; other invocation uses text code. This
is existing baseline behavior, not a language-detection feature. Only an absent
invocation selects the JSON/text
argument fallback. Keep this existing priority; do not apply the rejected
non-Bash JSON-priority proposal. Rows display that code segment without an
ARGUMENTS heading, per the operator's Alpha feedback, and then the
independent fixed `RESULT\n\n---` text segment immediately before the existing
output segment. Preserve the result's JSON/text, whitespace, and line-limit
rules. Put Failed inside the RESULT area: arguments, RESULT/divider, Failed,
then any actual output. A failure without actual output still emits the RESULT
label and Failed; success without output emits neither. Keep the success
empty-content and list-overflow fallbacks. The RESULT label shares the existing 4096-byte event budget
with the payloads. For approved R7, retain the existing result-then-argument
string fitting and final event-size check, and remove the three now-unreachable
whole-payload/status fallback branches. With lists handled separately, the two
variable strings can fit within the budget alongside their fixed labels. Do not
add a replacement fallback mechanism. The Channel
formats JSON and fits the complete encoded event; it does not redact arguments.
Keep the existing shared argument-formatting entry and its callers: the operator
rejected the R6 relocation proposal with "不改。其他地方还要用". Do not move that
work into the non-list RESULT branch as part of this task.

## Automated input provenance

Preserve the existing completion producer's kind and TeamMate source name through
ordinary submission into the neutral input projection. TeammateInputNotice carries
teammate_completion with producer or workflow_completion without a name;
TeammateInputEvent.notice is null for other inputs. This shape belongs beside the
input contract and carries only the facts this display consumes. Reuse the current admitted-input
path; do not create a new event family, parse notification bodies, expose all
model-envelope attributes, or change model-facing notification text.

Feishu maps that metadata and the existing cron/system source names to the
operator-selected English labels. Unknown/ordinary input continues through the
existing text display. Core retains the input-body redactor; notice.producer is
validated host identity metadata and travels unchanged like teammate_name.
The receiving agent's body and completion delivery behavior
remain unchanged. Workflow only needs its already-existing kind; no name or run
record changes are required.

## Implementation and review boundary

One developer owns implementation files/tests and release declarations. The
TeamLeader owns this record and repository knowledge. The developer may choose
local names and small helper shapes within the stated ownership constraints;
source evidence takes precedence over assumptions from the earlier checkout.

The operator discarded the first implementation on 2026-09-10. A new developer
starts from next at `7ed1d886964e520025cbc1e8151c8ff2eefd9a58`, with the old writer
closed and all non-.agents files restored to the baseline. Design from these
requirements and the baseline owners; do not replay the previous implementation.
Existing domain-page edits are retained design records pending reconciliation,
not evidence that the restored source already implements them. In particular,
argument display needs no new shared type or provider language contract. Any
neutral metadata required for the separate notification-label feature must carry
only missing producer facts; explain each shared-field change by that capability.

Keep the existing native START/END/RESULT order, the Core-owned field policies, Channel
call-generation tracking, provider caching behavior, ten-line text result rule,
and current state schemas. Verify both providers and the layer above each edited seam. Independent review
must challenge whether completion facts are sufficient and minimal,
whether only argument details bypass redaction, and whether list-only or byte
fitting paths produce unwanted details or orphan labels.

The verification and delivery plan is the requirement's final section. This
record captures the agreed presentation plus the necessary implementation
plumbing under the operator's explicit development instruction; it does not
claim that the operator selected individual type or helper names.
