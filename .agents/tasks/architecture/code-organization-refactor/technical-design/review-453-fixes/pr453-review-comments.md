# PR #453 external review-comment adjudication

Recorded 2026-10-09 against the reviewed tree identified by
[the external review](https://github.com/excitedjs/dreamux/pull/453#pullrequestreview-5459263113).
This is a follow-up within the existing repair task, not another independent
review workflow.
Implementation delivery: [PR #465](https://github.com/excitedjs/dreamux/pull/465),
targeting the parent feature branch.

## Authority and limits

The operator said: “拉一下评论看看。真问题可以修复，不是真问题的话，直接在在评论上回复他。”
This authorizes source-backed fixes and replies in the original GitHub threads.
The earlier instruction “停掉最后这次复审” still stops the internal review
workflow. R74, R75 and R76 remain unchanged; physical provider-home alias
resolution is not added. The same developer owns source and tests; the
TeamLeader owns adjudication, knowledge and delivery.

The separate parent-delivery instruction, “先合入 453”, authorizes normal
delivery to `next`. It does not authorize bypassing required non-author review
or branch protection. [PR #464](https://github.com/excitedjs/dreamux/pull/464)
identifies the preceding repair delivery; GitHub remains authoritative for
pull-request state and CI.

## Source adjudication

| Original comment | Disposition and concrete boundary |
| --- | --- |
| [Register interceptor](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221039673) | Confirmed omission-return scenario. Tapable preserves an undefined register result for new taps but overwrites existing taps during retroactive interception. The existing hook guard now preserves undefined-as-unchanged for earlier and later taps. Actual sync/async execution and explicit replacement assertions retain original owner attribution; no general tap validator is added. |
| [Exact unbind with same-Team inheritance](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221040384) | Confirmed topology: group and exact topic both serve L; removing the exact row leaves L serving the topic while an exact-target COT fence rejects its future submissions. Unbind now retires the removed presentation and claims the committed fallback for fresh submissions, including the same Team. Actual owner assertions prove interruption once, no stale output, fresh inherited output and subsequent parent-route retirement. |
| [Inherited topic takeover](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221041126) | Confirmed topology: L serves a topic through its group; installing an exact N binding reports no displaced exact row, so L's anchor in that topic is not retired. Bind now supplies the effective prior serving Team separately from the exact replaced row. Actual active/completed presentation assertions prove no stale output, no second terminal, correct new output and restoration through fallback; the public previous-binding result stays exact-only. |
| [Sealing catch](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221041790) | No current failing producer is identified. The reviewer explicitly acknowledges current legal event shapes cannot trigger a seal failure. Core-owned typed DTO freezing and per-listener isolation remain; runtime activity sanitization is already producer-guarded. A speculative catch is not added under the named-failure-scenario rule. [Thread reply](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221496786). |
| [Feishu major/BREAKING note](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221042324) | Refuted against current CLAUDE.md Changelog Responsibility: Dreamux-internal packages explicitly include feishu-channel and use minor/plain notes for incompatible APIs. Its published 6.x number does not override that exception. Existing persisted routing documents remain readable. [Thread reply](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221497263). |
| [Utils BREAKING/Review framing](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221043032) | Refuted against the same current policy: API changes with readable persisted files never use BREAKING, Rebuild or Review. The ordinary note already names the removed export and external-provider adaptation. [Thread reply](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221497712). |
| [Bootstrap shipping claim](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221043614) | Confirmed README contradiction. R56 deliberately leaves the package unpublished and as a dev dependency, so the correction is documentation of that availability boundary, not publication or a new runtime dependency. README and maintenance guidance now state the unpublished/dev-only boundary. Its independent export-condition guard remains; it is not release authorization. |
| [Async factory/config reader](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221044176) | Confirmed unobserved rejected-promise paths. The factory is already synchronously object-validated; contrary to the comment, loadPlugins' await observes constructPlugin's attributed rejection, not the rejected factory result. A config reader currently stores its Promise into config without observing it. Factory and reader thenables now fail loading synchronously after observing their rejection, with ref/name/phase and config-entry attribution. Resolving/rejecting cases exercise the actual loader and publish no Promise-valued config. |
| [Pairing token logs](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221044856) | Confirmed fresh/resend gate contexts contain the raw credential. Ordinary gate decision logs are actually emitted at debug, not info as claimed. Both contexts now expose only credential length. An actual FeishuAccess call sequence verifies fresh/resend logs, persisted usable token, approval and later admission without raw-token exposure. No inbound helper is imported into access. |
| [Case-alias plugin state directories](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221047139) | The name grammar and exact duplicate comparison admit Foo and foo, whose verbatim state paths alias on a case-insensitive filesystem. The duplicate-name comparison now refuses simultaneous ASCII case aliases while preserving original spelling, the state path and exact API key of a single mixed-case plugin. Actual loader/host assertions cover both alias orders, an always-loaded alias and single-name preservation. No path hash, migration, FS detector or insensitive-volume reproduction is claimed. |
| [Workflow journal ordering](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221081829) | No present ordering defect. Actual result and terminal paths await their matching journal fact before the store write; emit/submit also await appends. The requested sentence now documents that existing invariant, without adding a mutation queue, new state or a global ordering guarantee across unrelated writes. [Thread reply](https://github.com/excitedjs/dreamux/pull/453#discussion_r4221504080). |

## Evidence owners

- Hook isolation: `/packages/dreamux/src/plugin/hooks.ts` and actual hook tests.
- Route mutation and presentation: `/packages/channel/feishu-channel/src/routing/index.ts`,
  `/packages/channel/feishu-channel/src/routing/operations.ts` and
  `/packages/channel/feishu-channel/src/cot/recipients.ts`.
- Plugin construction/configuration: `/packages/dreamux/src/plugin/loader.ts`,
  `/packages/dreamux-types/src/plugin.ts` and the real loader/host tests.
- Pairing decisions: `/packages/channel/feishu-channel/src/access/gate.ts` and
  `/packages/channel/feishu-channel/src/access/index.ts`.
- Workflow durability: `/packages/dreamux/src/service/workflow-service/run.ts`.
- Publishing policy: `/CLAUDE.md`, Changelog Responsibility; R56's actual
  words remain in the [rulings](/.agents/tasks/architecture/code-organization-refactor/rulings.md).

Passing historical gates do not certify these new corrections. The existing
1,965-identity coverage ledger must preserve every surviving contract and its
actual owner assertion. Any fresh validation report must distinguish default
model exclusions, actual native Codex execution, simulated Feishu IO and
unobserved platform/filesystem cases.

## TeamLeader pre-review and current validation (2026-10-09)

The TeamLeader inspected all production, test, maintenance, README and change-note
diffs against the external review's tree. The two routing facts are resolved
inside the serialized routing transaction, not from an earlier snapshot; one
private hierarchy resolver serves both planning and committed mutations. The
new ephemeral facts do not become persisted fields or Core payloads. Exact
previous-binding responses and historical anchor provenance remain. Failed
atomic writes produce no release, claim or notice; same-Team binding and
independently served exact-topic assertions retain their locked meaning.

All 900 tracked/new non-KB input hashes match the tested contents, with no
missing or additional input path. All 1,965 historical identities retain their
original dispositions and owner assertions. The TeamLeader read the actual
eight-package summaries and native case lines, rather than accepting test
counts or the completion notification as coverage proof.

| Repository command | Recorded result |
| --- | --- |
| Rush build | Passed |
| Rush lint | Passed |
| Rush typecheck | Passed |
| Rush typecheck:tests | Passed |
| Default Rush test, both live selectors unset | 2,668 passed; six explicit model exclusions |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | 2,674 passed; zero skipped; all six actual native Codex cases |
| Rush change verification against origin/next | Passed |
| Complete diff whitespace check | Passed |

The enabled cases cover effort/reset, persistent native resume, portable output
schema, in-flight activity, an unbound native terminal and #63. Both #63
acknowledgement-before-blocking-completion assertions remain. Feishu transport
IO is fake; Claude fixtures are synthetic. Local Linux evidence does not
certify macOS/case-insensitive volumes, actual Feishu/Claude or service-manager
acceptance. Hosted CI belongs to the delivery PR, not these local results.

This is source/assertion pre-review under the operator's direct follow-up
authority. The R77-stopped workflow was not restarted and no independent review
pass is claimed. Current knowledge owners and maintenance guidance are aligned
with these corrections; R74/R75/R76 and the documented startup scan cost remain.
