# Code organization audit

> **Status of this artifact.** This is the read-only survey the task started
> from, kept as evidence: 14 slice surveys of the whole repository, every
> finding checked by an adversarial verifier, concluded by a final judge. It
> was produced on 2026-09-24 on the `feat/plugin-system-mvp` branch of
> [PR #453](https://github.com/excitedjs/dreamux/pull/453); file and line
> references point at that tree. Commit references are given as pull requests.
>
> The operator answered most of its §9 questions the same day; the
> requirement lists the rest as open items. The
> [rulings ledger](../rulings.md) decides wherever it and this report differ,
> and the [requirement](../requirement.md) states the amended target. In
> particular:
>
> - §6.1 and §6.3: there is no `team-entity/` kernel and no separate entity
>   layer; `service/agent/` and `service/team/` are one directory per aggregate
>   (R7). The `agent-service` rename is R6.
> - §6.3 lifecycle: closing is self-contained per Agent and batched upward;
>   `dispatcher.start` and the reopen logic are deleted (R10, R11).
> - §2.1 "one text-level leak" (`base-prompt.ts`, "You are Codex") is not a
>   leak: that text sits in the replace slot only Codex reads, and it stays (R19).
> - §P12 last item (the bootstrap plugin re-deriving `.workspace`): bootstrap
>   is unchanged on this point; a Dispatcher cwd inside a repository is not
>   handled (R42).
> - §7: R1 adopts H2 (code-only counting) in place of H1's counting mode;
>   H1's rewrite of the cap's remedy text still applies. H3 is R5
>   (dependency-cruiser), H7 is R2, H8 is R3 (enabled), H9 is R4. H4, H5, H6,
>   H10, and H11 are still unruled proposals.
> - §8: the sequencing is amended in the requirement, which also folds in the
>   issue #448 storage solution (see the rulings).
> - The landing-place part of §9 item 26, with the reply-tool guard, is R41.

Branch `feat/plugin-system-mvp`, read-only. Input: 14 slice surveys, 281 raised findings, 278 kept after adversarial verification (3 refuted), 58 verifier-added items. I re-opened the files behind the load-bearing claims (the near-cap files, the lifecycle split in `dispatcher-service`, the `runtime-owner` callbacks, the `beginShutdown` chain, the `deduplicate` usage, the dead `getRuntimeConfig`, the source-text tests, the `no-sync-io-gate` fixture, and the operator's ruling on the cap). Every one of those checked out. Where a verifier corrected a proposal, the corrected version is what this report adopts; where two slices' proposals conflicted, §6 states the resolution.

---

## 1. Executive summary

- **The operator already ruled on the cap.** `.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md:38`: “不要搞什么机械拆分。700 行就是为了卡架构重构的。是不是有共性的模块可以拆出来？” The gate exists to force architecture work and is met by extracting *shared mechanics*, never by splitting one class across files. The code did the opposite in at least 35 places (§5).
- **The dominant carve-out shape is a single-importer sibling that takes the parent's private state as a bag or as callbacks.** `dispatcher-service/input-source-lifecycle.ts` owns the Dispatcher's own Agent and mutates the parent through `markStopped`/`markCleanupPending`; `teammate-service/runtime-owner.ts` writes the parent's `phase` through `markClosing`; `workflow-service/run-terminal.ts` takes four callbacks into `WorkflowRun`; `feishu-session-ops.ts` reads every session private through `SessionHandle`. These are not modules; they are one class in two files.
- **The cap kept firing because line count is dominated by style, not concepts:** ~180 conditional spreads that `tsconfig` does not require, validation repeated at 3–4 layers, comment prose restating one invariant in ten places (30–55 % comment share in several files, and the cap counts comments), 22 private `isRecord` copies, ~45 `errorMessage` copies, hand-rolled single-flight/serial-tail idioms next to the shared helpers, and two JSON-schema DSLs.
- **Twelve files sit at 648–700 lines** (`feishu-channel.ts` 700, `team-service/index.ts` 699, `teammate-collection/index.ts` 689, `workflow-service/run.ts` 687, codex `runtime.ts` 683, `feishu-session-ops.ts` 680, `teammate-service/index.ts` 672, `dispatcher-service/index.ts` 672, `config.ts` 666, `feishu-cot-adapter.ts` 665, `dreamux-types/agent-runtime.ts` 656, `platform/paths.ts` 648). The next feature on any of them forces another arbitrary cut.
- **Dependency direction is unenforced and already broken.** All 33 `packages/dreamux/src` directories form one strongly connected component; 19 directory pairs import each other; `platform/` imports `config/`, `state/` and `service/`; `command/` is both the kernel every domain imports and the wiring that imports every domain.
- **Whole mechanisms exist twice:** dispatcher teardown (stop vs failed-start rollback, already drifted), Team/agent history paging (already drifted on `grep.trim()`), the provider activity-read primitives (byte-identical across codex and claude-code), the runtime lifecycle shell, workspace placement, the managed-service install pipeline, Feishu's two platform adapters (`FeishuTransport` + `FeishuBot`).
- **Defensive code with no producer is widespread:** optional deps that production always supplies (with `?? noop` fallbacks that silently unfence work), catalogs validated three times, a write-only `getRuntimeConfig` global set at five entry points, an events collector mode only tests use, a `deadlineAt` mechanism no caller passes, a SQL-shaped `DispatcherStore` whose mutators nobody calls.
- **The Team domain has no kernel.** `team-collection/` and `team-service/` import each other across 21 edges because `TeamRecord`, `TeamStore`, errors and the summary have no neutral home; the TeamMate side already has one (`agent-entity/`).
- **`DispatcherService` is a god facade** with ~11 Team pass-throughs while TeamMate/Workflow/cron are ops objects; admission is applied in three styles and `admit` names three different gates.
- **The harness pins the carve-outs in place:** at least 7 tests read source text and assert file paths, private-method bodies and importer lists, so a correct move looks like a test regression under the "don't weaken load-bearing tests" rule.
- **Naming lies to readers:** `TeammateService` serves the Dispatcher Agent and TeamLeaders; `input-source-lifecycle` owns the Agent; "route" means four things in feishu-channel; providers call the runtime id `dispatcherId`.
- **Headline recommendation:** treat this as a *deletion-led* refactor in six stages (§8): (0) classify the source-text tests and install a warn-mode direction/cycle gate; (1) delete dead and defensive mechanisms; (2) fix leaf layering (`platform/`, `command/`, `state/`, worktree types, a `team-entity` kernel); (3) reshape each service domain onto one template with real owners; (4) unify the caller-facing adapters; (5) providers and Feishu; (6) flip the gate to error and burn the exception list. Keep the 700-physical-line cap as the operator set it, change what its docs tell agents to do, and add the structural gates that catch the carve-out shape itself.
- **Roughly 45 operator decisions are queued in §9.** The largest are: cap semantics (comments counted or not), a formatter gate, deleting the text-mirror tests, the `Teammate*`→`Agent*` rename, and a dozen small user-visible tightenings that a structural fix would otherwise change silently.

---

## 2. How the code is organized today

### 2.1 Package map

| Package | Role | Depends on |
|---|---|---|
| `packages/dreamux` | Core host: server, admin socket, CLI, onboarding, daemon, config, provider loading, `service/` | `dreamux-types`, `dreamux-utils`; providers only via dynamic `import()` in `registry/provider-loader.ts:254` and `plugin/loader.ts:307` |
| `packages/dreamux-types` | Provider/plugin contracts (declaration-only) | tapable types |
| `packages/dreamux-utils` | Neutral primitives (operator ruling: depends on nothing) | — |
| `packages/agent-runtime/{codex,claude-code}` | AgentRuntimeProvider implementations | types, utils |
| `packages/channel/feishu-transport` | Lark SDK adapter | Lark SDK, marked |
| `packages/channel/feishu-channel` | ChannelProvider, extension API | types, utils, feishu-transport |
| `packages/plugins/bootstrap` | Workspace-profile plugin | types |

Package-level direction is clean and enforced (`eslint-config` provider bans, `tests/package-boundary-guards.test.ts`). One text-level leak: `service/dispatcher-service/base-prompt.ts:2` says "You are Codex" in the runtime-neutral `replace` slot.

### 2.2 `packages/dreamux/src` layers as they should be, and the edges that break them

Intended order (inferred from `service/CLAUDE.md`, `.agents/domains/service-topology.md`): `platform` < `command` kernel / `config` / `registry` / catalogs < entity kernels (`agent-entity`, `worktree`, `mcp`, `completion-router`, `dispatcher-core-events`) < entity services (`teammate-service`, `workflow-service`, `scheduler`) < collections (`teammate-collection`, `team-collection`, `team-service`) < aggregate (`dispatcher-service`, `channel-service`) < process (`dispatchers`, `server.ts`, `admin`, `cli`, `onboard`, `daemon`).

Measured reality: 53 upward edges; one SCC of 33 nodes. Named inversions:
- `platform/paths.ts:46-51` → `config/config.ts` (for a global nobody reads) and `state/dispatcher-id.ts`; `platform/json-document-store.ts:6` → `service/legacy-state.ts`.
- `command/catalog.ts:9-16` → every `service/*/commands.ts`; `command/host.ts:10-18` → `DispatcherService`, `dispatchers/errors`, `mcp/leases`.
- `channel/conversation-projection.ts:13-14` → `service/dispatcher-core-events`, `service/agent-entity`.
- `worktree/{manager,workspaces,repo-request}.ts` → `teammate-collection/types.ts` (its own request/result types).
- `team-collection/mcp-delegate.ts:59`, `teammate-collection/mcp-delegate.ts:36-37` → `dispatcher-service` (5-file type cycle with `dispatcher-service/mcp-delegates.ts`).
- `team-collection` ↔ `team-service` (14 + 7 import statements).
- `daemon/restart-intent.ts` is imported by four service files (core → operator surface).

### 2.3 The per-domain template as it actually exists in `service/`

| Domain | Owning class file | Readers | Projections | Errors | MCP tools | Notes |
|---|---|---|---|---|---|---|
| `teammate-collection` | `index.ts` | `agent-entity/{read-helpers,history-query}.ts` | `agent-entity/read-helpers.ts` | `errors.ts` | `mcp-delegate.ts` + carved `mcp-tool-descriptors.ts` (also hosts workflow_* tools) | `types.ts` also owns worktree contracts |
| `teammate-service` | `index.ts` | `submission.ts` | `turn-recording.ts` | — | — | `runtime-owner`, `turn-coordinator`, `factory` are carve-outs |
| `team-collection` | `index.ts` (facade) + `runtime-registry.ts` (the real collection) | `types.ts` | `read-model.ts` / `team-service/team-summary.ts` | `errors.ts` (holds team-service's dissolve errors) | `mcp-delegate.ts` (inline descriptors) | own `read-helpers.ts` copy of paging |
| `team-service` | `index.ts` | — | `types.ts` (holds Command output schema used by `dispatcher.submit`) | none | — | `closing`, `collaborators`, `initial-prompt`, `leader-agent` |
| `workflow-service` | `index.ts` | `types.ts` | `types.ts` | `errors.ts` | in `teammate-collection` | `run-terminal`, `run-support`, `agent-policy`, `json-args` |
| `scheduler` | `service.ts` (no index) | `types.ts` | `store.ts` | `errors.ts` | `mcp-delegate.ts` | `.commands` facade re-wrapped by Team |
| `dispatcher-service` | `index.ts` (composition root + Team facade + stop) | — | `runtime-status.ts` | — | `mcp-delegates.ts` | 15 satellites, most single-importer |
| `channel-service` | `index.ts` | — | `types.ts` (7 lines) | — | `mcp-delegate.ts` + `mcp-delegates.ts` | initialize/start/ports live in the dispatcher lifecycle |
| `worktree` | `manager.ts` (no index) | `repo-request.ts` | — | — | — | contract types live upstairs |

Consistent: every domain has a `commands.ts`; Team/TeamMate/cron/Channel each have an MCP delegate; `agent-entity/` is a real kernel for the TeamMate side. Inconsistent: where readers/projections/errors live, which file holds the owning class, whether the MCP catalog is inline or carved, whether the aggregate exposes a domain as methods or as an ops object, and which domains have a kernel (Team has none).

### 2.4 Process shell and providers (short)

- `server.ts` + `cli/server.ts` split the serve lifecycle; `cli/server-ctl.ts` is a second admin-socket client and argv parser reached via a child `node`; the managed service (launchd/systemd) is spread over `onboard/service.ts`, `onboard/service-node.ts`, `daemon/*`, `cli/service-status-parse.ts`, and a 212-line PATH policy in `platform/paths.ts`.
- `config/config.ts` is both the contract (31 importers) and the provider/plugin loader; `config-helpers.ts` is its single-importer overflow.
- Provider resolution is re-solved five times because `registry.ts:79` stores untyped implementations and pre-registers builtin descriptors without implementations.
- codex and claude-code share a parallel layout with byte-identical `activity/{error,budget}.ts`, near-identical `opened-file.ts`/`cursor.ts`, and a hand-copied lifecycle shell around `RuntimeStateFence`.
- feishu-channel is a flat `feishu-*` namespace (38 of 46 files) with a 700-line session class carved into `feishu-session-{ops,inbound,routes}`, `feishu-notification`, `feishu-route-reconciliation`, and a `feishu-gate` ↔ `feishu-gate-io` re-export cycle.

---

## 3. Root causes: why files hit the wall, and what the cap produced

### 3.1 Style and abstraction patterns that inflate line count without adding concepts

1. **Conditional-spread boilerplate.** No package sets `exactOptionalPropertyTypes`, so `...(x !== undefined ? { x } : {})` is a no-op for optional properties. Counts: `dreamux/src` 103–104, feishu-channel 44, codex 17, claude-code 15. Codex `provider.ts:135-177` is 42 lines of them; `team-collection/runtime-registry.ts:448-477` (`depsBase`) and `teammate-collection/index.ts:520-550` likewise. Each costs ~3 lines at exactly the files nearest the cap.
2. **Deps bags re-spelled per layer.** The same per-dispatcher facts (config, providers, worktrees, admissions, conversationProjection, coreEvents, logs) are declared in `TeamCollectionOptions` (18 fields), `TeamServiceDeps` (18), `TeammateCollectionOptions`, `TeammateServiceDeps`, `TeamLeaderAgentDeps`, `DispatcherAgentDeps`, `DispatcherInputSourceLifecycleOptions` (21), and forwarded at ~100 `x: this.opts.x` lines. `Dispatchers` copies 12 option fields into private fields and re-spreads them (`dispatchers/index.ts:51-88, 179-198`).
3. **Validation repeated at every layer.** Close note checked 4× on one path (`teammate-collection/commands.ts:213,221` → `teammate-collection/index.ts:251` → `teammate-service/index.ts:445`); run_id 4×; Team id 6× in one `open()`; validate-and-discard readers (`agent-entity/history-query.ts:40-45`); MCP catalog validated 3× (`mcp/leases.ts`, `mcp/catalog.ts`, `mcp/shim.ts`).
4. **Comment prose that restates invariants and narrates history.** `team-service/closing.ts` 41 % comments, `service/mcp/types.ts` 78 %, `mcp/leases.ts` 53 %, `platform/paths.ts` 45 %, `dreamux-types/agent-runtime.ts` 56 %. The "closed record / only proof" invariant is restated in ≥10 docstrings; "Core used to…" narration in ≥12 feishu files; review-round citations (`admin/socket.ts:42,81,107`). The cap counts comments (`eslint-config/index.js:211`), so prose competes with code for the budget — and whitepaper §6 rightly bans trimming it to duck the gate, which leaves splitting as the only remaining move.
5. **Micro-helpers copied per file.** `isRecord`/`asRecord`/`isPlainObject` ×22 across packages (three different semantics); `errorMessage` defined in `platform/errors.ts:159` and `platform/error-info.ts:6` plus ~8 more copies and ~35 inline ternaries; the promise-tail serializer hand-written in `runtime-state.ts`, `workflow-service/run.ts` (twice), `journal.ts`, `scheduler/store.ts`, `completion-router`, feishu `routing/store.ts`, `lib/mutex.ts`; the single-flight "nullable promise + `.finally` reset" idiom ×6 while `@deduplicate`'s `'active'` mode has zero users.
6. **Two vocabularies for one contract.** `command/schema.ts` and `service/mcp/tool-metadata.ts` both define `arrayOf`/object builders; every MCP delegate copies a positional `tool()` wrapper (3×) and spells each tool name twice (descriptor list + `switch` with an "unreachable" default); the repo schema exists twice and has drifted (`worktree/repo-request.ts:30-40` has `slug`, `tool-metadata.ts:143-191` has bounds and no `slug`); the submission-status enum is spelled 5×.
7. **Command scaffolding.** `parse(payload) { commandPayload(payload); }` ×18; `as unknown as readonly AnyCoreCommand[]` in 7 modules; "no input" expressed two ways.
8. **Dead mechanisms carried in full.** `platform/paths.ts:65-83` runtime-config global (5 writers, 0 readers); `state/dispatcher-store.ts` create/upsert/remove (0 callers); codex `events.ts` one-shot mode (`awaitTurn`, `runTurn`, `acceptAnyThread`, `onTrace`) with the `releaseTurn` protocol it forces on `TurnManager`; `worktree/manager.ts` assessment deadline (~70 lines, no caller passes `deadlineAt`); `KeyedAsyncQueue.runBefore` (43 of 70 lines, 0 callers); codex `assessCleanup` `testHooks` threaded through 13 spreads, no test passes them.

### 3.2 What the cap actually produced

- **Single-importer siblings with a parent-private input bag** (the house pattern): `input-source-start-rollback.ts` (10 collaborators), `dissolve-members.ts` (`{teamId, note, held, roster, store}`), `runtime-status.ts`, `team-runtime-stop.ts`, `runtime-helpers.ts`, `teammate-ops.ts`, `initial-prompt.ts`, `collaborators.ts`, `run-support.ts`, codex `runtime-support.ts`, claude `runtime-session.ts`, feishu `SessionHandle`.
- **Callbacks that mutate the parent's state machine**: `runtime-owner.ts:288 markClosing()` sets `TeammateService.phase`; `closing.ts` closure sets `TeamService.leader_ = null`; `run-terminal.ts` `closeAdmission/finalize` re-enter `WorkflowRun`; `input-source-lifecycle` ↔ `DispatcherService` cross-call through `isUnavailable()`, `markStopped()`, `markCleanupPending()`.
- **Type-only back-imports and cycles** hidden by erasure: `mcp-tool-descriptors.ts:29` ← `mcp-delegate.ts:55`; `doctor-plugins.ts:15` ← `doctor.ts`; `feishu-session-ops.ts:40` ← `feishu-channel.ts`; `admin/socket.ts:20` ← `server.ts`.
- **Re-export shims to preserve import paths after a split**: `feishu-gate.ts:584-591`, `loadDispatcherAccess` alias, `config.ts:45` re-exporting `expandHome`, `onboard/service.ts:37-49` re-exporting `service-node.ts`.
- **Squeezed lines**: `team-service/index.ts:681` (213-char JSDoc), `:688`; `doctor.ts:288` (5-line push folded to 1 in the PR #453 plugin commit); `workflow-service/run.ts:45-46,69-70,148,508` (exactly 700 lines at the oldest commit of the audited clone's shallow history; #391 brought it to 687).
- **Structure tests that freeze the layout**: `collection-ownership.test.ts`, `completion-delivery.test.ts`, `team-dissolve-contract.test.ts:163-200`, `core-event-catalog.test.ts:555-590,840-857`, `channel-service.test.ts:440-458`, `mcp-delegate-catalog.test.ts:305-320`, `workflow-service.test.ts:372-387,711-733`, `legacy-state-fail-loud.test.ts:505-523`, plus export-name pins in `package-boundary-guards.test.ts` and `feishu-channel/tests/public-api.test.ts`, `dreamux-utils/tests/index-exports.test.ts`, `dreamux-types/tests/root-export-surface.test.ts`.
- **Whole responsibilities left in the wrong owner because the owner was full**: Channel session initialize/start/ports in the dispatcher lifecycle instead of `ChannelService`; workflow_* MCP tools in `teammate-collection`; the Dispatcher Agent held by "input sources"; Team `stopSchedulers` via a registry-held handle while workflows use 3 verbs × 4 hops.

---

## 4. Pattern catalog

Severity is the highest instance severity. "Fix principle" is what every instance follows; per-instance homes are in the slice data and §6.

### P1. Cap carve-out: one owner cut across files (high)
**Definition.** A sibling file whose only importer is its parent, whose inputs are the parent's private fields (bag or callbacks), or which back-imports the parent. **Why bad.** Adds a name without a responsibility; the invariant is now read across files; the parent stays at the cap. Direct violation of the operator's ruling above and whitepaper §6.
**Instances.** `dispatcher-service/{input-source-start-rollback,team-runtime-stop,runtime-helpers,teammate-ops,runtime-status,restart-notice,identity,inbound-task-drain,dispatcher-workflows}.ts`; `teammate-service/{runtime-owner (leaked lifecycle half),turn-coordinator,turn-recording,factory}.ts`; `teammate-collection/{dissolve-members,mcp-tool-descriptors}.ts`; `team-collection/{runtime-registry,read-helpers,roster-reader,worktree-cleanup}.ts`; `team-service/{initial-prompt,collaborators,leader-agent (6 fns/3 deps types)}.ts`; `workflow-service/{run-terminal,run-support,agent-policy}.ts`; `config/config-helpers.ts`; `cli/service-status-parse.ts`; feishu `feishu-session-{ops,inbound,routes}.ts`, `feishu-notification.ts`, `feishu-route-reconciliation.ts`, `feishu-gate-io.ts`, `feishu-cot-{activity,outbox}.ts`, `feishu-inbound-anchor.ts`; transport `doc-comment.ts` (cut along one method, leaving `fetchDocMeta`/`resolveWikiNode` behind); codex `runtime-support.ts` (created by #432 when `runtime.ts` was 699), `skill-roots.ts`, `approval.ts`; claude `runtime-session.ts`.
**Fix principle.** Either the sibling owns named state/an invariant/an external contract and takes it by value (then keep and fix the seam), or it folds back into its owner once the deletions in P3/P4/P9 make room. Never a third option.

### P2. Function-valued deps and re-spelled deps bags (high)
**Definition.** Closures passed down to reach back up, or the same dependency list declared at every layer. **Why bad.** Whitepaper §6: "function-valued deps are usually a reverse dependency in disguise"; each new fact is edited in 4–6 interfaces.
**Instances.** `TeammateRuntimeOwnerCallbacks {isActive, markClosing}`; `EntityTurnCoordinator` `{identity,isActive,owesCompletion}`; `TeamClosingDeps` `{record,commit,leader,closeLeaderForDissolve}` + `abandonCreation` closures; `WorkflowRunTerminalDeps`; `DispatcherInputSourceLifecycleOptions.{isUnavailable,restartIntent,agentMcp}`; `RestartIntentConsumer` setter chain (`server.ts:249` → `Dispatchers.setRestartIntent` → `DispatcherService.setRestartIntent` → closure); `TeamRuntimeRegistry` `mustTeam`; `TeamStore.roster` callback; `CotActivitySink`; feishu session's ~22 lambdas (`feishu-channel.ts:140-433`) and the 16-member `FeishuToolSession`; `FeishuDocumentComments` four one-method bot forwarders; codex `resolveExtraArgs: () => runtimeArgs`, `getThreadId()`; the six deps bags listed in §3.1(2); `SuffixGenerator` threaded through four option types.
**Fix principle.** Pass collaborators as values; derive facts from what the callee already holds; a value known before construction is a constructor argument, not a setter. One per-dispatcher infrastructure type only after the always-supplied deps become required (P3), placed above `worktree`/`completion-router`/`core-events` and below `teammate-service` to avoid a new loop.

### P3. Defense without a named scenario (high)
**Definition.** Optionality, fallbacks, re-checks, caps or guards that no producer reaches. **Why bad.** CLAUDE.md: "Defensive code found in review is deleted, not corrected." Each branch is a state readers must disprove; optional gates that default to no-op silently unfence work.
**Instances.** Always-supplied deps declared optional (`TeamCollectionOptions.admitOperation?` with `?? (task)=>task()` at `runtime-registry.ts:464`, `coreEvents?`, `conversationProjection?`, `workflowLog?`; `AgentRuntimeCreateContext.{activity?,logger?}`, `ChannelSessionCreateContext.{logger?,state_root?,cache_root?}`, `DreamuxLogger.child?`, `FeishuBot` optional members, transport `FeishuMessageReader`); console-fallback loggers ×4 across providers and feishu; identity scope asserted at three layers (`runtime-profile.ts`, `runtime-owner.ts:78`, `teammate-collection/index.ts:582`); config entry re-looked-up 6× with 6 missing-entry policies; `seal.ts` runtime kind/version checks on compile-time-typed events; catalog/envelope validated 3×; `McpDelegateIdentity` derivable from the name yet validated 3×; `json-args.ts` re-implementing `platform/json-value`; `RESERVED_AGENT_NAME_SEGMENTS` (unreachable: every allocated name ends in `-<suffix>`); `producerCompletions` Map that grows per spawned name; codex `TurnManager` thread-change re-subscription (only a fabricated test reaches it), `terminalFingerprints` sha256 conflict detection (can turn a benign double report into failing every submission), admission sets sized for concurrency the decision queue forbids; claude `git worktree list` + wyhash discovery that only reorders candidates; `DispatcherTaskDrain.run` + `assertNotShuttingDown` double gate; `TeamCollection.open` re-reading `record.json` for a Team it holds live; `hasSources?.()`; `dispatcherId` mismatch branch in the core-event bus; `terminalLogged`, `deliverTerminal = null`; WorkflowRun's `failAfterNotification` path for a `turn.settled` rejection that cannot happen.
**Fix principle.** Make required what production always supplies (tests build real or no-op values through helpers); delete the second fence downstream of a constrained input; name a scenario or delete the guard. Every user-visible change in this class (e.g. refusal codes, doctor rows) goes to §9.

### P4. Duplicated mechanism (high)
**Definition.** One mechanism implemented twice with independent drift. **Why bad.** A fix must be repeated at every entry point; the copies already disagree.
**Instances.** Dispatcher teardown sweep ×4 (`dispatcher-service/index.ts:368-413`, `input-source-start-rollback.ts:43-75`; rollback lacks `drainCreatedHooks`); "stop every held member" ×5 with two definitions of "held"; history paging (`agent-entity/read-helpers.ts` vs `team-collection/read-helpers.ts`, `grep.trim()` drift); workspace placement (`worktree/workspaces.ts:17-66` vs `team-collection/runtime-registry.ts:153-176` + 4 adapter copies of `repo.cwd ?? dispatcher.workspace()`); legacy cron-store walk (`server.ts:403-423` vs `cli/doctor.ts:162-186`); managed-service install pipeline (`onboard/run.ts` vs `daemon/install.ts`, verbatim comment at `run.ts:150`/`install.ts:130`, dry-run already diverged); launch validation (`onboard/service.ts:234-272` vs `doctor.ts:461-581`); admin socket client (`cli/server-ctl.ts:105-157` vs `admin/client.ts`, still emitting advice `CHANGELOG.md:44` says was removed); provider lifecycle shell (codex/claude `runtime.ts`, six verbatim comment paragraphs); provider activity read (`error.ts`, `budget.ts`, `opened-file.ts`, `cursor.ts` framing); env merge ×4; `FeishuTransport` vs `FeishuBot` (~20 forwarders); three address types for one target; chat-submission envelope built by hand twice (test header admits it); card-action key read 3×; six Feishu response/JSON-shape conventions; `errorMessage`/`isRecord`/atomic write/`pathExists` copies; worktree identity parsed twice with different rules; cleanup-state vocabulary ×4; path-segment regex ×4; `TeamListRow`/`TeamHistoryRow` hand-maintained; `teamSubmitResult` schema in two DSLs.
**Fix principle.** One owner, both copies deleted in the same change (never a third layer over two survivors). Where the copies differ by policy, the change names which policy wins.

### P5. Layering inversion and cycles (high)
**Instances.** `platform/paths.ts:46-51`, `platform/json-document-store.ts:6`; `command/{catalog,host}.ts`; `channel/conversation-projection.ts`; `worktree/*` → `teammate-collection/types.ts`; the 5-file MCP delegate ring; `team-collection` ↔ `team-service`; `teammate-collection` ↔ `workflow-service`; `admin/socket.ts` ↔ `server.ts`; `onboard/types.ts` ↔ `provider-diagnostics.ts`; `cli/doctor.ts` ↔ `doctor-plugins.ts`; `team-collection/types.ts` ↔ `read-helpers.ts` (the only value-level cycle); `daemon/restart-intent.ts` imported by core; `agent-entity/{read-helpers,history-query,activity-errors}.ts` → `command/`; `dreamux-utils/config-validate.ts` carrying core config-schema migration text; `feishu-gate` ↔ `feishu-gate-io`; `feishu-message` ↔ `feishu-message-render`; `feishu-slash-commands` ↔ `feishu-submit`; `dreamux-types` publishing core-private `CoreCommand*`/`ProviderRef`/`RegisteredProvider`.
**Fix principle.** Declare the layer order once, make the bottom layer a real leaf, move composition roots to the top, and give every shared type to the lowest layer that needs it. Then gate it (§7).

### P6. Dumping-ground modules (medium)
**Instances.** `agent-entity/types.ts` (persisted schema + TeamMate DTOs + generic validators + dead `CreateTeamLeaderInput`), `agent-entity/read-helpers.ts` (4 concerns), `team-collection/types.ts` (deps bag + persisted schema + DTOs + payload parsers), `team-service/types.ts`, `teammate-collection/types.ts` (worktree contracts), `teammate-service/turn-recording.ts`, `workflow-service/run-support.ts`, `service/mcp/projection.ts` (3 functions, 3 consumer sets), `service/` root (12 files mixing primitives and policy), `platform/paths.ts` (PATH policy, skill catalog, workflow-id rule), `config/config.ts` (contract + loader), `onboard/types.ts` (host-wide `CommandRunner`), codex `activity/path.ts` (5 concerns), `dreamux-types/agent-runtime.ts` (4 domains).
**Fix principle.** `types.ts` holds types only and imports nothing from `command/`; readers/projections go to a per-domain `requests.ts`; primitives go to `platform/` or `dreamux-utils`; policy goes to its owner.

### P7. Two vocabularies for one contract (medium)
**Instances.** The two schema DSLs; Command vs MCP validation drift (`teammate.spawn` accepts `""` prompt via `mustString`, MCP requires non-empty; `intent !== ''` guard in the entity absorbs it); `FeishuTarget`/`ChannelOutboundTarget`/transport `OutboundTarget`; `containerChatId` threaded through 4 interfaces though derivable; four Core-answer trust styles in feishu (typeof chain, 3 blind casts); alias triples in `dreamux-types` (`ProviderBinCheck`/`AgentRuntimeBinCheck`/`ChannelBinCheck` …); three config `read` signatures; `runtime_id` meaning dispatcher id in one call and agent id in the other; `admit` naming three gates; `validateTeamMateName = validateAgentEntityName`; `loadDispatcherAccess` alias; `command/errors.ts` re-exporting `platform/errors` (12 vs 16 import paths).
**Fix principle.** One builder module, one declared shape per operation, one name per concept; delete the alias in the same change as the last importer.

### P8. Dead or legacy surface (medium)
**Instances.** Beyond §3.1(8): provider barrels (~50 codex, ~39 claude names, 37 feishu-channel runtime exports) with one production consumer (default export); `./config` subpaths; `dispatcherCodexConfig`/`dispatcherClaudeCodeConfig`; duplicate `BUILTIN_*_PROVIDER_REF`; `provider-ref.ts` ×3; transport `createGroup`/`inviteMembers`, `FEISHU_TRANSPORT_PACKAGE`, `webSocketRegistration`; `service/index.ts` facade (imports through it: 2 of 12); `DispatcherService.summary`, `prepareChannels`, `TeamLeaderHandle` re-export; `TeamCollection.allocateName`; `last(name, number)` overload; `Turn.delivery`/`AgentCall.turn`; `InboundDeliveryResult`; `TeamClosedFact` fields; `TeamSchedulerLifecycle`/`TeamServiceCreateOutput<T>`; group pairing kind branches; `PendingPairingEntry.replies`, `ttl_left_ms`; cron `action.intent` unread by firing; `turn_timeout_ms` accepted-and-ignored in codex; `HOST_INJECT_ENV = {}`; `command_lifecycle`/`commandUuids`/`isSynthetic` (test-only); `CodexOutputSchemaCodec.fingerprint`; handshake version `'0.1.0'`.
**Fix principle.** Delete; where a name is published, an ordinary change note. Add an unused-export gate so it stops regrowing (§7).

### P9. Verbose style (medium)
Instances in §3.1(1,4,7) plus mixed indentation in `config.ts`, `doctor.ts:71`, double quotes in `agent-entity/types.ts`, no semicolons in feishu-transport. **Fix principle.** Formatter (operator decision), plain `field: value` for internal objects (keep conditional spreads only where key presence is observable or where the literal spreads over an existing object), one statement of each invariant in `service/CLAUDE.md`, history to `.agents` records — and never as a way under the gate.

### P10. Harness gaps (high)
Only structural gate: `max-lines 700` (`eslint-config/index.js:209-212`, comments counted; semantics locked by `tests/no-sync-io-gate.test.ts:54-61`). No direction rule, no cycle rule, no unused-export check, no formatter, no filename convention; `.agents/scripts/check.sh` validates only `.agents/domains` paths (so `service/CLAUDE.md` lists a non-existent `delivery-result.ts`, and `Server.admitAdminRequest()` is cited in two KB files). Import direction is checked only by hand-written source-grep tests for named pairs. See §7.

### P11. Naming (medium)
`TeammateService`/`teammate-service/` serve all three roles (17 error strings say "TeamMate" for the Dispatcher Agent and leaders; `.tm.` runtime-id segment); `DispatcherInputSourceLifecycle` owns the Agent; `FeishuTargetRouter` does not route; `routing/index.ts` is a class file; "route" ×4 meanings; `mcp-delegate.ts`/`mcp-delegates.ts` twice; `feishu-message.ts` is 85 % attachments; `state/` persists nothing; `Rollout` (Codex noun) in Claude code; providers' `dispatcherId` for `identity.runtimeId`; `closeAdmission()` aborts every live workflow run; `require*(…, fallback)` that returns the fallback.

### P12. Misplaced responsibility (high)
Channel-session lifecycle split `ChannelService` ↔ dispatcher lifecycle (one map with two owners, three close loops, three provider resolutions); Dispatcher Agent with no owner (lifecycle holds it, `mustAgent` ×2, status projected 5 ways with vocabulary switching between `'ready'` and `'running'`); `team.state` assembled in 5 places with the store calling up for the roster; access/pairing state changes over 4 files with 3 read-lock rules and a mutex owned by a fifth; ask-user over 4 files; workflow MCP tools in the TeamMate collection; the managed service over 4 directories; worktree reclamation with three owners and two `TeamWorkstreeCleanup` instances; `Team` workspace loan as a per-call argument (forces wrappers in 3 layers + runtime checks); provider supervisors `mkdir -p` the launcher-owned cwd (silently runs an agent in an empty dir after a deleted worktree); bootstrap plugin re-deriving `.workspace` by magic string.

---

## 5. Cap-driven carve-out inventory

Legend for "Home": **Fold** = back into parent after the listed deletions make room; **Own** = keep as a real owner but fix the seam; **Move** = belongs to a different owner; **Del** = delete.

| File | Parent | Evidence | Proper home |
|---|---|---|---|
| `service/dispatcher-service/input-source-start-rollback.ts` | `input-source-lifecycle.ts` | sole importer; 10-collaborator bag; duplicates `doStop` sweep, already drifted | Del → one private `releaseRuntimes(failures)` on the lifecycle owner |
| `service/dispatcher-service/team-runtime-stop.ts` | `index.ts` | 22-line try/log wrapper; error logged twice | Del → `collectShutdownFailure(failures, () => teams.stopForHost())` |
| `service/dispatcher-service/runtime-helpers.ts` | lifecycle | 13 lines; duplicates `ChannelService.build` catch-close; swallows failures so rollback can never record them | Del → `ChannelService.closeAll()` |
| `service/dispatcher-service/teammate-ops.ts` | `index.ts` | 18-line proxy re-listing 8 verbs | Del → collections take `admit` at construction |
| `service/dispatcher-service/runtime-status.ts` | `index.ts` | 3 near-identical projections; `DispatcherService.summary` dead | Fold → one live status on the Agent owner; projection in `dispatchers/` |
| `service/dispatcher-service/restart-notice.ts`, `identity.ts` | lifecycle | single importer; `ensureDispatcherIdentity` passes the same cwd 3×; `dispatcherRootWorktreeIdentity` = `reuseCwdWorktree` | Fold into a `DispatcherAgent` owner in `agent.ts` |
| `service/dispatcher-service/inbound-task-drain.ts` | `index.ts` | second admission check beside `assertNotShuttingDown` | Fold into the lifecycle's admission gate |
| `service/dispatcher-service/dispatcher-workflows.ts` | `index.ts` | hides Team fan-out that schedulers do explicitly | Del → lifecycle fans out like schedulers |
| `service/dispatcher-service/runnable-channel.ts` | lifecycle | provider resolved 3× | Move → `ChannelService.assertRunnable()` at the same pre-side-effect point |
| `service/dispatcher-service/input-source-lifecycle.ts` | `index.ts` | 21-field bag + callbacks both ways; holds `agent_`; `started`/`cleanupPending` beside promises | **Own** → rename `DispatcherLifecycle`; take stop/rollback/agent; delete the setters |
| `service/dispatcher-service/team-leader-handle.ts` | `index.ts` | `finishOutsideLease` guards a lease that no longer exists (its test fabricates one); imported upward by `teammate-collection` | Del → narrow `TeamLeaderScope` type declared in `team-service` |
| `service/teammate-service/runtime-owner.ts` | `index.ts` | callbacks write parent `phase` (`:288`); durable reopen here, close in parent; `mustWorktrees` ×2; forwarders | **Own** as `RuntimeGeneration` (lease, mint, launch, stop); lifecycle pieces fold into the service |
| `service/teammate-service/turn-coordinator.ts` + `turn-recording.ts` | `index.ts` | `EntityTurn` split from its only constructor; grab-bag name; `admissionWithoutTurn` identity fn; `asError` ×3 | Fold → `turn.ts` + `admission.ts` |
| `service/teammate-service/factory.ts` | — | pure `new TeammateService(...)` forwarder; KB claims it composes | Replace with a per-dispatcher factory that owns the ledger |
| `service/teammate-collection/dissolve-members.ts` | `index.ts` | bag of 5 privates; path pinned by a source-text test | Fold |
| `service/teammate-collection/mcp-tool-descriptors.ts` | `mcp-delegate.ts` | header justifies the split; type back-import; hosts workflow schemas; 877 lines combined | Fold after workflow tools move + `tool()`/`name` schema dedupe |
| `service/team-collection/runtime-registry.ts` | `index.ts` | 7 pure forwarders left in parent; `mustTeam` callback; 847 combined; 4 parallel maps | Fold → one `TeamCollection` (after workspace/roster/scheduler-map deletions) |
| `service/team-collection/read-helpers.ts` | `types.ts`/`read-model.ts` | line-for-line copy of `agent-entity` paging; value cycle | Del → shared `platform/history-page.ts` |
| `service/team-collection/roster-reader.ts` | registry | exists only for a registration-timing gap the code does not have | Del (TeamService publishes `team.state`) |
| `service/team-collection/worktree-cleanup.ts` | both | stateless one-method class instantiated twice | Fold → private `settleClosedWorktree` on the collection |
| `service/team-collection/create-request.ts` | `index.ts` | also hosts `TEAM_LEADER_REQUIRED_SKILL_SOURCES` for `leader-agent` | Keep (bounds + hash); move the constant to `leader-agent.ts` |
| `service/team-service/initial-prompt.ts` | `index.ts` | carved in the PR #453 plugin commit; second leader-submission path bypassing `submitToLeader` | Fold into `createNew` via `submitToLeader` |
| `service/team-service/collaborators.ts` | `index.ts` | constructor body as free builders over the parent's bag; double Team fence on scheduled fires | Fold into the constructor; delete `buildTeamScheduler` |
| `service/team-service/leader-agent.ts` | `index.ts` | 6 free fns over 3 layered deps types; peer `dispatcher-service/agent.ts` is one fn | **Own** as one `createTeamLeaderAgent(identity, ctx)` |
| `service/team-service/closing.ts` | `index.ts` | 4 closures + 2 per `abandonCreation`; parent mutates `leader_` inside a callback | **Own** with data arguments (`dissolve(input, leader)`); keep `record()/commit()` only; do **not** add a leader-holder noun (already ruled against, whitepaper §3) |
| `service/team-service/completion-targets.ts` | `index.ts` | rebuilds the closure `submitToLeader` spells; `unsupportedCompletion` duplicated | Fold; one `unsupportedDelivery` in `completion-router` |
| `service/workflow-service/run-terminal.ts` | `run.ts` | 4 reverse callbacks; three spellings of one fact; `run.ts` was exactly 700 | Fold, in the same change as deleting the unreachable `failAfterNotification` path and moving per-run persistence into `journal.ts` (budget: ~745 otherwise) |
| `service/workflow-service/run-support.ts` | `run.ts` (+3 for `isRecord`) | 5 unrelated things | Del → `semaphore.ts` (real concept), `WorkflowPersistenceError` → `errors.ts`, `normalizeAgentOptions` → `protocol.ts`, `isRecord` → utils |
| `service/workflow-service/agent-policy.ts` | `run.ts` | 6 lines, one constant | Fold |
| `service/workflow-service/json-args.ts` | `index.ts` | re-implements `platform/json-value` for already-canonical args | Del |
| `service/agent-entity/activity-errors.ts` | `activity-reader.ts` | one mechanism split; 2 error classes + mapper every adapter must call | Fold |
| `service/agent-entity/history-query.ts` | — | Command reader in the neutral layer; only `teammate-collection` uses it | Move → `teammate-collection/requests.ts` |
| `service/mcp/{projection,identity-version,dispatch-reminders}.ts` | `leases.ts` / delegates | 3 functions with 3 consumers; one constant + history comment; domain text in the neutral dir | Del/fold to callers |
| `service/channel-service/{mcp-delegates,types}.ts` | `dispatcher-service/mcp-delegates.ts` | 3-hop chain; 7-line types file | Fold into `ChannelService.mcpDelegates()`/`list()` |
| `config/config-helpers.ts` | `config.ts` | single importer; two copies of utils helpers; alias; dead branch | Del (after `config.ts` loses dead init code and the loader) |
| `cli/service-status-parse.ts` | `doctor.ts` | parses what `onboard/service.ts` renders; back-imports `LAUNCHD_LABEL` | Move → `daemon/` unit module |
| `channel/feishu-channel/src/feishu-session-ops.ts` | `feishu-channel.ts` | self-declared cap carve-out; `SessionHandle` bag rebuilt per call; 6 responsibilities; type back-import | Del → `FeishuOutbound`, `FeishuAccess`, `FeishuAskUser`, card-action table |
| `…/feishu-session-inbound.ts` | routes → session | self-declared; 270-line `onMessage`; calls parent via `h.delivery` | Del → `inbound/` pipeline |
| `…/feishu-session-routes.ts`, `feishu-notification.ts` | `feishu-channel.ts` | carved in the PR #453 plugin commit when the file was 699 | Fold (route table inline in `start()`; retry into `FeishuOutbound`) |
| `…/feishu-route-reconciliation.ts` | `feishu-channel.ts` | one method; callback back into bindings | Fold into `FeishuBindingOperations.forgetTeam` |
| `…/feishu-gate-io.ts` | `feishu-gate.ts` | self-declared; re-export shim + alias; header claims content it lacks | Move → `access/` state module |
| `…/feishu-cot-activity.ts`, `feishu-cot-outbox.ts`, `feishu-inbound-anchor.ts` | `feishu-cot-adapter.ts` | `CotActivitySink` bag of the adapter's privates; outbox state/functions/byte-math in three files | `cot/{card,recipients,adapter}.ts` |
| `channel/feishu-transport/src/transport/doc-comment.ts` | `feishu.ts` | #431 cut one method to get under 700; second type table | Regroup → `transport/docs.ts` with `fetchDocMeta`/`resolveWikiNode` |
| `agent-runtime/codex/src/runtime-support.ts` | `runtime.ts` | #432 exiled `threadInstructionParams()` at 699 lines; prompt shaping split with `provider.ts` | → `system-prompt.ts` (one function, has its own test); env formula → `paths.ts` |
| `agent-runtime/codex/src/skill-roots.ts` | `runtime.ts` | free fn wrapped by a private forwarder; silent skill-blind fallback contradicts a recorded requirement | Fold into bootstrap as a typed protocol call; delete the fallback |
| `agent-runtime/codex/src/approval.ts` | `runtime.ts` | second fail-fast handler; substring classifier for message text only | Del → inline handler in the runtime |
| `agent-runtime/claude-code/src/runtime-session.ts` | `runtime.ts`/`rpc.ts` | 3 helpers, 3 consumers; leftover of a prior move | Del → `stream.ts`/`rpc.ts`/`paths.ts` |
| `agent-runtime/codex/src/activity/{error,budget}.ts`, claude equivalents | — | byte-identical across providers | Del → `dreamux-utils/activity-scan.ts` |

**Looks suspicious but is legitimately separate (one line each):**
- `workflow-service/runner.ts`, `runner-process.ts`, `script-compiler.ts`, `journal.ts`, `store.ts`, `protocol.ts`: distinct process/persistence/compile owners with their own tests.
- `teammate-service/{submission,completion-renderer,admission-ledger}.ts`: real concepts (contract, rendering, stateful dedupe) with importers beyond the parent.
- `teammate-collection/system-prompt.ts`, `dispatcher-service/base-prompt.ts`: content modules parallel to each other.
- `team-service/roster-projection.ts`, `team-summary.ts`: cohesive projections (they move to the Team kernel, not fold).
- `dispatcher-service/agent.ts`, `mcp-delegates.ts`: the documented role→servers decision and the Agent builder (the latter becomes the Agent owner).
- `scheduler/cron-validation.ts`: one shared rule set with a caller-chosen failure type.
- `cli/doctor-plugins.ts`: net +12 lines in the PR #453 plugin commit, coherent job, own test; the type back-import is cosmetic.
- `codex/tool-display.ts`, `claude-code/tool-display.ts`: TUI-parity wording with their own tests; the peer keeps the same split.
- `claude-code/control-rpc.ts`, `reasoning-effort.ts`, `skill-adapter.ts`: created below the cap, one-way deps (skill-adapter is an optional consolidation only).
- `feishu-transport/transport/{outbound-message,message-content,connection}.ts`: designed modules (#424, ported with tests), though regrouping by API domain still helps.
- `feishu-ask-user.ts` (pure registry), `feishu-cot-presentation.ts`/`feishu-cot-events.ts` (need a reshuffle of display vs byte-fitting, not a merge), `routing/` directory.
- `service/submission-sources.ts`: 47 lines, 9 importers, deliberately never imported by the renderer.
- `WorkflowSemaphore` (inside `run-support.ts`): a real closable counting semaphore; it needs its own file, not a fold.

---

## 6. Target organization

### 6.1 Layer order for `packages/dreamux/src` (declared, then gated)

```
platform/            leaf: paths + segment-name rule, errors (incl. LegacyStateError, RuleViolation…),
                     logger, json-value (isPlainJsonObject), sockets, home-paths,
                     history-page, in-flight-work, serial-queue, deduplicate, closed-fact,
                     shutdown-errors, frozen-snapshot→json-value, command-runner, instance-lock
command/             kernel only: errors (commandFailure, throwCallerMistake), payload, schema, validate, registry, port, mustDispatcherId
config/, registry/, plugin/, agent-runtime/ (catalog+loader), channel/ (catalog+loader+core-port moved out)
service/agent-entity/, service/team-entity/ (new), service/worktree/, service/mcp/, service/completion-router.ts, service/dispatcher-core-events/
service/agent-service/ (today teammate-service), service/workflow-service/, service/scheduler/
service/teammate-collection/, service/team-collection/, service/team-service/
service/dispatcher-service/, service/channel-service/
service/dispatchers/, server/ (server.ts, commands catalog, server-commands, legacy-state probes, provider-diagnostics), admin/, cli/, onboard/, daemon/
```
`state/` disappears (`DispatcherStore` deleted; `dispatcher-id` becomes the platform segment-name rule). The `service/` root keeps only cross-domain policy (`legacy-state` detection, `name-allocator`→`agent-entity`, `dispatcher-workspace`→`worktree/workspaces`, `submission-sources`), and `service/index.ts` is deleted (server imports `dispatchers/` directly; update the eslint re-export rule that names it).

### 6.2 Per-domain template (`service/<domain>/`)

```
index.ts       the owning class (Collection or Service). Other class files exist only if they own named state.
requests.ts    request readers + result projections shared by Command and MCP (both adapters import it)
commands.ts    Command records only (typed defineCommand, no double cast, one "no input")
mcp.ts         tool records {descriptor, parse, execute}; the domain that owns the operation owns its tools
errors.ts      errors raised in this domain (imports platform/errors directly, never command/errors)
types.ts       types only; imports nothing from command/
```
Rename `scheduler/service.ts` → `index.ts`, `worktree/manager.ts` → `index.ts`; flatten `completion-router/` to a file. Runner-up considered: keeping readers in `commands.ts` — rejected because cron and Team readers serve both surfaces.

### 6.3 Domain-by-domain shape

**agent-entity (kernel).** Keeps: persisted identity schema, one `as const` vocabulary each for status / cleanup_state / worktree mode (derived types + Sets + `enumOf`), the name rule (`AGENT_NAME_PATTERN`, no alias), `records.ts` (`toStatus`, `toRecordRow`, `matchesRecordQuery`), identity/collection stores, runtime-state, activity-reader (with public failures thrown directly), `AgentNameRegistry` (stays dispatcher-level). Loses: TeamMate DTOs (→ agent-service/teammate-collection types), Command readers (→ `teammate-collection/requests.ts`), `agent-config.ts` (`resolveAgent`→`config/`, capability projection→collection or `agent-runtime/catalog`), `runtime-profile` scope asserts, `CreateTeamLeaderInput`, `assertManagedWorktreeAvailable`→`AgentEntityCollectionStore`.

**team-entity (new kernel, mirror of agent-entity).** `record.ts` (`TeamRecord`, `TEAM_ID_PATTERN`/`validateTeamId` via the platform segment rule, `teamNameParam`, `alignedWithLeader`, `teamSummary`), `store.ts` (persistence only, no event publishing; per-Team agent-store accessors `leaderIdentity(teamId)`, `members(teamId)`; `record.json` path from `platform/paths.ts`), `errors.ts`. Direction: `team-collection` → `team-service` → `team-entity`, nothing back.

**agent-service (today `teammate-service`; rename is §9).** `TeammateService` owns the whole durable lifecycle: `starting` single-flight, reopen (beside close), pre/post-start phase gates, cleanup decided from `identity.worktree` alone (delete `ownsWorktreeOnClose`), one `releaseRuntimeAndConverge()`. `runtime-generation.ts` (from runtime-owner): lease, MCP mint via `McpLeaseRegistry.mintServers`, `createRuntime`/`start` with rollback, `stop`, `interrupt`, `continuity`, `holdsUnprovenRuntime()`. `turn.ts` (coordinator + `EntityTurn` + `Turn {id, settled}`), `admission.ts` (`TurnAdmission`, projections, `AdmissionLedger` keyed `{teamId,name}+sourceId`), `submission.ts` (+ `submission-sources.ts` beside it, `channel-submission.ts` folded in as the Channel reader), `completion-renderer.ts` (absorbs utils `completion-body`), a per-dispatcher `TeammateServiceFactory` (constructs the ledger, derives `dispatcherId` from identity and logger fields from role; the only construction path). Deleted: `factory.ts` forwarder, `TeammateRuntimeOwnerCallbacks`, `send()`, `assertIdentityScope`, `InboundDeliveryResult`, `requireLifecycleText` re-checks, the `intent !== ''` guard (after §9 ruling).

**teammate-collection.** One `Map<name,{entity,subscription}>` + `materializations` + `reopening`; `publish()` refuses retired entities so eviction has one path; discriminated scope `{kind:'dispatcher'} | {kind:'team', teamId, workspace}` (loan is an invariant, not a per-call argument); `stopForHost()` from `heldMembers()` replaces the 4 external sweeps; `closeAllForDissolve` inline; `submitTask()` private helper; `getCapabilities` becomes a dispatcher-level config read; `dispatcherWorkspace()` deleted. `types.ts` keeps `TeammateOps` + spawn/send/close inputs (worktree types leave). `requests.ts` owns spawn/send/close codecs used by both adapters (validation tightening → §9). `mcp.ts` composes the Workflow tool group from `workflow-service/mcp.ts` onto the `teammate` server (tool names unchanged; this composition is the one added mechanism, paid for by removing the `teammate-collection` ↔ `workflow-service` loop).

**team-collection / team-service.** `TeamCollection` = merged registry (cache `Map<teamId,{service,subscription}>` + `constructing`, one pre-publication probe, created-hook runs, worktree settle from the `onClosed` subscription and the creation-failure branch, `create(options, createRequest?)` with replay only when a request is present, `open()` returns a cached live Team without re-reading disk, teamId-addressed `submitToLeader/interruptLeader/dissolve({requester})/leaderScope/scheduler/runForLeader` that take the dispatcher gate themselves, exported as a narrow `TeamsPort`). `read-model.ts` builds one row per Team from one leader/member read; `TeamListRow = Omit<TeamHistoryRow,…>`. `TeamService` publishes `team.state` itself (from `createNew`, `updateRecord`, roster), builds its children inline with the composed fence, owns `startScheduler/stopScheduler` as public verbs beside the workflow verbs (delete `TeamSchedulerLifecycle`, the registry `schedulers` map), hands out already-fenced `teammates` (with `spawn` bound to the shared workspace) and `workflows`, calls `submitToLeader` for the initial prompt, and keeps the leader in its own slot passed to `TeamClosing` as data. `TeamCollectionOptions = TeamServiceDeps & {root; nameSuffixGenerator}` — no field-by-field remap. Delete: `roster-reader`, `worktree-cleanup`, `collaborators`, `initial-prompt`, `read-helpers`, `TeamLeaderHandle`, `TeamLeaderTeammateOps`, `TeamServiceCreateOutput`, `allocateName`, `TeamDissolveInput` shadow types, `teamClosedFact` fields (shrink both closed facts to `{team_id}` / `{name}`), `name` parameter (getter equal to id).

**workflow-service.** `WorkflowRun` owns its terminal intent (one nullable field + finalize task); `journal.ts` becomes the per-run durability owner (`create`, `commitAgentResult`, `commitTerminal`, `recover`), deleting the candidate/commit flags and `recoverRunningRecords`' journal knowledge; `protocol.ts` is the one IPC codec (child and parent decoders, normalized options); `semaphore.ts`; `limits.ts` holds every documented bound; validation once in `createRun` (re-typed like the scheduler); `caller_kind` derived from `teamId`; `closeAdmission()` renamed to what it does (`requestStopAll`) — §9; `mcp.ts` owns the four workflow tools. Delete `run-terminal`, `run-support`, `agent-policy`, `json-args`, `failAfterNotification`/`beforeFinalize`/`deliverWhileTerminal`, `terminalLogged`.

**scheduler.** `SchedulerService implements SchedulerCommands` (no `.commands` facade, no Team re-wrap); one pure `advanceJob` + one `rearm`; one store read per fire; `jobId` dropped; `dispatcher_id` derived from path (stop writing, keep reading); `requests.ts` holds readers and `cronJobResult`; `store.ts` is persistence only.

**dispatcher-service.** `DispatcherService` = composition root + public operations. `lifecycle.ts` (`DispatcherLifecycle`, from input-source-lifecycle): admission gate (folded drain), prepare/start `@deduplicate once`, one terminal `shutdown()` whose synchronous prologue is the fence list, one `releaseRuntimes(failures)` shared with failed-start rollback; on a rollback whose stops converged, `agent_` is cleared so a `dispatcher.start` retry builds a fresh Agent. `agent.ts` owns the Dispatcher Agent (identity ensure via `reuseCwdWorktree`, build, `mustAgent()`, lazy activation + resume notice, one live status). `RestartIntentConsumer` is a constructor value. `readonly teams: TeamsPort`, `teammates`, `workflows`, `scheduler` — one admitted-ops style; delete the 11 Team pass-throughs, the dissolve triple, `prepareChannels`, `startInputSources`, `summary`, `workspace()` (manager answers), `listChannels`, the `TeamLeaderHandle` re-export, `shuttingDown` (→ Admission terminal close), `beginShutdown` at both levels. `DispatcherServiceOptions` carries `dispatcher: DispatcherConfig` alongside `config`.

**channel-service.** Single owner of `Map<channelId,{instance,portLease,live}>`: `assertRunnable()` (pre-workspace), `build()`, `initialize(assertAvailable)`, `start(assertAvailable)`, `closeAdmission()`, `closeAll()` (logging, reported), `list()`, `mcpDelegates(caller, dispatch)`; providers resolved once and cached. Delete `channel-service/{mcp-delegates,types}.ts`, `runtime-helpers`, `runnable-channel`.

**worktree.** Owns `WorktreeRequest`, `PreparedWorkspace`, `WorkspaceLoan`, `parseWorktreeIdentity` + vocabularies; `WorktreeManager` constructed with `{config, dispatcherId}`, owning workspace resolution (absorbing `dispatcher-workspace.ts`, `dispatcherWorkspace` alias, `resolveSpawnWorkspace`, the registry's `prepareWorkspace`, the four adapter `?? dispatcher.workspace()` copies) via one `prepareWorkspace({slug, cwd?, request?})`; `.workspace/` layout private; deadline mechanism deleted; `paths.ts` and `workspaces.ts` deleted.

**mcp (service).** `leases.ts` stamps identity from the delegate name, validates the catalog once, checks the result envelope once (reduced), `mintServers()`; `catalog.ts` moves beside it; `tool-metadata.ts` keeps only annotations + a positional `toolMetadata`; one JSON-schema builder module (from `command/schema.ts`) serves both surfaces; `descriptor.ts` → `src/mcp/launch.ts` owning subcommand/env/args (CLI imports both constants). One `failureText(commandFailure(err))` in `command/errors.ts` replaces `mcp/failure-text.ts` and the shim's copy.

**dispatcher-core-events.** Bus iterates its own `sources` Set (no EventEmitter, no `maxSources`, no `dispatcherId` parameter, `hasSources` required); `seal` = deepFreeze only; `conversation-projection.ts` moves in; one `agentState()` builder.

**completion-router.** `deliveryTo(initiator)`, exported `unsupportedDelivery(reason)`, `TurnCompletionDelivery` type moved in; keying `WeakMap<token, Map<producer, WeakMap<recipient,…>>>` (keeps the accepted `(producer, token, recipient)` triple, fixes the leak); one directory/class name.

**dispatchers / server / cli / onboard / daemon.** `Dispatchers.get(id)` resolves the config entry and throws `DispatcherNotFoundError` (`dispatchers/errors.ts` folded); one summary projection (`dispatcher.status` vocabulary → §9). `Server` owns the whole serve lifecycle given `{config, providers, plugins, loggerFactory}`; `cli/server.ts` exports `runServe()` run in-process; `cli/server-ctl.ts` deleted (commands call `adminJsonInvoker` in-process); `admin/socket.ts` takes `{commands, log}` and loses the pid lock (→ `platform/instance-lock.ts`). `server/` module holds the command catalog, `server-commands`, `legacy-state` aggregate probe (per-store results for doctor rows), `provider-diagnostics`. `daemon/` owns the managed service end to end: `unit.ts` (labels, path, render + parse), `environment.ts` (PATH policy from `paths.ts`, Node selection), `install.ts` (one pipeline for onboard and `daemon install`), `control.ts`, `status.ts`; `restart-intent` protocol moves next to the dispatcher Agent owner (operator surface imports core, not the reverse). `onboard/` keeps wizard (parse options once, prompt fills gaps, registry loaded once) and config merge (spread on the loaded config). `ServiceHost {runner, platform, homeDir, uid}` built once at the CLI edge.

**config / registry.** `config/config.ts` = contract (types, defaults, parse, validate, stringify, redact, `dispatcherAgent()` accessor; `DispatcherConfig.runtime` deleted); `config/load.ts` = provider/plugin loading. `registry.ts` owns typed `register(kind, descriptor, impl)` running the contract assertion once (no monkey-patching `createRuntime`; plugin `contribute` goes through the same path), `resolve(kind, ref)`; builtin descriptors not pre-registered; one `loadProviders` used by config, wizard, doctor, daemon, Server; one kind-loader module; `capabilities.ts` WeakMap and the four twin error classes deleted. Builtin id→package tables stay together in the single composition-root file.

### 6.4 Providers and Feishu (warranted cross-package moves)

- **dreamux-types**: `activity.ts` split out of `agent-runtime.ts`; capability shapes de-aliased into `provider.ts`; `CoreCommand*`/`ProviderRef*`/`RegisteredProvider`/`JsonInvokeResult` moved back into core; `AgentRuntimeFeature` union; `TeamListRow`/`TeamInterruptResult` published with `team.ts`; `WorktreeCleanupState` named; `logger/activity/paths/state_root/cache_root/limit` required; `injectEnv` deleted (§9); `export type * from` per module replaces the hand-kept root list.
- **dreamux-utils**: one `activity/` module (error class + reason table, budget that throws it, `openContainedFile(roots)`, cursor framing + query fingerprint); `json-shape.ts` (`isPlainObject`, `asString`, `nonEmptyString`); one path-based atomic-write pair; `errorMessage/errorInfo`; `runtimeSpawnEnv` stays per-provider `paths.ts` instead; `RuntimeStateFence` grows only the shared stop slot + fenced-stop convergence + `terminateForFence` handoff (not start/restart); config-validate loses the core migration text and `require*` is renamed `read*`; README/package.json rewritten.
- **codex / claude-code**: `paths.ts` per runtime (native home honoring `CODEX_HOME`/`CLAUDE_CONFIG_DIR`, child env, log/skill-view paths); runtime constructed from the neutral context (no `runtime-deps.ts`, no `codexHomeDoctor`); codex `events.ts` = resident decoder only, `TurnManager` = admission/settlement only (`runtime-activity.ts` mirrors claude), `protocol.ts` = all wire requests, `args.ts` = one function, `activity/{discovery,rollout-file}.ts`; claude `activity/{chain,projection}.ts`, `session.ts` (from supervisor), narrowed `Pick` seams so fakes stop double-casting; both barrels shrunk to `default` + factory + config type + `DEFAULT_*` that core tests use; provider-internal tests move into the provider packages.
- **feishu-transport**: owns typed inbound (`parse/message-event.ts`, `parse/card-action.ts`), `transport/{inbound,messages,docs}.ts` by API domain, one `expectFeishuOk`, one `json.ts` semantics, no `contract/`, no dead group/invite API, no `webSocketRegistration`. `FeishuBot` = `Omit<FeishuTransport,'start'|…> & {start(routes)}` with only a start adapter.
- **feishu-channel**: directories `session/` (`FeishuChannelSession` + `FeishuLifecycle {signal, isLive, track, assertLive}` as the one liveness value), `inbound/` (`attachments`, `render`, `enrich`, `work`), `outbound/` (`FeishuOutbound`: sendText incl. leader-only observe, sendCard with one fence/logging policy, react, editCard, locate, sendNotification with the catalogued single retry), `access/` (`state`, pure `gate` + pure transition functions, `FeishuAccess` owning the mutex), `ask-user/`, `card-actions.ts` (one keyed table incl. built-ins; owns `DREAMUX_ACTION_KEY`, publicly exported), `delivery` split into a submit unit (typed `FeishuCoreCommands`, COT anchor, outcome mapping, one `chatSubmission` builder + one attrs function) and `deliver` (plan + fallback), `cot/{card,recipients,adapter,bytes}.ts`, `cards/kit.ts` + one file per family, `routing/` (+ `operations.ts`, `installProvisionedRoute`, `update<T>` returning values), `tools/` (context carries collaborators as narrow Picks; catalog = the extension registry seeded with built-ins; `session-mcp` is the one invoker applying the fence to both kinds), `paths.ts` for the package's own state files, `errors.ts`. `index.ts` shrinks to plugin entry + full extension contract + the three harness names.

### 6.5 Concepts that disappear

`SessionHandle`, `FeishuInboundDelivery`, `FeishuTeamSubmitter`, `FeishuToolSession`, `ChannelOutboundTarget`, `containerChatId`, `FeishuSessionFence`/`alwaysActiveSessionFence`, `FeishuCotSessionSeam`, `FeishuCotIoHandle`, `CotActivitySink`, `FeishuRouteReconciliation`; `TeamLeaderHandle`, `TeamLeaderTeammateOps`, `TeamRuntimeRegistry`, `TeamSchedulerLifecycle`, `TeamServiceCreateOutput<T>`, `TeamWorktreeCleanup`, `roster` callback, `SpawnTeamMateRequest`/`Omit<…,'sharedWorkspace'>`, `dissolveTeamForLeader`; `TeammateRuntimeOwnerCallbacks`, `assertIdentityScope`, `ownsWorktreeOnClose`, `InboundDeliveryResult`, `admissionWithoutTurn`, `factory.ts` forwarder; `WorkflowRunTerminalDeps`, `failAfterNotification`, journal commit flags, `json-args`, `callerKind`; `DispatcherStore`/`state/`, `getRuntimeConfig`, `DispatcherConfig.runtime`, `setRestartIntent` chain, `stopHostTeammateRuntimes`, `beginShutdown`, `shuttingDown`; `McpDelegateIdentity`, `assertJsonCompatible`, `AgentActivityReadError`+mapper, `RESERVED_AGENT_NAME_SEGMENTS`, `CreateTeamLeaderInput`; `HOST_INJECT_ENV`/`injectEnv`; the `'active'` deduplicate mode, `KeyedAsyncQueue.runBefore`, the worktree assessment deadline; `FeishuBot` forwarders, `narrowMetaFromEvent`, `FeishuMessageReader`; codex one-shot collector mode + `releaseTurn`, `getThreadId`, `turnCwd`, `onTurnCompleted`, `parseCodexArgs`, `fingerprint`, `terminalFingerprints`; claude `ClaudeValidatedHistory` reopen, `lifecycleSupported` tri-state (§9), `resumeOnNextSpawn`, `stopped`; `cli/server-ctl.ts` and the child-process `serve`.

### 6.6 Where >700 lines might be legitimate

After the deletions no single responsibility above needs more than 700 physical lines. The one at risk is `workflow-service/run.ts` if the terminal fold lands before the persistence move (~745): the ordering in §8 avoids that. If a merged `TeamCollection`, `TeammateService` or `feishu-cot-adapter` still exceeds the cap after its removals, record it as a micro-refactor candidate per whitepaper §6 — that is the operator's own stated remedy — rather than re-split. `dreamux-types/agent-runtime.ts` is not a carve-out case; a split by domain (`activity.ts`) is the sanctioned response.

---

## 7. Harness: options for the operator

| # | Option | What it catches | Cost / risk | Recommendation |
|---|---|---|---|---|
| H1 | Keep `max-lines 700` counting comments (status quo), but rewrite the remedy text in `eslint-config/index.js:20-23` and `README.md:10` to whitepaper §6 wording ("find the responsibility that wants its own owner… or record a micro-refactor candidate"), and add the sibling admission test to `service/CLAUDE.md` | Stops the docs from prescribing the split | None | **Do now** |
| H2 | `skipComments: true, skipBlankLines: true` | Removes the incentive to delete rationale | Changes an operator-set gate; `tests/no-sync-io-gate.test.ts:54-61` (701 comment lines) must be updated knowingly | Operator decision; code-only headroom today: `team-service/index.ts` 504, `dispatcher-service/index.ts` 532, `teammate-collection/index.ts` 555, `run.ts` 643 |
| H3 | Import-direction + no-cycle gate for `packages/dreamux/src` (dependency-cruiser as `lint:deps` in `rush lint`, or `no-restricted-imports` blocks extending the existing `withCoreImportBoundary` mechanism), with a declared layer order and an exception list that only shrinks; type-only imports count (KB "Honest Layering") | The carve-out shape itself: back-imports, upward edges, cycles | Needs §8 stages 1–2 first or the exception list is the whole graph | **Recommend**, warn-mode in stage 0, error in stage 6 |
| H4 | Filename convention check: ban `*-helpers`, `*-support`, `*-ops`, `run-support`, `runtime-session`; require `index.ts` as owning class; `types.ts` must not import `command/` | Generic dumping-ground names | Small script in `rush lint` | Recommend |
| H5 | Unused-export check (knip / ts-unused-exports) with allowlists for published entry points | Dead exports and aliases regrowing | Initial inventory noise | Recommend |
| H6 | Package-wide re-export ban (move `SERVICE_REEXPORT_SELECTORS` into `eslint-config`, allow only package entry `index.ts`, extend to `export { X }` without source) | Shims like `feishu-gate.ts:584`, `command/errors.ts:22-31` | None | Recommend |
| H7 | Formatter check (`prettier --check`) in `rush lint`, applied once | Style drift; makes the line count a function of structure | `eslint-config/CLAUDE.md` forbids formatting churn — operator must waive once | Recommend, one dedicated commit |
| H8 | `exactOptionalPropertyTypes` decision per package | Makes the conditional-spread question deterministic | If enabled, ~180 sites need a pass anyway | Decide explicitly; recommend off + remove no-op spreads |
| H9 | Delete source-text structure tests (whitepaper §7), replacing behavioural guarantees with behaviour tests; migrate pairwise import greps into H3 | Tests that fail on moves, not on behaviour | Some encode recorded guards (`completion-delivery` ledger #13, `deleted-surfaces-absence`, provider-neutrality, legacy-state grep); each deletion is named in the PR | Recommend, with §9 sign-off on the recorded ones |
| H10 | Extend `.agents/scripts/check.sh` to validate backticked `*.ts` names in `packages/**/CLAUDE.md` | Stale ownership docs (`delivery-result.ts`, `Server.admitAdminRequest()`) | Small | Recommend |
| H11 | `"types": []` in `dreamux-types/tsconfig.json` replacing `no-host-types.test.ts`; `export type *` replacing `root-export-surface.test.ts` | Same guarantees by the compiler | None | Recommend |

Recommended package: H1 + H3 + H4 + H5 + H6 + H9 + H10 + H11 now; H2, H7, H8 as explicit operator rulings. Entry-only imports: not recommended as a blanket rule (only 24 % of cross-domain imports go through an `index.ts` today, and the template makes `requests.ts`/`types.ts` legitimate targets); H3's layer rule is the meaningful constraint.

---

## 8. Refactor sequencing

Every stage leaves `rush build`, `lint`, `test`, `typecheck:tests` green; every stage that moves a config/state fact updates `packages/dreamux/skills/dispatcher/dreamux-maintenance/` and `.agents/` in the same PR and runs `.agents/scripts/check.sh`.

**Stage 0 — Harness prep (no production code moves).** Inventory the source-text tests (`collection-ownership`, `completion-delivery`, `team-dissolve-contract`, `core-event-catalog`, `channel-service`, `mcp-delegate-catalog`, `workflow-service`, `legacy-state-fail-loud`, `core-provider-neutrality`, `package-boundary-guards` name pins, `public-api`, `index-exports`, `root-export-surface`) and classify each assertion (direction → H3; behaviour → rewrite; placement → delete) in a task record. Install H3 in warn mode with today's graph as the exception list, H4–H6, H10, H11. Rewrite the cap docs (H1). Get §9 rulings on H2/H7/H8 and the recorded-guard deletions. *Depends on nothing.*

**Stage 1 — Pure deletions and required-ness.** `getRuntimeConfig` trio; `DispatcherStore`/`state/`; `DispatcherConfig.runtime` + provider `dispatcher*Config`; dead exports from H5; `deduplicate 'active'`, `runBefore`; worktree deadline; `json-args`; codex one-shot collector mode + `releaseTurn`, thread-change machinery, dead options, `fingerprint`, `terminalFingerprints`→`Set<turnId>`; claude test-only protocol surface (after §9), `testHooks`/`locator`, discovery layers; transport dead API; `FeishuBot` optionals; make always-supplied deps required across `TeamCollectionOptions`, `TeamServiceDeps`, `TeammateCollectionOptions`, `TeammateServiceDeps`, `DispatcherCoreEventPublisher.hasSources`, dreamux-types contexts (change notes on types + providers). Delete the redundant validations (§P3) and the four-copy vocabularies (as-const arrays). *Watch:* `tests/entity-turn.test.ts` (`delivery` getter → `ensureDelivery`), `admission-ledger.test.ts:383`, `teammate-dissolve-members.test.ts:212-221` (forged caller), `core-event-catalog.test.ts:189-248` (forged events), `completion-token-routing.test.ts:214-226` (keep — accepted triple), codex `codex-runtime.test.ts:686-707` (fabricated thread change), `claude activity-reader.test.ts:282`.

**Stage 2 — Leaf layering.** `platform/` becomes a leaf (`LegacyStateError`, segment-name rule, primitives from `service/` root, `history-page`, `instance-lock`, `command-runner`); `command/` becomes kernel-only (catalog + host resolvers move to `server/`; domain Command factories take per-domain resolvers; one schema builder module; `defineCommand`); `worktree/` owns its types; `service/team-entity/` created; `conversation-projection` and `core-port` move into `service/`; `restart-intent` moves beside the dispatcher Agent; utils gets `json-shape`, one atomic write, `activity/`, `errorMessage`; `config/load.ts` split; registry typed `register()`. *Depends on stage 1 (required deps) for the loop-free per-dispatcher type.* *Watch:* `package-boundary-guards.test.ts`, `core-provider-neutrality.test.ts` (H3 must carry the neutral-seam invariant before its regexes go), `legacy-state-fail-loud.test.ts:505-523`, `no-sync-io-gate.test.ts`.

**Stage 3 — Service domains (one PR each, in this order).** (a) agent-service/teammate-service + teammate-collection (factory, `RuntimeGeneration`, turn/admission, collection maps, scope invariant, `stopForHost`, fold `dissolve-members`). (b) team-entity + team-collection + team-service (merge registry, `team.state` owner, kernel types, TeamClosing data args, leader factory, scheduler verbs, initial prompt via `submitToLeader` — flag §9 item on completion routing). (c) workflow-service (journal owner *before* terminal fold, `protocol.ts`, `semaphore.ts`, validation once, `requestStopAll` rename after §9). (d) scheduler. (e) dispatcher-service + channel-service (`DispatcherLifecycle`, `DispatcherAgent`, `ChannelService` owner, `TeamsPort`, admitted ops, `Admission` primitive, one teardown, `Dispatchers.get` resolves config). *Watch:* the issue #63 non-blocking-inbound live gate, `teammate-completion-lifecycle.test.ts`, `team-dissolve-recovery.test.ts` (start-failure ordering after adoption moves ahead of `workflows.stopAll`), `team-leader-prompt.test.ts`, `input-source-lifecycle.test.ts` (rebuilt around the new owners), `dispatcher-plugin-hooks.test.ts`, `commands.test.ts:117` (only stop() caller), `codex-live.test.ts`.

**Stage 4 — Adapters and schemas.** `requests.ts` per domain; `mcp.ts` tool records; workflow tools composed onto the `teammate` server; MCP identity from name; catalog/envelope validated once; one repo schema (§9 for `slug`/bounds); one submit-receipt module; delete `mcp-tool-descriptors.ts`, three `tool()` copies, `channel-service/mcp-delegates.ts`; `failureText` unified; `cli/server-ctl.ts` deleted; `serve` in-process. *Watch:* `mcp-delegate-catalog.test.ts:305-320`, `mcp-lease-shim.test.ts:350,370`, `mcp-public-failures.test.ts:56`, `failure-classification.test.ts`, `bin-launcher.test.ts:37`, `channel-input-format.test.ts:89-104` (attr order is a contract), `CHANGELOG.md:44` behaviour.

**Stage 5 — Providers, Feishu, host shell (parallelizable).** Provider `paths.ts`, `RuntimeStateFence` narrow share, activity primitives, barrels, provider-internal tests moved; feishu-transport typed inbound + domain regrouping; feishu-channel directories (`session/`, `inbound/`, `outbound/`, `access/`, `ask-user/`, `cot/`, `cards/`), one lifecycle value, card-action table, typed Core client, chat-submission builder; daemon/ managed-service owner + one install pipeline + `ServiceHost`; onboard wizard parse-once. *Watch:* `feishu-settlement-envelope.test.ts`, `feishu-gate.test.ts:1040` (alias identity → delete), `feishu-allow-chats-release-contract.test.ts:124-145` (persisted format — untouched unless §9), `feishu-extensions.test.ts:523,948` (`sendCard.mode`), `feishu-provider-state-root.test.ts` (deleted with the throw), `uninstall.test.ts:176-199` (refusal before `runner.calls`), `daemon.test.ts:270-290` (dry-run ledger byte-identical), `onboard.test.ts:544` (auth advice now from the provider), `dispatcher-codex-home.test.ts`, `system-prompt.test.ts`, `connection.test.ts` retarget.

**Stage 6 — Lock the harness.** Flip H3 to error with an empty (or explicitly justified) exception list; delete the remaining text-mirror tests per the stage-0 classification; update `service/CLAUDE.md` (template, sibling rule, invariants stated once), `packages/dreamux/CLAUDE.md` (cli/onboard/daemon owners), `.agents/domains/{service-topology,current-architecture,state-config-and-files,channel,plugins,provider-runtime}.md`, the feishu-channel and eslint-config `CLAUDE.md`s; run `check.sh`.

---

## 9. Open questions for the operator

Items marked *(inference)* are the auditors'/my reasoning, not a recorded ruling.

**Harness and taste**
1. Cap semantics: keep counting comments/blank lines (status quo, locked by `no-sync-io-gate.test.ts:54-61`) or switch to code-only? The ruling "700 行就是为了卡架构重构的" is about purpose, not counting mode *(inference)*.
2. Formatter gate (`prettier --check`) despite `eslint-config/CLAUDE.md` "Do not introduce formatting churn"; and the `exactOptionalPropertyTypes` decision.
3. Deleting source-text tests that encode recorded guards: `completion-delivery.test.ts` (failure-ledger #13), `dreamux-types/tests/deleted-surfaces-absence.test.ts`, the legacy-state path grep, `core-provider-neutrality` regexes (replaced by H3), export-name pins in `package-boundary-guards`, `public-api`, `index-exports`.
4. Rename `TeammateService`/`teammate-service/` → `AgentService`/`agent-service/` (or `AgentEntity` in `agent-entity/`); error text and `TeammateClosedFact`/`LockedTeammate` with it. Public `dreamux-types` names, the `teammate:` result keys and the `.tm.` runtime-id segment stay unless ruled.
5. Name for the Team kernel (`team-entity/` mirrors `agent-entity/`; runner-up `team-record/`).
6. Adding the `no-cycle`/direction gate as a new mechanism (dependency-cruiser vs extending `no-restricted-imports`).

**User-visible behaviour a structural fix would otherwise change**
7. Unifying the TeamMate spawn/send/close codecs makes the admin Command reject an empty prompt / blank `agent_runtime` / blank `intent` (today MCP rejects, Command accepts).
8. `dispatcher.status` reporting identity vocabulary consistently (today `'ready'` when live, `'running'` cold); `dispatcher.start` returning the same projection.
9. `getTeamStatus` losing dispatcher admission (during shutdown it would answer instead of refusing).
10. `team.create` with a prompt currently routes the leader's completion to the Dispatcher Agent; `team.submit` from the same adapter does not. Which flag should `team.create` carry?
11. Workflow `closeAdmission()` renaming (`requestStopAll`) and dropping the redundant `closeAdmission(); stopAll()` pairs; Team-scope workflow runs becoming fully drain-tracked once `finishOutsideLease` goes.
12. Cron: drop the Command-only `action` input and stop writing `action.intent` (echoed in results today); stop writing `dispatcher_id` in cron jobs and results; the `MAX_JOBS_PER_OWNER` cap (StatedFailure with a scenario, or delete).
13. `turn_timeout_ms` in codex config (accept-and-ignore vs implement); codex `approval_policy` allowlist values (`on-failure`, `auto`, `auto-approve` contradict the fail-fast rationale).
14. Refusal code when a scope is closed: INTERNAL today for dispatcher/workflow fences vs SERVER_SHUTTING_DOWN for server/channel; unify to a stated code?
15. `dispatcher.submit` returning `TEAM_SUBMIT_*` codes for the Dispatcher's own Agent (renaming is user-visible).
16. Doctor: honoring `CODEX_HOME` (today it validates `~/.codex` while the runtime uses `$CODEX_HOME`); the shared-tmp placement check's owner; collapsing legacy-state rows; removing the `.codex`/`.claude` uninstall refusal or sourcing it from providers.
17. Onboard honoring `DREAMUX_CONFIG_DIR` (today it writes `~/.dreamux`); persisting `DREAMUX_ROOT` into the service unit.
18. Provider supervisors no longer `mkdir -p` the cwd (a deleted worktree fails loudly instead of running in an empty dir).
19. Claude Code minimum CLI version gate replacing the lifecycle-less fallback (KB currently promises "single-input compatibility remains supported").
20. `injectEnv`/`HOST_INJECT_ENV` deletion (recorded #209 env-boundary decision); `isSynthetic` (recorded producer-less item).
21. Are Agent Runtime providers untrusted producers? Decides the Core byte/length caps in `activity-reader.ts` and the capability caps in `agent-runtime/capabilities.ts`.
22. Dispatcher prompt wording: "You are Codex running as a Dreamux Dispatcher" → runtime-neutral text (model-facing).
23. MCP repo request: should MCP accept `slug`, and do the MCP-only length bounds become domain rules?
24. Whether a dispatcher stop → restart in one process is a requirement (today unreachable and broken); whether `dispatcher.start` retry after a post-prepare failure should rebuild the Agent (recommended) *(inference on retry behaviour: code read, not executed)*.
25. Plugin hooks receiving frozen `{id, cwd, hooks}` faces instead of the concrete aggregates; `Dispatcher.workspaceDir` on the plugin face; whether `builtin:codex`/`claude-code` become always-loaded plugins.
26. Feishu: `FeishuInstanceApi.sendCard.mode` (keep as documented hint or remove); porting the v1 cards to Card 2.0 (catalogued copy change); keeping the single notification retry (catalogued); which "where did this message land" rule is authoritative (infer vs read-back) and why replies are recorded only for leaders; `access.json` ledger fields (`last_gate`, `observed_chats`, `warnings`, `kind`, `replies`) and per-message writes; `generation`/`origin`/`space_id`/per-channel keying semantics; narrowing `submitToTeam` to facts (plugin-API change); feishu-transport → dreamux-utils edge.
27. Journal role now that `record.json` writes are atomic: commit point or diagnostics only? Per-record-class corrupt-file policy (TeamStore swallows, identity store rethrows, JsonDocumentStore fails loud) — any unification changes what an operator sees.
28. Worktree identity parser strictness (Team reader rejects `''`, Agent reader keeps it) — prefer the variant that keeps every file readable.
29. `AgentActivityRecord` vs `RuntimeActivity` vocabularies (`assistant_message`/`tool` vs `assistant.message`/`tool.call`) — aligning changes agent-visible tool output.
30. Delete the `producer` dimension of completion dedupe? Not needed for the leak fix; would amend the accepted decision record.

---

## Appendix — counts and coverage

| Slice | Raised | Kept | Refuted | Verifier-added |
|---|---|---|---|---|
| teammate | 18 | 18 | 0 | 5 |
| team | 22 | 22 | 0 | 4 |
| dispatcher | 16 | 16 | 0 | 5 |
| workflow | 19 | 19 | 0 | 4 |
| entity | 24 | 24 | 0 | 4 |
| host | 19 | 18 | 1 (host-15) | 3 |
| cli | 16 | 16 | 0 | 5 |
| feishu-a | 18 | 18 | 0 | 2 |
| feishu-b | 21 | 21 | 0 | 4 |
| shared | 18 | 17 | 1 (shared-16) | 4 |
| codex | 21 | 21 | 0 | 4 |
| claude | 21 | 20 | 1 (claude-3) | 5 |
| layering | 26 | 26 | 0 | 4 |
| consistency | 22 | 22 | 0 | 5 |
| **Total** | **281** | **278** | **3** | **58** |

Of the 278 kept, the verifiers marked roughly three in five "confirmed" and two in five "adjusted"; every adjusted item is reported here in its corrected form. Verifier-added items I re-checked directly: `consistency-missed-1` (lifecycle owns `agent_`, setters both ways), `dispatcher-missed-1` (`@deduplicate` only `'once'`), `dispatcher-missed-2` (`beginShutdown` called at three levels back-to-back), `team-missed-1` (Team fence applied in `collaborators.ts`, `completion-targets.ts`, the handle), `workflow-missed-2` (`closeAdmission` → `reserveStop` → abort), `host-missed-1` (`candidate.createRuntime = …` at `external-provider.ts:136`), `host-missed-2` (verbatim comment `run.ts:150` / `install.ts:130`), `feishu-a-missed-1` (`inactiveFence`, three fence shapes), `claude-missed-3` (`mkdir(cwd)` in both supervisors), `layering-missed-1` (the source-text tests). All held. Not independently re-verified: the remaining verifier-added items are adopted on the verifiers' evidence and are marked where they rest on an unexecuted reading.

No slice's survey or verification failed. The audited clone's git history is shallow (about 50 commits), so cap-driven origin is proven by history only for the PR #453 plugin commit (feishu routes/notification, `initial-prompt.ts`, `doctor.ts` squeeze), #432 (codex `runtime-support`), #431 (transport `doc-comment`), and `workflow-service/run.ts` (exactly 700 lines at the oldest commit of that history; #391 brought it to 687); the rest is judged from structure (single importer, parent-private bag, back-import, self-declaring header).