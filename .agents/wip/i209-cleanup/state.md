# i209 cleanup — working state (NOT a settled KB record)

> Scratch workspace for the one-shot architecture cleanup on branch
> `feature/i209-npm-package-split` (PR #223). Kept under `.agents/wip/` on
> purpose so it does NOT count as a settled decision record and does not trip
> `.agents/scripts/check.sh`. The real decision record is written into
> `.agents/decisions/` only at the end. Delete `.agents/wip/` before merge.

Purpose: survive context compression across a multi-workflow run. Anyone
resuming should read this file first, then `plan.md` in this dir.

## Origin

A max-effort review of PR #223 (the #209 package split) surfaced architecture
debt. Full verified review findings live at:
`/private/tmp/claude-501/-Users-bytedance-Development-dreamux/ffff4629-4ee5-423e-ad0e-19735a18dc18/tasks/w94i29glf.output`
(29 findings, 0 refuted). The maintainer (朱德予) reviewed them interactively
and approved a one-shot cleanup with the settled scope below.

## ⚠ HARDENED SCOPE (read `plan-hardened-scope.md` — AUTHORITATIVE over plan.md §5)

Mid-run, the maintainer hardened the requirements. Hard success criteria (task
INCOMPLETE if any fail):
1. `packages/dreamux/src/agent-runtime/builtin/` DELETED entirely (the directory
   must not exist).
2. ALL re-export shims deleted repo-wide; importers point directly at the real
   source (package / dreamux-types / dreamux-utils). "重导出都是垃圾代码,全部干掉".
3. Core `@excitedjs/dreamux` imports `@excitedjs/dreamux-types` DIRECTLY (no core
   re-export shim of the contracts). `agent-runtime/types.ts` is DELETED, not
   shimmed.
4. `packages/dreamux/src/agent-runtime/CLAUDE.md` DELETED.
5. `codex-home` moves INTO `@excitedjs/agent-runtime-codex` (codex-only concept;
   maintainer: "不应该留在核心包里"). Diagnostics move INTO the packages too.

Details + file-by-file fate + importer survey: `plan-hardened-scope.md`.
This grows D1 substantially (relocate host logic to `agent-runtime/host-paths.ts`
+ `host-context.ts` + builtin-registration; move diagnostic/codex-home into
packages; repoint ~12 core src + 13 test importers). Phase 2 (foundations A/B/C)
is orthogonal and keeps running; some shims B creates (turn.ts, paths.ts) are
DELETED in Phase 3 per criterion 2.

### NORTH STAR (maintainer's articulated principle — overrides everything)

Pluginization = polymorphism. Dreamux Core has **NO built-in implementations**.
It calls only the **Interface** (published in `@excitedjs/dreamux-types`) and is
**completely unaware** of which class implements it; `builtin:codex` /
`builtin:feishu` are providers indistinguishable from any npm provider (only the
ref→package-name resolution differs). All injectable providers — agent-runtime
AND channel — conform to **one unified provider interface**. Anything
provider-specific (codex-home, diagnostics, path layout, config shape) "belongs
to whoever owns the concept, NEVER to Dreamux" → it lives in the provider
package. Consequence: the core package ends up with little code.

This RESOLVES both earlier forks:
- **Fork A (interface unification): CORRECTED — do NOT merge.** Maintainer
  (2026-06-14 13:07): "Channel 和 agent runtime 是两个东西,它们应该有两套
  Interface,而不是完全归到一起." Keep the TWO SEPARATE interfaces that ALREADY
  exist in dreamux-types: `AgentRuntimeProvider<TConfig>` +
  `AgentRuntimeCreateContext` (agent-runtime.ts:381/269) and `ChannelProvider<TConfig>`
  + `ChannelSession`/`ChannelRoutes` (channel.ts:136/109/105). There is NO new
  unified interface to design. The work is purely: Core ADOPTS these two existing
  dreamux-types interfaces DIRECTLY and DELETES its parallel host duplicates
  (`agent-runtime/types.ts:202` host `AgentRuntimeProvider`, `:129` host
  `AgentRuntimeCreateContext`). "归一到同一个 interface" meant: every injectable
  provider conforms to its kind's published dreamux-types interface — NOT that
  runtime and channel share one interface. Core still distinguishes the two kinds
  (two interfaces, two create seams); it just never knows the concrete impl
  (codex/claude/feishu).
- **Fork B (de-leak):** FULL de-leak, one step. Core must never name
  `app_id`/`app_secret` or any provider config field. Generalize/neutralize
  `bot_app_id` in `dispatcher-store`/`status.json` (provider self-reports a
  neutral identity). Touches a persisted schema → needs a rush change.
- **Channel symmetry:** RESOLVED — `channel/feishu/` is dissolved the same way as
  `builtin/` (feishu is just a provider package; its host logic relocates out of
  Core). `channel/feishu/bot.ts` and all channel shims deleted.
- **Provider-ref branching:** ELIMINATED everywhere, including the `runtimePaths`
  `if (ref === claude-code)` branch the plan deferred as R5. Host paths become
  provider-AGNOSTIC (keyed by runtime identity; the provider lays out its own
  files inside host-provided dirs).

## Settled decisions (do NOT re-litigate — the maintainer decided these)

1. **Core drives ALL providers through the neutral `@excitedjs/dreamux-types`
   contract.** Today core keeps a parallel HOST `AgentRuntimeProvider` /
   `AgentRuntimeCreateContext` (carrying `row`/`dispatcher`/`dispatchers`/
   `log`-callback — core-internal types) and bridges per-builtin in
   `builtin/<name>/provider.ts` with duplicated glue (`loggerFromHostLog`,
   `identity:{runtime_id,checkpoint_id}` mapping, `as unknown as
   DispatcherProviderConfig`). External `agentRuntime` providers are even typed
   on the HOST contract (`external-provider.ts` imports `AgentRuntimeProvider`
   from `./types.js`) — so a `dreamux-types`-only plugin author literally cannot
   implement what core drives. This is the proof the per-builtin adapter is
   wrong: external plugins can't get a core adapter, therefore core must drive
   neutral for everyone.
   - Target: catalog/registry typed on the neutral provider; core builds the
     neutral context ONCE at the launcher (row→identity, store→state sink, host
     `log`→`DreamuxLogger`, `provider.readConfig`→config); each builtin
     `provider.ts` shrinks to a tiny factory injecting genuinely host+builtin
     hooks (codex socket allocator, package-bin env, codex-home doctor, host
     log/state paths). External providers driven via neutral, NO adapter.
   - Fixes review findings #2 (loader id mismatch), #3 (config double-cast),
     and the duplicated adapter glue.

2. **Channel: same convergence (review finding #4).** Core holds
   `Map<string, FeishuChannelSession>` (concrete) and calls
   `session.start({submitTurn: …})` where `submitTurn` returns a result the
   reaction ledger keys off; the neutral `ChannelRoutes.deliver` returns `void`,
   so the neutral contract is not load-bearing. Target: strengthen the neutral
   channel inbound-submit to return a neutral result (`status`/`turnId`/`error`);
   core holds `Map<string, ChannelSession>` (neutral); egress addressed by
   `channelId`; remove the `as unknown as DispatcherFeishuConfig` double-casts in
   `config.ts`. Do it optimally (pre-merge, no consumers).

3. **New leaf package `@excitedjs/dreamux-utils`** (pure functions; depends on
   nothing or only `dreamux-types`; **no third-party** like fs-extra/execa — they
   don't cover the security primitives and add dep surface). Absorb the
   byte-identical duplicated helpers: config-validate primitives (×3: codex,
   claude-code, core `config/validate.ts`), `internal/os.ts`
   (isProcessAlive/killProcessGroup/ensureOwnerOnlyDir/pathExists), `ensureOwnerOnlyDir`
   (×4 incl core `platform/owner-only-dir.ts`), completion-body (×2 + core
   orphan), turn-render / `turn.ts` render, the teammate spill-path builder.
   Delete copies, repoint imports, delete core orphans. **The new package MUST
   carry a `repository` field** (npm provenance — see finding #1). Updating the
   "runtime packages depend on dreamux-types only" rule in CLAUDE.md is required.

4. **Config validation.** ADD: forbid two channels with the SAME provider ref on
   one dispatcher (core-level, abstraction-clean — closes the
   dispatcher-egress-to-wrong-bot gap, review finding #14, since one dispatcher
   then has at most one feishu bot). REMOVE: all cross-dispatcher Feishu app_id
   uniqueness enforcement — the maintainer's call: "撞了就撞了" (same app_id across
   dispatchers is allowed; it's user error if the long-link collides; core can't
   validate platform semantics anyway). Drop `assertUniqueFeishuAppIds` /
   `soleFeishuConfigFromChannels` / `dispatcherFeishuAppId` machinery, the
   `DispatcherStore.create` `bot_app_id` guard, and the divergent onboard copy
   (`onboard/config-files.ts`). Align onboard to the single validation path.
   - Consequence the maintainer accepted: since feishu is the only channel
     provider today, "two channels per dispatcher" becomes unconfigurable now;
     the multi-channel routing infra stays for when a 2nd provider (slack)
     lands. Two same-kind bots → use two dispatchers. There is NO real use case
     for two feishu bots on one dispatcher (maintainer confirmed).

5. **Determinate fixes** (small, independent):
   - #1 `packages/channel/feishu-channel/package.json` missing `repository`
     (HIGH — blocks first npm publish under provenance).
   - #2 `registry/provider-loader.ts` ~L165 `registerImplementation(seedDescriptor.id, …)`
     → key off `provider.descriptor.id` (also subsumed by decision #1 rewiring,
     but fix standalone too).
   - #5 `tests/smoke.test.ts` imports `CodexProcessExitHandler` that the codex
     supervisor shim + package `index.ts` no longer export → re-export it.
   - #7 `dispatcher-service/dispatcher/service.ts` registers `this.slots.set`
     AFTER the multi-channel start loop → register the slot BEFORE the loop so an
     inbound during startup doesn't throw "dispatcher not running".
   - #10 `dispatcher-service/channel-binding/store.ts` v2 `read()` skips bad rows
     / only checks key presence → fail loud on malformed rows (0.x contract).

## Dropped from scope

- #8 cross-dispatcher app_id uniqueness validation (decision #4: not validated).
- #14 as a standalone egress fix → subsumed by decision #4 (one feishu per
  dispatcher) + decision #2 (channelId-addressed egress).

## Model assignment (maintainer directive, ultracode)

- Investigation / research → **sonnet**
- Post-hoc verification (build/test runs, checking) → **sonnet**
- Development (implementation, fixes) + review → **opus**
- Plan/design synthesis → opus.

## Workflow staging (I stay in the loop between phases; surface to user only at the end)

- **Phase 1 — Investigate + Plan** — RUNNING. Task `ws50mpro9` / run
  `wf_534b136d-cb9`. 5 sonnet investigators + 1 opus plan synthesis. Plan will be
  written to `/tmp/i209-cleanup/plan.md`; I will relocate it to
  `.agents/wip/i209-cleanup/plan.md` when it completes.
- **Phase 2 — Implement foundations** (opus, sequential in the real working
  tree): determinate fixes (A) → dreamux-utils (B) → config validation (C), with
  `rush build`/`rush test` gating after each.
- **Phase 3 — Implement convergence** (opus, sequential): agent-runtime neutral
  contract (D1) → channel neutral contract (D2), build/test gating.
- **Phase 4 — Verify + review**: full `rush build`+`rush test` (sonnet) → bounded
  opus fix loop → adversarial opus review of the diff → write rush change files +
  the real decision record into `.agents/decisions/` + CLAUDE.md updates.

## Rules to respect during implementation

- No synchronous blocking IO in `packages/*/src/**` (#85; `rush lint` gate).
- Public repo — never commit feishu identifiers/secrets (gitleaks pre-commit).
- Do NOT commit unless the maintainer asks — they review the working tree.
- `.gitleaks.toml` / `.npmrc` are byte-identical with the claudemux repo — don't
  touch.
- Upgrade-blocker changes (config schema / paths / persisted formats / bundled
  skills) need a `rush change` file (root CLAUDE.md "Changelog responsibility").

## Phase 1 outcome (plan is authoritative)

Full ordered plan: `.agents/wip/i209-cleanup/plan.md` (823 lines). Spine
A→B→C→D1→D2 with a shared-file sequencing contract (§1). Three corrections to
the original investigation (all folded into the plan):
- **R1**: D1 diagnostic is NOT deferrable — codex/claude packages ship no
  diagnostic; it lives only in core host adapters. Neutral catalog forces
  neutralizing it → add `cwd` to neutral `AgentRuntimeDiagnosticContext`
  (dreamux-types, additive/non-breaking) + `doctor.ts` rewrite. ACCEPTED.
- **R8**: config is already parsed at load (`config.ts:440-450`); launcher +
  doctor pass `dispatcher.runtime.config` DIRECTLY — do NOT re-call
  `provider.readConfig`.
- **D2 narrowing**: strengthened `ChannelRoutes.deliver` return must narrow the
  `runtime.channelInput` union (`NoticeInjectionResult`'s `'skipped'` is not in
  `InboundDeliveryResult`).

Confirmations (no further maintainer input needed):
- **R2**: Decision #4 reverses shipped PR #224 (multi-feishu-per-dispatcher,
  commit 63cd886). Maintainer CONFIRMED in conversation: no use case for two
  feishu bots on one dispatcher; forbid duplicate provider ref. Needs a BREAKING
  rush change for `@excitedjs/dreamux`.
- **dreamux-types `deliver` change is BREAKING** for external channel authors —
  accepted (do-it-right, pre-merge, no consumers); needs a rush change file
  leading with `BREAKING:`.

Build harness verified: deps installed (`common/temp/node_modules` present);
git tree clean. Recipe: `node common/scripts/install-run-rush.js build|lint|test`;
`DREAMUX_SKIP_LIVE_CODEX=1` fast path; `rush update` after adding a package /
editing workspace deps.

## doctor + onboard (maintainer clarification 2026-06-14 ~13:1x)

- **doctor — IN SCOPE, make provider-agnostic now.** `cli/doctor.ts` calls each
  provider's OWN diagnostic (the neutral `diagnostic` the package now ships).
  Iterate providers, call `provider.diagnostic(neutralContext)`; ZERO
  codex/claude branching. (Pairs with diagnostic-into-packages.)
- **onboard — DEFERRED. Do NOT redesign in this cleanup.** Maintainer: "onboard
  我还没想好要怎么设计 ... 作为 todo 项,等你全部搞完了再推进." For Phase 3, onboard
  (`onboard/run.ts`, `onboard/types.ts`, `onboard/uninstall.ts`, `onboard/config-files.ts`)
  gets ONLY the minimal import repoints needed to keep compiling after builtin/
  is deleted and codex-home/args/paths move (repoint to the codex package or the
  relocated host modules). Do NOT make onboard provider-agnostic, do NOT strip
  its codex/feishu awareness, do NOT redesign its flow. Leave its logic intact.
- **De-leak scope narrowed accordingly:** the full de-leak (no provider config
  in core) targets the RUNTIME-driving + dispatcher path NOW. Onboard's residual
  provider-awareness rides with the deferred onboard redesign — do not force it.
  (bot_app_id neutralization still proceeds where it is on the dispatcher/status
  path, but if it tangles into onboard's flow, keep onboard compiling and defer
  the onboard-side de-leak.)

## Post-cleanup TODOs (after Phase 4 — maintainer will drive)

- Onboard provider-agnostic redesign (maintainer to design). Currently
  codex-aware; left intact this cleanup.
- Revisit `packages/dreamux/tsconfig.tests.json` (Phase 2 shipped an inert
  no-op; making it real surfaces ~106 pre-existing test type errors).

## Status log

- 2026-06-15: **Q1 + Q2 COMPLETE + GREEN; eslint guardrail added.** Verified by
  the maintainer's reserved final pass (main loop):
  - Q2 (one provider-loading path): done in an earlier workflow; build+lint+test green.
  - Q1 (blind channel-MCP conduit): done via the Q1-only workflow (wf_3b8e678a).
    admin has two generic methods `channel.invoke_tool` / `channel.list_tools`;
    `callFeishuMcpTool`→`invokeChannelTool`; `feishuMcpServerDescriptor` deleted →
    `session.mcpServerDescriptor`; `handleFeishuListChatBots` deleted →
    `provider.handleSessionlessTool`; `feishu-mcp-surface.ts` DELETED;
    `mcp/feishu-mcp.ts`→`mcp/channel-mcp.ts`; CLI subcommand + descriptor args
    `feishu-mcp`→`channel-mcp`; rush changes written; CLAUDE.md (root + package +
    feishu-channel) updated. The TeamLeader egress authz moved to
    `DispatcherService.authorizeTeamLeaderChannelEgress` — VERIFIED the 3 deny
    paths survive byte-for-behavior (BAD_REQUEST missing target via
    `session.resolveTarget`; CHANNEL_SCOPE_DENIED message-not-in-bound via
    `messageBelongsToTarget`; CHANNEL_SCOPE_DENIED unbound via neutral
    `target_key`); gate runs only for `team_leader`.
  - ESLint guardrail (issue #209): `packages/dreamux/eslint.config.js` now MERGES
    a provider-package import ban (`@excitedjs/agent-runtime-codex` /
    `-claude-code` / `feishu-channel`) into the shared `no-restricted-imports` for
    `src/**`, keeping the #85 sync-IO pattern group (verified via
    `eslint --print-config`). The feishu import axis is fully clean; the 9 residual
    codex/claude CONFIG imports (config.ts ×6, doctor.ts, onboard/types.ts,
    onboard/run.ts) carry documented `eslint-disable -- Q3 de-leak` markers.
  - **REMAINING neutrality gap (vocabulary leaks NOT on the import axis, so the
    eslint rule does not catch them) — the "Q1-broad" de-leak, surfaced by the
    gate grep:**
    1. `dispatcher/base-prompt.ts:47,103` — LLM prompt names feishu fields
       (chat_id/chat_type/message_id/sender_*/source="feishu"). MAINTAINER-OWNED
       prose track + behavior-affecting → defer.
    2. `mcp/team-mcp.ts:128,133,252` — bind_channel/transfer_back tool descriptions
       + a comment name `chat_id` ("for Feishu, { chat_id }"). Neutral fix needs the
       provider to declare its bind-selector schema (contract addition).
    3. `dispatcher-service/team/types.ts:82` + `team/service.ts:406,409` —
       `TeamChannelBindingSummary.chat_id` wire field + `meta["chat_id"]` read.
       Neutral fix = use `target_key`; BREAKING wire change (rush change).
    4. `teammate/mcp-config.ts:12,32` — `feishuScope` option + `--feishu-scope`
       CLI arg in core's teammate MCP descriptor. Rename to a generic channel scope
       across the teammate MCP + the teammate-mcp shim reader + team service.
  - Tests workflow-NOT-migrated note is RESOLVED: the Q1 workflow's Q1tests phase
    migrated smoke/multi-channel-routing/e2e/runtime-paths/claude-code-runtime/
    codex-live and added `tests/channel-mcp.test.ts` (incl. the TeamLeader deny-path
    security tests); full suite green.

- 2026-06-15: **NEW authoritative plan for remaining neutrality work →
  `plan-q1q2-neutrality.md`.** Supersedes this file's "STILL feishu-named ... NOT
  a leak" line below — maintainer rejected that carve-out; it IS debt. Two
  workstreams: Q1 (channel MCP neutrality — core becomes a blind MCP conduit;
  the neutral contract + feishu-channel impl ALREADY exist, so it is core-side
  repoint + delete `feishu-mcp-surface.ts`) and Q2 (one provider-loading path —
  delete the static `registerBuiltin*` twin, builtin loads via the dynamic
  loader like npm). The 门禁/responsibility split (channel owns
  allowlist/grouplist/trustbot in access.json; core owns inbound routing /
  bind_channel; core's sole gift to the gate is a directory) is specified there.
  Prime directive: architecture > green tests; delete tests that pin removed
  machinery. Q2 partially applied in the working tree (config.ts + catalog
  deletions + server.ts done; cli/doctor/onboard/daemon/tests/docs pending) — the
  tree does NOT build until the cli/doctor/onboard/daemon repoint lands.

- 2026-06-14: **Phase 3b S0 + S1 COMPLETE + GREEN** (driven inline, not delegated —
  the cross-package contract is too coupled to fan out safely). State:
  - **S0 (dreamux-types contract)** built+tested green. Applied B1, B2, A1, A2, A3,
    + `injectEnv` on `AgentRuntimeCreateContext`, + `paths?` on
    `AgentRuntimeDiagnosticContext`. Two new public types
    (`ChannelMcpDescriptorContext`, `ChannelSessionlessToolContext`) added to the
    root-exports allowlist.
    - **B1 CORRECTION (code-grounded, verified against feishu-channel.ts:126-132):**
      `ChannelRoutes.deliver` is NOT `(envelope)` — it is
      `deliver(input: InboundTurnInput, envelope: ChannelInboundEnvelope, hooks?:
      InboundDeliveryHooks): Promise<InboundDeliveryResult>`. The neutral envelope
      cannot carry the turn CONTENT (text/body/attrs/attachments); the channel
      session normalizes it into `InboundTurnInput`, so the neutral deliver MUST
      carry it. This mirrors the session's `submitTurn(input, envelope, hooks)`
      EXACTLY → the package wrapper is a pure passthrough. (The written design §4.3
      under-specified this; corrected.)
    - **B2 path context:** dropped `stdoutLogPath`/`stderrLogPath`; added
      `logsDir(): string` AND `runtimeSocketDirs(): readonly string[]` (the neutral
      socket-dir accessor — see socket relocation below).
  - **Socket relocation (settled, refines design §9.2):** core no longer injects a
    socket-allocator FUNCTION. `AgentRuntimePathContext.runtimeSocketDirs()` exposes
    the host's preference-ordered candidate dirs (neutral); the codex package owns
    the fit-loop (`internal/socket.ts` `allocateCodexSocketPath(dirs,id)` +
    `representativeCodexSocketPath` for doctor) using dreamux-utils budget
    primitives. The diagnostic gets dirs via `AgentRuntimeDiagnosticContext.paths?`
    (reuses the same neutral path context — preserves doctor's socket pre-check).
  - **S1 dreamux-utils:** added `socket-budget.ts` (`DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES`,
    `unixSocketPathFitsBudget`, `assertUnixSocketPathBudget`). Built green.
    (Core's `platform/paths.ts` still has its own copies — transient dup, removed in
    S2 when core repoints to dreamux-utils.)
  - **S1 codex package** (build+test 27 + lint green): rewrote `codexProcessEnv` →
    `{...process.env, ...injectEnv, ...extraEnv}` (no PATH seed, no `delete CODEX_HOME`);
    runtime composes `<logsDir>/codex-app-server/<id>.log` (flat by runtime_id);
    provider builds socket allocator from `context.paths.runtimeSocketDirs()` + reads
    `context.injectEnv`; REMOVED `baseProcessEnv`/`allocateSocketPath` factory options;
    MOVED IN `codex-home.ts` + `diagnostic.ts` + `paths.ts` (home/config) +
    extracted `bin.ts` (`resolveCodexBinPath`, breaks the provider↔diagnostic cycle);
    provider now attaches its OWN `diagnostic`; exported all from index. `codexHomeDoctor`
    factory option KEPT for S1 (invert to package-self-check in S3).
  - **S1 claude-code package** (build+test 43 + lint green): deps `baseProcessEnv`→
    `injectEnv`; `buildProcessEnv` → neutral merge; stderr log composed from
    `<logsDir>/claude-code/<id>.stderr.log`; MOVED IN `diagnostic.ts`; provider drops
    `baseProcessEnv` option, reads `injectEnv`, attaches `diagnostic`; exported.
  - **S1 feishu-channel package** (build+test 98 + lint green): B1 `start(routes)` is a
    pure passthrough returning the real `routes.deliver(input,envelope,hooks)` result;
    added A1 `mcpServerDescriptor` (builds feishu-mcp stdio descriptor from neutral
    `command`+`adminSocketPath`), A2 `handleSessionlessTool('list_chat_bots')`, A3
    `getIdentity`→`config.appId`; MOVED IN `mcp-admin.ts`
    (`feishuMcpAdminMethod`/`Label`/`Params`+`FEISHU_MCP_SERVER_NAME`); exported.
  - **Constraints to honor in S2/S3 (consequences of the package decisions):**
    (a) RESOLVED — the host already mints a UNIQUE, fs-safe teammate `runtime_id`.
    `teammate/service.ts` `runtimeId(dispatcherId, runtimeIdentityName(identity))` =
    `validateDispatcherId(`${dispatcherId.slice(0,40)}.tm.${sha256(dispatcherId\0name).slice(0,12)}`)`,
    passed today as the adapter's `identity.runtime_id` (`= context.row.dispatcher_id`).
    Globally unique (hash folds dispatcher+name+team scope; teammate NAME is hashed not
    embedded, so old lossy `teamMateNameSegment` collisions are gone) and fs-safe
    (matches `DISPATCHER_ID_PATTERN`). Dispatcher's own `runtime_id` = its id (also a
    validated id). So flat `<logsDir>/<engine>/<runtime_id>.log` is collision-free and
    byte-identical to the old DISPATCHER path; only TEAMMATE logs relocate (nested→flat,
    rebuildable → minor changelog note). S2/S3 must preserve this mapping when building
    the neutral context (set teammate `runtime_id` = `runtimeId(...)`, not the bare name).
    (b) Core's host path
    context for claude binds `dispatcherDir` such that `<dispatcherDir>/mcp.json` lands
    where the old `dispatcherClaudeCodeMcpConfigPath` did. (c) register-builtins must NOT
    pass the deleted `baseProcessEnv`/`allocateSocketPath` options; it populates
    `injectEnv` (empty today) + the path context's `runtimeSocketDirs`. (d) doctor builds
    the diagnostic context with `paths` so the codex socket pre-check works.
  - Transient mid-stage dups (removed by S2/S5, per staging): core `platform/paths.ts`
    socket primitives; core `builtin/codex/{codex-home,diagnostic,paths}.ts` +
    `builtin/claude-code/diagnostic.ts` + core `feishu-mcp-surface.ts` admin helpers.
  - **NEXT: S2** (core host modules: host-paths.ts logsDir+runtimeSocketDirs,
    host-context.ts, register-builtins.ts, legacy-codex-skills.ts; re-type catalog).
- 2026-06-14: workspace created; Phase 1 launched.
- 2026-06-14: Phase 1 complete (task ws50mpro9, 6 agents). Plan archived to wip.
- 2026-06-14: Phase 2 (Foundations A/B/C) COMPLETE (task w866ts9dp) — all green,
  0 fix rounds. dreamux-utils created + 4 dup groups migrated; determinate fixes
  landed; config validation (Decision #4) done; rush change written. Known
  Phase-2 artifacts to undo in Phase 3 (per north star): turn.ts + paths.ts
  re-export shims (delete), tsconfig.tests.json is an inert no-op (revisit).
- 2026-06-14: maintainer hardened scope to the NORTH STAR (no builtin impls in
  Core; one unified Provider interface; full de-leak; dissolve builtin/ AND
  channel/feishu/). Phase 3a (design unified interface + relocation/de-leak map)
  launching next.
- 2026-06-14 (env-boundary + tm, RESOLVED with maintainer): see settled
  decision #6 below. Risk #1 (deliver->turnId) verified WIREABLE — full channel
  dissolution committed, no escape hatch. Risk #2 (host-hook injection asymmetry)
  RESOLVED by the env-boundary rewrite below (not deferred).
- 2026-06-15: **CHANNEL DISSOLUTION COMPLETE + ALL GATES GREEN.** Production now
  drives channels through the neutral `ChannelProvider`/`ChannelSession` seam:
  - New `channel/catalog.ts` (`ChannelProviderCatalog` + `createBuiltinChannelProviderCatalog`),
    mirroring `agent-runtime/catalog.ts`. Server builds it (or a test override
    `channelProviderCatalog`) and passes `channelProviders` to the dispatcher service.
  - `dispatcher/service.ts`: holds `Map<string, ChannelSession>` (was concrete
    `FeishuChannelSession`); start loop iterates `dispatcherConfig.channels`
    provider-agnostically → `provider.readConfig` → `provider.createSession(neutral ctx)`;
    `handleMcpTool`→`handleTool`, `messageBelongsToChat`→`messageBelongsToTarget`,
    sync `resolveTarget`→async; `start({submitTurn})`→`start({deliver})` with an
    `asInboundDeliveryResult` narrow. No-config defensive path = NO session.
  - `botFactory`/`skipBotSecret` REMOVED from Server/DispatcherService/DispatcherAgentService
    options (the secret-resolution seam is retired — config carries `{app_id,app_secret}`
    straight through). Package `createFeishuChannelProvider({ botFactory })` test seam
    added (mirrors codex/claude factory seams) for tests needing the real session + fake bot.
  - DELETED `channel/feishu/{bot.ts,feishu-channel.ts}`; RELOCATED feishu-mcp-surface.ts →
    `channel/feishu-mcp-surface.ts` (re-export block removed; absorbed the sessionless
    `handleFeishuListChatBots` host helper). `channel/feishu/` dir GONE.
  - `routeChannelInput` now takes the neutral `ChannelInboundEnvelope` and reads
    `envelope.target` directly (no resolveChannelTarget round-trip); `bindTeamChannel`/
    `transferTeamChannelBack` are async.
  - LOGGER FIX: core's fields-first pino logger was being handed to the message-first
    neutral `DreamuxLogger` slot → fields dropped. Added field-preserving
    `neutralLoggerFromHostLogger` (host-context.ts); dispatcher passes the wrapped
    `neutralLog` to BOTH `createRuntime` and `createSession` (also fixes a latent
    runtime-logger field-loss). Slot still keeps raw pino for core's own logging.
  - Tests: 8 files converted (helpers/fake-channel.ts: `feishuChannelCatalog(botFactory)`
    for real-session tests, `stubChannelCatalog()` for incidental-channel tests).
    channel-provider.test.ts PORTED (not slimmed) — verified the package has ZERO
    reply/react coverage, so core's is the only one.
  - GATES: tsc -p tsconfig.tests.json = 0 errors (60 files); vitest 635 passed/2 skipped;
    rush build + rush lint SUCCESS.
  - STILL feishu-named (advisor-confirmed core-owned host wire contract, NOT a leak):
    `callFeishuMcpTool`, `FeishuChannelToolCall`, `feishuMessageBelongsToChat`,
    `feishuMcpServerDescriptor` + admin routing, the `feishu-mcp` shim.
  - REMAINING (S6): bot_app_id→channel_identity de-leak (upgrade blocker, needs rush change);
    audit remaining re-export shims vs legit modules (criterion 2); package CLAUDE.md
    directory-map update (stale builtin/ + channel/feishu/ rows); tm removal; rush changes;
    KB decision record; final adversarial review.

## Settled decision #6 — env-injection boundary + tm retirement (maintainer 2026-06-14)

Triggered by drilling into Risk #2 (`baseProcessEnv`/socket host hooks that npm
providers can't get). Maintainer clarified the real architecture:

- **`baseProcessEnv` is NOT codex-specific and is mostly tm-era cruft.** Verified:
  `dispatcherProcessEnv` (`platform/package-bin.ts`) does exactly one substantive
  thing — prepend the dreamux package bin dir to PATH. Its ONLY wired consumer is
  the model invoking bare `tm` (base-prompt.ts:30). The 3 MCP shims
  (feishu/team/teammate) spawn via the ABSOLUTE `dreamuxBinPath`, NOT via PATH —
  so the codex-package comment "seeds PATH so the child can reach the bundled MCP
  shims" (`agent-runtime/codex/src/runtime-support.ts:8-12`) is STALE/inaccurate.
- **`delete CODEX_HOME` (`agent-runtime/codex/src/runtime-support.ts:28`) is
  removable cruft.** Verified: NOTHING sets `CODEX_HOME` anywhere (grep: only the
  delete + base-prompt.ts:71 "don't disturb CODEX_HOME" advice). It is residue
  from when dreamux used to set a dispatcher-private CODEX_HOME (caused problems,
  abandoned). Removing it makes codex inherit ambient env like vanilla codex —
  consistent with the "dispatcher app-server follows ~/.codex" invariant. Behavior
  note + rush change required (codex home resolution changes when an operator has
  ambient CODEX_HOME set).

THE CLEAN BOUNDARY (maintainer: "边界要特别清楚"):
- spawn env = `{ ...process.env, ...core.injectEnv, ...provider-config.extra_env }`
- **`extra_env`'s consumer is the PROVIDER, never core.** Provider reads it from
  its OWN config block and merges it itself. Core never sees/merges extra_env.
  (Today the dirty `baseProcessEnv(extraEnv)` hook makes the provider pass its
  extra_env BACK into core's function — backwards; that is the conflation to kill.)
- **Core RETAINS a neutral env-injection seam** = `injectEnv: Record<string,string>`
  on the neutral `AgentRuntimeCreateContext` (dreamux-types). Maintainer wants the
  ABILITY kept. Content is EMPTY now (tm injection retired → "no scenario" by
  maintainer's own words; the seam is a deliberate future affordance).

WHAT TO DELETE (this PR, mechanism + packaging — maintainer delegated tm timing
to me, "不要为兼容旧逻辑留垃圾代码"):
- `baseProcessEnv` factory hook on BOTH package provider factories
  (`agent-runtime/codex/src/provider.ts`, `agent-runtime/claude-code/src/provider.ts`)
  and the core adapters; packages read `context.injectEnv` from the create context
  instead (env is per-spawn → create context, not factory).
- `platform/package-bin.ts` `dispatcherProcessEnv` (tm-only PATH prepend). KEEP
  `dreamuxBinPath` (MCP shims use it as an absolute command).
- codex `codexProcessEnv`'s `delete CODEX_HOME` (and likely the whole wrapper —
  collapses to the trivial merge the runtime can inline).
- `@excitedjs/tm` dependency + `tm` package bin (`packages/dreamux/package.json`
  bin+deps, `packages/dreamux/bin/tm`) — vestigial once injection is gone. PENDING
  a full-repo `tm` reference sweep so removal is clean (tests/uninstall reporting).
  Update `.agents/decisions/dispatcher-tm-packaging.md` (superseded) + rush change
  (`tm` bin is published CLI surface). MAINTAINER MAY VETO the dep+bin removal and
  keep it for their tm-skill PR — default is full removal.

WHAT MAINTAINER OWNS (their NEXT PR, prose/skill track — do NOT touch here):
- base-prompt.ts tm instruction lines (18/29/30/35; line 71 CODEX_HOME advice STAYS).
- dispatcher bundled SKILL.md tm operational manual ("技能描述"; skill edits need
  skill-creator). One-PR window where tm prose is stale — maintainer accepted.
