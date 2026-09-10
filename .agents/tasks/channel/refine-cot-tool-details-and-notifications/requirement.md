# Requirement

## Current correction: divider spacing (2026-09-10)

Operator instruction: "给他 \n\n--- 前面加一个不可见字符，就和 result 的空白字符处理一样，改成 {不可见字符}\n\n---".

The operator reported that removing the RESULT heading in #403 rendered poorly
in Feishu and requested an invisible character before `\n\n---`, using the
same character as result whitespace preservation. The divider becomes
`\u00a0\n\n---`. This supersedes only the divider literal below; all result
content, ordering, and status rules remain in force.

## Current correction: result status labels (2026-09-10)

After reporting that Failed was much more visible than Completed, the operator
directed "那把固定插入的失败也干掉。", then narrowed that instruction:
"不对，如果有输出就干掉，没有输出的时候才显示成" with this exact layout:

```text
RESULT
---
Failed
```

The operator then aligned success:
"成功也保持对齐，有输出就不显示 Complete ，没有输出才显示",
followed by RESULT, the divider, and Complete.

Before merge, the operator additionally requested:
"稍等，额外增加一个小点，就是给 RESULT 这个leading 字符删掉，只保留 /n/n--- 这个分割线".
Remove only the RESULT word; the separate text segment becomes `\n\n---`.

For ordinary tool rows, show the divider immediately before actual
output, without an additional fixed status segment for either outcome. When no
output exists, show the divider and Complete or Failed according to the
call's status, whether or not arguments exist. Use the operator's Complete
spelling. List-only rows and the existing event-size fallback retain their
behavior. Do not infer a status from the output text.

This supersedes the earlier Failed-before-output and successful-empty-content
requirements below and the interim "RESULT 标题同行" selection. Development was
authorized by "从 next 切分支出来修" and resumed by these corrective instructions.

## Starting point

This is a new implementation of the requested tool details and concise system
notifications on next, not a repair of the discarded feature patch. Next already
has the fixed Read/List/Search/Edit/Bash action names and title words. Keep that
existing behavior. Next has no added provider/shared invocation-language contract
to remove. The operator corrected the TeamLeader's framing explicitly:
"我是说我最初定下来的需求。现在代码都让你回退了，哪还有恢复这一说了？"
Historical corrections below explain the desired presentation; they are not a
checklist of old code to rebuild and then repair.

## Operator decisions

The operator selected the following behavior after comparing private COT
rendering probes. Quotes preserve the decisions; the rules below state their
implementation boundary.

- "有 summary 的时候用 summary 作为title" and
  "没有 summary 的时候 传递 tool_name". The later Alpha correction preserves
  the existing fixed action words: "你怎么把我那几个固定标题给我删了？就是 Read
  edit、write、search、这几个。", followed by "那几个固定的Read Search 之类的单词
  你给我恢复了吗？". The TeamLeader's earlier removal of all action prefixes
  was too broad. The next baseline already has the required action naming/title
  rule, which remains in place; generic tools
  without an action still use the literal summary or tool_name.
- "原始需求里有提过要动这个 80 截断逻辑吗？为什么替我做决定？" (2026-09-10).
  The TeamLeader had expanded tool_name into an uncapped-name requirement
  without authorization. That interpretation and the resulting removal request
  were withdrawn. The subsequent explicit ruling supersedes preservation:
  "算了去掉就去掉吧，我还没见过超过 80 字符的 toolname". Remove the 80-byte
  tool-name cap under this new authorization, not as an inferred original demand.
  On the separate START title/name budget question, the operator then selected
  "保持原事件处理 (Recommended)": remove only the approved 80-byte cap and
  withdraw the added shared-budget rule. Keep the original title fitting and
  final event-size check.
- "args 作为第一个代码段传递": shell invocations use Bash code and JSON
  arguments use JSON code. After initially saying "这么麻烦就先不展示参数了",
  the operator immediately superseded that withdrawal with "你把参数给我展示出来吧，
  先不做脱敏了", then clarified "参数全给我放开，不要做脱敏了".
  All argument detail is displayed without redaction, including existing shell
  invocations and newly visible generic/MCP JSON. The proposed redaction repair
  is not requested.
