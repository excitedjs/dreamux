# Verification

## Rebase and draft publication preparation, 2026-09-13

At the operator's request, the TeamLeader rebased the original PR commit onto
`7cfd6ce5` and restored the parts-only work. The sole conflict was the channel
task index: retain the incoming goal-only format and the new task link, rather
than reintroducing duplicated workflow states. Comparison against the pre-rebase
stash found identical package and task-artifact contents, except that index;
all three untracked Rush declarations also matched their saved blobs.

Fresh root Rush build exited 0 with eight up-to-date operations; lint and
`typecheck:tests` each completed seven successful operations. The full test suite
was not rerun for this documentation-only rebase; the earlier five live-Codex
failures remain an unresolved acceptance limit. No test skip flag was introduced.

The operator authorized a new PR before further implementation discussion. The
TeamLeader chose a draft so publication does not claim completed review or
verification. No correction to R2, R5, R8, or mention token matching is included
in the publication preparation. The existing PR is not closed or force-updated.

## Parts-only follow-up pre-review, 2026-09-12

The following evidence covers the fresh replacement implementation against PR
head `87dda034b746231978cebdf5999f4bc05456e149`, not the discarded first attempt.
The earlier sections below are historical initial-PR evidence.

The TeamLeader inspected every production and test hunk. The sole body result is
required ordered parts; flat text/resource projections, generic metadata
sanitization, and text-to-parts fallbacks are deleted without a replacement layer.
Transport still owns content parsing and envelope mapping. Channel still owns
attachment resolution and XML; its existing `byIdentity` map de-duplicates
resources read directly from parts. The only production formatting caller first
enriches the event, where direct and resolved merged forwards receive empty
parts. Unsupported/malformed content and incomplete flags retain their existing
rendered meaning. The product catalog's reply, peer-format, code-literal, and raw
mention-admission contracts are unchanged. The test diff migrates body fixtures
and assertions; the live-Codex assertions and attachment-budget assertions are
not weakened.

Developer execution used root Rush update, build, lint, test, and
`typecheck:tests`. The final test log records 205 transport tests and 488 channel
tests passing, with four failures and 1,084 passes in Dreamux. Its 73 non-live
files pass. The four failures are the real-model structured-output, mid-turn
activity, unbound native turn, and Feishu mid-turn folding cases. The last fails
before marker injection; notifications show an error and a failed native turn,
not a completed folding scenario. Root `rush test` is **not green**.

The TeamLeader read the original developer tool transcript, rather than relying
only on its summary. The control restored package sources to the PR head,
rebuilt through root Rush, then ran the package-local locked Vitest 2.1.9 against
`tests/codex-live.test.ts`. Its output lists the same four test names failing and
five passing. This was a focused baseline control, **not a baseline root Rush
test run**, and only filtered failure names/counts were retained; it does not
establish identical error detail or the remote failure's cause. Restoration
reported `PATCH IDENTICAL`; the only subsequent package delta before final
checks was a comment reflow. The Leader did not repeat the source rollback.
Private transcripts, temporary backups, and raw logs remain outside public
artifacts.

The Leader independently invoked root Rush build (all eight operations already
up to date), lint (seven successful operations), and `typecheck:tests` (seven
successful operations). A direct Node replay against the built transport and
channel modules passed 17 scenarios covering literal text, native Markdown
mention/code fidelity, empty and unsupported content, resources without keys,
audio/media/shared entities, lazy-forward references, card merge, and repeated
resource positions with one resolved attachment. This is local semantic
verification, not a live client or delivery test.

A subsequent independent Leader root `rush test` rerun completed with all six
other package operations passing (two with expected failure-path stderr), but
five Codex-live cases failed: the same four case names plus fresh/resumed thread
continuity. Several now time out instead of returning an immediate failed native
turn. The earlier four-case baseline control does not explain this fifth timeout
or establish the latest run's cause. Non-live Dreamux files still pass; the full
test gate remains open. Do not describe the current result as four unchanged
failures or as proven solely environmental.

The Leader's root `rush update` could not complete because the environment's
configured `core.hooksPath` prevents Rush from installing the repository hooks.
No Git configuration was changed and no policy bypass was used. The earlier
attempt while tests were active was rejected by Rush's normal process lock;
retrying after completion exposed the hook conflict. The developer's original
03:11 local-time transcript independently records the same root update command
finishing successfully in its Claude environment. Thus dependency preparation
has a verified successful run; repeatability in the Leader's environment is
blocked at hook installation, not dependency resolution.

The Leader verified `core.hooksPath` has a nonempty command-scope value in its
shell and resolves to the Trae-managed hook wrapper. The wrapper invokes a managed
helper on its normal path and contains fallback delegation to the original Git
hook. That is not evidence that anti-leak checks are disabled, nor proof that
the helper's normal path preserves them. Confirm the complete effective hook
chain before any later authorized commit; do not remove the wrapper or bypass
policy to get a green update. Machine-local paths are intentionally omitted.

The follow-up read-only diagnosis found no intervening package-code change
between the four- and five-failure runs. The extra continuity case uses only the
Codex runtime provider, not the changed Feishu fixture; its ordinary model turn
must settle before the test can exercise resume. The folding case does use the
changed fixture and reached `feishu inbound submitted` and user-message events,
but never reached its mid-turn assertion. These facts narrow the investigation;
they do not identify the cause of the hangs or complete the live contract.

These checks are explicit delivery limitations, not waived contracts. During
that verification round no tests or skip flags were changed to conceal them,
no live Feishu message was sent, and the follow-up was not committed or pushed.

