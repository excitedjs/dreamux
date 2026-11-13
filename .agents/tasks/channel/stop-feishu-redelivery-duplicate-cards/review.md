# Implementation review

## Target and coverage

The complete uncommitted change on this branch (25 tracked files, 6 new
untracked ones including this record and the new test, 2 change files),
reviewed by five independent lenses against
[the requirement](requirement.md) and
[the final solution](technical-design/final.md):

| Lens | Scope |
| --- | --- |
| correctness | The detached routes, the identity retry, the decoder, the failure path |
| concurrency-lifecycle | Ownership, teardown, interleaving, the abort path |
| requirement-conformance | Diff against every sentence of the requirement and solution |
| test-integrity | Every edited assertion; the #63 gate; the new acknowledgement tests |
| architecture-consistency | Root and both channel-package CLAUDE.md files; the KB diffs |

Every lens read the diff, the three task records, and the source it judged; the
pinned Lark SDK was read directly for the envelope-flattening and
acknowledgement claims. `packages/channel/feishu-channel` was run in full (828
tests, 40 files) and the transport's `bot-member` and `self-identity` suites
(12 tests) by the conformance lens and again by the TeamLeader.

The live #63 gate was executed once, by the test-integrity lens, under
`DREAMUX_RUN_LIVE_MODEL_GATE=1` against a real Codex install; it passed in
119.7 s. That run predates the corrected wait predicate, so the current gate
has not been executed. Nothing in this change asserts against the real Feishu
platform.

## Adjudication

The operator ruled on scope once, at the start: **fix everything**.

> 全修（推荐）

That ruling covers every finding below. Severities are the lenses' own; the
acceptance column is the TeamLeader's after checking each against source.

