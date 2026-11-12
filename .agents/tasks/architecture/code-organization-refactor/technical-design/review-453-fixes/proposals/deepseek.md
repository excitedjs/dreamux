# PR #453 review fixes and final coverage — technical approach

Seat: independent solution author (DeepSeek). Revision 1, 2026-10-03.

Requirement input: `artifacts/review-fixes-20261003.md` revision 1 (the sole
authority). Baseline: `feat/plugin-system-mvp` after
[PR #462](https://github.com/excitedjs/dreamux/pull/462), compared with `next`
after [PR #451](https://github.com/excitedjs/dreamux/pull/451). The prior resulting-tree
review (`.workspace/review-20261003/final.md`) is consultation evidence for the
*problem*; where it and the current source disagree, the source wins.

This file is the only artifact this seat writes. No implementation, tests,
commits, push, GitHub, dependency install, or task-record write is performed or
authorized here.

## 0. Authority, scope, non-goals

Authority is exactly the nine *Required outcomes* in the revision-1 artifact,
under the operator words it records: "把这些问题修了", the retired-record
disk-read selection ("完全退休的 Team 记录…退休后读盘 (Recommended)"), and the
already-settled R72/R73. It is a repair pass on capabilities that exist today,
not a new-feature pass.

Non-goals (stated by the requirement, restated here so the developer does not
drift):

- No new plugin/hook/config-Command capability work; "New-only plugin
  configuration questions are outside this old-capability pass."
- No revert of accepted PR #453 product changes merely because they differ from
  `next`.
- No history cap, no record deletion, no new durable ledger, no mirrored phase,
  no compensating entity.
- No merge of #453 into `next`; that still needs the operator's authority.
- No weakening of locked assertions; a green run does not prove restored
  coverage.

Method: each item below names its authoritative owner from the current source,
the concrete callers, the end-to-end behavior after the change, the deletions
and additions, the lifecycle/concurrency/public-compatibility surface, and the
verification that would show it. Each added mechanism names a reachable
scenario; each removal names the concept that disappears.

## 1. The change set at a glance

| # | Outcome | Authoritative owner | Net concept delta |
| - | - | - | - |
| 1 | Retired Team store end of life | `service/team/store.ts` (`TeamStore`) + `service/team/index.ts` (`TeamCollection`) | − (process-lifetime per-history store) |
| 2 | Event producer identity | `service/dispatcher-core-events/index.ts` (`DispatcherCoreEventBus`) | − (frozen forwarding object) |
| 3 | Claude runtime dependency shape | `agent-runtime/claude-code/src/runtime-deps.ts` | − (dead `?? []` fallback / optionality) |
| 4 | Truthful uninstall preview | `onboard/uninstall.ts` (`removeConfigDirectory`) | + read-only prediction, − false `removed` claim |
| 5 | Configured official npm providers | `registry/provider-loader.ts` (kind-agnostic skeleton) | + one generic entry-shape rule, − 3 misleading notes |
| 6 | Pairing after expiry | `channel/feishu-channel/src/access/index.ts` (`recordPairingPrompt`) | − expiry-blind lookup |
| 7 | COT route retirement | `channel/feishu-channel/src/{inbound,session,cot,routing}` | − wrong anchor provenance |
| 8 | Documentation truth | `dreamux-types`, `.agents/product`, change notes, maintenance refs | − stale claims |
| 9 | Final-parent coverage | `packages/*/tests`, `artifacts/deleted-tests.md` | + restored behavioral contracts |

Every item is a correction of an existing owner. No item creates a new domain
concept, package, or persisted fact.

## 2. Outcome 1 — Retired Team store ownership

### 2.1 Owner and current callers

`TeamStore` (`packages/dreamux/src/service/team/store.ts`) owns the whole answer.
Its `stores` map (`:72`) currently holds one `TransactionalStore` per Team that
*exists*:

- `handle()` (`:102`) → `storeFor()` (`:115`) registers a store; this is the
  legitimate owner path (`TeamService` and the recovery reclaim).
- `get()` (`:174`) registers and roots a store whenever it reads a **valid**
  record — including a completed/`closed` Team with no owner in this process.
- `list()` (`:185`) calls `get()` for every directory, and
  `TeamCollection.recover()` (`index.ts:481`), `recoverWorktreeCleanup()`
  (`:369`), `acceptedRequest`, `listRows`, and `historyResult` all go through
  `list()`/`get()`.
- `TeamCollection.evict()` (`index.ts:778`) removes only the live service; it
  never touches the store map.

Reachable scenario: an ordinary Dispatcher start or any Team history read roots
one resident store per historical Team for the collection's whole life. The
retained set is `O(all durable Team history)`, and the only fact that ends it is
process exit.

### 2.2 Selected shape

Separate the two jobs the `stores` map conflates. It holds a store **only while a
holder owns that Team** (a live/dissolving `TeamService` or an in-flight
create); a plain read never creates one.

1. **`get()`/`list()` stop rooting.** When a store is already held, `get()`
   answers through it (the owner's committed value and queue stay
   authoritative). With no store held, `get()` reads the file and returns
   without registering — including a valid `closed` record. `list()` is
   unchanged logic and therefore stops rooting history too.
2. **The store unroots a Team at the write that retires it.** A record is
   *fully retired* exactly when `status === 'closed'` and
   `worktree.cleanup_state !== 'cleanup-pending'` — no live owner, no queued
   write, and no pending reclaim. The write that produces that value is by
   construction the last Team-record write (dissolve's trailing
   `settleTeamWorktreeCleanup`, or an abandoned creation's, or the closed write
   itself when the assessment was already terminal). After that update settles,
   `mergeRecord()` deletes its own map entry if it is still the current one.
3. **A create attempt that produces no owner drops its holder.** `createTeam()`
   (`index.ts:574`) mints a holder via `depsBase()` before publication. When the
   candidate is already taken (publication returns `null`) or creation throws
   before publication/ownership, the collection releases that entry.

### 2.3 End-to-end behavior after the change

- Cold Dispatcher start: `recover()`/`recoverWorktreeCleanup()` still sweep the
  records, but only the **non-closed** Teams they materialize stay rooted; every
  closed Team is read from disk and holds nothing.
- History/list/summary of a retired Team: read from disk on each access. Editing,
  deleting, or damaging a fully retired record becomes observable on its next
  read, and the Team name follows the record again — exactly the operator's
  selected semantics. A live Team read still answers from its held owner.
- Dissolve: the `closed` write and the trailing worktree reclaim both run through
  the owner's store; the reclaim's write is the one that unroots the entry. A
  reclaim that fails leaves `cleanup-pending`, so the entry stays held and the
  next ordinary start's `recoverWorktreeCleanup()` reclaims it through the same
  serialized owner.
- Abandoned creation: `abandonCreated()` writes `closed`, destroys children, then
  reclaims; the reclaim write unroots the entry (or the closed write already
  did, when no managed checkout was created).
- Concurrent name allocation: `create()`'s early-out (`get()`), its in-process
  `constructing` gate, and `publishRecord()`'s atomic read-decide-replace on the
  held store are all unchanged; probing a taken candidate no longer leaves a
  rootless holder behind.
- Accepted-request replay: `acceptedRequest()` still scans records and finds the
  `closed` Team with its request id from disk.

### 2.4 Deletions and additions

- Delete: the `get()` registration branch (`store.ts:174-182`); the
  "never evicted / held for the life of the collection" behavior described in
  the `stores` field comment (`:65-75`) and the `storeFor` comment.
- Add: `TeamStore.release(teamId)` (or an equivalent on the handle); the
  retired-record check after `mergeRecord()`'s update; a release on the
  no-owner create paths. Nothing else.
- No new field on `TeamRecord`, no persisted change, no new module.

### 2.5 Lifecycle and concurrency

The release runs only after the retiring update has settled, so no queued write
or pending reclaim can be orphaned; a `cleanup-pending` record is deliberately
**not** retired and keeps its owner. `mergeRecord()` must write through the
handle's **own** store (as `publishRecord` already does) rather than re-resolving
`storeFor()`, so a trailing post-retirement write cannot silently re-root an
entry; the handle and the map entry are the same object for the whole life of an
owner, so nothing diverges. After release, a read cannot re-create the entry
(reads no longer root) and `open()`/`rebuild()` refuse a `closed` record, so a
second competing store cannot appear; a later ordinary start mints a fresh one
only through recovery or a real owner.

### 2.6 Public compatibility

No public signature, config, persisted format, or CLI surface changes. The
observable change is intentional and operator-selected: fully retired history is
disk-authoritative. Active ownership, pending work, replay, and terminal `closed`
writes are preserved.

### 2.7 Verification

Deterministic internal tests over a real `TeamStore`/`TeamCollection` with a temp
root: (a) cold `list()`/`history()` over N closed records leaves no rooted
stores; (b) an open Team keeps answering from its held owner while its record is
changed on disk; (c) deleting/damaging a retired record is observed on the next
read and re-occupies/frees the name accordingly; (d) a `cleanup-pending` record
still shares one owner through a simulated recovery; (e) two concurrent creates
at one candidate still yield one Team.

## 3. Outcome 2 — Event producer ownership

### 3.1 Owner and current callers

`DispatcherCoreEventBus` (`service/dispatcher-core-events/index.ts`) is the sole
delivery owner. It allocates a frozen forwarding object
(`readonly publisher`, `:47,61-66`) whose `publish`/`hasSources` closures call
back into the bus. `dispatcher-service/index.ts` hands that object to three
internal Core consumers — `agent/factory.ts:26`, `team/types.ts:59`, and
`conversation-projection.ts:59` — at `:191`, `:200`, `:270`; it already hands the
**bus itself** to `channel-service` at `:210` (`createSource`/`revokeSources`).

### 3.2 Selected shape

Move the two producer verbs onto the bus and delete the forwarding object:
`DispatcherCoreEventBus` implements `DispatcherCoreEventPublisher` directly
(`publish()` becomes public; add `hasSources()`), keep the interface as the
narrow producer contract, and pass `this.coreEvents` at the three call sites.
The three consumers keep their `DispatcherCoreEventPublisher`-typed field, so
only the wiring changes. Session source leases (`createSource`,
`ScopedChannelEventSourceLease.revoke`, `revokeSources`) are untouched.

### 3.3 Deletions, additions, compatibility

- Delete: the `publisher` field (`:47`) and its `Object.freeze({...})` block
  (`:61-66`) — one runtime identity and one forwarding hop.
- Add: `hasSources(): boolean` on the bus; `publish` loses `private`.
- Compatibility: no wire, config, or persisted change. At runtime the bus object
  now also exposes `createSource`/`revokeSources` to those three Core consumers;
  because they are `DispatcherCoreEventPublisher`-typed and no runtime/provider/
  plugin ever receives this producer, no named failure requires further
  isolation (recorded TeamLeader disposition).

### 3.4 Verification

The bus satisfies the producer interface and forwards no longer exist; session
leases remain independently revocable (subscribe/revoke one leaves another
delivering); delivery/logging semantics are unchanged.

## 4. Outcome 3 — Claude runtime dependency shape

### 4.1 Owner and evidence

`ClaudeCodeRuntimeDeps` (`agent-runtime/claude-code/src/runtime-deps.ts:20-21`)
declares `skillSources?` and `disableFeatures?` optional, but the only production
supplier (`provider.ts:75-90`) always sets both from the required
`AgentRuntimeCreateContext.skillSources` / `.disabledFeatures`
(`dreamux-types/src/agent-runtime.ts:284,290`). The only fallback is
`runtime.ts:130` (`this.deps.skillSources ?? []`).

### 4.2 Selected shape and boundaries

Make both fields required on `ClaudeCodeRuntimeDeps` and delete the `?? []`
fallback at `runtime.ts:130`. **Do not** touch the argument builder's optional
`disableFeatures?: readonly string[]` (`args.ts:48`) or its `?? []` at
`args.ts:130`: that seam has real optional test suppliers and is a different
contract. Logger, RPC callbacks, and output schemas are likewise out of scope.

### 4.3 Verification

Package build/typecheck proves the sole production supplier still satisfies the
narrowed type; the Claude runtime package's existing tests exercise the
argument builder unchanged.

## 5. Outcome 4 — Truthful uninstall preview

### 5.1 Owner and evidence

`removeConfigDirectory()` (`onboard/uninstall.ts:170-202`) removes `config.json`
and the legacy `config.toml`, then non-recursively `rmdir`s the Dreamux root and
reports `skipped` when foreign content remains (`:189-201`). Its `dryRun` branch
(`:185-187`) unconditionally reports `removed`, contradicting the real run. The
CLI surfaces these statuses verbatim (`cli/commands/uninstall.ts:19-22`).

### 5.2 Selected shape

In dry-run, predict the same outcome without writing: the root is `removed`
exactly when, after the earlier owned removals already reported by
`runUninstall()`, nothing but the two owned config files would remain. Compute
this with a single `readdir` of the root and exclude the two owned file names and
the four owned child directories (`state`/`run`/`cache`/`logs`, by their resolved
basenames) that `runUninstall()` removes before this step; otherwise report
`skipped` with the same "not empty" reason.

### 5.3 Boundaries, deletions, compatibility

Delete the unconditional dry-run `removed` entry. Add one read-only prediction
helper (async `readdir`). Keep provider-home protection (`protectedRoots`) and
foreign-file retention exactly as they are; do not restore recursive root
deletion. No new durable state, no write on the dry-run path. Scenario: an
operator with a foreign file in `DREAMUX_ROOT` runs `uninstall --dry-run` and
must be told the root will be kept.

### 5.4 Verification

Deterministic: for a temp root containing only owned content and for one
containing a foreign file, dry-run status equals the real run's status
(`removed` vs `skipped`), and the dry-run performs no filesystem mutation
(compare a pre/post directory listing).

## 6. Outcome 5 — Configured official npm providers

### 6.1 Owner and evidence

The kind-agnostic skeleton `registry/provider-loader.ts` selects the factory
export (`selectFactoryExport`, `:192-205`: `module.default` for a bare `npm:`
ref) and asserts it is a provider (`:134-162`). The three official packages now
export the **plugin** factory as `default` (`agent-runtime/codex/src/index.ts`,
`claude-code/src/index.ts`, `feishu-channel/src/index.ts`) and their bare
provider factory only as a named export. So an already-valid config addressing
`npm:@excitedjs/agent-runtime-codex` / `-claude-code` / `feishu-channel` as an
`agents[].provider`/`dispatchers[].channels[].provider` ref fails the shape check
before daemon creation (`cli/server.ts:53-73`, `config/load.ts:110-123`). The
same bare ref in `plugins[]` correctly loads the plugin
(`plugin/loader.ts` `constructPlugin`, default export).

### 6.2 Selected shape

Teach the skeleton one generic rule: a provider ref resolves the package's
**public entry**, which may be either a provider factory or a plugin factory;
when it is a plugin factory, run that plugin's `contribute()` against a
throwaway `ContributeHost` and take the single provider it contributes for the
requested `spec.kind`. Zero or more than one provider of that kind is a contract
error naming the ref. The plugin case reuses the exact public entry the plugin
loader already uses; registration identity stays Core's (the descriptor is still
seeded from the configured ref). This keeps `npm:@excitedjs/agent-runtime-codex`
loadable as a provider **and** keeps `plugins: ["npm:@excitedjs/…"]` loading the
plugin, with no config change. `contribute()` is contractually no-IO, so the
throwaway host performs no side effects.

### 6.3 Deletions, additions, compatibility

- Delete: the three change notes' false "now fails loudly…" claims
  (`agent-runtime-codex/refactor-code-org-8a-providers_*.json`,
  `agent-runtime-claude-code/…`, `feishu-channel/plugin-system-mvp_*.json`) and
  any current reference that repeats them (`.agents/domains/plugins.md` step 3,
  `.agents/domains/provider-runtime.md`); replace with the actual behavior.
- Add: one selection branch in the skeleton plus a small "contribute into a
  throwaway host" helper. No package-name list, no per-package case.
- Compatibility: previously valid persisted config keeps starting; the new
  plugin entry keeps working; `builtin:*` refs and named bare-provider exports
  are unchanged.

### 6.4 Verification

Deterministic: for each of the three packages, a config whose provider ref is the
bare `npm:@excitedjs/...` loads and registers the correct kind; the same ref in
`plugins[]` still loads the plugin; a plugin contributing zero or two providers
of the kind fails with a ref-naming contract error.

## 7. Outcome 6 — Pairing after expiry

### 7.1 Owner and evidence

The gate (`access/gate.ts`) prunes expired pending entries into `working`
(`pruneExpiredPending`) and, for a sender whose only entry has expired, mints a
fresh token with `is_resend: false`. `FeishuAccess.gate()` (`access/index.ts:132-136`)
deliberately commits nothing for a `pair` action (send-before-save), so the
expired entry is still committed when `recordPairingPrompt()` (`:192-207`) merges
the sent card. That merge finds the same-sender key **without checking
expiry**, sees `is_resend === false`, and returns `current` — discarding the
freshly sent token. The user's card then references a token absent from
authoritative state.

### 7.2 Selected shape

Make `recordPairingPrompt()`'s same-sender lookup expiry-aware inside the
existing transaction: only a **live** same-sender entry (`expires_at > now`)
counts as "existing". When none is live, take the fresh-insert branch and drop
that sender's expired entries as it inserts the new token. Preserve every other
branch: the mid-window approval short-circuit, the resend bump
(`expires_at` refresh + prompt id), send-before-save, retry, and concurrent state
merging all stay.

### 7.3 Deletions, additions, compatibility

Delete the expiry-blind `find` in the merge. Add an expiry predicate to the
lookup (reusing the same `expires_at > now` rule the gate already uses); no new
state field, no schema change. Scenario: a sender whose earlier pending entry
expired sends a new message; the freshly sent card's token must survive the
merge.

### 7.4 Verification

Deterministic `access` tests: expired-then-new-token survives and is
approvable; a live same-sender pending entry with a genuine resend still bumps
in place; concurrent approval mid-window still short-circuits; the slot cap still
counts only live entries.

## 8. Outcome 7 — COT route retirement

### 8.1 Owner and evidence

Producer chain (current source): `routing/index.ts:136-156`
(`plan()` returns `matched` — the row that answered, "which may be the parent
group of a topic") → `inbound/pipeline.ts:487-496` (builds the anchor with
`target` = the message's own chat/topic) → `inbound/router.ts:123`
(`submitter.submit(plan.teamName, submission)`) → `session/submitter.ts:40-48`
(`beginInboundSubmission`). Consumption: `cot/adapter.ts:561-571,630-671` →
`cot/recipients.ts` `onRouteReleased` (`:216-229`) compares the **released
binding** against `state.anchor.target`. For a topic served by its parent-group
binding, the anchor's `target` is the topic, so the parent-group release never
matches and the ongoing presentation is not retired; later activity keeps
writing into it.

The anchor's `target` is documented as a **provenance** field ("kept beside the
ids so a binding that moves away can retire exactly the anchors that pointed at
it", `cot/recipients.ts:30-40`), and card placement uses only `chatId`/
`messageId`. `prepareVisibleAnchor` only requires the target's `chatId` to equal
the anchor's `chatId`, which holds for the parent group of a topic.

### 8.2 Selected shape

Record the **serving route** as the anchor's provenance: thread `plan.matched`
from `router.deliver()` through `submitter.submit()` into
`beginInboundSubmission()`, and set the anchor's `target` to that serving route
instead of the message's own target. `onRouteReleased`/`onRouteClaimed` then
compare the released/claimed route against exactly the route that produced the
presentation. Independently bound exact topics are unaffected — for them
`plan.matched` is the topic itself, exactly as today. The binding-card fallback
anchor (`setFallbackAnchorIfAbsent`) already uses the bound target and stays.

### 8.3 Boundaries

Preserve restoration and future-anchor behavior: do not assert permanent anchor
loss and do not force terminal semantics beyond the existing policy — a
non-closed Team event still clears future-anchor fences (`onTeamState`), and a
re-claimed route still re-opens presentation (`onRouteClaimed`). No new state
field: this repairs the provenance the field already documents.

### 8.4 Verification

Deterministic COT/routing tests through the real producer chain: a topic served
by its parent-group binding, with an active presentation, is retired when that
parent binding is released; an independently bound exact topic in the same
parent chat survives an unrelated parent release; a subsequently re-claimed
route re-opens presentation.

## 9. Outcome 8 — Accurate documentation

Small, exact corrections; no behavior change.

- `dreamux-types/src/agent-runtime.ts:444-445`: replace the claim that Core
  validates text/page/cursor **magnitudes** with what Core still does — requested
  record count and structural validation (R28 removed the magnitude budgets).
- `.agents/product/README.md`: add the already-accepted entries for removal of
  `dispatcher.start`, operational reads refused during owner close, and
  signal-driven process exits (mirroring the accepted B01/B10/B16 removals).
- The s4b-03 scheduler change note
  (`common/changes/@excitedjs/dreamux/refactor-code-org-s4b-03_*.json`): correct
  the false rationale that raw `action` "only ever set an unread `intent`" —
  `next`'s `normalizeAction` could use `action.prompt` as the effective prompt —
  and do not let the broad delete-result wording stand in for the actual result
  schemas.
- Team maintenance and knowledge owners of the retired-record boundary:
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md`
  and the relevant `.agents/domains/*` (state/config and service topology)
  updated to the changed retired-record disk-authority boundary introduced by
  outcome 1.

No doc may contain upgrade-detection, migration, or `Rebuild:` material for this
non-breaking change.

## 10. Outcome 9 — Final-parent coverage

This is the R43 final-parent stage: restore the behavioral contracts the
`.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`
ledger accounts for, under the new contracts, and restore the deferred #63
non-blocking-inbound live gate. The ledger is the obligation list, not file or
test counts.

- Changed owners from outcomes 1–7 get their own behavioral coverage (the
  verification notes above are the acceptance probes): retired-store lifetime,
  publisher identity/lease revocation, narrowed Claude deps, dry-run/real
  agreement, npm-ref + plugin-entry loading, expiry-aware pairing, route-release
  provenance.
- Restore the ledger's named contracts — collection admission, lock
  finalization, Team shutdown/dissolve, event/COT, completion, scheduler, and the
  #63 immediate-submit path (`.agents/domains/non-blocking-dispatcher-inbound.md`).
- Tests assert behavior with real owners and observed outputs. Do **not**
  recreate source-text/path/export-location assertions, and do not claim
  coverage from file/test arithmetic or from a green surviving suite.
- Distinguish deterministic internal tests from live provider evidence: the #63
  gate and Codex/Claude/Feishu E2E require a real runtime and fail loudly when it
  is absent (`DREAMUX_SKIP_LIVE_CODEX=1` only for an intentionally Codex-free
  environment). Report unavailable external systems as unavailable, not as
  passed.

## 11. Acceptance mapping

| Requirement outcome | Where addressed | Acceptance evidence |
| - | - | - |
| 1 retired ownership | §2 | no rooted stores for closed history; live owner still authoritative; `cleanup-pending` keeps its owner; concurrent create yields one Team |
| 2 event producer | §3 | bus implements the producer contract; forwarding object gone; leases still revocable |
| 3 Claude deps | §4 | narrowed type builds; argument-builder optionality preserved |
| 4 uninstall preview | §5 | dry-run status equals real run; no writes |
| 5 npm providers | §6 | bare `npm:` refs load all three; plugin entry still loads; notes corrected |
| 6 pairing expiry | §7 | new token survives an expired same-sender entry; resend/approval/concurrency preserved |
| 7 COT route release | §8 | served topic retired; exact topic survives; route re-claim re-opens |
| 8 documentation | §9 | stale claims corrected in code comment, product catalog, change note, maintenance refs |
| 9 final coverage | §10 | ledger contracts restored behaviorally; #63 gate restored; live limits disclosed |

All four Rush gates (`build`, `lint`, `test`, `typecheck:tests`) and
`.agents/scripts/check.sh` must pass after closeout; no locked assertion is
weakened.

## 12. Rejected alternatives

- **Outcome 1 — cap or evict on `closed` alone.** A cap is banned by the
  requirement; evicting on the durable `closed` write alone would orphan the
  trailing worktree reclaim (which still writes after `closed`). Keeping the
  `cleanup-pending` owner is required by outcome 1.
- **Outcome 1 — reintroduce a `next`-style disk-only history with no owner
  path.** Would drop the memory authority active owners and replay depend on.
- **Outcome 1 — a new `retired` promise on `TeamService` plus a collection-side
  release.** Correct, but it adds a lifecycle signal and a second release site
  for something the record's own terminal write already determines. Prefer the
  record as the authority; revisit only if a real post-retirement writer is
  found.
- **Outcome 2 — keep the frozen forwarding object but narrow its type.** Both
  sides survive; that is "dedup by indirection" and removes nothing.
- **Outcome 5 — Core-side per-package cases or a silent migration to
  `builtin:`.** Explicitly disfavored: a package-name list is a Core special
  case, and rewriting a persisted reference is an unacceptable silent migration.
- **Outcome 5 — flip `default` to the bare provider.** Breaks
  `plugins: ["npm:@excitedjs/…"]`, which is the new plugin-entry capability the
  requirement says to preserve.
- **Outcome 7 — a separate `servingRoute` field on `CotState`.** Adds a second
  provenance fact beside the anchor that already exists to carry it.
- **Outcome 6 — commit the gate's pruned state for `pair` actions.** Changes the
  deliberate send-before-save ordering; the expiry-aware merge is the narrower
  fix.

## 13. Unresolved facts and blockers

- Outcome 1 is the only genuinely load-bearing design choice. It is settled on
  the record's terminal state as the release trigger; the TeamLeader should
  confirm that no path writes a Team record after a `closed` +
  non-`pending` value. Source review found none (dissolve and abandoned creation
  both end with the reclaim write; `destroyChildren` writes no Team record).
- Outcome 5 hinges on the plugin `contribute()` no-IO contract. If any plugin
  reachable through an `npm:` provider ref performed IO in `contribute()`, the
  throwaway host would be unsafe; the three official plugins do not, and the
  contract forbids it (`dreamux-types/src/plugin.ts`).
- Outcome 7 deliberately fixes only the provenance the field already documents;
  no live Feishu reproduction was run by the review, and this proposal does not
  claim one. The fix is source-level and must be shown by the deterministic
  tests in §8.4, with live evidence reported separately.
- Outcome 9's live obligations (#63 gate, Codex/Claude/Feishu E2E) depend on a
  real runtime; where it is unavailable the result is "not verified", not
  "passed".

No blocker prevents a single developer from implementing this batch. The one
item that could force a product decision is outcome 5 if, contrary to this
analysis, a package's public entry cannot be resolved to the requested provider
kind without a config change; the requirement directs reporting that contract
conflict rather than substituting a startup migration.

---

# Cross-review round 1 (2026-10-03)

One append-only adversarial round. Sources read: `proposals/mimo.md`,
`proposals/codex-ultra.md`, `source-audit.md`, and a re-read of the current
source and requirement revision 1. No voting: every disposition below rests on
a source fact. First-round reasoning above is preserved; where the source
disproves it, the withdrawal is stated here and the revised position is the
authority. No new operator decision and no extra product change is introduced.

Repository records use public PR links rather than bare commit ids:
[PR #453](https://github.com/excitedjs/dreamux/pull/453),
[#455](https://github.com/excitedjs/dreamux/pull/455),
[#457](https://github.com/excitedjs/dreamux/pull/457),
[#459](https://github.com/excitedjs/dreamux/pull/459),
[#460](https://github.com/excitedjs/dreamux/pull/460),
[#461](https://github.com/excitedjs/dreamux/pull/461),
[#462](https://github.com/excitedjs/dreamux/pull/462). (This file carried no
bare commit references in round 1, so nothing else needed conversion.)

## A. Withdrawals: source disproved parts of my round-1 design

**A1. Outcome 1 — "release at the write that leaves `closed` + non-pending" is
unsafe. Withdrawn.** The predicate is not an ownership endpoint.
`dissolveRecordPatch` writes `cleanup_state: 'cleanup-pending'` *only* when the
assessment is not terminal; for an unmanaged or already-terminal managed
worktree the closed write itself already carries a terminal cleanup state
(`service.ts:665-703`), and `runDissolve` then runs `destroyChildren` before
`closeFromRecord` (`service.ts:637-651`). `abandonCreated` has the same shape
when `workspace.createdCheckout` is false (`service.ts:390-430`). At that
instant the construction or the live service still owns the handle. So a
terminal record is not proof that runtime ownership ended — exactly the audit's
"Additional source checks" point.

**A2. Outcome 1 — the `mergeRecord`-via-captured-store change alone is
insufficient, and I missed the initialization contract. Partially withdrawn.**
Besides the release point, `get` cannot simply stop registering: `TeamService.rebuild`
documents and relies on "`record` was already read through the collection's
`store.get`/`.list` … which loaded this same Team's `TransactionalStore`"
(`service.ts:458-462`), and `recoverWorktreeCleanup` relies on the same through
`store.list()` before `handle.current` (`index.ts:369-382`).
`TransactionalStore.current` throws before a successful load
(`transactional-store.ts`, `get current`). Removing permanent registration
without an acquisition that loads first makes `mustRecord()` throw. My round-1
text did not name that acquisition boundary.

**A3. Outcome 5 — the throwaway `ContributeHost` is withdrawn.** Rerunning
`contribute` against a throwaway host constructs a provider over plugin-owned
state that only `server()` initializes: the Feishu plugin builds its provider
over its own `FeishuExtensionRegistry` and initializes that registry in
`server()` (`feishu-channel/src/plugin.ts:24-38`), so an extraction through a
throwaway host yields a provider whose extension state was never rooted. The
audit's point stands: `contribute` is ordinary JS, and its no-IO contract does
not prove the absence of such coupling. Withdrawn in favour of the package
entry/export boundary (C3).

**A4. Outcome 6 — lookup-only is insufficient. Superseded.** The task's own
requirement is that pairing "must discard obsolete expired entries as well as
find a live winner". My round-1 "drop that sender's expired entries" is a
weaker form of that; upgraded in C5.

**A5. Outcome 7 — repurposing `anchor.target` is withdrawn.** See C4: it
changes documented visible-target release/claim behaviour, which the round-2
brief explicitly says to retain.

**A6. Round-1 §12 wrongly rejected moving `service.closed`.** I claimed that
delaying `closed` would delay Team-card retirement. Source refutes it:
presentation retirement is driven by the `team.state` Core event published at
the *closed write* (`updateRecord`, `service.ts:990`; consumer
`cot/adapter.ts:142-143,536-538`), not by the `service.closed` promise. The
route-removal trigger for a closed Team is the same event
(`session/session.ts:265-266`). So MiMo's move is sound; it is simply not
necessary for record release (C2).

## B. Point 1 — handle producers, consumers, initialization, and actual overlap

**Producers of a `TeamRecordHandle`** (`TeamStore.handle`, `store.ts:102`):
only `TeamCollection.depsBase` (`index.ts:783`), called by `createTeam`
(`index.ts:594`) and `rebuild` (`index.ts:716`); and `reclaimTeamWorktree`
(`index.ts:377-382`). There is no other producer.

**Consumers:** `TeamService.deps.record` — `createNew` publishes through it
(`service.ts:276`), `updateRecord` writes `running`/`closed` through it
(`service.ts:368,626,412`), `mustRecord` reads `current` (`service.ts:995`),
and `settleTeamWorktreeCleanup` reads `current` and updates
(`service.ts:1088-1117`). Recovery consumes the recovery handle for the same
settle.

**Current initialization assumptions:** `rebuild` and `recoverWorktreeCleanup`
depend on an earlier `get`/`list` having loaded the exact store (A2). Any
transient-read design must therefore acquire-and-load the handle before
`current` is read.

**Actual overlap enumeration (not assumed):**

1. *`destroyChildren` after the closed write.* Real, but strictly before the
   settle and before any proposed release point inside `runDissolve`
   (`service.ts:637-668`). No overlap with a post-settle release.
2. *Construction handoff.* `createTeam` acquires once, `startCreated`s, then
   `track`s the service before returning (`index.ts:574-610`), so a
   "release-if-untracked" at construction settlement never fires for a
   successful create; failed/`null` constructions release explicitly.
3. *Admitted continuations.* The only Team-record writer that can run
   concurrently with a dissolve is the `running` transition: `submitInput`'s
   guarded write (`service.ts:826-837`, guarded by
   `mustRecord().status === 'starting'`) and `startCreated`'s write
   (`service.ts:368`). Each enqueues synchronously in the same microtask that
   reads the committed value, and such a write is issued only while the
   committed value is not yet `closed`; `TransactionalStore` is a single FIFO
   tail (`enqueue`/`update`) and the settle update is enqueued only after
   `await updateRecord(closed)` and `destroyChildren`. Every such post-`closed`
   write therefore *executes before the cleanup-settle write*. There is no
   reachable writer left once the settle promise settles.
4. *Recovery vs. a live service.* `recoverWorktreeCleanup` runs at startup over
   `closed` + `cleanup-pending` records and `recover()` skips `closed`
   (`index.ts:369-375,481-487`), so a recovery handle and a service handle
   never coexist for one Team.

**Revised position (point 1).** Acquire-and-load a handle
(`acquire(teamId): Promise<TeamRecordHandle>`); make `update` write through the
captured store; release the entry from the paths that own the last write — the
end of `runDissolve` and `abandonCreated` (after the settle attempt), the
construction settlement when no service was tracked, and the recovery
`finally`; and delete the entry only when the committed value is retired
(absent, or `closed` with no `cleanup-pending` worktree fact). This is a
**quiescent single-owner release**. I reject adding a holder count or an
admission-operation hold for the current writer set: the only candidate
straggler (the `running` transition) is bounded before the settle by the
`starting` guard plus the FIFO queue, so no named scenario reaches such a hold.
This is a reasoned disagreement with codex-ultra §1, not a vote; the correct
parts of that section — acquire-and-load, captured-store update, retire-only
predicate — are accepted here.

## C. Point 2 — moving `service.closed`

Today `closed` resolves after `destroyChildren` and before physical cleanup
(`service.ts:175-181,637-651,1002-1010`). Its only promise consumer is
`TeamCollection.track`'s eviction (`index.ts:755`); a second host-stop sweep
reaches whatever is still in `live` (`index.ts:528-536`), and `stopForHost` is
idempotent, so a later-resolving `closed` only keeps a closed service in `live`
longer. The COT retirement signal is the `team.state` event at the closed write
(A6), so it is not delayed.

**Is the timing change necessary for record release? No.** An explicit release
at the end of `runDissolve`/`abandonCreated` reaches the same quiescent point
(B) without widening the documented meaning of `closed`. MiMo's move is
therefore a sound *alternative* that makes `evict` a safe release point; I keep
`closed`'s current meaning and choose the explicit release. This is a material
but non-blocking disagreement about which smaller change to make.

**Failed cleanup job vs unfinished durable fact.** A settle that throws is a
*settled attempt* with no in-process continuation; the durable
`cleanup-pending` fact remains for the next start's recovery. So no live owner
holds the entry after a failed settle, but the entry must still be retained by
the retire-only predicate — releasing it would drop the fact while
`cleanup-pending` stands, contrary to outcome 1's "unfinished cleanup must
still share the correct serialized owner". MiMo's release-at-`evict` would drop
that entry; I retain it. Bounded by failed-cleanup Teams, which are rare.

## D. Point 3 — package entries vs throwaway host

Source: the provider loader selects `module.default` for a bare `npm:` ref
(`registry/provider-loader.ts:192-205`) and calls it with
`ProviderFactoryContext` `{ ref }` (`agent-runtime/external-provider.ts:84`;
`dreamux-types/src/provider.ts:176-190`); the plugin loader selects `default`
for a bare plugin ref and calls it with **no** argument
(`plugin/loader.ts:241-250`). The three official `default` exports are now
plugin factories; `createCodexAgentRuntimeProvider` takes an options object and
the Claude/Feishu bare factories take none, so a small context-taking adapter
is needed to expose each as a provider-factory default.

The same-name rule rejects a duplicate plugin name
(`plugin/loader.ts:167-173`), and always-loaded plugins load first, so a bare
`plugins: ["npm:@excitedjs/…"]` ref to one of the three official packages
*already* fails today. Restoring the provider default therefore removes no
working plugin capability; the plugin entry stays available as the always-loaded
builtin, as `npm:pkg#createXPlugin`, and unchanged for third-party packages
(whose defaults are not always-loaded).

**Revised position (point 3).** Restore each package-root `default` to a
correctly typed provider factory via its current named bare-provider
constructor; expose `createCodexPlugin`/`createClaudeCodePlugin` named (Feishu
already has `createFeishuPlugin`); change `BUILTIN_PLUGIN_PACKAGES`
(`registry/builtins.ts:55-68`) from package strings to package/export
descriptors and have `constructPlugin`'s builtin branch select the descriptor's
export (bootstrap keeps its default). Zero new Core mechanism, and no
provider-name case. This converges with MiMo §1.2 and codex-ultra §4. The one
residual contract fact to disclose: a bare `plugins[]` ref to an official
package changes its loud failure from duplicate-name to provider-shaped, and
the correct ref is `npm:pkg#createXPlugin`; no config migration is introduced.

## E. Point 4 — COT serving-route provenance, proven through producers

Producers of a stored anchor: `beginInboundSubmission`
(`session/submitter.ts:40-48`, called from `inbound/router.ts:123`),
`setFallbackAnchorIfAbsent` for the binding notice
(`routing/operations.ts:107-118`), and `announceProvisioned`
(`routing/operations.ts:296-320`). Normalization: `prepareVisibleAnchor`
requires `target.chatId === anchor.chatId` (`cot/recipients.ts:346-360`), which
holds for a topic and its parent group because a topic shares its chat id. The
authoritative serving fact already exists and is dropped:
`plan()` returns `matched` (`routing/index.ts:143-154`) and `deliver` discards
it at `submitter.submit(plan.teamName, submission)` (`inbound/router.ts:110-123`).
Consumption is `onRouteReleased` comparing `state.anchor.target`
(`cot/recipients.ts:216-231`).

**Revised position (point 4).** Keep `anchor.target` as the visible
destination and add one nullable `servingTarget` to the stored COT anchor,
supplied by the producer: `plan.matched` for bound inbound and card-action
forwarding; the just-bound/queried target for provisioning and the
binding-notice fallback; `null` for the dispatcher fallback. Extend only
`onRouteReleased` to interrupt when either the visible target or the serving
target equals the released route. Leave `blocksAnchor` and `onRouteClaimed` on
the visible target — this is the "retain prior visible-target release/claim
behaviour" the round-2 brief requires, and it keeps an independently bound exact
topic alive because its `plan.matched` is the topic itself. In-flight
create/append needs no cancellation: retirement reuses `advanceAnchor(null)`
and existing generation/terminal handling (`cot/adapter.ts:584-619`).

**Accepted additional finding.** `forgetTeamRoutes` performs the COT release
only inside `announceRoutesRemoved`, which its own `notice !== 'silent'` guard
skips (`routing/operations.ts:343-378`), and `routeRemovalNotice` maps
`TEAM_NOT_FOUND` to `silent` (`:69-71`). A silently committed route removal
therefore retires no presentation — the same policy outcome 7 states, applied
to a call site the brief names ("silent committed route removals"). Fix:
perform the `cot.onRouteReleased` loop for every removed route inside
`forgetTeamRoutes`, independent of the notice branch, leaving notification
policy untouched. This is a correction of the existing owner, not a new product
choice.

## F. Point 5 — pairing discards obsolete entries and finds a live winner

Accept the prune-at-commit form. Inside the existing `recordPairingPrompt`
transaction (`access/index.ts:192-207`): keep the concurrent-approval early
return (`:176-186`); compute one `now`; prune expired pending entries with the
gate's own pure operation (`access/gate.ts:108-121`); then resolve the live
same-sender winner and merge the sent token/card, preserving unrelated senders,
the resend bump, and the mid-window approval skip. This both discards obsolete
entries and finds a live winner, which a lookup-only reuse does not. Preserved:
send-before-save (the `pair` gate outcome is still not committed at
`access/index.ts:132-136`), retry after a failed send, TTL refresh, and
concurrent state merging.

## G. Point 6 — final coverage accounts for every surviving obligation

Accept the broader accounting. Coverage is not only this batch's regression
cases and not an unapproved "accepted gap": every surviving
`artifacts/deleted-tests.md` obligation gets one named disposition — restored
under a current owner, covered by a named surviving assertion, or superseded by
a named accepted decision — with mixed cases mapped assertion by assertion
(codex-ultra's family inventory is the model). Source-text/path/export-name
pinning stays retired.

**#63 evidence.** `packages/dreamux/tests/codex-live.test.ts` currently contains
only the classifier (`describe('codex detection logic')` with three unit
`it`s); the behavioral body was deleted and the ledger's standing high-risk
entry pins its contract (`deleted-tests.md:1-21,494-528`). Installed
`codex 0.159.0` is availability, not behavior: the restored gate must spawn a
real app-server, block a live Dispatcher turn, inject a second inbound during
that window, and observe it fold into the same native turn. If a Codex install
is genuinely absent, say so and leave the acceptance item incomplete; never
cite `DREAMUX_SKIP_LIVE_CODEX=1` as #63 coverage and never substitute fake
Feishu transport for real platform delivery.

## H. Convergences and remaining material disagreements

**Converged (all three, or a majority the source confirms):**

- Outcome 1: stop permanently rooting historical Team stores; reads become
  transient; an explicit acquisition boundary replaces the implicit
  `list`-loaded assumption; release only with a retire-only predicate
  (non-closed and `cleanup-pending` stay memory-authoritative).
- Outcome 2: the bus implements `DispatcherCoreEventPublisher`; delete the
  frozen forwarding object; session leases untouched.
- Outcome 3: only `skillSources`/`disableFeatures` become required;
  argument-builder optionality stays.
- Outcome 4: dry-run predicts the same root retention as real uninstall from
  the same invocation's owned removals; no recursive delete.
- Outcome 5: resolve at the package entry/export boundary (default provider +
  named plugin + builtin catalog export); no Core package-name case, no
  migration.
- Outcome 6: expiry-aware commit with obsolete-entry pruning; send-before-save
  and concurrent approval preserved.
- Outcome 7: carry the serving route from routing's `plan.matched`; parent
  release retires a parent-served topic; exact-bound topics survive.
- Outcome 8/9: same owners; full-ledger accounting; real #63 evidence required.

**Remaining material disagreements:**

1. *Release trigger (me + codex-ultra vs MiMo).* I keep `service.closed`'s
   current meaning and release explicitly at the end of the dissolve/abandon
   paths; MiMo moves `closed` after cleanup and releases at `evict`. Both reach
   a quiescent point; I prefer not to widen a documented promise.
2. *Retention of `cleanup-pending` (me + codex-ultra vs MiMo).* I retain the
   entry while a durable `cleanup-pending` fact stands; MiMo releases after the
   failed settle attempt.
3. *Holder count / admission holds (codex-ultra vs me).* I find no reachable
   post-settle writer beyond the FIFO-bounded `running` transition, so I do not
   add counts or operation holds; codex-ultra does. This is the one point where
   I would ask the reviewer to re-derive the `starting`-guard-plus-FIFO argument
   against the source before choosing the heavier mechanism.
4. *COT provenance form (me + codex-ultra vs MiMo).* I carry a `servingTarget`
   fact from the producer; MiMo re-derives surviving exact topics at release
   through a routing read. Carrying the fact the routing owner already computed
   avoids a second derivation.

## I. Revised consolidated position

| Outcome | Round-1 position | Round-2 revised position |
| - | - | - |
| 1 | release at the retired write; `get` never roots | **withdrawn trigger**; transient reads + acquire-and-load handle + captured-store update + quiescent single-owner release + retire-only predicate |
| 2 | unchanged | unchanged (bus implements the producer contract) |
| 3 | unchanged | unchanged |
| 4 | unchanged | unchanged |
| 5 | throwaway `ContributeHost` | **withdrawn**; package default = provider adapter, named plugin factories, builtin catalog carries the export |
| 6 | expiry-aware same-sender lookup only | upgraded to prune-at-commit plus live-winner selection |
| 7 | `anchor.target` = serving route | **withdrawn**; additive `servingTarget` from `plan.matched`, release matches visible OR serving; silent committed removals now retire presentation |
| 8 | unchanged | unchanged |
| 9 | ledger-named contracts restored | broadened to every surviving ledger obligation with a named disposition and real #63 evidence |

No blocker remains for one developer. The one open technical judgement worth an
independent re-derivation is H3 (whether any writer can enqueue after the
cleanup-settle in the current source); if a reachable one is found, add the
operation hold codex-ultra proposes rather than weakening the retire-only
predicate.

## J. Correction (root audit): the queued `running` patch is not drained by the settle

Verified against source; this supersedes the absolute claim in §B.3 and resolves
H3. `TransactionalStore` guarantees FIFO order **among operations already
enqueued** (`enqueue`/`update`, `dreamux-utils/src/transactional-store.ts`); it
does not guarantee that a later-queued operation has *executed* before an
unrelated async span returns. The guarded leader write is enqueued
synchronously with the read that admits it (`mustRecord().status === 'starting'`
then `updateRecord({status:'running'})`, `service.ts:826-837` — no `await`
between the check and the enqueue), so it is ordered after the closed write, but
when the worktree is unmanaged or already terminal
`settleTeamWorktreeCleanup` returns at its first check **without any record
update** (`service.ts:1100-1102`). Neither `destroyChildren` nor that cleanup
span is a queue barrier, so `runDissolve` can return with the queued `running`
patch still unexecuted. The root-audit scenario is real: a recovered `starting`
Team (`rebuild` tracks a service for a `starting` record, `service.ts:438-462`)
whose admitted leader submission queues `running` behind a pending `closed`
write, with terminal/unmanaged cleanup.

**Resolution — existing `drain()` plus the explicit single-owner handoff
suffices; holder/operation counts are not necessary.** Make the release a
drain-then-delete rather than a bare delete: `TeamStore.release(teamId)` awaits
the held entry's `TransactionalStore.drain()` (`transactional-store.ts`,
`drain()` awaits the current tail, which already includes every enqueued
operation) and only then deletes the entry if it is still the same one and its
committed value is retired. This is called at the single-owner release point —
the end of `runDissolve` and `abandonCreated`, after the cleanup attempt. It is
sufficient because no writer can *enqueue* after the closed commit resolves:

- the only writer that can race a dissolve is that guarded `running` patch, and
  its check-and-enqueue are one synchronous microtask, so it is enqueued before
  the closed update resolves (and is therefore already in the tail that
  `drain()` awaits);
- `startCreated`'s unconditional `running` write (`service.ts:368`) cannot
  overlap a dissolve at all: `TeamCollection.get` joins the in-flight
  construction (`index.ts:306-325`) and `open`/`dissolve` reach a Team only
  through it, so a dissolve cannot begin until `startCreated` has returned;
- recovery cleanup runs at startup over `closed` + `cleanup-pending` records
  that have no live service (`index.ts:369-375,481-487`), so it never shares an
  entry with a dissolving service.

This keeps `service.closed` exactly as it is and adds no count, admission hold,
or new state; `mergeRecord` writing through the captured store is retained but
is no longer the load-bearing part of the fix — the drain is. If a later change
introduces a writer that can enqueue after the closed commit resolves, this
argument is what must be rechecked (and only then would the codex-ultra
operation hold become warranted).