The old `inspect-native-post-inbound.mjs` artifact is a historical pre-PR probe
for baseline `3cac2f7`, not an executable current-contract verification. Its
flat-text API use and selection-only comparison are retained as historical
evidence and explicitly labeled; current verification uses the compiled owners
and the parts-based regression suites.

## Parts-only independent review adjudication, 2026-09-12

The `xhigh` review completed with full reported coverage (`partial: false`):
seven finders, 26 candidates, 21 verifier agents, 26 verdicts, seven refutations,
and nine synthesized findings. This is a completed review run, not acceptance of
its findings or a green delivery gate. The table below is the TeamLeader's
source-checked disposition, using the report's finding order. On 2026-09-13 the
operator declined R5 for now; the other rulings remain pending. No implementation
correction has been dispatched.

| Item | Finding and source | Disposition | Reason | Conflict with operator scope |
| --- | --- | --- | --- | --- |
| R1 | Incomplete placeholder examples in the transport change note | Reject as a correctness defect | The note says the legacy projection is removed; omitted examples do not establish a surviving marker, and an exhaustive replacement list would add detail without changing the contract. | None; no code or release-scope expansion proposed. |
| R2 | Unreachable `attachmentFor` map-miss fallback, `feishu-message.ts:226-245` | Accept as cleanup, pending ratification | Resolution and rendering consume the same parts, and every identity is mapped, including over-budget resources; remove the duplicate fallback, not real attachment failure reasons or deduplication. | None; this removes a remaining fallback in the converged body path. |
| R3 | Missing fresh KB-check result in the task record | Accept the recording omission only | The check did run successfully; the report's inference that the KB was unverified is false. The execution evidence is recorded below. | None; task evidence remains TeamLeader-owned. |
| R4 | Historical probe allegedly promises a pinned runnable baseline, `artifacts/inspect-native-post-inbound.mjs:1-24` | Reject as a follow-up regression | The artifact is explicitly historical, not a current verification command; its missing module snapshots already prevent execution at the PR head, before this change. Do not add a snapshot mechanism to repair an unpromised current replay. | Rewriting the historical probe is outside the approved parts-only implementation. |
| R5 | Hidden-value guards inspect text only and the resource assertion permits extras, `content.test.ts:620-632` | Defer: operator declined for now on 2026-09-13 | The coverage reduction remains real and no current leak was found; the operator selected "暂不采纳", so no correction is dispatched. | Changing this test now would contradict the operator's hold. |
| R6 | Merge assertion compares the primary array with itself, `inbound-markdown.test.ts:407-421` | Reject as an uncovered regression | The unchanged test at lines 317-328 pins the byte-identical parser input and concrete parts; the merge assertion still catches duplicate appends. The reviewer found no regression escaping both. | None; retain the existing parser and merge contracts. |
| R7 | Unused `FEISHU_SKILL_FALLBACK_NOTE`, `feishu-message.ts:40-45` | Defer pending a separate scope ruling | It is a pre-existing dead export, neither introduced nor orphaned here; its hypothetical future reuse is not a current defect, and this follow-up does not name its removal. | Treating all old fallback prose as approved deletion would stretch the parts-only ruling. |
| R8 | Three slash fixtures use flat text where the parser emits a mention, `feishu-slash-commands.test.ts:469,493,560` | Accept as fixture correction, pending ratification | The raw inputs produce mention-plus-text parts; the bot case actually submits the mismatched body. Use real parser output and verify the delivered mention while retaining slash-routing assertions. | None; the approved solution explicitly requires real parts fixtures. |
| R9 | Two tests pin adjacent text segmentation, `content.test.ts:29-35` and `inbound-markdown.test.ts:512-518` | Reject as a required correction | These inspect the exported parser result, not source layout; rendered equivalence alone does not make them forbidden structure tests. No current behavioral defect is demonstrated. | None; no new segmentation contract or parser change is proposed. |

For R3, the TeamLeader's pre-adjudication `.agents/scripts/check.sh` run and the
rerun after adding this table and updating the task indexes both exited 0 with
`KB OK (243 files reachable from root.md)`; `git diff --check` also passed.
This records completed checks, not a waiver of the five live-Codex failures or
the Leader's Rush hook-install conflict. Repeat the KB check after subsequent
knowledge edits.

For R4, the retained script reads source paths relative to its working directory;
it does not load `3cac2f7` by Git reference. At the PR head and current tree, the
snapshot lacks the imported Markdown/mention modules, so module loading fails
before the later obsolete `.text` access. Its historical results are not evidence
that the script runs against current code. No probe was rerun during adjudication.

The seven refuted candidates do not justify extra fixes: CI already runs the KB
check; the flagged all-text merge and overflow fixtures retain their behavior
checks; metadata consumers already received the same string-valued map before
this change; and shared test-helper extraction, repeated helper calls, and KB
wording expose no new correctness defect. Do not resurrect the removed projection
or add metadata defenses on those grounds.

R5 was presented first. Its initial card expired unanswered; at the operator's
request it was resent on 2026-09-13 with the same test-only correction scope.
The matching answer was:

> 暂不采纳

Keep R5 unchanged; this is a hold on the proposed correction, not a finding that
the coverage reduction is harmless. R2 and R8 remain separate unapproved
corrections. R7 remains outside the correction set unless the operator expands
the scope. The later publication ruling authorizes committing and pushing the
preserved work as a draft, not merge or a live Feishu test.