| # | Finding | Disposition | Evidence | Ruling |
| --- | --- | --- | --- | --- |
| 1 | Detached inbound puts the unbounded bot-info lookup inside the drain, so `close()` can hang forever (concurrency) | **Accepted** | `resolveBotInfo` issues up to three `client.request` calls with no timeout, and the SDK's client is a bare `axios.create()` with timeout 0 (`lib/index.js:185`). The lookup now runs inside work `teardown()` drains. Fixed with a per-request `BOT_INFO_TIMEOUT_MS = 10_000`, which bounds the whole lookup at about half a minute including backoff. | 全修 |
| 2 | The document-comment route has no lifecycle fence, so a teardown logs a false "failed to deliver" (concurrency) | **Accepted** | `submitter.submit` returns `{status:'error', message:'Feishu session is not live'}` rather than throwing (`session/submitter.ts:39-41`), and `deliverTo` reported every non-`rejected` outcome. The chat path has the guard at `inbound/pipeline.ts:417`; the doc path had none. Added `isLive` to the options and a fence before each report. | 全修 |
| 3 | The #63 gate waits for the request to be *sent*, then asserts its `ack` (three lenses) | **Accepted** | `requests.push(row)` runs before `await realRequest(...)` and `row.ack` is assigned after it (`codex-inbound-live.test.ts:180-183`). The predicate is now `turns().length === 2 && turns()[1]!.ack !== undefined`. | 全修 |
| 4 | AC-2's only test passes with the teardown drain deleted (test-integrity, blocking) | **Accepted — proved by mutation** | Deleting `await this.lifecycle.drain()` from `teardown()` left all six tests green. The test waited one microtask, which cannot reach the drain. It now waits for the drain call and then a bounded window; the same deletion now fails. | 全修 |
| 5 | The abort-silence test is satisfied by the pipeline's pre-existing swallow (test-integrity, blocking) | **Accepted — proved by mutation** | Deleting the session's `aborted` filter left the suite green, because `inbound/pipeline.ts:439` already swallows it. The branch is unreachable from any path, so it was deleted per the repo's "no defense without a named failure scenario" rule, and the test was replaced with one that drives the document-comment fence with a real `error` outcome. | 全修 |
| 6 | The identity-order test does not prove the "not before the route returns" half of its name (test-integrity) | **Accepted** | `bot.identityLookups === 1` is true whether the lookup ran inside the work or on the ack path, because `inject` awaits the route either way. Rewritten to hold the lookup open and assert the delivery has not started when the route returns. | 全修 |
| 7 | AC-7's channel half is claimed but does not exist (two lenses) | **Accepted** | `injectBotMemberAdded` had no call site anywhere. Added a channel test that feeds the event twice and reads `seenEventIds` back from the committed file; mutation (forwarding `''`) now fails it. The transport half cannot cover this and vice versa, which the test says. | 全修 |
| 8 | `feishu-document-comments.ts` claims the two reads are "the only unbounded part of this path" (architecture) | **Accepted** | `deliver()` runs N submissions after them, each able to start a runtime. Corrected. | 全修 |
| 9 | `channel.md` presents the timeout retry as the only redelivery source (architecture) | **Accepted** | The requirement records Feishu documenting at-least-once delivery, with 10 of 102 measured duplicates not fitting the retry schedule. The page now names both classes and says the Channel is idempotent, not exactly-once. | 全修 |
| 10 | `channel.md` keeps the retired ack rationale for the enrichment deadline (architecture) | **Accepted** | The code comment was corrected in this same change; the KB was not. Both now give the reader-facing reason. | 全修 |
| 11 | The pairing page still says there is no `doc_comment` handling (architecture) | **Accepted** | `DOC_COMMENT_EVENT_TYPE` has been registered since #429 (`bot.ts:174`), and this change detaches that very route. The sentence predates #429; corrected. | 全修 |
| 12 | The task record says the identity retry was dropped, and its residual-risk note is stale (architecture) | **Accepted** | `isBotMentioned` only reads `botOpenId` and never retries, so "the gate's own resolution attempt" described nothing. The solution now records the move into `resolveIdentityThen` and why. | 全修 |
| 13 | The solution claims the transport public shapes are unchanged (conformance) | **Accepted** | `ensureSelfIdentity()` is a new required member of `FeishuTransport` and flows into `FeishuBot` through `Omit<…>`. Recorded as an ordinary `minor` shape change. | 全修 |
| 14 | Two source comments still describe the retry as happening ahead of the route (conformance) | **Accepted** | `identity.ts:13-15`, `feishu.ts:374-376` and the `self-identity.test.ts` header. All three corrected. | 全修 |
| 15 | Transport comments describe channel policy — mention gating, the ack window (architecture) | **Accepted** | `packages/channel/feishu-transport/CLAUDE.md` requires platform capability only. The member stays; the channel-policy prose was removed. | 全修 |
| 16 | The failure log does not identify the message (architecture) | **Accepted** | Every other inbound log line carries `chat_id` / `message_id`, and this is now the only record of a lost event. `runDetachedInbound` takes a scope. | 全修 |
| 17 | `runDetachedInbound` hand-rolls `errorInfo` (architecture) | **Accepted** | `errorInfo` is in `@excitedjs/dreamux-utils`, which the package already imports, and three sibling modules use it for this exact field. | 全修 |
| 18 | A doc comment was displaced onto `identityLookups` in the fake bot (two lenses) | **Accepted** | Visible in the diff. Restored to `commentTextReads`. | 全修 |
| 19 | `identityLookups` on `FakeTransport` is never asserted (test-integrity) | **Accepted** | Dead scaffolding. Removed from both fakes. | 全修 |
| 20 | The bot-member case pins a precedence production cannot produce (test-integrity) | **Accepted** | The SDK flattens the envelope, so `header` never coexists with a top-level id. Deleted; the two cases that describe real payloads stay. | 全修 |
| 21 | The record cannot be committed while its state is `review` (architecture) | **Deferred to `done`** | `.agents/scripts/check.sh` fails on `review` by design; the state changes at the knowledge-closeout stage, before the PR. | 全修 |
| 22 | The per-request timeout does not bound the lookup: the SDK fetches a tenant token first, with no timeout on that leg (correctness, re-confirmed by adversarial verification) | **Accepted — proved by probe** | `Client.request` awaits `formatPayload`, which calls `getTenantAccessToken` → `requestToken` → `httpInstance.post(url, body)` with no timeout, on a bare `axios.create()` (timeout 0). A per-request `timeout` bounds only the final call. Replaced with `withDeadline` around the whole lookup at 10 s, which is inside the daemon's 15 s shutdown deadline; a test drives a never-settling client and fails if the deadline is removed. | 全修 |
| 23 | A source comment attributes a decision to the operator (correctness) | **Accepted** | `session.ts` carried "the operator ruled it must not" in a JSDoc that ships in a published package. Replaced with the technical property alone. The same class exists at `packages/dreamux/src/service/dispatcher-core-events/conversation-projection.ts:174`, which is outside this task's scope and is recorded as debt rather than fixed here. | 全修 |
| 24 | The two new task records contradict each other on whether the #63 gate ran (correctness) | **Accepted** | `review.md` said "not covered by any lens" while `verification.md` recorded a passing 119.7 s run. `review.md` was the wrong one; both now say the same thing, including that the run predates the corrected predicate. | 全修 |
| 25 | The document-comment fence also skips the rejected-subscription cleanup (correctness, judged overstated) | **Accepted as narrowed** | The fence sat before the `rejected` branch, so a teardown could skip `routing.unsubscribe`. The verification pass showed the ordinary close does not reach it, but the fence did more than its own comment claimed. Moved to guard only the report; the repair below runs regardless. | 全修 |
| 26 | A failed inbound send is logged twice (correctness) | **Accepted as documented, not merged** | The send logs its own failure and rethrows; the session now logs the lost inbound. Collapsing them would require the session to parse where the error came from. The layering matches `introduce ack failed` and the pairing-prompt failure, so the two records now say two lines rather than claiming one. | 全修 |
| 27 | `deliverExtensionForward` and `deliverAskUserSettlement` have the same teardown false-failure as the document path had (concurrency) | **Accepted — fixed at the root** | Both are `void`-detached from `handle`, outlive `close()`'s drain, and reported a teardown as an error-level failure. Fixed by #28 rather than by a third fence: they already read `describeSubmitOutcome`, so the new kind covers them with no code of their own. | 全修 |
| 28 | `isLive` is the second workaround for one missing fact: `FeishuSubmitOutcome` cannot say "never attempted, session stopped" (concurrency) | **Accepted — fixed at the root** | Added `{ status: 'not_attempted', reason: 'closed' }` to the union and a `not_attempted` report kind at `debug`. The submitter returns it instead of an `error` string, so every delivery path answers "was this a failure?" from the outcome it already holds. That deleted the `isLive` option added in this change and the chat path's `work.isSessionActive()` check at `pipeline.ts:417` — two workarounds for one missing fact, gone. | 全修 |
| 30 | `deliverAskUserSettlement` never classified its outcome, so a teardown still logged `[ask-user] answer delivered` at info (round 3, two lenses) | **Accepted** | Row 27's claim that both card-action paths were fixed at the root was wrong: only `deliverExtensionForward` read the classification. `deliverAskUserSettlement` logged a fixed info line with `status` as an ordinary field. Now it reads `describeSubmitOutcome`, so a stopped answer is reported at `debug` and named as not attempted. | 全修 |
| 31 | A provisioning run that commits a Team and a route can answer `not_attempted`, and the inbound path said nothing (round 3) | **Accepted** | `run()` creates the Team, commits the binding and announces the card before it submits. A teardown in that window produced `not_attempted`, and `pipeline.ts` returned silently — true of the submit, false of the run. The run now records its own half, where the fact lives. | 全修 |
| 32 | `describeSubmitOutcome`'s `default` would silently file a future status as `failed`/`error` (round 3) | **Accepted** | The `default` absorbed `error`/`unsubmitted` by name and anything else by accident. Both are now explicit cases and the default is a `never` assertion, so a new status is a compile error rather than a false failure record. | 全修 |
| 33 | The classification's header comment stated counts that were already wrong and are now wrong again (round 3) | **Accepted** | It said "five kinds and not seven statuses" against nine statuses; the edit made it "seven … eight" against ten. The counts are gone; the rule (a new status joins a kind or earns one) stays. | 全修 |
| 34 | 10 s deadline plus the 5 s COT drain consumes the whole 15 s host budget (round 3) | **Accepted** | `teardown()` runs `cot.close()` (bounded at 5 s) before `lifecycle.drain()`, so the two bounds are sequential. The ceiling is now 5 s, and the per-request timeout 2 s — at 5 s each the first attempt would have consumed the entire budget and the retries could never run. | 全修 |
| 35 | `resolveAppOwner`'s `?? {}` collapsed "timed out" into "this app has no owner" (round 3) | **Accepted** | `card-actions.ts` renders an empty owner set as `Owner 校验配置错误`, a permanent configuration defect, while a lookup failure renders as `请稍后重试`. A deadline expiry now rejects so the caller reaches the transient message. | 全修 |
| 36 | A deadline expiry produced no diagnostic at all (round 3) | **Accepted** | Every other failure path reports through `diag`; this one returned `undefined` silently, and the abandoned loop's later diagnostic describes a different failure. `withDeadline` now names the lookup and the deadline. | 全修 |
| 37 | The host-deadline test asserted against the full 15 s, so a 14 s ceiling would pass (round 3) | **Accepted** | It now asserts against what is actually available after the COT drain. `resolveAppOwner` gained its own never-answering test, which it had none of. | 全修 |
| 38 | `not_attempted` covers only "already dead at entry", not "died while the submit was in flight", so the latter is still reported as `error` (round 3, two lenses) | **Accepted** | Core's port fence answers `SERVER_SHUTTING_DOWN` when the host is going away, which `teamSubmit`'s catch mapped to `error`. It now maps to `not_attempted`, so a delivery the shutdown interrupted reaches the same answer as one that never started. | 全修 |
| 39 | The teardown-silence test captured only `error` level, so deleting either `not_attempted` guard left it green (round 3) | **Accepted — proved by mutation** | The recording logger now captures every level, and the subscriber-path case asserts that *no* record is written for a stopped delivery — not a failure, and not the `not_attempted` line either. Deleting the `deliverTo` guard fails it. The cold-open and subscriber paths are covered separately, because one case cannot reach both. | 全修 |
| 40 | The shipped change note and the design record still said ten seconds after the ceiling became five (round 3, two lenses) | **Accepted** | Both corrected; the change note is the operator-facing changelog entry, so a wrong threshold there is a wrong statement about behaviour. | 全修 |
| 41 | `verification.md` both recorded that the #63 gate ran and that it did not (round 3) | **Accepted** | The two halves are in the same file twelve lines apart. Row 24's claim that this was reconciled was wrong. Both now say the same thing. | 全修 |
| 42 | The abandoned lookup is not cancelled, so it keeps retrying and can leave a socket pending (round 3) | **Deferred — SDK-owned** | The tenant-token exchange is inside the SDK's `formatPayload` and its request options carry no signal; `HttpRequestOptions` has no `signal` field. Cancelling it would mean replacing the SDK's HTTP client, which is a larger change than this task. The deadline bounds the *caller*; the abandoned work is bounded by its own three attempts, except on the token leg, which is unbounded inside the SDK. Recorded as a known limit rather than papered over. | 全修 |
| 43 | `FeishuBoundTeamSubmitOutcome` spells the closed-session answer `refused` while the inbound path now spells it `not_attempted` (round 3) | **Deferred** | Two operations, two contracts: an extension call is refused before it ever reaches the submitter, and its answer also has to carry `binding_changed`. Unifying them is a change to a published surface with no defect behind it — the two are distinguishable by their own types, and no caller reads both. | 全修 |
| 44 | The `not_attempted` message entries in two tables are unreachable because the guards return first (round 3) | **Accepted — fixed** | Round 3's own guards made the entries dead, which was a symptom of a worse bug (#45). Both paths report again, so all three entries are live. | 全修 |
| 45 | `not_attempted` was invisible in a stock install: both real paths returned before reporting, and the only path that reported wrote at `debug`, which the default `info` level drops (round 3, full result) | **Accepted — this made the change worse than what it replaced** | Before this change a teardown produced `failed to submit feishu inbound` at error — wrong about the cause, right about the message. The first version of this fix produced nothing at all: the message is gone and the operator cannot even find it by id. The kind now reports at `info`, and both delivery paths report it. A shutdown is still not a failure; it is still a record. | 全修 |
| 46 | The `not_attempted` fact is derived from the session lifecycle, but Core's admission fence closes far earlier, so the longer slice of teardown still filed an error-level false failure (round 3, full result) | **Accepted** | `closeAdmission()` runs at the start of a dispatcher close; this session's `lifecycle.abort()` does not run until `channels.closeAll()` at the end, after two runtime sweeps. In that window `isLive()` is true and Core answers `SERVER_SHUTTING_DOWN`. The error outcome now carries Core's code, and the submitter maps that code to `not_attempted` regardless of liveness. | 全修 |
| 29 | The "no abort branch" comment rests on an invariant no test asserts (concurrency) | **Accepted as recorded** | Deleting the branch is safe today for the sink, but the silence is now implicit: each path intercepts aborts earlier, and one of those interceptors turns an abort into an error-level line rather than silence. `final.md` and the code comment now say that rather than claiming a blanket guarantee. | 全修 |

| 47 | Six non-blocking comments from the external reviewer (Devbox), all leftovers of row 45's `debug`→`info` reversal plus one layering wording point | **Accepted** | Three source comments still said `debug` or "deserves silence"; `session.ts` claimed the document path reports nothing at all, contradicting the info line it writes; the `'debug'` member of `SubmitOutcomeReport.level` had no producer; two test names said "reports nothing" while asserting an info line; and the transport's deadline comment sized itself against the host's 15 s and the channel's 5 s drain, which is exactly the upstream knowledge row 15 removed from that package. All corrected; the transport now states its rationale in its own terms and the test asserts its own ceiling. | 全修 |

## Corrections applied

Every accepted finding was fixed in this change, then the whole diff was
re-checked: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests` all
pass. Two test doubles needed the new `isLive` option, and three transport
assertions needed the new `timeout` in their expected request — both are the
change's own new contract being made visible, not relaxed assertions.

Four of the corrections are test-shaped, so each was verified by deleting the
behaviour and confirming a test fails; the table is in
[verification.md](verification.md#mutation-checks).

## What the review did not settle

The live #63 gate was executed once by one lens (119.7 s, passed) before the
wait predicate was corrected; it has not been re-run since. Nothing in this
change asserts against the real Feishu platform.