- "那确实应该优先显示invocation ，而不是arguments_json。
  只有invocation为空，才显示arguments_json" (2026-09-09, R3). This priority
  applies to every tool; it is not limited to Bash.
- "result 如果是 json 就放进代码段，不是的话就继续作为 text 节点插入。
  保留现在的空白字符填充逻辑。"
- "他们有 list，那就只渲染 list。" This takes precedence over the earlier
  mistaken suggestion to expand arguments/results for file-list rows.
- "就是在现在的 result 块前面插入一个新 text 块" with the fixed RESULT label
  and a horizontal divider. A blank line separates the label and `---`, so the
  label does not become a Markdown setext heading.
- "ARGUMENTS 这个标题给删了，只保留 RESULT" (2026-09-09, Alpha feedback).
  Remove the argument heading only; keep the argument code segment and the
  independent RESULT label/divider. This supersedes the earlier argument label.
- "确实，这个顺序问题要修一下。" (2026-09-10), after the operator observed
  Failed before the arguments. Put the failure text in the RESULT area: argument
  code first, then RESULT/divider, then Failed and any actual output. A failed
  call without actual output still has a RESULT area containing Failed.
- "那你这就是在给provider适配增加负担。" (2026-09-10), after examining the
  previous attempt's inferred invocationLanguage field. That discarded
  implementation is not part of the new baseline. Use the existing Channel
  action-based code-language choice; fine-grained script-language detection is
  not a requested capability. Argument content remains visible.
- Automated push-backs should be one line: `TEAMMATE CALLBACK` and the producer's
  name, a cron-trigger label, and `WORKFLOW FINISHED`.
- "workflow 先不展示 name 了" (2026-09-09): no Workflow name extraction or display.
- The operator deferred further discussion of provider argument/result caching:
  "先不管这个了". Do not redesign that lifecycle in this task.

## Accepted behavior

1. Preserve the existing action-based names and title words. Baseline names are
   Read, List, Search, Edit, and Bash for read, list_files, search, edit, and run.
   With a summary, the first four prefix that summary with their action word;
   run keeps the summary as-is. Without a summary, omit the title and show the
   action name. The existing edit action also covers Write; no new Write action
   or provider classification is requested. For tools without an action, use
   the nonblank summary itself as title, or tool_name when untitled. Remove the
   existing 80-byte name cap under the later explicit operator ruling.
   Keep existing action icons. Generic titles do not add a tool-name prefix,
   and untitled generic rows use tool_name. Keep the native event-size limit.
2. When items produce a list, display that list alone; the rule is based on the
   supplied items, not an allowlist of tool names. Do not add arguments, RESULT,
   a divider, or output to list-only content, including failed calls with items.
   Keep the existing list budgeting and overflow fallback: after the known
   many-short-items issue was presented as R2, the operator ruled "不用动。下一个".
   This narrow baseline limitation is accepted for this task.
3. Otherwise display an argument code segment without an ARGUMENTS label when
   arguments exist. Always select a nonempty invocation before arguments_json,
   regardless of tool or notation. Use the existing Channel rule: invocation
   code is bash when tool_action is run, otherwise text. Only when invocation
   is empty, use arguments_json:
   pretty-print JSON objects/arrays as JSON code, otherwise use text code.
   Do not add a provider language-detection field for this display choice.
   All argument payloads and displayed invocation strings
   bypass Core redaction, including secret masking and path rewriting; JSON
   serialization and Channel byte fitting still apply. This exception does not
   change the existing redaction of summaries, items, results, or input/assistant
   bodies. Do not introduce a configuration flag or a new redaction mechanism.
   Include Codex webSearch's existing query/action parameters in its argument
   projection so calls without invocation can show them. The operator approved
   this R4 mapping with "好的。"; native pairing is unchanged.