## Published PR status and mention defect, 2026-09-13

Read-only GitHub checks before the requested rebase found PR #414 open at
`87dda034`, targeting `next`, with the original approval and nine successful
checks. GitHub reported `mergeable: CONFLICTING` and `mergeStateStatus: DIRTY`.
Those results did not establish integration against the newer base. At that
inspection the local parts-only follow-up was uncommitted and absent from the
published head.

The published review's inline comment identifies overlapping text-mention keys
at `packages/channel/feishu-transport/src/parse/mention.ts:52-75`. The TeamLeader
verified the source and reproduced the issue locally through the built
`parseInbound` entry point using ten synthetic mention records: with
`@_user_1` processed before `@_user_10`, the last occurrence becomes the first
person's mention plus literal `0`, rather than the tenth person's identity.
The renderer emits that mistaken identity as an `<at>` element. No real Feishu
message or identity was used in the reproduction.

This is a concrete parsing defect, separate from R5's test coverage and R2's
unreachable fallback. The published reviewer called it pre-existing and
non-blocking; that assessment does not make the wrong-identity result correct.
The follow-up does not modify `mention.ts` and does not fix the defect. The
operator subsequently authorized the rebase recorded above, not a scanner
change.

## Observed message-send failure detail loss

Two reply tool invocations during the mention-format explanation failed with
HTTP 400. Read-only inspection of the existing SDK diagnostic found platform
code `230028`, a platform log ID, and this response message:

```text
The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS
```

The rejected explanations contained a fictional address used as a syntax
example. The later explanation omitted address-valued examples and was delivered.
Do not publish the actual message/chat/log identifiers or raw daemon records.

The same failures reached higher-level logs and MCP as only the Axios message,
`Request failed with status code 400`. Source checks confirm:

- Both channel `errInfo` helpers select message and stack, discarding nested
  response fields from their projection.
- Core's MCP lease failure path uses `failureText`; ordinary errors retain their
  message under the existing `INTERNAL` prefix. It does not parse SDK responses.
- The existing transport outbound helper is the message create/reply owner and
  already changes in this task, so it can form one complete platform error
  description for both existing consumers. The installed SDK generic request
  method forwards its HTTP result and rethrows HTTP errors after SDK logging.

The operator requested adding the fix to this task. The implementation plan now
requires a synthetic wire-envelope reproduction at transport, logger, and MCP
boundaries, with credential/request-body omission and preserved cancellation and
partial-send behavior. No product fix or validation run has occurred yet.

## Native provider append probes, 2026-09-11

The operator explicitly requested provider-level parameter tests:

> provider这里是不是也测试一下，看看developerInstructions是不是支持字符串，以及append system prompt是不是支持多和参数传递

Tested installed versions: Codex CLI 0.153.4 and Claude Code 2.1.267. These
diagnostic probes ran outside the repository and bypassed Dreamux's adapters.
They do not authorize product development.

Codex used a separate native app-server over stdio. Both requests supplied the
same two synthetic instruction fragments, first as a JSON array and then as one
string. The accepted string case used an ephemeral thread and completed an
actual model turn with tools prohibited by the probe instructions.

| Codex input | Observed result |
| --- | --- |
| `developerInstructions: [A, B]` | Rejected with code `-32600`: `Invalid request: invalid type: sequence, expected a string` |
| `developerInstructions: "A\n\nB"` | Thread creation accepted; the completed model response returned both synthetic values correctly |

Claude Code's native CLI sent requests to a loopback capture endpoint using a
placeholder credential, isolated configuration, and `--bare`. That endpoint
returned synthetic responses; its evidence is the CLI's outgoing payload, not
model interpretation. Inspect the task request separately from auxiliary
requests emitted by the CLI.

| Claude CLI arguments | Captured task request |
| --- | --- |
| One `--append-system-prompt` with a joined A/B value | Both fragments in system content |
| `--append-system-prompt A --append-system-prompt B` | Only B in system content |
| `--append-system-prompt B --append-system-prompt A` | Only A in system content |
| `--append-system-prompt A B` | A in system content; B in user content, not a second system fragment |

A separate actual-model check used Claude Code's native stream-JSON input/output
with tools disabled, safe mode, and no session persistence. The joined value
returned both synthetic markers. Repeated A/B flags returned `alpha: null` and
the correct beta marker. Both processes exited successfully. This corroborates
the capture result under the resident protocol used by Dreamux: repeated flags
overwrite instead of accumulating.

