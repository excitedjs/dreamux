# Solution adjudication

Current amendment: R75, 2026-10-08. The operator said “先和 next 保持一致吧”
after the next/current uninstall comparison. The [revision-2 requirement](../../artifacts/review-fixes-20261003.md)
and [final solution](final.md) replace only the foreign-retention predictor
with next-compatible preview and recursive root removal. The earlier table
below remains the historical consultation record for the other outcomes.

Date: 2026-10-03. The three independent proposals and one adversarial round
are complete. The source corrections within that round did not start another
peer-review round. This table records TeamLeader decisions, not votes.

| Question | Disposition and source reason |
| --- | --- |
| Release at terminal record write | Reject. An unmanaged/terminal worktree's closed write precedes child destruction. Status is not an ownership endpoint. All authors withdrew this after source checks. |
| Move service.closed after physical cleanup | Reject. Preserve the signal and exact-instance eviction at their existing point; a record hold can outlive live service membership without another lifecycle promise. |
| FIFO implies cleanup drained a late running patch | Reject. The unmanaged cleanup path has no trailing record update. The independently checked recovered-starting/closed-write overlap requires the existing transactional drain. |
| Count every Team admission/write | Reject. Actual guarded submission writes are synchronously enqueued before closed commits or skipped after it. Queue drain and explicit construction coverage suffice; no generic operation accounting is added. |
| Pure single-owner transfer versus narrow holder count | Select the narrow count on the existing entry. DeepSeek/MiMo's argument that construction and dissolve cannot overlap relies on collection.get joining construction. The leader delegate is instead bound directly to the service (`team/leader.ts`, `team/leader-mcp.ts`) and can submit self-dissolve before initial construction finishes. Count one construction-to-service transfer and one detached dissolve, plus explicit recovery/read acquisitions. This protects independently settling uses without exposing another completion protocol to the collection. Pure single ownership could work only if it also joins all those paths; no votes decide this. |
| Failed cleanup job versus pending durable fact | Release the settled job's hold; retain the small record's existing memory authority while its cleanup-pending fact remains. No live service, retry timer, or hidden task is retained for that fact. Fully retired completed history is released as R74 selected. |
| Provider default versus throwaway contribution host | Restore typed provider defaults and explicit named plugin exports. Bare configured official plugin refs already fail duplicate-name checks alongside always-loaded builtins. Third-party defaults and plugin capability remain. No-I/O is not purity and does not turn contribution into a provider factory contract. |
| Direct named constructor alias as context-taking default | Use small neutral typed factory adapters. Codex constructor options are not the published provider-loader context; declaration compatibility matters as well as JavaScript calls. |
| Replace anchor.target or infer current routes on release | Reject both. Preserve visible-target fence policy and add the actual serving target to the same stored anchor. Later exact binding does not alter the provenance of an existing parent-served card. Retire committed silent removals independently of notices. |
| Expiry-aware lookup only | Prune at successful-send commit with one current time, preserving concurrent approval and live winner behavior. Pair gate outcomes do not persist the pruned snapshot, so lookup-only leaves obsolete entries accumulating. |
| Regression tests alone or accepted coverage gaps | Reject. Every surviving deleted-ledger obligation needs named evidence or an actual superseding ruling. Restore and run the real #63 gate; installed Codex alone proves nothing. |

The resulting [final solution](final.md) is revision 1 against the active
[requirement](../../artifacts/review-fixes-20261003.md). It requires no further
operator product choice. The direct repair instruction and explicit R74 answer
authorize implementation; no new approval-card evidence is invented. Pending
external verification remains an acceptance obligation, not a design veto or
an automatic declaration that coverage has passed.