4. Before each existing nonempty output segment or failure indication, insert the separate segment
   `{ "type": "text", "text": "RESULT\n\n---" }`. Preserve the output's current
   JSON-object/array versus text classification, ten-content-line text limit,
   whitespace filling, redaction, and final per-event byte limit. Do not prepend
   the label inside the output/code string. On ordinary non-list failed rows,
   place the existing Failed text after the RESULT label and before actual
   output; it never precedes arguments. Emit RESULT and Failed even when that
   failed call has no actual output. Keep successful empty-content and the
   previously retained list-overflow fallbacks unchanged.
5. Display automated inputs as one-line labels:
   - TeamMate completion: `TEAMMATE CALLBACK · {producer_name}`.
   - Due cron fire: `CRON TRIGGERED` (the aligned English wording for a fire).
   - Workflow terminal callback: `WORKFLOW FINISHED`, without a name or run ID.
   - The current Core system input (Dispatcher restart): `SYSTEM RESTARTED`.
   Keep actual task submissions and other ordinary input bodies visible. Keep
   source-id recognition of the Channel's own inbound body intact.
6. Simplification affects the human COT display only. The receiving agent still
   receives the existing full notification and task body. Do not parse prose or
   XML to infer notification kind/name; retain the submitting owner's facts.

## Baseline and current evidence

Implementation starts at freshly fetched next commit
`00b858efa2f9cfdb7fdbf829aac9cfe0856b6915`. Earlier investigation used a different
checkout; facts must be checked against this baseline.

The original implementation is superseded. On 2026-09-10 the operator directed
restoring every non-.agents file to next, restating the requirements, and assigning
a new developer. The freshly fetched restart baseline is
`7ed1d886964e520025cbc1e8151c8ff2eefd9a58`; all implementation files and the branch
HEAD were reset to it, with only .agents records retained. The new developer
implements these requirements from that source, not by replaying the discarded
feature patch. Previous Alpha, review, and test evidence is historical.

- Both start and completion tool activities cross Core projection with
  arguments, invocation, items, and result fields. The current Channel renders
  invocation but not the full `arguments_json`.
- Claude pairs native tool_use/tool_result in its provider. Codex projects each
  native item independently. Channel only tracks call ID/card generation.
- `TOOL_CALL_END` marks parameter completion and precedes execution results.
  `list` is supported in `TOOL_CALL_RESULT.content`; native titled rows hide
  `TOOL_CALL_ARGS`. These choices and event order remain in force.
- Completion producers distinguish TeamMate and Workflow before the recipient
  currently reduces both to a text-only task-notification input. TeamMate facts
  carry the producer name. Cron and restart already have distinct sources.
- Latest next has no Workflow record name. The operator explicitly excluded
  displaying it, so no name/state/compiler change is necessary.

Source owners:

- `/packages/agent-runtime/claude-code/src/runtime-activity.ts`
- `/packages/agent-runtime/codex/src/turn-manager.ts`
- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/service/completion-router/index.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-events.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-presentation.ts`

## Scope and validation

Implement within runtime display facts, neutral conversation projection, and
Feishu presentation. Keep native event timing, argument/result pairing, card
lifetime, routing, completion delivery, and persisted state formats intact.
The operator explicitly changed the argument/invocation redaction contract;
leave the other projection fields under their existing policy. No Workflow-name
capability, new retry/cache, separate notification bus, or redaction rewrite.

Verify exact tool event/segment order, restored action titles and generic summary/name selection, generic JSON
arguments, Bash versus other invocations, unredacted argument/invocation values
using synthetic secrets and paths, preserved redaction on other fields,
list-only success/failure, RESULT as an independent segment, byte boundaries
with Unicode, unchanged text/JSON output rules, notification provenance/redaction,
and source-id suppression. Run the
repository build, lint, test, and typecheck:tests gates plus built CLI smoke,
knowledge checks, release declarations, and independent review. Create a PR to
next, dispatch the existing feature-branch Alpha release, and verify its exact
published package version before reporting delivery.
