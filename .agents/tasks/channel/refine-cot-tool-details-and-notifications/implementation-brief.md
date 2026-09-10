# COT display requirements

Make Feishu tool details readable and system notifications concise.

## Expected display

1. Keep the existing fixed action titles and icons. Other tools use summary as
   their title when present, otherwise tool_name. The operator subsequently
   approved removing its 80-byte cap; keep the original title fitting and native
   event-size check. The operator rejected the added shared title/name budget.
2. Calls with list items show only the list. Other calls show arguments first
   as a code segment, without an ARGUMENTS heading. Prefer invocation; use
   arguments_json only when invocation is empty. Keep the current bash/text
   choice for invocation; JSON argument objects/arrays use formatted json code.
3. Arguments and invocation are displayed without redaction or path rewriting.
   Other fields retain their existing redaction rules.
4. Before the result area, insert an independent text segment containing
   `RESULT\n\n---`. JSON result objects/arrays use formatted json code; other
   results remain text. Keep the existing whitespace filling, line truncation,
   and event byte limit.
5. On non-list failures, the order is: argument code, RESULT/divider, Failed,
   actual output. Failure without output still has RESULT and Failed. Preserve
   existing successful empty-content and list-overflow behavior.
6. Automated notifications display one short line:
   - `TEAMMATE CALLBACK · {name}`
   - `CRON TRIGGERED`
   - `WORKFLOW FINISHED` (no workflow name)
   - `SYSTEM RESTARTED` for the existing restart notice.
   The model still receives the complete original notification body.

## Boundaries

The starting code is next at `7ed1d886964e520025cbc1e8151c8ff2eefd9a58`.
Keep native tool event timing, argument/result pairing, source-id suppression,
and state/config formats. The existing tool action is sufficient for code
language selection; no new provider language-classification field is needed.
Include native Codex search query/action data in the displayed arguments.

## Completion

Implement and verify the complete behavior. Run the repository's Rush build,
lint, test, typecheck:tests, and built CLI smoke gates. Include appropriate
Rush change declarations and report verification results and real limitations.
The TeamLeader owns .agents, Git, PR, publication, and final external review.
