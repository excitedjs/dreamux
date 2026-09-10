# Verification

## Current correction: divider spacing (2026-09-10)

Baseline: `origin/next` at `ecfb378d`, including merged #403.
Branch: `fix/cot-result-divider-spacing`.

The result divider is now `\u00a0\n\n---`. U+00A0 matches the character
already used by `preserveSpacing` for text results. Existing segment-output
assertions cover text, JSON, missing output, and event budgets with this prefix;
no new test or mechanism is needed for the literal change.

Passed: `node common/scripts/install-run-rush.js build`, `lint`, `test`
(including real Codex), and `typecheck:tests`; `.agents/scripts/check.sh`;
`git diff --check`. The existing Feishu result tests pass with the updated
transmitted segment. The full test suite completed in 2 minutes 20 seconds.

TeamLeader pre-review confirms that the product diff only prefixes the existing
divider literal; it stays in the Feishu presentation owner and adds no contract,
state, or mechanism. Product and Channel documentation reflect the new literal.
Rush generated a patch change file; committed change-file validation passed.

Implementation commit `8ef9e6fb` passed all nine CI checks on PR #404.
Release run `34440974386` succeeded for that exact commit, including the built
CLI smoke and packed-artifact audit. npm metadata confirms
`@excitedjs/dreamux@0.25.1-alpha.g8ef9e6fb9676` depends on the matching
`@excitedjs/feishu-channel@6.2.1-alpha.g8ef9e6fb9676`.

External independent review is pending. Client rendering has not been
inspected, and the running service has not been changed.

## Current correction: result status labels (2026-09-10)

Baseline: `origin/next` at `22cf0a7a53ea636daad9c939ff2185e3379bc42e`.
Branch: `fix/cot-status-placement`. This is the follow-up to merged PR #401;
all older attempts and review records below are historical.

The only product-code change is the Channel's non-list result-segment assembly.
Both outcomes now render arguments when present, a `\n\n---` divider, then
actual output or the appropriate no-output status, Complete or Failed. The
conditional header, unconditional failure line, and separate successful-empty
fallback were removed. Provider/Core facts, list rendering, event-size fallback,
formatting, redaction, and card lifetime are unchanged.

Validation on the initial status implementation (before the final heading removal):

- `node common/scripts/install-run-rush.js update`: passed.
- `node common/scripts/install-run-rush.js build`: passed.
- `node common/scripts/install-run-rush.js lint`: passed.
- `node common/scripts/install-run-rush.js test`: passed, including the real
  Codex integration and non-blocking-inbound live gate. Runtime tests emitted
  expected diagnostic warnings; the command exited successfully.
- `node common/scripts/install-run-rush.js typecheck:tests`: passed.
- `.agents/scripts/check.sh`: passed (223 files reachable).
- `git diff --check`: passed.
- Rush patch change file: generated with `rush change --bulk`; verification
  against `origin/next` passed after the change file was committed.
- Mandatory pre-commit staged ESLint, author, gitleaks, and internal-content
  gates: passed.
- GitHub CI on implementation commit `85c34b7a`: all nine checks passed,
  including the Linux and macOS Rush jobs.

Behavioral coverage includes actual failed text/JSON output without an added
status line, successful text/JSON output, both outcomes with no output with and
without arguments, existing lists and oversized-list fallback, and long Unicode
arguments/output staying inside the event budget. Assertions that previously
required Failed beside output or omitted RESULT for empty success were updated
against the operator's new explicit requirement.

