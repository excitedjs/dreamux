# PR #453 review repairs: final technical solution

Revision 2, 2026-10-08. TeamLeader source selection for the operator-authorized
[repair requirement](../../artifacts/review-fixes-20261003.md), revision 2.
R75 supersedes only the original uninstall predictor solution. The other eight
repair outcomes and final-parent coverage obligations remain.
Public solution surface: [Issue #463](https://github.com/excitedjs/dreamux/issues/463).
All three independent proposals and the single cross-review round are complete.
The [TeamLeader adjudication](adjudication.md) resolves the remaining lifetime
mechanism choice using the direct leader-MCP producer. No product decision is
left pending. The independent proposals are [DeepSeek](proposals/deepseek.md),
[MiMo](proposals/mimo.md), and [Codex ultra](proposals/codex-ultra.md).
[Source audit](source-audit.md) records independently checked caller and queue
facts. Proposal text is historical consultation evidence, not implementation
authority. This file selects the solution; the requirement owns product scope.

## Record lifetime belongs to actual uses of one owner

Keep the Team-only store map, transactional queue, bound record handle, terminal
closed merge, and concrete-name construction arbitration. Remove permanent
retention of completed history and implicit initialization by earlier scans.
Leave the generic `TransactionalStore` unchanged.

Use an explicit asynchronous acquisition that registers/finds the canonical
entry synchronously, retains that entry, loads it, and returns an initialized
handle. The handle's `current`, `create`, and `update` all use that captured
store; update must not look up another instance by id. The existing entry has
one holder count for its independently settling acquisitions. This represents
actual ownership, not Team admission or a second persisted phase.

Limit those acquisitions to:

- One construction hold, transferred once to the successfully tracked service.
  The collection acquires before construction work, passes the loaded handle
  explicitly into dependencies, and releases failed/null construction only
  after its abandonment/discard work. Rebuild inspects that handle rather than
  relying on an earlier history snapshot. Cover failures before the factory's
  current inner try block and failure after tracking without double release.
- The dissolve call retains its captured record before the asynchronous
  worktree precheck, so an admitted initial-leader call remains on the same
  owner if construction fails and retires while that precheck waits. A refusal
  or a call joining a concurrently accepted task releases its hold; acceptance
  hands that same hold to detached settlement, including a failed closed write.
  Calls that find an already-published task return its receipt without a hold.
- The existing startup recovery job's hold, acquired and loaded before cleanup,
  then released in finally. Recovery constructs no Team or runtime.
- Temporary store reads; concurrent readers and a constructor join the same
  canonical entry. Completed cold history is released, not permanently seeded.

The service hold releases when the exact instance is evicted by its existing
`closed` callback. Preserve the current signal: durable closed plus child
destruction attempted, before physical Git cleanup. The detached task keeps
the record authoritative through that later cleanup. Abandoned creation stays
covered by construction; it does not need another lifecycle promise.

A pure get of an existing retained entry joins its load promise and returns
the committed snapshot without acquiring another write-lifetime hold. A cold
lookup still acquires an initialized temporary owner and releases it after
reading. This implementation refinement removes accidental reader latency;
active memory authority, cold retired reads and writer ownership are unchanged.

Each release retains its hold while awaiting the captured store's existing
`drain()`. Then decrement, test retirement, and remove the exact current entry
synchronously. An acquisition during that wait remains counted. Release only
an absent record or a closed record with no cleanup-pending fact and no holds.
Nonclosed and unfinished-cleanup facts retain the small memory-authoritative
record even when a failed materialization or cleanup attempt has settled;
there is no retained service, retry job, timer, or separate recovery ledger.

This covers the concrete late running patch behind closed for an unmanaged
worktree: child destruction and no-op cleanup are not record-queue barriers.
It also covers initial-leader self-dissolve through the descriptor-bound MCP
delegate while construction is still completing. Do not count every Team
admission or every individual write: those broader mechanisms were withdrawn
after auditing the actual write sites. The existing guarded leader transition
cannot newly enqueue after observing committed closed; initial construction is
covered by its own hold. Host stop alone neither retires the nonclosed record
nor removes its service from the second runtime sweep.

The retained record set is nonclosed Teams, unfinished cleanup facts, and
in-flight acquisitions, rather than completed history. History queries still
require disk IO and an O(history) result array. Fully retired record edits,
deletion, or damage affect the next query/replay/name probe as R74 selected.
Preserve closed terminality, accepted-request replay while its record exists,
and invalid/missing/unreadable record policy. No cap, tombstone, record deletion,
weak reference, or generic lifetime manager is added.

## Preserve provider configuration at the public package boundary

Restore the three official package-root defaults as correctly typed neutral
provider factory adapters, invoking their current named bare-provider
constructors on package defaults. Keep named constructor options intact.
Do not alias the Codex options constructor as the context-taking public factory.

Export explicit plugin factories (`createCodexPlugin`,
`createClaudeCodePlugin`, existing `createFeishuPlugin`). Extend the existing
builtin plugin catalog's composition data to name the package and factory
export; its loader uses that export for builtins. Configured third-party npm
plugins continue to use default or their explicit `#export` selection.
Bootstrap keeps its existing default. No provider-loader package-name case,
hybrid default, shape recognition, throwaway contribute host, or config rewrite.

The configured bare official npm provider refs regain their original startup
behavior. Builtin contributions, Feishu provider/API shared registry, and named
plugin entry capability remain. Explicit official npm plugin entries were
already rejected by the always-loaded duplicate-name rule; a named export
does not bypass that rule. Document the actual root-default/named-plugin
contracts and replace obsolete startup-failure/migration claims throughout
pending notes and references. No manual startup migration is needed.

## Correct the remaining existing owners

- **Event bus:** implement the existing narrow publisher interface on
  `DispatcherCoreEventBus`, expose its two producer verbs, delete the frozen
  forwarding object, and wire the three Core consumers directly. Preserve
  revocable source leases, listener isolation, ordering, sealing, and duplicate
  subscription behavior. No runtime/provider/plugin receives this producer.
- **Claude:** make only internal `skillSources` and `disableFeatures`
  dependencies required and delete the impossible empty-list fallback. Keep
  genuine optional builder/test/RPC/logger/output-schema seams.
- **Uninstall (R75):** use the existing owned-path removal flow for the root
  as next does. Its preview checks existence and reports planned removal;
  actual removal uses async recursive force removal. Remove the separate
  config-unlink/nonrecursive-root path and the ordered removal predictor,
  inode/name ledger, link expansion and alias-disambiguation machinery.
  Provider-derived protected operator-state checks, current root addressing,
  service removal and no-write dry-run remain. Root contents are no longer
  protected as foreign files. Permission/syscall failures remain real removal
  errors, not a new preview guarantee or unknown-state fallback.
  R76 explicitly leaves the provider-home alias scenario uncorrected. Keep
  normalized-path checks without physical alias resolution or a special
  symlinked-root removal branch; no additional filesystem mechanism is added.
- **Pairing:** inside the successful-send commit, preserve the concurrent
  approval early return, take one current time, reuse the existing expiry
  pruning rule, choose the current live same-sender winner, and merge or bump
  against the pruned committed state. Return pruning even when retaining a live
  winner. Preserve unrelated valid senders, send-before-save, failed-send retry,
  approval, and both resend forms. Never commit a stale pre-send gate snapshot.
- **COT:** keep visible target and add nullable serving target to the stored
  anchor. Route planning already owns `matched`: carry it through bound inbound
  and normal card forwarding into submission. Provisioned submissions use the
  just-installed exact route; queued provisioning uses the actual binding.
  Dispatcher fallback and document comments pass null. Binding-card fallback
  uses the post-send checked bound target. Preserve the raw submission for a
  Dispatcher retry and explicitly copy provenance through anchor normalization.
  On release for that Team, match the existing visible target or its serving
  target. Keep existing visible-target fence/claim/reset policy. Retire all
  committed removed routes before optional notices, including silent removal;
  failed commits retire nothing. Reuse generation/terminal handling. Do not
  cancel issued IO, override existing terminal intent, re-resolve on every
  activity, or retire independently served exact topics.

The COT serving fact is necessary: a topic originally served by group A may
later gain an exact binding to B. Release-time current-row inference would
incorrectly keep A's existing card. Replacing the visible target would bypass
the already established exact-topic fence policy. Both facts travel with the
one existing anchor; no Core payload or persisted route field is added.

## Coverage and closeout are part of the same authorized outcome

Restore final-parent behavior evidence for every surviving deleted-ledger
obligation, not only regression cases for this batch. Do not restore superseded
contracts or literal source/path assertions. The developer supplies an ignored
case/contract-to-test evidence matrix; the TeamLeader verifies and promotes
the durable accounting. Each surviving obligation maps to a named new/current
assertion, or an actual named superseding decision. No unapproved accepted gap
or old green test count closes an obligation.

Required families: entities/Teams/worktrees/state; admission/completion/events/
leases; Workflow/cron; Codex/Claude runtime/activity; Feishu access/routing/
provisioning/COT/ask-user/settlement; canonical Commands/admin/MCP; config/plugins/
onboard/doctor/daemon/uninstall/sockets; transport/utilities/neutral contracts.
The ledger's later R71 corrections override its obsolete literal fixture recipes.
Keep locked assertions and the compiler/import-graph replacements.

Use real owners, temporary files, observable outputs, and explicit async barriers
for cold history, overlapping holds/writes, constructor/self-close, both owner
fences before side effects, late lock undo, first-terminal arbitration, cleanup
failure/recovery, replay, event lease revocation, expiry/approval, parent versus
exact route retirement, next-compatible no-write preview and recursive root
removal, and built provider/plugin imports and
declarations. Fake boundaries establish internal behavior only.

Restore and run the real #63 gate: real Codex app-server, a Dispatcher turn
blocked in a short synchronous operation, second Feishu inbound during that
window, second turn/start acknowledgement before the blocking command's
item/completed as well as native turn/completed, folding into the same turn,
marker processed afterward, and no automatic inbound reaction. Keep explicit
react usable. Installed Codex 0.159.0 is availability, not this proof. Preserve
the historical explicit `DREAMUX_RUN_LIVE_MODEL_GATE=1` execution boundary for
authenticated native-model work, with separate auth-free real protocol checks.
Missing Codex fails loudly unless intentionally excluded; a run excluding model
work cannot certify the gate. Actual
platform/provider checks and unavailable external prerequisites are reported
separately; they do not disappear into a fake-test claim.

The TeamLeader updates current product/KB owners and task records; the single
developer updates source-adjacent guidance, package docs and maintenance refs.
Keep server-owned records designated server-owned despite retired edits becoming
observable. Mirror accepted dispatcher-start removal, actual operational read
fences, and signal 0/1/deadline behavior. Narrow the stale activity-size-validation
comment; correct the cron action.prompt note. Use ordinary Rush notes for these
repairs and the retired-record behavior; no generated changelog edits or invented
BREAKING/Rebuild action.

Pass build, lint, test, typecheck:tests using the repository Rush entry point,
then `.agents/scripts/check.sh` after the TeamLeader closes the task. Independently
review the whole implementation and adapted test assertions. The direct repair
instruction and R74/R75 answers supply authority; no extra approval card is claimed.
Final parent coverage is the R43 completion stage. Existing child delivery targets
the feature branch; parent PR #453 merge into next remains outside this work's
authority.


## Execution boundary selected on 2026-10-08

R77 records the operator's “停掉最后这次复审”. The last corrected-tree
workflow stopped at scope confirmation before reporting findings; it is not a
review pass and is not restarted. The required repair and R43 behavior/coverage
contracts remain unchanged. Completed prior reviews, source-based adjudication,
TeamLeader pre-review and current local gates are separate evidence for this
child delivery. Existing feature-base child and alpha authority remain; parent
PR #453 integration into next and external-platform acceptance are not claimed.
