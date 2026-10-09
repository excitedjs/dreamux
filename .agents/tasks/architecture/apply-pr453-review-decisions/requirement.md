# Accepted requirement

## Source and scope

The operator selected specific findings in a deep source review of [PR #453](https://github.com/excitedjs/dreamux/pull/453) on 2026-10-09. This is a bounded remediation of those selections, not a restart of the earlier refactor or approval of every proposed cleanup.

## Operator decisions

- **F2, Scheduler:** “这个可以修一下。” This was attached to the recommendation to perform read, derive, and commit in the existing serialized owner; preserve the sparse caller patch, record the factual fire, and derive rearming from the current pause/schedule without a new global lock or state entity.
- **F3, routing required field (later ruling):** “这个应该吧 team_name 作为必填字段来校验吧？” Enforce the existing mandatory string field at the routing binding decoder. A missing or non-string team_name must fail loading through the existing malformed-binding error. Keep unknown-field tolerance and accepted absent-root_message_id compatibility. No supported producer of the malformed row was found; this later ruling authorizes validation of the named field without reclassifying the original review as a demonstrated normal-path incident.
- **A1, runtime filesystem mechanism:** “如果现在已经有代码在引用 dreamux-utils，那可以把这块文件系统的操作迁移到Utils包里去。” Both runtime manifests already depend on dreamux-utils, and their current file openers already import its neutral activity utilities. The stated condition is satisfied. Move only the duplicate file opening mechanism and delete both full old implementations; native transcript interpretation stays provider-owned.
- **A4:** “删” on the unreachable non-sync registration branch in isolatedTaps. Keep observation of a Promise returned by an ordinary SyncHook tap.
- **A5:** “删” on Workflow's impossible live terminal-record/null-intent combinations. Keep real terminal intent, retryable finalization and receive-time fencing.
- **A6:** “删” on the four static builtin MCP adapters' unreachable unknown-tool refusal branches. Keep registry ingress validation and external delegate boundaries.
- **A7:** “删” on Codex's unused locator branch and restartTask bookkeeping. Keep native discovery, restart/teardown, and rejection observation.
- **A8:** “删” on the argument builder's duplicate sandbox allowlist. The provider config reader remains the input-policy owner.
- **A9:** “删” on the loader's unreachable builtin branches, unused descriptor/context variability, and duplicated optional-capability checks. Keep actual provider registration and external-input contract validation; move the identical checks into the existing neutral loader.

## Deferred and excluded items

- F1 dual-Feishu shared-cache scenario: “过于极端了，我感觉暂时不防御这个问题吧。” No correction or new restriction is authorized for this configuration.
- A2 COT parent-state closure: “这块确实需要改一下，但是暂时先不动，他不在 dreamux 的核心链路上，可以往后放。”
- A3 concrete bot optionality: “同 A2” and “A2 和 A3 这两个问题如果是 feishu channel 相关的自限性问题，那都可以往后放”. Both are confined to Feishu channel internals and deferred.
- The earlier F3 P2 product-defect characterization remains withdrawn: no supported writer or accepted historical schema was found generating the missing field. The later explicit operator ruling above adds only mandatory team_name validation; it does not authorize a full routing-schema audit or downstream fallback.
- A10 scope-wide Workflow persistence dependency has no implementation approval.
- No release, deployment, merge, Team dissolution, unrelated cleanup, or product-contract contraction is included.

## Required behavior

1. Concurrent Cron sparse updates apply each submitted field against the latest committed job; omitted fields retain the latest committed values.
2. Recording a successful or admission-ambiguous scheduled submission cannot undo a current pause or current schedule. Settle only the submitted occurrence; a replacement next occurrence remains scheduled. Ordinary recurring and one-shot completion retain their behavior when the occurrence has not been replaced.
3. Provider admission stays outside the store transaction so one slow submission does not block other jobs or user updates. Deleted jobs and removed files are not recreated by settlement.
4. Activity opening retains actual file/root/identity checks, exact provider-facing error classification/messages, and handle lifetime. All four production consumers directly use one neutral implementation.
5. A routing binding with absent or non-string team_name is refused at load, before it can be published as an authoritative route. Valid bindings, unknown fields and the historical absent-root compatibility keep their existing behavior.
6. Each approved dead-code deletion removes the actual concept and obsolete tests rather than adding a compatibility shell. Genuine external-input checks and supported native argv overrides remain.

## Verification

Use real Scheduler/TransactionalStore owners with the existing deferred admission and fake-time seams. Cover sparse concurrent updates, pause during accepted/ambiguous admission, current rescheduling, and unchanged one-shot completion. Preserve existing non-blocking, miss, destroy/write ordering tests.

Use real temporary files to verify shared activity opening and retain native activity reader tests. Do not introduce filesystem injection just to exercise hypothetical failures. Remove obsolete structure-only assertions in the affected tests, as required by the engineering whitepaper; retain all load-bearing behavioral assertions. This test principle does not authorize a repository-wide cleanup of untouched tests.

Exercise the real routing file reader for absent/non-string team_name, valid bindings, tolerated unknown fields and absent-root compatibility. Do not mock downstream failures or extend validation to unrelated fields.

Required repository gates: Rush build, lint, test, and typecheck:tests; knowledge check and mandatory anti-leak commit hook. Checks not executed or unable to run must be reported precisely.

## Additional core removal instruction

On 2026-10-09 the operator explicitly directed: “有点扯淡，先给 core 的重导出都删掉。” This supersedes the earlier retention of core directory barrels and compatibility forwarding exports for this task.

Remove all re-exports from `packages/dreamux/src`, including the agent-runtime, registry and service aggregate modules, the old neutral-type import paths, and command error/helper forwarding. Migrate source and test consumers to the modules that actually define the symbols. Retain the functions, types, classes, package main, CLI behavior and error identities those consumers use; remove the aggregate paths themselves without replacement facades or local-import/export workarounds.

Remove the corresponding core ESLint exemptions, deleted-path Knip/layer configuration, and the service facade's exact export-list smoke assertion. Keep the compiled package-main, actual service-module ESM initialization and CLI smoke probes. Update current ownership documentation and run all four Rush gates plus the built-CLI smoke and knowledge checks.

The instruction names core only. Provider/channel/transport/utils/types public entries and internal forwarding are outside this addition. C2's Codex/Claude public-entry assertions remain outside this addition; the core service-facade assertion is part of the authorized deletion. No new product behavior, persistent schema, runtime policy, merge or release authority is inferred.