Independent external review approved
[PR #403](https://github.com/excitedjs/dreamux/pull/403) at implementation commit
`85c34b7a`, recorded on `f45e46b9`; there were no blocking findings. The operator
authorized merge and then requested removing only the RESULT word, preserving
the `\n\n---` divider. This final refinement changes the fixed segment and its
expected value, with no change to status conditions or event order. On this final
refinement, Rush build, lint, full test (including real Codex), and
typecheck:tests were rerun and all passed. Exact text/JSON and empty-output
segment assertions now require the divider without a heading. Knowledge and
diff checks passed. All nine GitHub CI checks passed on `cc3904cf`. The selected
external reviewer approved that final implementation in a second GitHub review
and reported no blocking findings. The review covered the heading removal and
its interaction with the already-approved status, list, and fitting behavior.
Only task closeout records change after that reviewed implementation; no further
product-code or test change is included. Merge is authorized by the operator.

No package has been installed into the running service and no service restart
or live-client visual acceptance is claimed for this correction.

## Historical attempt: restarted from next on 2026-09-10

The operator stopped the prior attempt and requested restoring all non-.agents
files to next before a new developer starts. The old writer was closed, origin/next
was fetched, and local HEAD is now `7ed1d886964e520025cbc1e8151c8ff2eefd9a58`.
`git diff --exit-code origin/next -- . ':(exclude).agents'` and the index check
both passed; status showed only retained .agents changes. No previous product
patch remains in this baseline. The remote PR and published Alpha have not been
rewritten by this local reset.

The following previous-attempt reviews, gate runs, and publications are historical
evidence only. Fresh implementation, full verification, and external review are
required for the new attempt. The current requirement preserves baseline fixed
action titles, puts Failed in RESULT after arguments, and excludes any new
provider language-classification contract.

The operator subsequently corrected the requirement playback: existing next
behavior is retained, not "restored" by the new developer. The new task is tool
argument/result presentation and concise notification labels. The TeamLeader
sent this framing correction to the new developer; no additional reset or
reintroduction of the discarded implementation was requested.

## Name-cap correction during the new pre-review

The TeamLeader incorrectly treated the existing 80-byte name truncation as a
requirement defect. The operator objected: "原始需求里有提过要动这个 80 截断逻辑吗？
为什么替我做决定？" The original requirement said tool_name, not an uncapped
name. The TeamLeader withdrew the removal request and corrected the brief,
requirement, design, and product/Channel records. The old speculative
oversized-name finding did not authorize removing it.

The operator then explicitly decided: "算了去掉就去掉吧，我还没见过超过 80 字符的
toolname". This later ruling authorizes removal of the cap. The TeamLeader
forwarded it to the same developer and updated the current requirement; the
original overreach remains recorded above rather than retroactively justified.

## Claude implementation pre-review

The TeamLeader inspected the complete package diff and the changed assertions
against the recorded user decisions. Fixed action titles remain as in next;
generic summaries no longer gain a tool-name prefix. Non-list content is argument
code, RESULT/divider, failure text when present, then output. No-output failure
and argument-only success are covered, along with invocation priority, raw
arguments, result/body redaction, list-only failure, notification labels, and
the retained list-overflow limitation. Native timing and provider pairing are
unchanged.

The follow-up removed the name cap as authorized, but also introduced a shared
START title/name byte budget: title is fitted first and name takes the remainder.
The latter is an additional behavior decision, not an accepted consequence of
the cap-removal ruling. The operator selected "保持原事件处理 (Recommended)" on
the separate question: withdraw the shared-budget addition and keep the original
title fitting and final event-size check. The final follow-up implements this
ruling; the TeamLeader verified the START name/title assignments against next.

The developer reports all five gates passing on this follow-up tree and supplied
`common/temp/gate-logs/rush-*.log`; the TeamLeader inspected the build, lint,
test, test-typecheck, and smoke completion summaries. The change-verification
log uses the default origin/main comparison, so it does not validate this PR
against next; rerun with an explicit origin/next target after committing. The
previous trailing blank line is removed, and the final `git diff --check` passes.
Skill validation and the repository KB check pass independently.

Final local checks after the budget-rule withdrawal:

| Gate | Result |
| --- | --- |
| Rush build | Passed, 2 operations executed and 6 cached |
| Rush lint | Passed, 7 operations |
| Rush test | Passed, 2418 tests across 7 packages; expected stderr warnings in 3 packages |
| Rush typecheck:tests | Passed, 6 operations |
| Rush smoke-built-cli | Passed, 1 operation |
| git diff --check | Passed |
| dev-workflow skill validation | Passed |
| .agents/scripts/check.sh | Passed, 223 reachable KB files |

The removed test covered only the rejected shared START budget. The approved
long-name test and existing event-size assertions remain. No live Feishu probe or
service installation was performed for this replacement implementation. A fresh
fetch confirms that next remains at the restart baseline. Independent final
review remains assigned to the operator-selected external reviewer; local gates
do not substitute for that review.

The first commit attempt was rejected by the mandatory pre-commit gitleaks scan:
`curl-auth-header` matched synthetic command fixtures in
`feishu-cot-tool-rows.test.ts` and `cot-projection-privacy.test.ts` (four matches).
No commit was created and no guardrail was bypassed. AGENTS.md requires asking
on guardrail false positives; replacing these authentication-header fixtures
with plain diagnostic commands while retaining the assertions was proposed.
The operator approved modifying the test samples. Because the question card
routed outside the original topic, its verified answer was forwarded by a
coordinating Team. That Team closed without making edits and explicitly returned
fixture ownership. This TeamLeader replaced the fictitious authentication-header
commands with `echo "token: dummy"`, preserving raw-argument and other-field
redaction assertions. The internal-content gate also rejected the fictitious
home-directory path in that sample; the same approved fixture-only correction
uses `/tmp/cot-output.txt` instead, preserving the path-propagation assertion.
The original developer remains idle; this TeamLeader owns
verification, documentation, staging, commit, and publication. Scan rules remain
unchanged.

After that fixture-only edit, full Rush test, lint, and typecheck:tests pass
again, and staged gitleaks reports no leaks. The original raw-argument and result/summary/item
redaction assertions remain; production source is unchanged by this follow-up.

While that question was pending, a separate existing ask-user routing defect was
confirmed in source and installed code: sending a question card does not observe
its returned message ID in the target router. The answer exposes that card ID;
a later question addressed to it misses the router lookup and falls back to the
group, dropping the reply anchor. Send logs confirm an anchored first card and
an unanchored second card. The fix is outside the current COT implementation;
use an observed ordinary message from the original topic for subsequent questions.

The developer's three reported questions are adjudicated as follows:

- Producer name: accept unchanged identity metadata. Completion source comes
  from the host producerName in turn-recording.ts; identity-store.ts validates
  names at creation, and actorScope already carries identity.name unchanged as
  teammate_name. The original design's payload redactor on this new identity
  field was a TeamLeader implementation assumption, now corrected. Existing
  notification-body redaction remains unchanged.
- Result fitting: accept the removal of unreachable whole-payload fallbacks
  under the already-approved simplification ruling; the final event-size check
  and known list fallback remain.
- Failed list rows: accept list-only as explicitly required for calls with
  items regardless of status. The changed test is a documented product decision,
  not a hidden weakening of error-display coverage.

## Previous attempt: review and implementation state

The initial shared xhigh review completed with seven finders, nine candidates,
nine verifiers, seven grouped findings, and no coverage failures. TeamLeader
adjudication and the operator rulings are recorded below. Every initial finding
now has a disposition. The original writer completed R4 and R7 together; the
TeamLeader inspected their complete diff and checked the final combined gate
logs. Final review of the complete resulting change is assigned to the
operator-selected external reviewer and remains pending.

Implementation started from freshly fetched next commit
`00b858efa2f9cfdb7fdbf829aac9cfe0856b6915`, before any implementation write. The
branch has not been rebased; later next commits do not change that starting fact.

## Round 1 adjudication and operator rulings

| ID | Finding | Disposition and source evidence | Operator ruling and boundary |
| --- | --- | --- | --- |
| R1 | Escaped quoted secrets survive argument redaction | Superseded by explicit raw-argument policy; implemented and tested. The TeamLeader reproduced the old regex failure with a synthetic script, then verified arguments_json is serialized without redaction and invocation is copied unchanged. | After briefly withdrawing argument display, the operator restored it: "你把参数给我展示出来吧，先不做脱敏了", then "参数全给我放开，不要做脱敏了". This applies to arguments/invocations only, not a global redaction removal. |
| R2 | Many short list items exceed the event limit after pill framing | Defer under explicit no-change ruling. 150 three-character paths reproduce the status-only fallback. The same text-only pill accounting exists in the pinned baseline. | "不用动。下一个". Keep the existing list budget and fallback; do not fix this known limitation in the task. |
| R3 | Non-Bash invocation takes priority over full JSON arguments | Reject as intended behavior. Agent prompt is the invocation and wins over the full input; the existing code already implements the desired ordering. | "那确实应该优先显示invocation ，而不是arguments_json。只有invocation为空，才显示arguments_json". Keep invocation first for every tool. The proposed non-Bash JSON-priority change is withdrawn. |
| R4 | Codex webSearch does not project query/action as arguments | Accept, ratified, implemented. `argumentsFor` maps the existing native query/action into arguments; other item kinds retain the previous field selection. The runtime regression covers started/completed, both queries, unchanged summary, and absent invocation. | The operator replied "好的。" to this exact mapping proposal. No pairing/cache redesign or inference from title text. |
| R5 | An oversized full tool name can throw during START | Reject as a blocking finding. A synthetic name beyond 4096 bytes demonstrates the exception mechanism, but no supported producer was shown to supply it. | No arbitrary name cap or speculative defensive change. This remains a reachability evidence gap. |
| R6 | START and list-only paths format arguments they do not display | Reject under explicit no-change ruling. Keep the shared formatting entry and its callers. | "不改。其他地方还要用". This is the operator's stated reason, not a newly verified inventory of consumers. |
| R7 | Three whole-payload/status fallback stages are unreachable after string fitting | Accept, ratified, implemented. The assembler now keeps only result-then-argument string fitting; the final native event-size check remains. Unicode/size/label coverage is retained and extended. | "如果是代码简化的话，直接做就行了". Behavior-preserving simplification may proceed directly; this does not override the specific R2/R3/R6 rulings or authorize product changes. |

All ratified corrections were recorded before dispatch to the original single
writer. No proposed redaction rewrite, list-budget fix, JSON-priority change, or
formatting relocation was implemented. The short-lived parameter-display
withdrawal was superseded before any commit or release; the final requirement
and solution describe restored, unredacted arguments.

## TeamLeader pre-review of the final combined revision

The TeamLeader traced runtime activity through Core projection into the Channel,
including the layer above each edited seam. `invocation` always wins over
arguments_json, the argument exception is field-specific, and the RESULT header
is its own text segment. Native provider pairing, card generation tracking, and
START/END/RESULT order remain unchanged. The completion producer crosses the
existing admitted-input path; model rendering still reads only source, attrs,
text, and reminder, so the full notification body is preserved.

R4 forwards query/action as structured provider facts instead of parsing a
summary. R7 removes only the three unreachable fallback stages: after fitting,
the two variable strings and fixed labels fit within the result budget. The
final event-size check and operator-retained list fallback remain present.

The final combined repository gates (writer run 5, logs inspected by the
TeamLeader) passed:

| Command | Result |
| --- | --- |
| `node common/scripts/install-run-rush.js update` | Passed during setup; dependency state unchanged afterwards |
| `node common/scripts/install-run-rush.js build` | Passed, 2 executed operations; unchanged operations cached |
| `node common/scripts/install-run-rush.js lint` | Passed, 7 operations |
| `node common/scripts/install-run-rush.js test` | Passed, 4 ordinary operations plus 3 with expected stderr warnings |
| `node common/scripts/install-run-rush.js typecheck:tests` | Passed, 6 operations |
| `node common/scripts/install-run-rush.js smoke-built-cli` | Passed, 1 operation; other packages define no smoke command |

The first implementation test run encountered one scheduler timing failure;
its focused rerun and subsequent complete runs passed, including the final
combined revision. Changed package test configs include both source and tests
and exclude only dependencies/build output. Runtime, Channel, and Core tests
cover invocation notation, generic JSON, raw argument/path values, preserved
redaction on other fields, list-only failures, Unicode byte fitting, source-id
suppression, and completion provenance. Focused final Channel tests passed 98
cases; Codex runtime/display tests passed 119 cases. No real secrets were used
in regression inputs or external probes.

## Final review handoff

After final TeamLeader pre-review passed, a second shared xhigh workflow started.
The operator then requested the named external reviewer: "你去找devbox去review".
The TeamLeader stopped the redundant workflow and is providing a draft PR at a
pinned commit as the requested review surface. The stopped run is not a clean
review and no conclusion is inferred from it. The first completed xhigh review
and its ratified corrections remain recorded above.

External final review remains pending until the selected reviewer's result is adjudicated.
The draft PR is an explicit review artifact, not a ready-to-merge declaration.
Its scope is the complete diff against the pinned baseline, with the current
requirement, final solution, and the R1-R7 dispositions above. The subsequent
operator-requested Alpha feedback reopens implementation; no repeated reviewer
status checks are needed while awaiting its reply.

## Alpha publication and feedback

PR #401 head `b70d22429b2da7ca73532c90520104a2794299b7` passed all nine
GitHub CI checks. After the operator explicitly requested publication,
[release run 34366550601](https://github.com/excitedjs/dreamux/actions/runs/34366550601)
succeeded and exact npm metadata confirmed
`@excitedjs/dreamux@0.25.0-alpha.gb70d22429b2d`. The install command and tarball
link were delivered. This does not claim external final review completion.

The approved Alpha adjustment removes the ARGUMENTS heading while retaining
the code payload and RESULT label/divider. TeamLeader inspected the complete
follow-up diff and the writer's run 6 logs: Rush build, lint, test,
typecheck:tests, and built CLI smoke all passed. The three test operations
with warnings emit expected stderr from failure-path tests; no test failed.
Focused Channel coverage passed 110 cases. The changed assertions remove only
the deleted heading expectations and retain argument payload, RESULT ordering,
failure display, and event byte-limit assertions.

An arguments-only row now uses the existing single-segment form with a code
segment, as the native content contract allows. No final-build live probe of
this form is claimed. Tool title behavior, Failed placement, and the provider
pairing lifecycle are unchanged by this follow-up.

## Rebase onto refreshed next

The operator corrected the target with "不是 dev，说错了，是 next". After a fresh
fetch, both task commits replayed without conflicts onto
`7ed1d886964e520025cbc1e8151c8ff2eefd9a58`. Stable patch IDs for the package and
release-declaration diff before and after the rebase match. The first commit's
range-diff differs only in surrounding product-document context introduced by
next; the argument-heading removal replays identically. Task metadata records
the new review base separately from the original development baseline.

Fresh validation on the rebased source passed Rush build, lint,
typecheck:tests, test (including real Codex integration), and built CLI smoke.
The test warning operations contain the existing expected stderr. No package
source adjustment or test assertion change was needed for the rebase.

The rebased head `4a45d478cc7c2a6015a3a6bcf37d9289de3a55fe` also passed all nine
GitHub CI checks. At the operator's request,
[release run 34372428582](https://github.com/excitedjs/dreamux/actions/runs/34372428582)
published `@excitedjs/dreamux@0.25.0-alpha.g4a45d478cc7c`; exact npm metadata
confirmed availability and the operator received the install command and tarball.
The operator subsequently requested Devbox re-review focused on complexity and
entropy reduction; the request pins this same head. No review result has been
received or inferred.

## Invocation-language correction

After the operator identified the provider burden, the TeamLeader withdrew the
added language-classification contract. The implementation returns code-language
selection to the existing Channel action rule and removes the new provider
inference, shared event fields, and Core forwarding. Argument content,
invocation-first selection, and completion provenance remain in scope. The
language-specific classification introduced by this task is superseded, including
the earlier tests expecting PowerShell/JavaScript run actions to display as text.
Those actions return to the prior bash code-label behavior; this does not alter
their execution or invocation text. The writer's run 7 passed build, lint,
typecheck:tests, test, and built CLI smoke. Its language-only restoration leaves
the Claude provider package equal to next; existing shell unwrapping remains.
These results precede the following failure-order correction.

## Failure-order correction

The operator approved fixing Failed before arguments: "确实，这个顺序问题要修一下。"
Non-list rows put arguments first, then the RESULT label/divider, then Failed
and any actual output. Failed without output still belongs in that RESULT
area. Successful empty-content and previously retained list-overflow fallbacks
are unchanged. Fresh combined implementation and validation are pending.

The TeamLeader reopened the official COT Message Brief on 2026-09-10 and checked
the END and RESULT sections: END marks complete argument input and execution
starting; neither documented payload has a per-tool execution-status field.
No native status field or new lifecycle event is introduced for this correction.

## Remaining delivery and limitations

- Initial task/knowledge links, anti-leak hooks, and committed Rush change
  verification passed. Validate the Alpha feedback again before updating the PR.
- CI for the next revision remains pending. No build has been
  installed into the running service; no final-build live Feishu probe is claimed.
- The baseline result redactor has the same escaped-string limitation observed
  in R1. That path is unchanged; the argument ruling does not authorize its
  rewrite. R2's known list overflow remains per the explicit operator ruling.
- Config/state schemas, maintenance skill contracts, and completion delivery
  routing are unchanged. No manual rebuild or restart is part of this task.
