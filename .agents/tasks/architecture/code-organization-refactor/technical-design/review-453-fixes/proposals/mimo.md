# Review fixes and final coverage — technical proposal (MiMo)

Round-one independent proposal. Sole requirement input:
[`artifacts/review-fixes-20261003.md`](../../../artifacts/review-fixes-20261003.md),
revision 1. Baseline is the feature branch after
[PR #462](https://github.com/excitedjs/dreamux/pull/462).
The resulting-tree diagnosis at `.workspace/review-20261003/final.md` is
consultation evidence only; nothing in it authorizes work beyond the
requirement's nine outcomes. No peer proposal was read before this one.

## 0. Outcome

Seven targeted fixes, two documentation passes, and the final-parent test
stage, each in the module that already owns its fact. The batch removes
concepts (the frozen publisher facade, dead dependency optionality, a
divergent duplicate pending-slot lookup, unconditional preview claims,
permanent positive Team-store registration) and adds one mechanism total: a
`release` verb on `TeamStore`, paid for by the ruled retired-record
semantics. The one product behavior change — retired Team history becomes
disk-authoritative — is the operator's explicit selection ("退休后读盘"); every
other outcome restores or preserves existing behavior.

## 1. The two contested boundaries

### 1.1 Retired Team record ownership (Outcome 1)

**Owner.** `TeamStore` (`packages/dreamux/src/service/team/store.ts`) remains
the single writer per `team/<team>/record.json`; `TeamCollection`
(`service/team/index.ts`) is its only owner and decides when a Team's store
has no owner left. `TeamService` is the writer during a Team's life; the
collection's recovery sweep is the writer during a leftover cleanup.

**End-to-end behavior.** Online, constructing, pending-write, and
cleanup-owning Teams keep today's memory-authoritative store exactly as-is
(B21 holds). A fully retired Team — closed, children destroyed, worktree
cleanup settled — has no store in memory: the next history read, replay
lookup, or name probe reads `record.json` from disk, so a hand edit or
deletion of a retired record is observable on that next read and the name
follows a valid record again. This is precisely the presented consequence the
operator selected and nothing wider: no history cap, no record deletion, no
ledger, no mirrored phase.

**The retirement rule.** A Team's `TransactionalStore` entry in
`TeamStore.stores` is held while an owner can still write the record, and is
released when the last one retires:

1. a tracked `TeamService` retires when its `closed` promise resolves;
2. a construction that settles without a tracked service retires immediately
   (failed create, publish-null candidate, failed rebuild);
3. the recovery sweep (`reclaimTeamWorktree`) retires when its one
   `settleTeamWorktreeCleanup` call settles.

**Changes.**

- Delete the permanent-registration semantics in `store.ts`: `get`
  (174–183) no longer `hold`s a positive read or seeds a store from it — an
  unowned name answers from `loadTeam` and keeps nothing; the post-read owner
  re-check stays (a handle may have appeared mid-read, and the held store is
  then the authority). `list` (185–201) inherits this via `get`. Rewrite the
  `stores` field doc (65–75), which currently states "a store is never
  evicted", to the new meaning: one store per currently owned Team.
- Add one verb, `TeamStore.release(teamId)`, deleting the map entry. Its doc
  states the caller's quiescence obligation: no write may be in flight or
  issued afterward for that id. No holder counting — see rejected
  alternatives.
- `team/service.ts`: move `closeFromRecord()` to after
  `settleTeamWorktreeCleanup` in both `runDissolve` (currently
  `finally` at 650–652, settle at 657–668) and `abandonCreated` (424–429).
  `closed` then means *fully retired* (destroy pass **and** cleanup settle
  done), which is what makes `evict` a safe release point. Update `closed`'s
  doc (175–181) and `closeFromRecord`'s (1002–1008) accordingly; the
  existing reason for resolving after the destroy pass (a host stop racing a
  dissolve must still find the Team live mid-destroy) is preserved, not
  changed.
- `team/index.ts`: `evict` (778–781) calls `this.store.release(teamId)` after
  dropping the live instance; `reclaimTeamWorktree` (377–393) releases in a
  `finally` around `settleTeamWorktreeCleanup`; the construction settlement
  in `publishConstruction` (729–740) releases when the construction produced
  no tracked service (checked against `live`/`starting` — a `track`ed Team
  keeps its store and releases through `evict`). This covers `createTeam`'s
  throw paths (createNew failure including abandonment, `startCreated`
  abandonment, `refuseIfClosing`), its `created === null` path, and
  `rebuild`'s throw.

**Lifecycle and concurrency.**

- *Single-writer invariant preserved.* The map still guarantees one
  `TransactionalStore` per held name, so `publishRecord`'s atomic
  read-decide-replace name claim and `mergeRecord`'s closed-is-terminal merge
  keep their serialization. Concurrent name allocation is unchanged: the
  `constructing` gate (index.ts:558–562) arbitrates in-process candidates and
  the store queue arbitrates the publish itself.
- *Release is quiescent without extra machinery.* Every record write goes
  through the one chokepoint (`updateRecord`, `record.create`, or the
  handle's `update` from `settleTeamWorktreeCleanup`), and every one is
  awaited by its caller before the moved `closeFromRecord`. The one known
  straggler family — a pre-dissolve admitted `submitInput` writing
  `starting → running` (service.ts:827–837; the store comment at 267–270
  names it) — is bounded: the status check reads the committed record at
  settlement, so a write is issued only while the record still says
  `starting`; its enqueue follows within a microtask, i.e. always before the
  dissolve's later `closed` and settle writes. No post-release writer exists,
  so no retirement gate, in-flight counter, or queue-drain API is added.
- *Release/re-hold races are benign.* A transient `get` racing a release
  serves one possibly-pre-settle snapshot — semantically identical to reading
  an instant earlier — and holds nothing. `handle()` on a released id
  (recovery cleanup) re-holds the one store again; that path has exactly one
  holder at a time (recovery runs at startup for closed cleanup-pending
  Teams, which never have a live service).
- *Replay and cleanup preserved.* `acceptedRequest`'s scan (256–261) reads
  retired records from disk and answers identically across restarts;
  `recoverWorktreeCleanup` (369–375) still finishes every `cleanup-pending`
  reclaim, now with its own hold/release around the settle.

**Public compatibility.** No file shape changes; no `BREAKING:`/`Rebuild:`.
The product change is the ruled narrowing of daemon-lifetime snapshot
semantics for fully retired history only, disclosed as an ordinary change
note (and in the product catalog / maintenance reference — Outcome 8).

### 1.2 Configured official npm providers (Outcome 5)

**The actual contract conflict (stated before any substitution).** Both
loader contracts select `module.default` for a bare `npm:` ref — the provider
loader (`registry/provider-loader.ts:192–205`) asserts a **provider factory**,
the plugin loader (`plugin/loader.ts:242–253`) asserts a **plugin factory** —
and the three official packages serve both roles. One default export cannot
honor both. Next's contract was default = provider factory; this branch moved
default to the plugin factory (index.ts barrels, `refactor-code-org-8a-providers`
note), which is why a persisted `npm:@excitedjs/agent-runtime-codex`-style ref
now fails the provider-shape assertion before daemon creation.

**Resolution — the public package boundary, one contract per export.**

- Each package's `default` export is again its bare provider factory
  (restoring the provider-ref contract for bare refs):
  `createCodexAgentRuntimeProvider` / `createClaudeCodeAgentRuntimeProvider` /
  `createFeishuChannelProvider` re-exported as default
  (`codex/src/provider.ts:79`, `claude-code/src/provider.ts:43`,
  `feishu-channel/src/provider.ts:39` — all zero-or-options factories that
  already accept the loaders' `{ ref }` factory context, exactly as on next).
- The plugin factory is a named export: feishu already has
  `createFeishuPlugin` (`plugin.ts:24`); add the symmetric
  `createCodexPlugin` / `createClaudeCodePlugin` named exports beside the
  existing default functions.
- `BUILTIN_PLUGIN_PACKAGES` (`registry/builtins.ts:55–68`) records the export
  name each always-loaded plugin is imported as (the map already names
  packages; it now names the factory too), and `plugin/loader.ts`'s builtin
  branch selects that export instead of a hard-coded `'default'`. The
  `npm:pkg#export` plugin-ref path is untouched, so third-party plugin
  packages keep default = plugin factory.

Both capabilities are preserved: existing default npm provider refs load
again with no config edit, and the plugin entry capability (plugins[] refs,
always-loaded builtins, `#export` selection) is intact. The one residual
contract fact to report in the change notes: a bare `plugins[]` ref to one of
the three official packages no longer resolves their plugin factory — use
`npm:pkg#createCodexPlugin` etc. That path was never loadable alongside
always-loading (the same-name check rejects the duplicate contribution), so
no capability disappears.

**Changes.** Three package barrels + two `plugin.ts` named exports; the
builtin map and the plugin loader's export selection; no change to
`provider-loader.ts` itself. **Not** chosen: any Core-side package-name case
in the provider loader, any shape-sniffing "plugin-shaped default" fallback,
and no startup config migration (not needed — and per the requirement, a
migration would first have to be reported).

**Note and reference updates (with the same change).** Rewrite the pending
change-file comments that currently disclose the startup failure and tell
callers to switch to `builtin:` — `common/changes/@excitedjs/agent-runtime-codex`
and `-claude-code/refactor-code-org-8a-providers_2026-09-25-00-00.json`
(last sentence) and `common/changes/@excitedjs/feishu-channel/plugin-system-mvp_2026-09-24-02-30.json`
— to describe the restored default and the named plugin factories; update the
package index.ts doc comments claiming "default export is the plugin
factory". Ordinary notes only: the upgraded daemon starts with existing
config, so nothing is `BREAKING:`.

## 2. Remaining code outcomes

### 2.1 Event producer ownership (Outcome 2)

**Owner/behavior.** `DispatcherCoreEventBus` is the authoritative delivery
owner; its narrow producer contract (`publish`, `hasSources` —
`dispatcher-core-events/index.ts:22–25`) is what internal producers hold.
Behavior unchanged: seal-then-deliver, best-effort listeners, per-session
source leases with independent revocation (`createSource`/`revoke`/`revokeSources`
stay exactly as they are).

**Changes.** Make the bus implement `DispatcherCoreEventPublisher` directly:
`publish` and `hasSources` become its public methods; delete the frozen
`publisher` forwarding object (47, 61–67) and pass `this.coreEvents` at
`dispatcher-service/index.ts:191, 200, 270` (line 210 already passes the bus
to `ChannelService`, which needs the lease verbs). Consumers
(`agent/factory.ts:26`, `team/types.ts:59`,
`conversation-projection.ts:59`) keep their `DispatcherCoreEventPublisher`
types unchanged — that type is the retained narrow contract, and it is what
still hides `createSource` from them. Removal: one forwarding identity and
two closures. No runtime/provider/plugin receives the producer today, so no
exposure policy is invented.

### 2.2 Claude dependency shape (Outcome 3)

`AgentRuntimeCreateContext.skillSources` and `.disabledFeatures` are required
(`dreamux-types/src/agent-runtime.ts:284, 290`) and the sole production
supplier passes both (`claude-code/src/provider.ts:75–90`). Make
`skillSources` and `disableFeatures` required on `ClaudeCodeRuntimeDeps`
(`runtime-deps.ts:20–21`) and delete the `?? []` fallback
(`runtime.ts:130`). `systemPromptAppend`/`outputSchema` stay optional, and the
argument builder's own optional test suppliers are untouched — those are real
optional seams. Internal contract only (the deps type is not in the package
barrel); deletion of two dead optionality branches, no behavior change.

### 2.3 Truthful uninstall preview (Outcome 4)

**Owner/behavior.** `onboard/uninstall.ts` owns the uninstall plan. Real
uninstall deletes the owned config files and non-recursively `rmdir`s
`DREAMUX_ROOT`, reporting `skipped` when foreign content remains
(`removeConfigDirectory`, 173–206); dry-run must predict that same outcome
and perform no writes.

**Changes.** In the dry-run branch of `removeConfigDirectory`, replace the
unconditional `removed` (185–187) with the same predicate the real `rmdir`
applies: read the root's entries (read-only), and report `removed` only when
every child is one of this plan's own deletions (the two config files and the
owned `state`/`run`/`cache`/`log` directories from `runUninstall` 81–108);
any other child reports `skipped` with the existing "not empty" reason.
Provider-home protection (`assertSafeOwnedDirectory`, `resolveOperatorStateRoots`)
and the retain-foreign-files policy are untouched; recursive root deletion
is not restored.

### 2.4 Pairing after expiry (Outcome 6)

**Owner/behavior.** `FeishuAccess` (`access/index.ts`) owns access state and
all pairing transitions; send-before-save stays (the `pair` gate outcome is
deliberately not committed at `gate()` 132–137 — the token is recorded only
after the card is on screen). The defect: `recordPairingPrompt`'s same-sender
lookup (192–207) is a duplicate of the gate's pending-slot lookup but *without*
its expiry awareness (`gate.ts:129–147` skips `expires_at <= now`; the
defective copy does not). An expired same-sender entry therefore eats the
fresh non-resend token the gate just minted — the user sees a card whose
token approval answers `not_found`.

**Changes.** Make `recordPairingPrompt` resolve the same-sender slot through
the gate's own `findExistingPendingByKey` (export it from `access/gate.ts`
and delete the divergent `Object.entries(...).find(...)` copy). The merge
branching (resend-bump vs. fresh entry, mid-window approval skip) is
unchanged; a lingering expired entry is pruned by the next gate pass exactly
as today (gate.ts:114–121). One lookup, one meaning. Preserved: send-before-save,
retry, expiry, approval (`approvePairingByToken`), and concurrent-state
merging in the same serialized `store.update` transaction.

### 2.5 COT route retirement (Outcome 7)

**Owner/behavior.** The local policy is already written down
(`cot/recipients.ts:167–174`): an ongoing presentation retires when the Team
closes **or the route that produced the anchor is taken away**. The release
handler (`onRouteReleased`, 216–231) matches only
`sameTarget(state.anchor.target, input.target)`, so a topic anchor served by
its parent-group binding (routing's fallback rule: exact binding wins, then
the topic's parent group — `routing/index.ts:143–167`) is not retired when
that serving parent route is released. Fix: retire exactly the presentations
whose serving route was released; independently bound exact topics survive.

**Changes.** Extend `onRouteReleased`'s interrupt condition to the serving
relation: interrupt when `sameTarget(anchor.target, released)` (existing
case), **or** the anchor is a topic inside the released chat-level target and
that topic has no binding row of its own. The "independently bound" fact is
the routing document's, so the one routing-aware caller supplies it:
`FeishuBindingOperations` (`routing/operations.ts`) — which already mediates
routing↔cot (`offerAsFirstAnchor` does the same kind of routing check at
107–119) — passes the surviving exact-topic targets for the released chat at
its three `onRouteReleased` call sites (unbind 227, displaced bind 183, route
removal announcements 280). A small document read on `FeishuRouting` (the
topic rows of one chat; `topicBindingsFor` at 189–199 is the existing
neighbor) feeds it. The fence policy (`rememberTarget`, `blocksAnchor`,
`onRouteClaimed` restoration at 233–244) keeps its current exact-target
scope — the requirement says preserve future-anchor behavior and forbids
permanent-anchor-loss or terminal claims; in practice new inbound no longer
routes to the released route, so no new anchor arises from it.

**Lifecycle note.** `onRouteReleased` already runs after the unbind/removal
commit; the interrupt (`detach(..., 'interrupted')` in
`cot/adapter.ts:543–551`) is what stops subsequent assistant/tool activity
from writing into the retired presentation — no routing recheck is bolted
onto every activity write.

## 3. Accurate documentation (Outcome 8)

All in the same change as the behavior they describe:

1. Narrow `dreamux-types/src/agent-runtime.ts:438–445`'s
   `readRecentActivity` contract comment to the checks Core still performs
   (record count vs. requested limit, structure, public errors); delete the
   claim of independent text/page/cursor magnitude checks (removed under
   R28) without touching the surviving checks.
2. Product catalog (`.agents/product/README.md`): add entries for the
   already-accepted removal of `dispatcher.start` (enabled dispatchers start
   with the daemon), owner-close read fences (operational reads refused while
   the owner closes; global status stays observable), and signal-driven exit
   semantics (SIGTERM/SIGINT exit 0/1 with the 15-second deadline) — recorded
   as behavior descriptions from the acceptance ledger (B01/B10/B16), with no
   invented operator quotes (B16's authority is a disclosed change, and the
   entry should say so or stay silent on authorship).
3. Same file, the "Team record is the only existence fact" entry (239–245):
   replace the daemon-lifetime snapshot paragraph with the ruled boundary —
   owned Teams (online/constructing/pending-write/cleanup) keep memory
   authority; fully retired history is read from disk on demand, so
   edit/delete/damage is observable on the next read and name availability
   follows a valid record.
4. Correct the `refactor-code-org-s4b-03` change note's rationale: raw `action`
   did not "only set an unread `intent` diagnostic" — next's `normalizeAction`
   could take `action.prompt` as the effective prompt, so dropping the field
   is a real input contraction (top-level prompt is authoritative), not a
   behavior-neutral cleanup; and the note's broad result wording must not
   stand in for the actual result schemas (which stay as they are).
5. Maintenance + knowledge owners for the retired-record boundary (config/
   state maintenance synchronization rule): update the owning
   `packages/dreamux/skills/dispatcher/dreamux-maintenance/` reference
   (`references/service-lifecycle.md`) and the domain records that state the
   memory-authority semantics (`.agents/domains/state-config-and-files.md`,
   `service-topology.md` / `dispatcher-orchestration.md` as applicable), plus
   the knowledge closeout in the same PR. Current-state-only wording: one
   accepted boundary, no migration history.

## 4. Final-parent coverage (Outcome 9)

R43's words authorize exactly this stage ("只有最后453合入next的时候才要求单测
覆盖。"), and it is the restoration stage — tests are written here, not
deferred. Scope: **meaningful behavioral evidence for the owners this batch
changes and for the locked contracts the review names** (admission, lock
finalization, Team shutdown/dissolve, event/COT, completion, scheduler, #63
inbound), with the deleted-tests ledger accounting for every obligation.
File/test counts prove nothing; source-text and file-path assertions stay
retired (Stage 9 banned them — restoring them is prohibited, and entries in
the ledger that pinned only structure are closed as "covered structurally,
assertion type retired", not reinstated).

**New behavioral tests for this batch's changes** (deterministic, internal):

- *Outcome 1:* cold history read retains no store and serves disk after
  retirement; an owned Team keeps memory authority across a hand edit; the
  name of a retired Team whose record is deleted frees on the next allocation
  probe; concurrent create-at-same-candidate still admits exactly one; the
  closed-is-terminal merge still drops a queued `starting → running` write;
  replay of an accepted `team.create` resolves without materializing; a
  failed create/rebuild leaves no held store; cleanup recovery holds only for
  its settle. Validation names from the requirement map here: *cold history,
  overlapping owners and writes, close/construction order*.
- *Outcome 5:* a bare `npm:@excitedjs/…` default import through both loaders
  yields a provider; `plugins[]` `#export` and always-loaded builtin refs
  yield plugins. *Both provider/plugin imports.*
- *Outcome 4:* dry-run and real uninstall agree on root retention with
  foreign content and with a clean root (real run against a temp root).
  *Dry-run agreement.*
- *Outcome 6:* an expired same-sender pending entry no longer discards a
  freshly sent token; resend still bumps the live entry; approval racing the
  merge still wins. *Expiry/concurrent approval.*
- *Outcome 7:* releasing the serving parent-group route retires the topic's
  ongoing presentation; a topic with its own binding survives an unrelated
  parent release; a re-claim re-opens presentation. *Parent versus
  exact-topic routes.*
- *Outcomes 2–3:* behavior is preserved by construction; covered by the
  event/COT and Claude runtime suites below rather than structure assertions.

**Locked-contract restoration from the ledger** (the review's named list,
each traced to its `deleted-tests.md` entries and restored as behavioral
cases against current owners): collection admission and close ordering
(R73 surface), Workflow provisional-lock finalization/undo, Team
dissolve/shutdown (closed-before-destroy, non-reopening, receipt-before-
teardown), core-event/COT delivery, completion delivery (recipient policy,
FIFO), scheduler (`advanceJob`/`rearm`, one-shot miss behavior), and the
issue #63 non-blocking-inbound contract. The ledger's own "restore recipe"
and contract-pinned notes are the source; where a pinned contract's owner
moved, the test is rewritten against the new owner, not the deleted file.

**Evidence classes, stated per case:**

- *Deterministic internal tests* — the four Rush gates cover all of the
  above except the live pieces.
- *Live provider evidence* — the #63 non-blocking-inbound live gate is
  restored in `codex-live.test.ts`'s behavioral body (the trimmed shell and
  escape hatches remain); it requires a real Codex install and the live-gate
  flags and fails loudly without them. This is the priority restoration.
- *Unavailable external systems* — real Feishu cannot be driven in CI; the
  pairing/COT/uninstall cases exercise the owners above the transport, and
  the ledger gap (no live Feishu E2E) is recorded as an accepted limitation,
  not claimed as covered.

Every ledger entry ends marked restored / covered otherwise / accepted gap;
`DREAMUX_SKIP_LIVE_CODEX=1` runs stay green-by-exclusion and are never cited
as #63 coverage. No locked assertion is weakened; if a restoration makes a
current test disagree, the change is reviewed against the source contract
before touching either.

## 5. Acceptance mapping

| Required outcome | Verified by |
| --- | --- |
| 1 Retired Team ownership | New store-lifecycle suite + existing Team create/dissolve/history tests; manual validations: cold history, overlapping owners/writes, close/construction order; rule text: no cap/record deletion/ledger/mirrored phase |
| 2 Event producer | Existing event/COT suites green through the bus; code diff shows the forwarding object gone and the leases untouched |
| 3 Claude deps | Compile-time narrowing + existing Claude runtime suites; optionality retained only where a real supplier is optional |
| 4 Uninstall preview | Dry-run vs. real parity tests (foreign file → `skipped` both; clean root → `removed` both); provider-home guards unchanged |
| 5 npm providers | Loader tests for both import shapes (bare default → provider; plugin refs → plugin); pending change notes rewritten; no Core package-name case in the diff |
| 6 Pairing expiry | Expiry/retry/approval/concurrent-merge cases in the access owner |
| 7 COT route retirement | Parent-vs-exact-topic cases; restoration/future-anchor behavior pinned unchanged |
| 8 Documentation | Product catalog diff, s4b-03 note, `agent-runtime.ts` comment, maintenance reference + `.agents` closeout; `.agents/scripts/check.sh` |
| 9 Final-parent coverage | Ledger accounting complete; named locked contracts restored; #63 live gate restored with live evidence when Codex is present; evidence classes labeled |

Gates after closeout: `rush build`, `rush lint`, `rush test`,
`rush typecheck:tests`, and `.agents/scripts/check.sh`. One developer
implements; tests travel with the batch (this is the R43 stage).

## 6. Rejected alternatives

- *Team store holder refcounts / lease tokens.* No reachable scenario has two
  concurrent holders (constructing gate, closed-never-rebuilt, startup
  ordering, one recovery sweep), so counting defends nothing named and adds a
  mechanism.
- *Release at `evict` without moving `closeFromRecord`.* The current ordering
  resolves `closed` (and thus evicts) **before** the worktree settle write
  (service.ts:650–658); releasing there would let the settle re-hold a fresh
  store and hand two `TransactionalStore`s the same file. Moving the resolve
  after settle removes the hazard instead of fencing it.
- *LRU/entry caps on the store map, or a durable ledger of retired names.*
  Both explicitly forbidden by the requirement; a cap with no recovery is a
  deadlock.
- *WeakRef/GC-based store release.* Nondeterministic; the requirement asks
  for release after owners and pending work retire, not after GC.
- *Core provider-loader special cases ("if the package is @excitedjs/… use
  the named export") or a plugin-shaped-default fallback.* Forbidden by the
  requirement and an N-valued discriminant on one export; one export keeps
  one factory contract.
- *Silent startup migration rewriting `npm:@excitedjs/…` refs to `builtin:`.*
  Forbidden without an operator report, and unnecessary: both contracts are
  preservable at the package boundary (§1.2 states the one residual fact).
- *Keeping default = plugin factory and requiring `#create…Provider` in
  config.* Breaks the persisted refs the requirement protects.
- *Committing the gate's pair `nextState` at `gate()` time.* Records a token
  before its card is on screen — the exact thing send-before-save exists to
  prevent. The expiry-aware lookup fixes the merge without moving the commit.
- *Pruning expired entries inside `recordPairingPrompt`.* The next gate pass
  already prunes; the defect is the lookup's meaning, not retained data.
- *Retiring every topic of a parent chat on parent release, or adding a
  routing recheck to every COT activity write.* The first violates the
  exact-topic survival rule; the second is a larger mechanism than the stated
  policy (release retires presentation) requires.
- *Replacing the publisher facade with a management-exposing bus at runtime.*
  The narrow producer **type** is retained; internal consumers are typed
  against it, which is the actual isolation boundary that exists today.

## 7. Unresolved facts (no blocker)

1. External embedders of the three packages' default export as a *plugin*
   factory were never surveyed (the in-repo consumer set is empty). §1.2's
   residual contract fact and the rewritten notes cover it; if the operator
   knows of such a consumer, the alternative (`#export` on their side) is
   already supported.
2. B16's signal-exit behavior has no located operator quote (authority "D"
   in the diagnosis); the catalog entry can describe behavior without
   authorship, but the operator may want a ruling recorded. Not blocking.
3. Live #63 evidence needs a Codex install and the live-gate flags in the
   delivery environment; real Feishu remains unexercised end to end. Both
   are labeled in the coverage plan, not papered over.
4. A single history read racing a dissolve's settle may return the pre-settle
   snapshot once (equivalent to reading earlier). Deliberately not fenced.

## 8. Sequencing and delivery

Order for one developer: §1.1 (largest, self-contained) → §1.2 (packages,
loader wiring, notes) → §2.5, §2.4, §2.3 → §2.1, §2.2 (mechanical) → §3 with
the knowledge closeout → §4's ledger accounting and locked-contract
restorations (interleave each fix's own tests with that fix). Change files:
ordinary notes for the retired-record semantics narrowing, the pairing fix,
the COT fix, and the uninstall preview fix; rewritten notes for §1.2; nothing
`BREAKING:`. Delivery follows the existing child-PR authority into PR #453's
branch; merging #453 into `next` remains the operator's call.

---

# Cross-review round 1 (2026-10-03)

One append-only adversarial round, per the round-2 brief and its mid-round
queue-overlap addition. Sources read: `proposals/deepseek.md`,
`proposals/codex-ultra.md`, `proposals/mimo.md` (first round above),
`source-audit.md` including its final overlap paragraph, the current source,
and requirement revision 1. No voting; every disposition below rests on a
source fact. First-round reasoning above is preserved; where source disproves
it, the withdrawal is stated here and the revised position is the authority.
No new operator decision and no extra product change is introduced.

Repository records use public PR links:
[PR #453](https://github.com/excitedjs/dreamux/pull/453),
[PR #455](https://github.com/excitedjs/dreamux/pull/455),
[PR #457](https://github.com/excitedjs/dreamux/pull/457),
[PR #459](https://github.com/excitedjs/dreamux/pull/459),
[PR #460](https://github.com/excitedjs/dreamux/pull/460),
[PR #461](https://github.com/excitedjs/dreamux/pull/461),
[PR #462](https://github.com/excitedjs/dreamux/pull/462). The one bare commit
reference in round 1 (the baseline SHA) was replaced above.

## A. Withdrawals: what source disproved in my round-1 design

**A1. The `closeFromRecord` move and release-at-`evict` are withdrawn.** Not
wrong in effect, but unnecessary and wider than needed. `closed` resolves
after `destroyChildren` and before physical cleanup
(`service.ts:637-651,1002-1010`); its only consumer is `track`'s eviction
(`index.ts:755`). Presentation retirement is driven by the `team.state` event
published at the **closed write** (`updateRecord`'s status-transition publish,
`service.ts:989-991`; consumed at `cot/adapter.ts`), not by the `closed`
promise, so delaying `closed` would retire nothing later — and it would widen
a documented promise ("resolved once the destroy pass has run") for no
required gain. The mid-round brief says preserve the current closed signal
unless the change is required; it is not. The revised design releases
explicitly at the record-owning paths and leaves `closed` exactly where it is.

**A2. Release at the end of the cleanup attempt is not quiescent — the
first-round straggler argument is withdrawn.** My round-1 claim ("every
straggler write enqueues before the settle write") assumed promise order
across independent resource owners. The source audit's final paragraph gives
the counter-schedule that needs no failure and no plugin: a recovered
`starting` Team submits its leader while dissolve has **queued** a `closed`
update still awaiting its atomic file write; the submission's
`mustRecord().status === 'starting'` check (`service.ts:827-837`) sees the
still-committed `starting` value and enqueues `running` **behind** `closed`;
once `closed` commits, `destroyChildren` and that queued patch run
concurrently; for an unmanaged worktree
`settleTeamWorktreeCleanup` returns without a trailing record update
(`service.ts:1096-1103`), so reaching the end of cleanup does not drain the
queued patch. Cleanup completion therefore does not imply record-queue
drainage.

**A3. Release-after-failed-settle is withdrawn in favor of a retire-only
predicate.** My round-1 released the entry even when the settle failed. The
requirement's retention classes name "cleanup-owning" Teams and say
"unfinished cleanup must still share the correct serialized owner"; "fully
retired" excludes a standing `cleanup-pending` fact. A failed cleanup **job**
is a settled attempt with no in-process continuation; the unfinished durable
**fact** is what keeps memory authority (and the name) until a later settle —
this process's recovery or the next start's — makes it terminal.

**A4. The `TeamStore.get`/`list` change as written was incomplete — the
implicit initialization assumption is withdrawn.** `TeamService.rebuild`
documents and relies on "`record` was already read through the collection's
`store.get`/`.list` … which loaded this same Team's `TransactionalStore`"
(`service.ts:458-462`), and `recoverWorktreeCleanup` relies on `list` having
loaded the store before `handle.current` (`index.ts:369-382`);
`TransactionalStore.current` throws before a successful load. Transient reads
must be paired with an explicit acquire-and-load boundary (point 1 below).
Relatedly, `handle.update` re-resolves `storeFor` by id while `current`/
`create` use the captured instance (`store.ts:102-113,256-262`) — once
entries can be released, that split lets an old handle target a different
store (source-audit). The revised handle writes through its captured store.

**A5. COT re-resolution at release is withdrawn in favor of carrying the
serving route.** See point 4.

**A6. Lookup-only pairing fix and the §4 "accepted gap" language are
withdrawn.** See points 5 and 6.

## B. Point 1 — handle producers/consumers, initialization, actual overlap

**Producers of a `TeamRecordHandle`** (`store.ts:102`): exactly two —
`TeamCollection.depsBase` (`index.ts:783-792`, called by `createTeam` and
`rebuild`) and `reclaimTeamWorktree` (`index.ts:377-382`). **Consumers:**
`TeamService.deps.record` — `createNew`'s `create` (`service.ts:276`),
`updateRecord` (`:368,412,626`), `mustRecord`'s `current` (`:995-999`), and
`settleTeamWorktreeCleanup`'s read/update (`:1096-1117`) — plus the recovery
handle for the same settle. There is no other producer or consumer.

**Initialization assumptions (must be made explicit):** `rebuild` and
recovery currently depend on an earlier `get`/`list` having loaded the exact
store (A4). The revised contract: `acquire(teamId): Promise<TeamRecordHandle>`
registers/returns the canonical entry and **loads it before handoff**;
`depsBase` becomes async (both callers already are) and rebuild acquires
first and reads the record from that handle rather than seeding from an older
read. `current`/`create`/`update` all use the captured store instance.

**Actual overlaps, enumerated (not assumed):**

1. *`destroyChildren` after the closed write* — real, but strictly before any
   release point inside `runDissolve` (`service.ts:637-668`).
2. *Construction handoff* — `createTeam` tracks the service before returning
   (`index.ts:605-613`), so a construction-settlement release fires only for
   untracked outcomes (failed create/abandonment, publish-null, failed
   rebuild, `refuseIfClosing` before `track`).
3. *Admitted continuations* — the only concurrent record writer is the
   `running` transition (`submitInput`/`startCreated`), and the audit's
   schedule (A2) is its worst case: a patch already **queued** behind
   `closed`, executing concurrently with `destroyChildren`, unordered with
   the no-op unmanaged cleanup.
4. *Recovery vs. a live service* — `recoverWorktreeCleanup` runs at startup
   over `closed` + `cleanup-pending` records and `recover()` skips `closed`
   (`index.ts:369-375,481-487`); the two handles never coexist for one Team.

**Verdict on the brief's question — existing drain + explicit single-owner
handoff suffices; holder counts are not needed.** The audit offers "the
existing queue's drain or an explicitly held queued operation". The lighter
one closes the named schedule completely:

- *Single-owner handoff:* the handle writes through its captured
  `TransactionalStore` (A4 fix), so a late patch can never target a store
  other than its own, and the map keeps one instance per held name.
- *Existing drain as the release gate:* `release()` is
  `await store.drain()` → then a **synchronous** check-and-delete: remove the
  entry iff it is still this handle's instance and its committed value is
  retired (absent, or `closed` with no `cleanup-pending` worktree fact).
  `TransactionalStore.drain()` (`dreamux-utils/src/transactional-store.ts:151`)
  awaits exactly the queued work the audit's schedule leaves behind.
- *Why no new enqueue can slip past the drain:* a `running` patch is issued
  only while the committed slot still says `starting`; the check and its
  enqueue are separated by microtask continuations only, so every such enqueue
  lands before the `closed` write's own completion is even observed — and the
  release path runs after that completion plus the whole destroy/cleanup
  span. This is FIFO-tail ordering within one owner plus the status guard, not
  an assumption of promise order across owners.
- *Residual stated, not hidden:* if a write were somehow still in flight at
  delete time it would complete on the captured orphan instance (one atomic
  write to a retired record) and cannot race a second instance, because a
  retired name is never re-acquired in-process (`open`/`rebuild` refuse
  closed; recovery runs at startup). That is the same bounded orphan-write
  case my round-1 A2 already analyzed.

codex-ultra's holder count + per-operation `try/finally` holds would also be
correct, but every queued operation already serializes through the one queue
`drain()` covers; the extra count defends no remaining named scenario and
spreads retention across every admission point. DeepSeek independently
reaches the same no-count conclusion (its §B). The one place codex-ultra's
caution is adopted: delete only **synchronously after** drain, with the
instance-identity guard, so no drain-then-delete window can detach a joining
acquisition.

**Release points (single-owner, explicit):** end of `runDissolve` and
`abandonCreated` (after the settle attempt), construction settlement when no
service was tracked, and the recovery `finally`; all through the same
`handle.release()` (drain + retire-only delete). `get`/`list` never hold.
A failed rebuild or failed settle therefore leaves the entry held **only**
while its committed value is unretired — exactly the ruling's retention
classes.

## C. Point 2 — the `closed` signal, the sweep, and cleanup facts

Moving `service.closed` after physical cleanup is **withdrawn** (A1): it is
not required for record release once release is explicit at the owning paths,
it would keep a closed service in `live` longer (the second host-stop sweep
at `index.ts:526-538` iterates `live`/`starting` and `stopForHost` is
idempotent, so nothing breaks — but nothing is gained), and it would widen
`closed`'s documented meaning ("resolved once the destroy pass has run") that
the review surface relies on. Preserve the current signal and the current
one-shot `team.state`-at-closed-write retirement path.

**Failed job vs unfinished fact, distinguished:** a settle that throws is a
*settled attempt* — no in-process continuation exists — while the durable
`cleanup-pending` fact remains. The retire-only predicate (B) keeps the entry
held (memory authority, name taken) while that fact stands, and the same
predicate releases it when a later settle — this process's recovery `finally`
or the next start's — writes a terminal worktree state. No cleanup registry,
no second phase field: the record's own fact decides, as the requirement
asks.

## D. Point 3 — package entries vs throwaway contribute host

My round-1 design stands and converges with both peers: package-root `default`
= provider factory (restoring the provider-ref contract), named plugin
factories (`createCodexPlugin`, `createClaudeCodePlugin`, existing
`createFeishuPlugin`), and `BUILTIN_PLUGIN_PACKAGES` carrying package/export
descriptors the plugin loader's builtin branch selects. Source additions this
round:

- *The throwaway contribute host is rejected on source.* The provider loader
  calls factories with a `{ ref }` context (`agent-runtime/external-provider.ts:84`);
  the plugin loader calls a **zero-argument** factory (`plugin/loader.ts:241-253`).
  Re-running `contribute` against a throwaway host constructs providers over
  plugin-owned state that only `server()` initializes — the Feishu plugin's
  provider runs over its shared `FeishuExtensionRegistry`
  (`feishu-channel/src/plugin.ts:24-38`), so throwaway extraction yields a
  provider whose extension state was never rooted (DeepSeek §A3), and the
  no-IO contract does not make `contribute` side-effect-free (source-audit).
  One export keeps one factory contract; that is also the smaller concept
  count: named exports already exist, the adapter is one line, and no
  provider-path machinery is added.
- *Bare official plugin refs are **not** valid today with always-loading.*
  `loadPlugins` runs always-loaded sources first and rejects a duplicate
  `plugin.name` (`plugin/loader.ts:164-173`), so `plugins[]: ["npm:@excitedjs/…"]`
  already fails at the factory phase. Restoring the provider default removes
  no working plugin capability; after the change that ref fails loudly at the
  plugin-name check instead (correct ref: `npm:pkg#createXPlugin`). This is
  the residual contract fact to state in the rewritten notes — nothing more.
- *Typing note:* Codex's constructor takes an options object; the loaders'
  `{ ref }` context is ignored the same way next's default factories ignored
  it. A one-line context-ignoring default adapter is acceptable if typing
  demands it; do not reintroduce deleted options.

Rejected again with source basis: Core package-name cases (requirement
forbids), shape-sniffing plugin-shaped defaults (two contracts on one
export), and any startup migration (both capabilities are preservable, so
the report-a-conflict-and-migrate escape hatch does not trigger).

## E. Point 4 — COT: carrying the serving route, proven through producers

**Withdrawal (A5): my re-resolution-at-release design (surviving-topic list
from routing) is withdrawn.** The policy text is "the route that **produced**
the anchor was taken away" (`cot/recipients.ts:167-174`) — creation-time
provenance. Re-deriving "who serves now" at release mishandles the real
sequence where a parent-served topic later gains its own binding: at release
of the parent, the topic has a row, so re-resolution would let the
presentation continue even though the route that produced it is gone.
Carrying the fact routing already computed is also the smaller mechanism.

**Revised position:** keep `VisibleMessageAnchor.target` as the visible
destination — `blocksAnchor`, `onRouteClaimed`, and `prepareVisibleAnchor`'s
chat-agreement check keep their current visible-target meaning ("retain
prior visible-target release/claim behavior") — and add one nullable
`servingTarget` to the stored anchor, supplied by the producer:

- *Producers proven, not assumed* (the complete constructor set in current
  source): `inbound/pipeline.ts:492` (chat inbound), `session/card-actions.ts:102`
  (ask-user forwarding), and `routing/operations.ts:113` (binding-notice
  fallback via `setFallbackAnchorIfAbsent`). All three flow the anchor through
  `chatSubmission` (`feishu-submit.ts:98-106`) into
  `FeishuTeamSubmitter.submit` (`session/submitter.ts:40-48`), which calls
  `beginInboundSubmission` (`cot/adapter.ts:163-171`). The one threading point
  is therefore `submit`/`beginInboundSubmission`: `inbound/router.ts:110-123`
  passes `plan.matched` (bound), `null` (dispatcher fallback), and
  `feishu-provisioning.ts` passes the exact target it just bound; the
  binding-notice fallback passes its checked bound target. `plan.matched` is
  already computed and currently discarded at that exact call
  (`routing/index.ts:143-154`) — carrying it is fact-threading, not a new
  derivation. Document-comment submissions carry no anchor at all (`null`).
- *Normalization proven:* `prepareVisibleAnchor` (`cot/recipients.ts:346-360`)
  requires `target.chatId === anchor.chatId`, which holds today and is
  untouched because the visible `target` keeps its value; the serving fact
  rides along on the copy. `anchor.target`'s own doc ("kept beside the ids so
  a binding that moves away can retire exactly the anchors that pointed at
  it") is what the release comparison needs — the additive field supplies it
  without repurposing the visible one (which DeepSeek §A5 and I now agree
  would change claim/fence behavior the brief says to retain).
- *Release:* `onRouteReleased` interrupts when the released route equals the
  anchor's visible target (existing case) **or** its `servingTarget`
  (parent-served topic case). Independently bound exact topics survive: their
  `plan.matched` is the topic row itself, so a parent release matches
  neither — including when both rows name the same Team. `blocksAnchor` and
  `onRouteClaimed` stay visible-target; no permanent-anchor-loss or terminal
  claim is added.
- *In-flight create/append:* retirement reuses the existing detach path
  (`advanceAnchor(null)` with the current generation/terminal handling,
  `cot/adapter.ts:584-619`); later activity finds no state and writes
  nothing. No cancellation, generation counter, or tombstone.
- *Silent committed route removals:* adopt the peers' finding —
  `forgetTeamRoutes` performs the `onRouteReleased` loop only inside
  `announceRoutesRemoved`, which the `notice !== 'silent'` guard skips
  (`routing/operations.ts:343-378`; `rejectedDeliveryNotice` maps
  `TEAM_NOT_FOUND` to silent at `:69-71`). A committed removal is a release
  of the serving route, and requirement 7 conditions retirement on the
  release, not on a card being announced. Fix: run the release loop for every
  removed route regardless of notice; **retain** the notice policy exactly
  (silent removals stay silent). Ordinary unbind and displaced rebind already
  call `onRouteReleased` directly and are unchanged.

## F. Point 5 — pairing: prune-at-commit plus live-winner selection

**Withdrawn (A6): lookup-only is insufficient.** Filtering the same-sender
lookup fixes the discarded-token bug but copies every obsolete expired entry
forward on each expiry/resend cycle (they survive until some later gate pass,
or indefinitely on disk if no inbound follows). The brief requires both:
discard obsolete expired entries **and** find a live winner.

**Revised position:** inside the existing `recordPairingPrompt` transaction
(`access/index.ts:169-221`), against the latest committed state — never the
gate's pre-send `nextState` (source-audit): keep the concurrent-approval
early return first (`:176-187`); compute one `now`; prune expired pending
entries with the gate's own pure operation (`pruneExpiredPending`,
`access/gate.ts:108-121`); then select the same-sender winner through the
gate's expiry-aware lookup (`findExistingPendingByKey`, `:129-147`) —
deleting my round-1 divergent `Object.entries(...).find(...)` copy — and
merge the sent token/card: resend bump for a live winner, fresh entry
otherwise, unrelated senders untouched. Preserved unchanged: send-before-save
(`gate()` commits nothing for `pair`, `:132-137`), retry after failed send,
TTL refresh, approval/concurrent merging, and slot-cap counting of live
entries only. Comparison conclusion: prune-at-commit is the same transaction
and the same two reused pure helpers; lookup-only is strictly weaker.

## G. Point 6 — final coverage accounts for every surviving obligation

**Withdrawn (A6): my round-1 "accepted gap" self-disposition and
named-contracts-only scope are withdrawn.** No seat may accept a coverage gap;
that is an operator decision I am not permitted to invent.

**Revised position:** the deleted-tests ledger is the obligation list. Every
surviving obligation gets exactly one named disposition — restored as a
behavioral case under a current owner; covered by a named surviving
assertion; or **superseded by a named already-accepted decision** (an
existing ruling/record, cited) — with mixed files mapped assertion by
assertion. Structure-asserting cases (source-text/path/export-name pinning)
stay deleted under Stage 9's own scope and are recorded as assertion-type
retirements, not gaps. Anything unrestorable is reported to the operator as
an incomplete acceptance item — never self-accepted. codex-ultra's coverage
family inventory (its §6 table over the ledger's line ranges) is the right
accounting model and is adopted as the working checklist.

**#63 evidence.** `codex --version` reports `codex-cli 0.159.0`
(source-audit) — installed, and past the 0.137+ gate. Availability is not
evidence. The restored gate must follow
`.agents/domains/non-blocking-dispatcher-inbound.md:111-137` and the ledger's
pinned contract (`deleted-tests.md` standing entry): a real app-server spawn,
a Dispatcher turn blocked mid-turn, a second Feishu inbound injected in that
window, and the observation that it reaches `turn/start` and **folds into the
same native turn** before the first completes, with no automatic inbound
reaction. The deterministic suite may cover the same path through a
controlled runtime but cannot replace the live run; `DREAMUX_SKIP_LIVE_CODEX=1`
is never cited as #63 coverage. Real Feishu platform delivery remains an
unavailable external system — reported as not verified, per the requirement's
own evidence classes, not as passed and not as an accepted gap.

## H. Convergences and remaining material disagreements

**Converged (all three, source-confirmed):**

- Outcome 1 shape: stop permanently rooting historical stores; transient
  reads with a post-read owner re-check; explicit acquire-and-load handle;
  captured-store handle writes; release at the owning paths with a
  retire-only predicate (non-closed and `cleanup-pending` stay
  memory-authoritative). All three first rounds got the release trigger
  wrong in different ways (mine: evict after a moved `closed`; DeepSeek: the
  retiring write; codex-ultra: holder counts without first naming the drain
  option) and the audit's overlap paragraph is the shared correction.
- Outcomes 2, 3, 4, 8: identical scope in all three (bus implements the
  narrow producer; two Claude fields; dry-run predicts from the same
  invocation's owned removals; the same documentation owners).
- Outcome 5: package entry/export boundary — default provider factory,
  named plugin factories, builtin catalog export descriptors; throwaway
  contribute host rejected; no migration; bare official plugin refs already
  invalid with always-loading.
- Outcome 6: prune-at-commit plus live-winner selection in the existing
  transaction; send-before-save and concurrent approval preserved.
- Outcome 7: carry `plan.matched` as an additive `servingTarget`; release
  matches visible or serving; claim/fence stay visible; silent committed
  removals retire presentation without announcing.
- Outcome 9: full ledger accounting with named dispositions and real,
  executed #63 evidence.

**Remaining material disagreements (one):**

1. *Retention mechanism (codex-ultra vs me + DeepSeek).* codex-ultra adds a
   holder count and pre-await operation holds at admission points; DeepSeek
   and I use the existing queue's `drain()` as the release gate plus the
   captured-store handoff and retire-only delete. Both close the audit's
   queue-overlap schedule; the drain variant removes nothing and adds no
   per-operation discipline, while the count variant would also cover a
   hypothetical future writer that enqueues outside the status guard. No
   such writer exists in current source (`updateRecord`'s callers are
   `startCreated`, `abandonCreated`, `runDissolve`, `submitInput` — the
   first three inside paths release awaits, the fourth status-guarded). If
   implementation review finds a writer that escapes both the guard and the
   owner path, adopt the operation hold at that point rather than weakening
   the predicate — recorded as the one open technical judgment, not a
   product question.

## I. Revised consolidated position

| Outcome | Round 1 | Round 2 (authoritative) |
| --- | --- | --- |
| 1 | move `closeFromRecord` after settle; release at `evict` + untracked construction | **withdraw both**; `closed` unchanged; `acquire()` loads before handoff; handle writes through captured store; `release()` = `await drain()` + synchronous retire-only delete (absent or `closed` + non-pending); release at end of `runDissolve`/`abandonCreated`, untracked construction settlement, recovery `finally` |
| 2 | unchanged | unchanged |
| 3 | unchanged | unchanged |
| 4 | unchanged | unchanged |
| 5 | default = provider factory, named plugin exports, builtin catalog export names | unchanged; source-confirmed (bare plugin refs already fail today; throwaway host rejected) |
| 6 | expiry-aware lookup only; pruning deferred | **upgraded**: prune-at-commit (`pruneExpiredPending`) + live-winner lookup, one `now`, approval skip first |
| 7 | re-resolution at release via surviving-topic list | **withdrawn**; additive `servingTarget` from `plan.matched` at the single submitter threading point; release matches visible or serving; silent committed removals release without notice |
| 8 | unchanged | unchanged |
| 9 | named locked contracts + self-accepted gaps | **withdrawn scope**; every surviving ledger obligation gets a named disposition; no self-accepted gaps; #63 restored and run live (Codex 0.159.0 present; availability ≠ evidence) |

No blocker remains for one developer. The single open technical judgment is
H1 (drain-then-delete vs holder counts); the drain variant is the revised
position, with the operation hold named as the fallback only if an
escaping writer is found during implementation review.
