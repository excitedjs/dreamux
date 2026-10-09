# Repair solution

## Scheduler ownership

Keep Scheduler's schedule validation and policy. Change the existing CronJobStore update boundary so a synchronous derive function receives the current row inside TransactionalStore.update. Scheduler normalization, effective enabled state, and next-run calculation execute there. Remove the pre-transaction mustJob path and preserve the existing job-not-found command error. Adapt reconcile without changing its startup ordering.

Successful/ambiguous fire settlement records id and firedAt, then applies a current-row scheduling decision in the same transaction. A disabled current row stays disabled. If next_run_at has been replaced since the dispatched occurrence, preserve that replacement and its writer's timer ownership; otherwise advance the current recurrence/schedule or finish the current one-shot and arm that result. Re-arming a preserved occurrence could submit it twice if its timer already began dispatch. The original occurrence time is an observed fact, not a second policy ledger. Use no new generation, lock, durable field, or owner. Keep provider submission outside this transaction, missed settlement, lifecycle arm fencing, and deletion semantics.

## Routing binding decoder

Validate typeof row.team_name === string in the existing validatedBinding function before projecting the row. Missing and non-string values use the existing malformed-binding failure, not a downstream fallback or silent default. Keep the existing file version, unknown-field projection and absent-root_message_id compatibility. Add real file-reader regression cases. No new validator framework or validation of neighboring fields is required.

## Shared activity opening

Put one openActivityFile operation and result type in the existing dreamux-utils activity filesystem/scan owner. Accept a root list and provider-owned static error messages. Keep initial/reopen ENOENT/ELOOP classification, regular-file and canonical-root checks, inode/device comparison, held-handle ownership, and all close-on-failure behavior. No provider discriminant, native layout, callback factory, retry, cache, or new filesystem policy enters utils.

Change Codex path/reader and Claude path/reader directly. Delete both old opened-file implementations. Move Claude session-evidence decoding into its existing native activity/path owner before deleting that file. Keep both readers' discovered-file identity comparisons and native metadata/cursor/lineage behavior.

## Selected deletions

- A4: narrow isolatedTaps to its actual SyncHook registration contract; remove unsupported async registration conversion and artificial tests, retain Promise-return rejection observation.
- A5: let terminal intent gate a live WorkflowRun. Pass or use the known reserved intent for finalization; remove impossible terminal-record fallbacks. Preserve retryable terminalTask, fixed terminal candidate and runnerTerminalMessageSeen.
- A6: remove static builtin handler unknown-tool policy after registry catalog proof. Keep registry unknown-tool result and external validation.
- A7: delete the Codex locator input/branch and its literal-null caller, plus restartTask and its self-clear; keep actual restart fencing and rejection observation.
- A8: translate already validated Codex config in args; remove its second allowlist only. Keep extra_args after generated approval/sandbox flags and before the separately appended MCP flags.
- A9: remove post-resolution builtin alternatives; pass the sole {ref} factory context directly and remove unused descriptor input. Use the published ProviderFactory type instead of a now-identical local declaration. Move identical config/onboard/diagnostic shape checks into the existing loader; delete both adapter copies while retaining kind-specific mandatory checks and error order.

## Entropy and product boundaries

The change removes two file opening implementations, two unused Codex state/input concepts, several impossible branches, and repeated input-policy copies. It introduces one shared operation in an existing owner and current-row transactional derivation at an existing write boundary. Native transports, persisted schemas, MCP/Command catalogs, supported extra_args overrides and public runtime factory entries retain their contracts. F1/A2/A3/A10 remain excluded. F3 adds only the later operator-selected mandatory binding field check.

## Verification plan

The implementation developer returns changed files and focused behavioral evidence. The TeamLeader reviews the whole diff, runs the four Rush gates and knowledge/anti-leak checks, and obtains independent read-only reviews of scheduler/core and shared-runtime changes. The final PR targets next; normal CI and merge authority are separate delivery facts.