The [Claude CLI reference](https://code.claude.com/docs/en/cli-usage) documents
the single-text append option. Repetition semantics above are live evidence for
the installed version, not an extrapolation from that documentation. OpenAI's
[app-server reference](https://learn.chatgpt.com/docs/app-server) was consulted;
the specific array rejection is established by the native response above.

Current-scope conclusion: keep Identity as a string and preserve the existing
provider-owned rendering of the runtime append list into one native string.
No upstream identity-array conversion is needed. Do not implement Claude append
as repeated command-line flags. All probe processes exited;
private captures remain outside the public repository. No production code,
tests, configuration, or live Team identity changed. These checks do not validate
the proposed creation-time Channel concatenation or compaction behavior.

## Thread-ID addressing probes, 2026-09-11

The operator identified a compaction scenario: the model can lose the inbound
chat/message IDs, omit `message_id`, and accidentally create a new topic. The
current tool requires `chat_id` but makes `message_id` optional. Its send path
uses message create when that optional field is absent. The observed-message
ledger is updated after sending; it does not recover a missing reply destination.
Losing both required chat identity and message identity does not itself produce
a valid call: the new-topic scenario requires the model to recover or supply the
chat ID while still omitting the message ID.

The operator preferred testing Thread ID over retaining additional tool-owned
address state:

> 用工具保留原地址的话，我感觉有点复杂了。你可以尝试一下，能不能以 Thread ID 为目标发送消息。

Authorized probes used direct Node HTTP calls with native `post` content, no CLI,
SDK renderer, or production-code changes. The current topic ID was the target.

| Attempt | Result |
| --- | --- |
| Create with `receive_id_type=chat_id`, `receive_id=omt_example` | HTTP 400, code 230001, invalid receive_id |
| Create with `receive_id_type=thread_id`, `receive_id=omt_example` | HTTP 400, code 99992402, field validation failed |
| Reply with `omt_example` in the message-ID path | HTTP 400, code 99992354, invalid open_message_id |

None of these direct attempts created a message. The
[official topic overview](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/thread-introduction)
documents Thread ID as a forwarding destination and history container; that is
not evidence that ordinary create/reply accepts it directly.

A fourth probe supplied only Thread ID as its address input:

1. GET message history using `container_id_type=thread`, that Thread ID,
   `page_size=1`, and ascending creation order.
2. Check that the returned message belongs to the requested thread, then reply
   to its returned `message_id` using native post content.
3. GET the newly sent message and compare its chat/topic with the lookup result.

Lookup, reply, and readback all returned code 0. The response and readback both
identified the requested original thread, and the readback chat matched the
lookup. No chat/message ID or cached anchor was supplied to that probe. This
establishes a stateless Thread-ID-to-message lookup followed by ordinary reply
in this environment, not direct platform sending to Thread ID. The raw scripts
and request/response captures remain outside the public repository.

The current `reply.chat_id` does not implement this resolution. The operator
subsequently rejected adopting the lookup/reply proposal and instead specified
appending the initial chat/message address and mandatory reply instruction to
the identity during automatic collaboration-space Team creation. The probe
results remain historical evidence; no Thread-ID tool contract is to be added.

## Creation-time reply identity investigation

Current-source inspection confirms the proposed narrow implementation point:

- `feishu-provisioning.ts:createTeam` already holds the initial request and
  currently forwards `space.identity` into `team.create.leader.identity`.
- `FeishuSubmission.anchor` contains the actual chat/message address. Use its
  initial message ID rather than assuming every submission source ID names a
  Feishu message. Ordinary inbound uses the same ID for both; question settlement
  has its own source identity and a separate actual-card anchor.
- The existing per-target provisioning run chooses the first request; later
  concurrent messages wait and then submit through the installed binding.
- `TeamService.createNew` retains the creation identity in existing storage;
  `teamLeaderSystemPrompt` appends the stored agent identity when restoring the
  TeamLeader. Codex supplies append guidance on start/resume and Claude Code
  supplies its native append-system-prompt argument.

No product implementation or live Team identity was changed. Injection,
preservation of custom identity, concurrency, and actual model behavior across
compaction remain implementation-time validation. The operator specified the
product behavior but has not approved development through a new card.

## Identity string composition after the scope reduction

The operator deferred identity arrays from this release and required string
concatenation. Source recheck confirms the existing path:

- `FeishuProvisioning.createTeam` currently passes the space identity string to
  `team.create.leader.identity`; this is where the reply guidance will be joined.
- `TeamService.createNew` stores the normalized string as
  `leader_identity_prompt` and supplies it to Agent identity creation. Restore
  reuses the stored Agent identity or the Team's original creation string.
- `teamLeaderSystemPrompt` places built-in Team role, tool, and workspace text
  before the complete identity string in the existing runtime append list.
- Codex's `renderCodexSystemPromptAppend` wraps each existing runtime fragment
  and joins with blank lines; `threadInstructionParams` assigns the resulting
  string to `developerInstructions`.
- Claude Code's `claudeCodeSystemPromptAppendContent` also joins all fragments
  with blank lines, and the CLI receives one append-system-prompt argument.

The required implementation checks now cover preservation of custom identity,
Channel reply guidance, and built-in instructions through create/store/restore
and both provider boundaries. They also cover absent custom identity, unchanged
space policy, per-topic initial address selection, and compaction behavior.
These checks have not run against an implementation; product code is unchanged.

The earlier array round-trip, scalar rejection, storage-version, and error-
propagation cases are removed from this release along with their format change.
Their review evidence remains in the historical reports. The independent code-
fence regression remains required: legacy post text rows, native Markdown, and
card fences must reach the transport's code-part output after the Channel scanner
is removed.

## Native mention representation documentation recheck

The operator asked how many native mention spellings the plan needs to handle.
Direct retrieval of the official Markdown sources confirms:

- [Sending content](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json.md):
  text/native post Markdown uses XML `user_id`; structured post uses an `at`
  node. `all` is a target value rather than another representation.
- [Receiving content](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content.md):
  text mentions become `@_user_N` placeholders with accompanying `mentions`;
  structured `at.user_id` can itself hold that placeholder. Native post `md`
  can retain the inline XML.
- [Card Markdown](https://open.feishu.cn/document/feishu-cards/card-components/content-components/rich-text.md):
  XML supports `id`, multi-target `ids`, and `email`. The earlier design/review
  enumeration omitted the last two attributes.

The first answer mixed sending syntax and received representations. The operator
clarified the scope: "我说的是入站消息这里". Current received-content evidence
requires three representations: placeholders plus mentions, structured `at`
nodes (possibly containing placeholders), and inline markup retained inside
Markdown. Post and card inline attributes belong to that third representation;
they are not separate parser services.

The sending references additionally describe multi-ID/email attributes, but their
actual event/GET normalization has not been captured. Do not count all sending
variants as independently observed inbound forms or add resolver mechanisms on
that basis. Use platform-resolved identities without treating an email or display
name as an Open ID. No new live probe or product-code change was made for this
documentation check.

## Current-repository transport consumer audit

After the operator removed claudemux/external compatibility from consideration,
source checks found the following current production graph:

- `renderMarkdownToCards` is called only by transport `send` and
  `renderSingleCard`; only `editText` uses the latter. No production caller uses
  shared `editText`; the channel's remaining mention is a test fake.
- Reply and introduce acknowledgement both reach the same `send`, so neither
  retains a renderer call after native-post conversion. Explicit `sendCard` /
  `editCard` serialize supplied objects directly; COT uses native endpoints.
- `textMessageContent` serves only the removed edit fallback. `applyMentions`
  serves text parsing that semantic parts replace. `mentionName` and
  `extractPostText` have exports/tests but no production caller. Preserve actual
  post parsing via `parseInbound` when retiring those helper surfaces.
- `conversationKey` has declarations and adapter forwarding but no producer or
  consumer. `render/split.ts` is a pure helper reusable by native post.

Implementation checks must preserve raw card send/edit and COT, move live long-
text guarantees into native-post coverage, and update the package-boundary export
inventory and test fakes to match removed APIs. Do not weaken the gate or remove
behavior merely because its old test called a retired wrapper. No implementation
or runtime change was made during this audit.

## Long-message split review, 2026-09-11

The operator asked:

> 长文输出拆分逻辑现在是不是过于保守了？

Current product code still uses the card renderer. Its packer checks serialized
card content against 28 * 1024 bytes and limits each card to 180 elements.
Consequently 181 short separate paragraphs can produce two cards even when the
body is far below the byte budget. This follows directly from the lexer-to-element
mapping and the packer's count check; it is a source-derived example, not a new
live probe. A next element that does not fit moves intact to the following card,
which can also leave unused capacity in the current card. Wide-table splitting
and oversized-cell rejection are separate card-renderer rules.

The [current reply API documentation](https://open.feishu.cn/document/server-docs/im-v1/message/reply)
states 30 KB for cards/posts and 150 KB for text, and warns that style tags can
increase the effective message size. The 28 KB threshold reserves about 6.7%
relative to the code's 30 * 1024 interpretation. Existing visual probes establish
neither the exact native-post limit nor the necessary headroom: the largest post
request was 6,285 bytes. No near-limit messages were sent during this read-only
review. After discussing this evidence, the operator decided:

> 那就先保持28kb 吧。

Retain 28 * 1024 bytes of serialized native-post content as the operating budget.
No tighter threshold or additional live boundary experiment is needed for this
decision. It does not turn the previous probes into near-limit evidence and does
not authorize product development.

The proposal keeps whole-message passthrough as the common path and already
excludes card element/column/cell constraints. Only an oversized message enters
the splitter; code fences, table headers, and Unicode handling apply when an
oversized block actually needs splitting. No product implementation was changed.

## Raw Card 2.0 direct-message probes, 2026-09-11

The operator challenged whether removing the custom transformations while keeping
the existing card presentation would meet the requirement, then explicitly
requested another set of private probes:

> 还是老样子，私聊我发探针看一眼

Five direct Node HTTP requests used `msg_type: interactive`, `schema: 2.0`,
`config.update_multi: true`, and exactly one `body.elements` Markdown component.
Each component received its entire authored body unchanged. There was no card
header extraction, Markdown token conversion, native table construction, mention
shorthand expansion, CLI, SDK, or production renderer on the probe path. The
probe script and raw captures remain outside the public repository.

| Probe | Serialized card content bytes | API result | Client result |
| --- | ---: | --- | --- |
| Six heading levels, paragraphs, lists, quotes, links | 723 | Success | Operator accepted |
| Twelve-row Markdown table, pagination, cell formatting | 837 | Success | Operator accepted |
| Inline card XML mention, literal code tags, code blank lines, escaping | 1013 | Success | Operator accepted |
| Four tables in one Markdown component | 613 | Success | Operator accepted |
| Five tables in one Markdown component and trailing marker | 775 | Success | Operator accepted |

The operator's exact response to this set was:

> 全都正常。

This confirms client rendering of the tested examples, including the fifth
table. It is not development authorization or new peer-bot wakeup evidence.
The send responses and default GET views returned no mention metadata for these
private cards; do not infer notification or event delivery from their appearance.

The current [official Card 2.0 Markdown documentation](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text)
supports native headings, tables, code, and card XML mentions. It states a
five-data-row page size and a maximum of four tables per Markdown component.
The fifth-table probe succeeded and was visually accepted in this environment;
record the documentation/runtime difference without claiming an unlimited table
count or adding an unobserved local rejection rule.

The result establishes that the tested card examples can use native Markdown
without the reply renderer's custom conversions. It does not establish arbitrary
long-message splitting, pixel parity with the old custom header/table styling,
or, at that point, permission to remove unrelated rendering/editing APIs. The
later operator current-repository consumer ruling separately permits retiring
unused APIs; it does not change what those rendering probes demonstrated.

After the leader proposed retaining cards, the operator clarified the final
presentation choice:

> 不，还是用富文本吧。

The selected outgoing solution remains native `post + md`. Keep these raw-card
results as comparison evidence; do not interpret visual acceptance as a request
to switch the solution back to cards or as development authorization.

## Native Markdown direct-message probes, 2026-09-11

The operator explicitly requested writing probe code and sending rendering samples
to their direct conversation. The operator then required bypassing `lark-cli`
because its internal processing might affect the result. This is authorization
for the probes, not approval of the full product implementation.

The [probe script](artifacts/native-post-probes.mjs) uses Node's native `fetch` to
authenticate the configured bot, verify its expected identity, and POST directly
to `/open-apis/im/v1/messages?receive_id_type=open_id`. Each request contains one
`post` with one `md` element. There is no CLI, SDK, Markdown normalization, or local
card rendering on this path. Credentials and recipient identifiers are runtime
inputs; raw request/response artifacts remain outside the public repository.

| Probe | Serialized request bytes | API result | Returned type | Mention records |
| --- | ---: | --- | --- | ---: |
| Typography, headings, lists, links | 909 | Success | `post` | 0 |
| Inline XML mention and literal code samples | 659 | Success | `post` | 1 |
| Native Markdown table | 624 | Success | `post` | 0 |
| Fenced code, JSON escaping, Unicode | 831 | Success | `post` | 0 |
| Long content, 20-row table, explicit end marker | 6285 | Success | `post` | 0 |

The mention record in the second response identifies the intended recipient.
This confirms server recognition of the mention. The operator subsequently
reported that the five probes looked fine and requested the inbound investigation.
That assessment does not independently prove notification behavior or peer-bot
event delivery.

Checks completed:

- `node --check` accepted the probe script.
- All five direct HTTP requests returned success with message IDs.
- Each serialized request was below the documented 30 KB limit.

Remaining evidence:

- Peer-bot event delivery and mention metadata, beyond visual rendering.
- Production reply-path implementation and its automated tests.
- Multi-message splitting: the long probe deliberately remains one message, so
  it is not evidence of a production splitter or partial-send behavior.

No production code, daemon configuration, or running service was changed by these
probes. No flag write was performed.

## Shared inbound parser and message readback

All five probes were fetched directly through message GET. Each decoded post
contains `title`, legacy `content`, and native `content_v2`. The latter exactly
retains the authored Markdown for four probes; Feishu resolves the actual
mention display name in the second, leaving its code samples intact.

The [source replay](artifacts/inspect-native-post-inbound.mjs) runs the current
parser and structured body renderer against those captures. It confirms lost
heading markers, table alignment, inline-code delimiters in these captures, and
doubled code newlines when selecting legacy `content`. Nodes that retain an
inline-code style are already re-fenced; this is not universal delimiter loss.
Selecting only `content_v2` through a
diagnostic input change retains native Markdown but causes actual inline mention
XML to be escaped as ordinary text. This is not a production patch or a live
WebSocket delivery test.

Two GET requests for the same actual inbound text message mentioning the bot
confirm the API's parameter-dependent identity: omission returns the bot open ID,
while explicit `user_id_type=open_id` returns its application ID. The latter is
misclassified as an open ID by the current normalizer. The event admission gate
uses its own original mention metadata before readback enrichment.

See [the inbound analysis](inbound-analysis.md) for source locations, evidence
limits, and the proposed owning boundaries. Image extraction remains a regression
scenario to validate, not a live image experiment in this probe set.

## Supplementary empty-name and bot mentions

The probe script's `--mention-probes-only` option sends one additional direct
message without repeating the initial five. Its three actual mentions are an
empty-name person, an empty-name bot, and a named bot; it also contains mention
tags inside inline and fenced code. The direct API accepted the 803-byte request
as `post`, returned three mention records, and identified the intended recipient.
Its client appearance and peer-bot group event behavior remain separate checks.

## Existing peer-card compatibility

The operator explicitly confirmed that the existing reviewer-to-bot card mention
path has long been working. It is the receipt/admission regression baseline;
there is no need to re-establish that fact as a prerequisite for this task.

Direct GETs of one already received reviewer card expose different projections:
`user_card_content` carries Card 2.0 Markdown `<at id=...></at>` and one open-ID
mention; the default view has no mention record and supplies rendered resources.
Current-source parser/merge/body replay emits escaped card XML rather than a
structured mention. This verifies a representation gap, not a delivery failure.
No additional card was sent to reproduce the established working receive path.

The updated validation scope includes text, structured rich posts, native
Markdown posts, and existing cards. Tests must retain field-level plain-text vs
Markdown meaning, code literals, mention identity and occurrence order, and the
existing structured/default card merge behavior.

## Native-post peer review request

The revised review request was sent in the originating topic using Node `fetch`
directly against the message reply endpoint. It contains one `post`/`md` element
with an empty-name native mention of the designated reviewer bot. Both the send
response and a subsequent GET without `user_id_type` identify that bot's open ID;
the send returned one mention record. The peer was asked to distinguish actual
realtime event metadata from mere message receipt or GET evidence. Its receive-side
assessment is now recorded in the round-two review below.

The knowledge check and both probe scripts' syntax checks pass. Product build,
lint, test, and test typechecking have not been run: this stage changed only task
artifacts, and product code remains at the recorded baseline.

## External solution review completion

Round two returned `sound-with-nits`, with no blocking findings. Its receiver-side
dispatcher log records submission of the native-post review request. The reviewer
traced admission of a trusted group bot to the raw event's actual mention of the
receiver. Together these establish that the new post reached the peer bot through
normal admission. The original webhook body was not captured; its mention content
is inferred from the log and gate, not directly inspected JSON. A subsequent
unmentioned message was rejected in the same chat, supporting that the gate was
enforcing its policy.

This evidence is reported by the independent receiver, separate from our direct
send/GET captures. Empty-name visual appearance remains unconfirmed by the
operator. All six review clarifications are incorporated in the final solution.
Task artifacts use synthetic identities and raw captures stay private. The
reviewer was asked to redact real identifiers and machine-local paths from its
public review comment; that external edit is tracked separately.

## Application-ID mention probes

The operator's response to the development-authorization card requested testing
whether native posts can mention the designated peer bot by application ID. This
was a probe instruction, not development approval.

The [direct-HTTP probe script](artifacts/native-post-appid-probe.mjs) resolves the
peer application ID from two reads of the already verified open-ID reference
message: the default view identifies the intended peer by open ID, and the
explicit `user_id_type=open_id` view returns the same mention key as `app_id`.
This proves the target mapping without guessing an application ID. The outgoing
probe content includes only that application ID, never an open ID or `@all`.

| Native post representation | Send result | Send mention count | Default GET mention count |
| --- | --- | ---: | ---: |
| `md` with `<at user_id="cli_example">Devbox</at>` | Success, `post` | 0 | 0 |
| Dedicated `at` node with `user_id: cli_example` | Success, `post` | 0 | 0 |

The first probe's legacy readback has only text nodes, with no `at` node; its
native Markdown retains the authored application-ID XML as source text. Therefore
acceptance of the post is not evidence that Feishu recognized an actual mention.
The already verified open-ID native-post request is the positive comparison:
one mention record and independent receiver-side submission evidence.

Current [official post content documentation](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json.md)
lists user ID, open ID, and union ID for the inline mention value. The
[official bot-to-bot guide](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/agent-at-agent-for-complex-tasks.md)
shows the quoted `user_id` attribute with an open ID. Neither consulted page
documents application-ID support for this native-post form.

The peer inspected both probe messages, excluding the two ordinary-mention
inspection notices. Its independent report confirms that the application ID
belongs to the intended receiver. Neither probe has a submission or gate-drop
record at the receiver, while nearby events and both notices show normal handling.
Its GET views also return no mention metadata. Our saved sender request uses
`user_id`; the peer reported a different `id` spelling in its first GET projection,
which is a readback observation, not the authored request. The second probe's
structured `at` nodes have empty identity/name fields in both readback projections;
our own capture independently confirms this normalization.

Combined evidence establishes that neither tested app-ID post produced a real
mention or demonstrated peer wakeup. The missing receiver logs support failure
to trigger event delivery rather than an observed gate rejection. They do not
constitute a complete delivery trace: GET fields cannot prove the shape of an
uncaptured webhook. These observations describe this tenant and the two tested
post forms, not every Feishu message surface or future rollout.

The script passed Node syntax validation and both direct requests completed. No
CLI, SDK renderer, product implementation, or running service was changed.

## TeamLeader implementation pre-review, 2026-09-11

The first implementation report claimed all four Rush gates passed. The leader
has not accepted it as review-ready: direct execution against the built transport
reproduced the following mismatches with the approved solution. No independent
implementation review has started.

| ID | Observed input and result | Required correction |
| --- | --- | --- |
| P1 | A fenced `ts` block with one line of 30,000 ASCII characters throws a 28,673-byte error against the 28,672-byte budget. | Count the injected newline's JSON-escaped cost and retain complete split code. |
| P2 | A double-backtick inline code span containing a single backtick followed by native mention XML promotes that XML to a mention. | Respect matching inline-code delimiter runs before interpreting mentions or images. |
| P3 | Primary and supplemental card projections each contain an `at` occurrence named `Same`, with different synthetic open IDs; merge drops the supplemental identity. | Preserve distinct identities while avoiding duplicate representations of the same occurrence. |
| P4 | A structured post `text` node containing literal native mention XML becomes a mention. | Keep plain-node versus Markdown meaning until semantic interpretation; retain legacy cross-row code coverage. |
| P5 | A native Markdown mention using the synthetic application identifier `cli_example`, with no supported record, becomes a model-facing mention ID. | Do not promote an unsupported application identity through the unmatched-token fallback. |

The plain-message fenced-text probe remains literal, as explicitly specified by
the approved plain-text contract; it is not a finding. Raw card send/edit still
use the shared size guard, so removal of the old guard name did not remove the
capability.

Further pre-review completeness work: exercise the actual final MCP failure
result from the platform envelope (the current channel test stops at a thrown,
preformatted Error); verify the combined identity across existing store/restore
and provider boundaries, distinguishing these checks from live compaction; add
transport test typechecking to cover the changed tests under the required Rush
gate. The transport currently lacks that script, so the reported gate did not
check those test types. Do not broaden that correction to unrelated runtimes.
The three newly added package-root post helper exports have no production
consumer outside their own module; they do not belong in the retained public
surface under the repository-only consumer ruling.

P2 also reproduces with escaped native Markdown examples: a backslash before
`<at user_id="ou_example">Example</at>` still promotes a mention, and a backslash
before a Markdown image reference to `img_v2_abc` still creates a resource. These are the same missing
inline-Markdown boundary, covered by the approved escaped-example requirement.

### Live Codex compaction probe

PASS on installed `codex-cli 0.153.4`. An isolated ephemeral app-server thread
received the identity captured from the built Feishu provisioning creation
payload, passed through the existing Codex instruction renderer. All addresses
and verification markers were synthetic. The initial user turn contained no
address and returned only `READY`.

The leader invoked `thread/compact/start`, observed a completed
`contextCompaction` item and completed compaction turn, then asked the model for
the would-be reply arguments without providing an address again. It returned the
correct synthetic chat and initial message IDs, plus both the custom identity
and built-in verification markers. The app-server process exited afterward.
The method and completion signals agree with the
[official app-server documentation](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction).

Evidence boundary: this is actual manual Codex compaction and model recall using
the current Channel payload and provider renderer. The Core invocation was a
capture-only harness; it did not create a live Team, execute the reply tool, or
send a Feishu message. It does not establish Claude compaction or production
routing. Core storage/restore and both provider composition checks are assigned
separately to the implementation developer. Private transcripts retain the
runtime identifiers and full probe receipts; no live identifiers are published.

### Second pre-review disposition

P1, P2 (including both escaped examples), and P4 passed direct replay against
the rebuilt transport. P3's initial reproduction passes, but its global ID set
still suppresses a supplemental occurrence when that ID appeared on another
primary line: primary contains `@Same` for one ID and `@Same has context` for
a second ID; supplemental contains bare `@Same` for the second ID. Comparison
must belong to the visible line and its identities, not to a document-wide
identity set. This is the same occurrence-preservation requirement, not a new
feature. The developer is asked to correct the comparison model rather than add
another exception around the global set.

The leader withdraws P5's inference that an unmatched `cli_` token can be
classified as an application solely from that prefix. The
[official user-create contract](https://open.feishu.cn/document/server-docs/contact-v3/user/create.md)
allows custom user IDs and does not establish that prefix as a disjoint type
namespace. The synthetic bare-token reproduction alone does not justify a new
format classifier. Remove that extra prefix rule. Keep the observed, typed
`id_type: app_id` readback normalization: it must not populate a supported user-ID
slot. Unmatched source identifiers remain source assertions; do not add lookups
or claim that a syntactic tag proves platform delivery. This is a leader
evidence correction, not a new operator ruling or an approval for outgoing
application-ID mentions.

### Real MCP failure boundary replay

PASS: an isolated Node probe used the built transport, real Feishu bot, real
Channel session and MCP capability, and Core's real `McpLeaseRegistry.invoke`.
Only the Lark client response and caller-generation lease were synthetic. The
client threw the captured HTTP-400/230028 response shape with a synthetic log ID.
The final result was `ok: false` with exactly:

```text
INTERNAL: Feishu message.reply failed (HTTP 400, code 230028, log_id=log_probe): The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS
```

Recorded logs retained the reason, code, and log ID; neither the outbound-body
sentinel nor the credential sentinel occurred. The session closed, its lease was
released, and the temporary state directory was removed. This was a local replay,
not a live platform rejection. The existing real-shim test separately verifies
that this Core failure result reaches MCP content unchanged. No Core production
error formatter or Feishu-specific Core branch was added.


### Final TeamLeader pre-review

PASS on the final rebuilt transport: the 30,000-character fenced line produces
two content strings of 28,672 and 1,448 serialized bytes. Matching inline-code
runs and both escaped examples remain literal. The same-name card case where
one identity already occurs on another primary line retains all three ordered
mention occurrences and the supplemental visible line. Structured plain-text
nodes remain literal. Typed `app_id` metadata populates no supported identity;
an unmatched source identifier still passes through as a source assertion.
The extra prefix classifier is absent. P1-P4 are closed; P5 is withdrawn as
recorded above, not counted as an accepted platform rule.

The leader inspected the developer's final native-session tool record: one
sequential root Rush run completed build (3 successful operations), lint (7),
test (4 successful plus 3 successful-with-warnings), and `typecheck:tests` (7).
The test warnings come from existing failure-path stderr in unrelated packages.
This is recorded developer execution, not a second leader rerun. Direct built-
code replay above, the real MCP failure replay, and the live Codex compaction
probe are independent leader checks. `git diff --check` and the KB checker also
pass. The new transport test-typecheck script covers tests previously omitted
from that gate.

No live service configuration, deployment, or lark-cli send was performed by the
implementation. No new live Feishu rendering or peer-wakeup claim is inferred
from unit results; the earlier native-post probes retain their stated limits.
Independent Devbox code review and normal PR CI are still outstanding.

Rush change-file command: after staging both new ordinary minor notes,
`rush change --verify` exits zero. Its output uses the configured default
`origin/main` comparison and lists existing committed notes, not the two new
notes. This does not establish validation of those additions; their JSON and
package/type fields were inspected separately, and verification must run again
after commit.


### PR review handoff

The operator requires a published PR before Devbox review. The local-input
manifest above is a historical snapshot; the PR head will identify the actual
review target. Publishing before review is explicitly authorized and is not a
claim of review approval. The task remains in review until independent findings
are adjudicated. The original source baseline includes an unrelated unmerged
Workflow-notification commit; only the current task's change is carried onto
`next`, with the required gates rerun after that integration.


The task patch was rebased onto `next` at `27428f85` without carrying the unrelated
Workflow commit. The only conflict was two additions to the channel task index;
both entries are preserved. Range-diff confirms no implementation change.

Post-commit change verification against `origin/next` detected a missing Dreamux
note that the earlier default-branch check had not exposed. Rush generated an
ordinary `none` note for the Dreamux maintenance/test-only changes; the existing
two channel/transport minor notes retain their release descriptions. No package
version or generated changelog was edited.
