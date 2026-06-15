# Issue #209 architecture cleanup — single ordered implementation plan

Branch `feature/i209-npm-package-split` (PR #223). One-shot cleanup, maintainer-approved.
Build path: `node common/scripts/install-run-rush.js build|test|lint`.

All file:line references below were re-verified against the working tree on this
branch. Where the investigation reports and the actual code diverge, the code wins
and the divergence is called out.

---

## 0. Executive summary

**Spine (ordered so the repo stays green between steps):**

- **A — Determinate fixes** in non-overlapping files (#1 repository field, #2 provider-loader key,
  #5 `CodexProcessExitHandler` re-export, #7 `slots.set` ordering, #10 binding-store fail-loud)
  + add the missing `packages/dreamux/tsconfig.tests.json` so test-only type errors are gated.
- **B — `@excitedjs/dreamux-utils`** leaf package: create, migrate 4 byte-identical helper groups
  (config-validate / os / completion-body / turn-render), repoint imports, delete copies + 3 core orphans.
  Atomic unit (register → `rush update` → build leaf → per-consumer repoint+delete).
- **C — Config validation change (Decision #4):** ADD per-dispatcher provider-ref uniqueness;
  REMOVE cross-dispatcher Feishu `app_id` uniqueness machinery. Align onboard to the single path.
- **D1 — Agent-runtime neutral-contract convergence:** catalog typed on neutral
  `AgentRuntimeProvider<unknown>`; one launcher-side `host-context.ts` builds the neutral create
  context once; each builtin `provider.ts` shrinks to host-hooks-factory + neutral diagnostic;
  external providers driven neutral with no adapter. **Includes diagnostic neutralization** (forced,
  see Risk R1).
- **D2 — Channel neutral-contract convergence:** strengthen `ChannelRoutes.deliver` to return a neutral
  `InboundDeliveryResult`; core holds `Map<string, ChannelSession>`; egress addressed by `channelId`;
  thread a channel-provider catalog into `DispatcherAgentServiceOptions`; replace the `as unknown as
  DispatcherFeishuConfig` casts with a validating extractor.

**Biggest risks (full detail in §11):**

1. **D1 diagnostic is NOT deferrable and needs a `dreamux-types` spec touch.** The codex/claude packages
   ship *no* diagnostic; the diagnostic lives only in core's host adapters and is host-coupled
   (`context.dispatcher.cwd`, host `codex-home.ts`). Because the neutral `AgentRuntimeProvider<TConfig>`
   embeds `diagnostic?: AgentRuntimeDiagnostic<TConfig>`, a neutral catalog forces neutralizing the
   diagnostic too — which requires adding `cwd` to the neutral `AgentRuntimeDiagnosticContext` and a
   `doctor.ts` rewrite. This is real surface the agent-runtime investigation explicitly (and wrongly)
   deferred.
2. **Decision #4 ADD reverses shipped PR #224** (multi-feishu-per-dispatcher, commit `63cd886`). Needs a
   BREAKING rush change + docstring/comment/test reconciliation + a one-line maintainer confirm.
3. **D2 ripples into admin + MCP**: `feishuMessageBelongsToChat` goes async (admin `await`),
   `callFeishuMcpTool` switches to `handleTool`, and `doStartDispatcher` needs a **new
   `channelProviders` option** threaded from `server.ts` — a prerequisite, not a leaf edit.

**Estimated edit surface:** ~48 files. New package: 6 files. Edited: ~30 src + ~9 tests. Deleted: ~9 (4
internal dup files ×2 packages + 3 core orphans + 1 feishu subset). 2 rush change files. 4 CLAUDE.md +
1 new decision record. The single largest blast radius is `dispatcher/service.ts` (touched in A, D1, D2)
and `config.ts` (C + D2).

---

## 1. Cross-step shared files — sequencing contract

These files are edited by more than one step. Edit them only in the order below; never re-open a region
a later step rewrites.

| File | A | B | C | D1 | D2 | Sequencing rule |
|---|---|---|---|---|---|---|
| `packages/dreamux/src/dispatcher-service/dispatcher/service.ts` | #7 `slots.set` move (region 406–463) | — | comments 68–73 / 392–395 (C) | `createRuntime` call @380 + imports | channels Map + session loop rewrite (region 404–441) | A does the minimal `slots.set` move first (independently testable). D2 **rebuilds the same loop region** and MUST preserve A's early `slots.set` + `slots.delete(id)` in catch, iterating the **local `channels`** var (not a slot lookup). D1 only touches the `createRuntime` call @380, a different region. |
| `packages/dreamux/src/config/config.ts` | — | imports @32–38 → dreamux-utils (B) | REMOVE `assertUniqueFeishuAppIds`/`soleFeishuConfigFromChannels`/`dispatcherFeishuAppId` + ADD provider-ref uniqueness | — | replace L681/L763 `as unknown as DispatcherFeishuConfig` casts with `extractFeishuConfig` | Do B's import repoint, then all C removals (the L700 cast vanishes with `soleFeishuConfigFromChannels`), then D2's two cast→extractor edits. Never touch the L681/L763 region in C. |
| `packages/dreamux/src/agent-runtime/types.ts` | — | — | — | replace host `AgentRuntimeProvider` / `AgentRuntimeCreateContext` / `AgentRuntimeStateStore` / `AgentRuntimeDiagnostic(Context)` / `DispatcherStatus` with neutral re-exports | — | D1-only. Single rewrite. |
| `packages/dreamux/src/agent-runtime/catalog.ts` | — | — | — | widen to neutral `AgentRuntimeProvider<unknown>` | — | D1-only. |
| `packages/dreamux/src/agent-runtime/builtin/{codex,claude-code}/provider.ts` | — | — | — | shrink to host-hooks factory + neutral diagnostic; delete `loggerFromHostLog`, the cast, the createRuntime translation | — | D1-only. |
| `packages/dreamux/src/dispatcher-service/teammate/service.ts` | — | turn.ts shim keeps its imports working | — | `createRuntime` call @898; collapse `runtimeRow`/`syntheticDispatcherConfig`; keep `runtimePaths` (see D1.6) | — | D1-only. |
| `packages/channel/feishu-channel/package.json` | #1 repository field | add `@excitedjs/dreamux-utils` dep (B) | — | — | — | A then B (different keys; either order is safe, but keep A first). |

---

## 2. Step A — Determinate fixes (non-overlapping files)

Each sub-step is independent; land them, then run the A checkpoint once.

### A1 — Fix #1: feishu-channel missing `repository`
- `packages/channel/feishu-channel/package.json` — insert after `"version": "0.1.0"`:
  ```json
  "repository": { "type": "git", "url": "git+https://github.com/excitedjs/dreamux.git", "directory": "packages/channel/feishu-channel" }
  ```
  Shape copied from `packages/channel/feishu-transport/package.json:6–10` (only `directory` differs).

### A2 — Fix #2: provider-loader registers under the wrong key
- `packages/dreamux/src/registry/provider-loader.ts:165` — change
  `registry.registerImplementation(seedDescriptor.id, provider)` →
  `registry.registerImplementation(provider.descriptor.id, provider)`.
  Verified: line 163 already registers the descriptor under `provider.descriptor.id` (for
  `existing === undefined`), and `seedDescriptorId(ref)` returns `ref.raw` for npm refs (line 217). For
  builtins `existing` is reused, so `seedDescriptor.id === provider.descriptor.id` and the change is a
  no-op there; for npm providers whose `descriptor.id !== ref.raw` it fixes the miss.

### A3 — Fix #5: re-export `CodexProcessExitHandler` (ordering: package first)
- `packages/agent-runtime/codex/src/index.ts` — add `type CodexProcessExitHandler` to the
  `./supervisor.js` export block (alongside `CodexProcess`, `CodexProcessOptions`, `CodexProcessExit`).
  Source type at `packages/agent-runtime/codex/src/supervisor.ts:54`.
- `packages/dreamux/src/agent-runtime/builtin/codex/supervisor.ts` — add `type CodexProcessExitHandler`
  to the re-export block from `@excitedjs/agent-runtime-codex`.
  Consumer that currently fails to compile: `packages/dreamux/tests/smoke.test.ts:35`.

### A4 — Fix #7: register the slot before the channel-start loop
- `packages/dreamux/src/dispatcher-service/dispatcher/service.ts`, `doStartDispatcher` (region 406–463):
  - Move `this.slots.set(id, { row, runtime, channels, log: channelLog })` (currently @458, after the
    try/catch) to **inside** the `try`, immediately after `await runtime.start()` (after line 407) and
    **before** the `for (const spec of specs)` loop. The `channels` Map is declared @404 and mutated by
    reference inside the loop, so the pre-registered slot sees sessions as they are added.
  - Add `this.slots.delete(id)` as the **first** statement of the `catch` block (before the
    `for (const session of channels.values())` close loop), to undo the pre-registration on a startup
    failure.
  - **Constraint (build-harness Risk 3):** the catch must keep iterating the **local `channels`**
    variable, not a slot lookup. D2 later rewrites this loop and must preserve both of these.

### A5 — Fix #10: binding-store `read()` fails loud on bad rows
- `packages/dreamux/src/dispatcher-service/channel-binding/store.ts`, `read()` (verified region ~174–188):
  - Replace `if (typeof row !== 'object' || row === null) continue;` with a `throw new LegacyStateError(...)`
    naming `path` + a `delete ${path} and re-bind` rebuild hint, matching the existing pre-v2-row throw
    just below.
  - Extend the `hasV2Keys` check (currently `hasOwnProperty('channel_id') && hasOwnProperty('target_key')`)
    to also assert `typeof row['channel_id'] === 'string' && row['channel_id'] !== ''` (and the same for
    `target_key`); otherwise throw the same `LegacyStateError`. `LegacyStateError` is already imported @8.

### A6 — Add `packages/dreamux/tsconfig.tests.json` (build-harness gap)
- The main package has **no** `tsconfig.tests.json`; test-only type errors (e.g. the #5 gap) are not gated
  by `rush typecheck` today, only caught at vitest runtime. Create it mirroring
  `packages/agent-runtime/codex/tsconfig.tests.json`: `extends: ./tsconfig.json`, `noEmit: true`,
  `rootDir: "."`, `types: ["node"]`, `include: ["src/**/*.ts", "tests/**/*.ts"]`. Add a
  `typecheck:tests` script to `packages/dreamux/package.json` consistent with the other packages.
  (Optional, same gap: `packages/channel/feishu-transport` also lacks one — out of scope, note only.)

**A checkpoint:**
```
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
DREAMUX_SKIP_LIVE_CODEX=1 node common/scripts/install-run-rush.js test --only @excitedjs/dreamux
```
Expect: smoke.test compiles (#5), binding-store tests still green (#10 only tightens already-invalid data),
dispatcher start tests green (#7). Add/confirm a #7 regression test: an inbound arriving during
`session.start()` resolves a running slot instead of throwing `not running`.

---

## 3. Step B — `@excitedjs/dreamux-utils` (atomic unit)

**Do the whole of B in one commit/PR slice.** Repointing a `workspace:*` import before `rush update`
leaves it unresolvable; a partial B breaks CI.

### B1 — Create the package skeleton
- `packages/dreamux-utils/package.json`:
  - `"name": "@excitedjs/dreamux-utils"`, `"version": "0.1.0"`, `"license": "MIT"`, `"type": "module"`.
  - `"repository": { "type": "git", "url": "git+https://github.com/excitedjs/dreamux.git", "directory": "packages/dreamux-utils" }` (npm provenance — required).
  - `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`,
    `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } }`,
    `"files": ["dist", "README.md", "LICENSE"]`.
  - `"dependencies": { "@excitedjs/dreamux-types": "workspace:*" }` (completion-body + turn-render need it).
  - `"devDependencies": { "@excitedjs/eslint-config": "workspace:*", "@types/node": "^22.10.0", "eslint": "^9.39.0", "typescript": "^5.7.0", "vitest": "^2.1.0" }` (versions copied from `dreamux-types`).
  - Scripts: `build` (`tsc -p tsconfig.json`), `typecheck`, `typecheck:tests`, `lint` (`eslint .`), `test` (`vitest run`), `clean`, `prepublishOnly`.
  - **Note:** do NOT add `eslint-plugin-n` directly — verified that codex/claude/dreamux-types get it
    transitively via `@excitedjs/eslint-config`; the 17.18.0 pin lives in the eslint-config package and
    must not be duplicated/floated here (build-harness Risk 6 applies to the config pkg, not this leaf).
- `packages/dreamux-utils/tsconfig.json`: byte-mirror `packages/agent-runtime/codex/tsconfig.json`
  (`target ES2023`, `module ESNext`, `moduleResolution Bundler`, `outDir ./dist`, `rootDir ./src`,
  `declaration`/`declarationMap`/`sourceMap` true, strict, NOT `emitDeclarationOnly`). **No `references`/
  `composite`** — verified no package in the repo uses TS project references.
- `packages/dreamux-utils/tsconfig.tests.json`: `extends ./tsconfig.json`, `noEmit: true`, `rootDir: "."`,
  `types: ["node"]`, `include: ["src/**/*.ts", "tests/**/*.ts"]`.
- `packages/dreamux-utils/eslint.config.js`: single line `export { default } from '@excitedjs/eslint-config';`.
- `packages/dreamux-utils/src/index.ts` barrel:
  ```ts
  export * from './config-validate.js';
  export * from './os.js';
  export * from './completion-body.js';
  export * from './turn-render.js';
  ```

### B2 — Copy the four source modules
- `src/config-validate.ts` ← verbatim from `packages/agent-runtime/codex/src/internal/config-validate.ts`
  (no dreamux-types dep). Exports: `isPlainObject`, `describeType`, `rejectUnknownKeys`,
  `requireNonEmptyString`, `readOptionalString`, `readOptionalBoolean`, `requireStringArray`,
  `requireStringRecord`, `requirePositiveInt`, `readProviderConfigObject`.
- `src/os.ts` ← verbatim from `packages/agent-runtime/codex/src/internal/os.ts` (full 94-line set; the
  feishu-channel copy is a subset). Exports: `isProcessAlive`, `killProcessGroup`,
  `EnsureOwnerOnlyDirOptions`, `ensureOwnerOnlyDir`, `removeEmptyLogFile`, `pathExists`.
- `src/completion-body.ts` ← merge the codex/claude `internal/completion-body.ts` with the core orphan
  `packages/dreamux/src/agent-runtime/completion-body.ts`. One private `safeSegment()`; export
  `teamMateCompletionOutputPath(spillDir, name, turnId)` (replaces the private `completionOutputPath` in
  the packages AND the exported `teamMateCompletionOutputPath` body in core `paths.ts`),
  `COMPLETION_INLINE_BUDGET_DEFAULT` (32000), `COMPLETION_INLINE_BUDGET_MAX` (160000),
  `ResolvedCompletionBody` type, `completionInlineBudget`, `resolveCompletionBody`. Import
  `CompletionEnvelope` from `@excitedjs/dreamux-types`; call `ensureOwnerOnlyDir` from `./os.js`.
- `src/turn-render.ts` ← verbatim from `packages/agent-runtime/codex/src/internal/turn-render.ts`. Exports:
  `DEFAULT_MESSAGE_ID_DEDUPE_WINDOW` (1024), `renderChannelBlock`, `renderChannelInput`. Import
  `InboundTurnInput` from `@excitedjs/dreamux-types`.

### B3 — Register + install
- `rush.json` — add after the `dreamux-types` entry:
  `{ "packageName": "@excitedjs/dreamux-utils", "projectFolder": "packages/dreamux-utils", "shouldPublish": true }`.
- Run `node common/scripts/install-run-rush.js update`.
- Build the leaf alone: `node common/scripts/install-run-rush.js build --only @excitedjs/dreamux-utils`
  and `lint --only @excitedjs/dreamux-utils`.

### B4 — Repoint consumers, then delete copies (per package)
Add `"@excitedjs/dreamux-utils": "workspace:*"` to each consumer's `dependencies` first, then repoint,
then delete. Re-run `rush update` after the package.json dep edits.

**codex package** (`packages/agent-runtime/codex/`):
- `src/config.ts:19` `./internal/config-validate.js` → `@excitedjs/dreamux-utils`
- `src/supervisor.ts:24–28` `./internal/os.js` → `@excitedjs/dreamux-utils`
- `src/runtime-support.ts:6` `./internal/completion-body.js` → `@excitedjs/dreamux-utils`
- `src/runtime.ts:38` and `src/turn-manager.ts:18` `./internal/turn-render.js` → `@excitedjs/dreamux-utils`
- DELETE `src/internal/{config-validate,os,completion-body,turn-render}.ts`.

**claude-code package** (`packages/agent-runtime/claude-code/`):
- `src/config.ts:22` config-validate → utils; `src/supervisor.ts:15–18` os → utils;
  `src/runtime.ts:72–73` completion-body + turn-render → utils.
- DELETE `src/internal/{config-validate,os,completion-body,turn-render}.ts`.

**feishu-channel package** (`packages/channel/feishu-channel/`):
- `src/feishu-message.ts:12` `{ ensureOwnerOnlyDir }` from `./internal/os.js` → `@excitedjs/dreamux-utils`.
- DELETE `src/internal/os.ts` (subset, absorbed by the full set).

**core** (`packages/dreamux/`):
- `src/config/config.ts:32–38` named imports from `./validate.js` → `@excitedjs/dreamux-utils`.
- `src/admin/socket.ts:14` and `src/daemon/restart-intent.ts:27` from `../platform/owner-only-dir.js` →
  `@excitedjs/dreamux-utils`.
- `src/platform/paths.ts` (`teamMateCompletionOutputPath`, ~379–388): replace the body with a re-export
  shim `export { teamMateCompletionOutputPath } from '@excitedjs/dreamux-utils';` — keeps test import
  paths stable. **Keep `teamMateNameSegment` in paths.ts** (dup-utils Risk 3): it backs many path
  builders; dreamux-utils uses its own private `safeSegment`.
- `src/agent-runtime/turn.ts`: remove the render-helper implementations; add
  `export { DEFAULT_MESSAGE_ID_DEDUPE_WINDOW, renderChannelBlock, renderChannelInput } from '@excitedjs/dreamux-utils';`
  and **keep all type re-exports from `@excitedjs/dreamux-types` unchanged** (service.ts, teammate/service.ts
  and many tests import them from here). turn.ts stays as a shim, it is NOT deleted.
- Test repoints: `tests/completion-body.test.ts:8–13` budget consts + `resolveCompletionBody` →
  `@excitedjs/dreamux-utils` (its `teamMateCompletionOutputPath` import @14 stays on `../src/platform/paths.js`
  via the shim); `tests/log-hygiene.test.ts:8` `removeEmptyLogFile` from `../src/platform/logs.ts` → utils;
  `tests/run-dir-hardening.test.ts:14` `ensureOwnerOnlyDir` from `../src/platform/owner-only-dir.js` → utils.
  `tests/codex-completion.test.ts:7` and `tests/claude-code-runtime.test.ts:29` need **no change** (paths.ts shim).
- DELETE core orphans/now-unused: `src/agent-runtime/completion-body.ts` (orphan — no src importer),
  `src/config/validate.ts`, `src/platform/process.ts` (true orphan, zero importers — verify with a repo grep
  before delete), `src/platform/logs.ts`, `src/platform/owner-only-dir.ts`.
  - **Do NOT touch `src/platform/fs-errors.ts`** — its `pathExists`/`isNotFound` have heavy core usage and
    different semantics from os.ts's `pathExists` (dup-utils Risk 4).

**B checkpoint (after each empty `internal/` dir is removed if truly empty):**
```
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
DREAMUX_SKIP_LIVE_CODEX=1 node common/scripts/install-run-rush.js test
```
Also confirm the codex/claude-code import-boundary tests still pass and that their `@excitedjs/dreamux`
grep is an exact match (not a prefix that would catch `@excitedjs/dreamux-utils`) — dup-utils Risk 10.

---

## 4. Step C — Config validation (Decision #4)

All edits in `packages/dreamux/src/config/config.ts` happen here (after B's import repoint, before D2's
cast→extractor edits). C does not touch the L681/L763 cast region.

### C1 — ADD per-dispatcher provider-ref uniqueness
- `readDispatcherChannels` (verified: `channelIds` Set @593, dup check @604/add @609): add a parallel
  `const providerRefs = new Set<string>()` next to `channelIds`. After `provider` is resolved (the
  `provider.ref` from `resolveConfigProvider`), before processing `rawConfig`/`channelProvider`:
  `if (providerRefs.has(provider.ref)) throw new Error(<file + dispatcher prefix> 'channel provider ref
  ' + provider.ref + ' duplicates another channel in this dispatcher; each provider may appear at most
  once per dispatcher')` then `providerRefs.add(provider.ref)`. Match the existing `channelIds` error
  style (file name + dispatcher prefix).

### C2 — REMOVE cross-dispatcher Feishu app_id uniqueness machinery
- `config.ts:527` remove the `assertUniqueFeishuAppIds(out, file)` call.
- `config.ts:693–701` remove `soleFeishuConfigFromChannels` (its L700 cast vanishes with it).
- `config.ts:719–722` remove exported `dispatcherFeishuAppId`.
- `config.ts:776–792` remove private `assertUniqueFeishuAppIds`.
- **Keep** `feishuConfigFromChannels` (L662) + `dispatcherFeishuConfig` (L706) — still used by
  `platform/secrets.ts:12`. Keep `dispatcherFeishuChannels` (L756) — still used by `dispatcher-store.ts`
  and (until D2) `doStartDispatcher`.
- `config.ts:744–765` update the `dispatcherFeishuChannels` docstring: drop "a dispatcher can run more
  than one Feishu bot at once"; state the config layer now enforces ≤1 channel per provider ref.

- `state/dispatcher-store.ts`: line 5 import — drop `dispatcherFeishuAppId`, add `dispatcherFeishuChannels`.
  Line 235 `rowDefaults`: replace `dispatcherFeishuAppId(config)` with the inline
  `dispatcherFeishuChannels(config)[0]?.config.app_id ?? ''` (verified that is exactly what
  `dispatcherFeishuAppId` returned). Lines 94–99: remove the `duplicateApp` `bot_app_id` guard block and
  its throw. (Ordering hazard: this file and config.ts must change together — `dispatcherFeishuAppId` is
  deleted in config.ts.) Note `bot_app_id` column persists in `DispatcherRow`/`status.json` — no schema change.

- `onboard/config-files.ts`: line 9 drop `dispatcherFeishuConfig` from the import (only the deleted local
  `assertUniqueFeishuAppIds` used it); line 55 remove the `assertUniqueFeishuAppIds(next)` call; lines
  71–83 remove the local `assertUniqueFeishuAppIds`. **Verify** the surrounding onboard test asserts more
  than the duplicate throw (see C-tests) — the function also guarded a rollback-on-error path.

### C3 — Tests
- DELETE `tests/global-config.test.ts:1042–1073` ("enforces cross-dispatcher Feishu app_id uniqueness").
- `tests/global-config.test.ts:960–985` ("accepts multiple channels with unique dispatcher-local ids"):
  this fixture (two `builtin:feishu` channels) now FAILS C1. Either invert to
  `rejects.toThrow(/provider .*duplicates another channel/)` OR replace the second channel with a distinct
  hypothetical provider ref to keep a positive multi-provider test. Add a dedicated negative test for the
  new duplicate-provider-ref error.
- `tests/onboard.test.ts:726` (`/duplicates dispatcher 'flow'/`): the second onboard run now SUCCEEDS.
  Rework the test — likely it asserted rollback-on-failure; convert to a positive replace-path assertion
  or move the negative expectation to the config-level provider-ref test.
- `tests/dispatcher-store.test.ts:222–250`: rename + rewrite the comment (it references the removed
  cross-dispatcher guard). Logic still passes (rowDefaults still computes `bot_app_id` from the first
  channel). No behavior change.

### C4 — rush change (BREAKING) + docs
- `common/changes/@excitedjs/dreamux/<slug>.json`: `packageName "@excitedjs/dreamux"`, `type "minor"`,
  `email "053700@gmail.com"`. Comment leads with
  `BREAKING: dispatchers[].channels[] now rejects two channels that use the same provider ref on one
  dispatcher (e.g. two builtin:feishu channels no longer load).` and
  `Rebuild: remove the duplicate-provider channel from ~/.dreamux/config.json (keep one) and re-run
  dreamux serve.`
  - The REMOVE side (relaxing app_id uniqueness) needs **no** change file — it never blocks a previously
    valid config.
- Reconcile docstrings/comments touched by the capability scope-down (Knowledge-delta protocol — this
  moves a settled design decision): `dispatcher/service.ts:68–73` (`DispatcherAgentSlot` comment) and
  `:392–395` (session-loop comment). Update the multi-channel narrative + reconcile the `.agents/` record
  that PR #224 added for live multi-channel routing.

**C checkpoint:**
```
node common/scripts/install-run-rush.js build
DREAMUX_SKIP_LIVE_CODEX=1 node common/scripts/install-run-rush.js test --only @excitedjs/dreamux
```
Target the config/onboard/dispatcher-store test files explicitly.

---

## 5. Step D1 — Agent-runtime neutral-contract convergence

Goal (Decision #1): catalog typed on neutral; build the neutral create context **once** at the launcher;
each builtin `provider.ts` shrinks to a host-hooks factory (+ neutral diagnostic); external providers
driven neutral with **no** adapter. **Diagnostic neutralization is included** — it is not deferrable
(Risk R1).

### D1.1 — dreamux-types: add `cwd` to the neutral diagnostic context (spec touch — see R1)
- `packages/dreamux-types/src/agent-runtime.ts:353–358` `AgentRuntimeDiagnosticContext<TConfig>`: add
  `cwd: string;`. Verified the codex host diagnostic needs cwd (`context.dispatcher.cwd ??
  defaultDispatcherCwd(id)`) and the neutral context lacks it; claude needs no cwd. `env` is already
  `DreamuxEnvironment = Record<string, string | undefined>`, structurally compatible with the host's
  `NodeJS.ProcessEnv` usage in doctor — no env change needed.
- Rebuild `dreamux-types` first so downstream consumers see the new field.

### D1.2 — New launcher helper: `packages/dreamux/src/agent-runtime/host-context.ts`
Owns the single host→neutral create-context construction (the logic deleted from both builtin adapters):
```ts
import type {
  AgentRuntimeCreateContext, AgentRuntimeProvider, AgentRuntimeStateCallbacks, DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { DispatcherStore } from '../state/dispatcher-store.js';

export function loggerFromHostLog(
  log: (level: 'info'|'warn'|'error', msg: string, err?: unknown) => void,
): DreamuxLogger { /* consolidated from the two byte-identical copies */ }

export function dispatchersToStateCallbacks(d: DispatcherStore): AgentRuntimeStateCallbacks {
  return {
    setStatus: (id, status, extras) => d.setStatus(id, status, extras),
    setThreadId: (id, threadId) => d.setThreadId(id, threadId),
    recordLostThread: (id, lost, neu, err) => d.recordLostThread(id, lost, neu, err),
  };
}

// Builds the neutral context. config is supplied by the caller (it already called
// provider.readConfig); paths/state/logger are derived from host inputs.
export interface HostLaunchInputs<TConfig> {
  identity: { runtime_id: string; checkpoint_id?: string | null };
  role: AgentRuntimeRole;
  config: TConfig;
  cwd: string;
  mcpServers: readonly AgentRuntimeMcpServer[];
  skillSources?: readonly AgentRuntimeSkillSource[];
  systemPromptContent?: string;
  paths: AgentRuntimePathContext;          // launcher now supplies explicitly
  state: AgentRuntimeStateCallbacks;
  logger?: DreamuxLogger;
  onTurnSettled?: (s: TurnSettledSignal) => void;
}
export function buildNeutralAgentRuntimeContext<TConfig>(
  i: HostLaunchInputs<TConfig>,
): AgentRuntimeCreateContext<TConfig> { /* spread, omitting undefined optionals */ }
```
Also consolidate the byte-identical `codexRowStateStore`/`claudeCodeRowStateStore` here as
`dispatchersToStateCallbacks` (delete them from the two `runtime-support.ts`; keep `defaultCodexRuntimePaths`
/ `defaultClaudeCodeRuntimePaths` there).

### D1.3 — Neutralize the host `types.ts`
- `packages/dreamux/src/agent-runtime/types.ts`:
  - Replace host `AgentRuntimeCreateContext` (129–172) with `export type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';`
  - Replace host `AgentRuntimeProvider` (202–217) with the neutral re-export.
  - Replace host `AgentRuntimeStateStore` (the dup of `AgentRuntimeStateCallbacks`) with the neutral
    `AgentRuntimeStateCallbacks` re-export (keep an `AgentRuntimeStateStore` alias if other files import
    that name, to limit churn).
  - Replace host `AgentRuntimeDiagnostic` / `AgentRuntimeDiagnosticContext` with neutral re-exports.
  - Replace `DispatcherStatus` usages with neutral `AgentRuntimeStatus` (byte-identical union).
- `teammate/runtime-state.ts`: `implements AgentRuntimeStateStore` → `AgentRuntimeStateCallbacks`;
  `setStatus` param `DispatcherStatus` → `AgentRuntimeStatus`. No body change.

### D1.4 — catalog + external-provider typed neutral
- `catalog.ts:12/44/51`: import + `list()`/`resolve()` return `AgentRuntimeProvider<unknown>`.
  `asAgentRuntimeProvider()` duck-typing (144–156) unchanged.
- `external-provider.ts:43/93–113`: `ExternalAgentRuntimeProviderFactory` → `ProviderFactory<AgentRuntimeProvider<unknown>>`;
  `assertExternalAgentRuntimeProvider` validates the neutral shape (presence of `ref`/`descriptor`/
  `getCapabilities`/`createRuntime`; it never inspected the host-only create-context fields, so this is
  mostly type-level). **Resolution of the `<unknown>` question (R4):** the launcher operates on
  `AgentRuntimeProvider<unknown>`; `provider.readConfig(raw)` yields `unknown`, fed straight into the same
  provider's `createRuntime(ctx<unknown>)` — type-consistent without a per-provider typed handle.
  `buildNeutralAgentRuntimeContext<TConfig>` is generic but called as `<unknown>` at catalog-driven sites.

### D1.5 — Shrink both builtin `provider.ts` to host-hooks factory + neutral diagnostic
- `builtin/codex/provider.ts`: delete `loggerFromHostLog` (→ host-context.ts), delete the
  `as unknown as DispatcherProviderConfig` cast (124), delete the entire `createRuntime` translation
  (126–154). `createCodexAgentRuntimeProvider(options)` now returns the **package** provider (created via
  `createPackageCodexProvider` with the host hooks: `allocateSocketPath`, `baseProcessEnv`,
  `codexHomeDoctor`) with the neutral diagnostic attached:
  `return { ...pkg, diagnostic: codexAgentRuntimeDiagnostic };` where `pkg` is
  `AgentRuntimeProvider<DispatcherCodexConfig>` and `codexAgentRuntimeDiagnostic` is the neutralized
  diagnostic (D1.6). Return type becomes `AgentRuntimeProvider<DispatcherCodexConfig>`.
- `builtin/claude-code/provider.ts`: same shape (delete `loggerFromHostLog`, cast @100, createRuntime
  translation 102–133; attach the neutralized `claudeCodeAgentRuntimeDiagnostic`).
- Delete `codexRowStateStore`/`claudeCodeRowStateStore` from the two `runtime-support.ts`.

### D1.6 — Neutralize the two host diagnostic adapters + rewrite doctor
- `builtin/codex/diagnostic.ts`: change the type to `AgentRuntimeDiagnostic<DispatcherCodexConfig>`
  (neutral). Map field reads: `context.dispatcher.id` → `context.runtime_id`;
  `dispatcherCodexConfig(context.dispatcher)` → `context.config`; `context.dispatcher.cwd ??
  defaultDispatcherCwd(...)` → `context.cwd`; `context.env` unchanged. It keeps using host `codex-home.ts`
  (`dispatcherCodexHomeDoctorContext`, `validateDispatcherCodexHome`) — those are host filesystem checks,
  fed from neutral fields. `defaultDispatcherCwd` import can be dropped (cwd now always supplied).
- `builtin/claude-code/diagnostic.ts`: change to `AgentRuntimeDiagnostic<DispatcherClaudeCodeConfig>`;
  `dispatcherClaudeCodeConfig(context.dispatcher).bin` → `context.config.bin`. No cwd needed.
- `cli/doctor.ts`: `readDispatchers` (305–324) and `runtimeBinaryChecks` (534–569) build the **neutral**
  context `{ runtime_id: dispatcher.id, config: dispatcher.runtime.config, env, scope, cwd }`.
  **`config` is `dispatcher.runtime.config` passed DIRECTLY** — verified (config.ts:440–450) that config
  load stores `readConfig`'s parsed output into `runtime.config`, and `dispatcherCodexConfig` merely casts
  it; doctor must NOT re-invoke `provider.readConfig` (re-parsing an already-parsed object risks
  non-idempotent transforms / unknown-key rejection). `cwd` = `dispatcher.cwd ?? defaultDispatcherCwd(dispatcher.id)`.
  No async change to `runtimeBinaryChecks` is forced by config (it stays as today). The empty-dispatchers
  codex-bin edge (545–556, `resolveCodexBinPath(DEFAULT_CODEX_BIN, env)`) does not go through a diagnostic
  and stays as-is. `import type { AgentRuntimeDiagnosticContext }` (23) now resolves to the neutral type.

### D1.7 — Launcher call sites build neutral context once
- `dispatcher/service.ts:380` (`doStartDispatcher`): replace the host-shaped object with:
  resolve `provider` (already done); **`config` is `dispatcherConfig.runtime.config` passed directly**
  (already parsed at load — see D1.6; the launcher does NOT call `provider.readConfig`, so no `{file,prefix,
  agentId}` synthesis); `const paths = dispatcherRuntimePaths(provider.ref)` (see D1.8); then
  `const neutral = buildNeutralAgentRuntimeContext({ identity: { runtime_id: row.dispatcher_id, checkpoint_id: row.thread_id }, role: 'dispatcher', config: dispatcherConfig.runtime.config, cwd, mcpServers: this.dreamuxMcpServerDescriptors(id), skillSources: bundledSkillSourcesForRole('dispatcher'), systemPromptContent, paths, state: dispatchersToStateCallbacks(this.opts.dispatchers), logger: <channelLog adapted to DreamuxLogger> });`
  (verify `channelLog`'s type: if it is already a structured pino-style logger, write one direct
  `channelLog → DreamuxLogger` adapter rather than the current `loggerFromHostLog(loggerToLevelFn(channelLog))`
  round-trip; keep `loggerFromHostLog` only for genuine `(level,msg,err)` callers.)
  then `const runtime = provider.createRuntime(neutral);`. (The dispatcher passes no `onTurnSettled` — preserved.)
  The prior per-builtin `dispatcher === null → default*Config()` fallback (only reachable via the defensive
  no-config path) is retained inside the builtin provider factory if it must survive; a started dispatcher
  always resolves an `agents[]` entry, so `runtime.config` is present.
- `teammate/service.ts:898`: same pattern, `config: agent.config` passed directly (already parsed).
  `runtimeRow` (1108) and `syntheticDispatcherConfig` (1384) collapse into
  `identity: { runtime_id: <composite teammate runtime id>, checkpoint_id: <session_id/thread id> }`.
  **Preserve exactly** the existing `runtime_id`/`checkpoint_id` derivation (agent-runtime Risk 2 — these
  are the composite teammate runtime id and the runtime-native thread id, NOT the real dispatcher id). Keep
  the `onTurnSettled` wiring unchanged.

### D1.8 — `paths` injection (keep host-side; do NOT add a dreamux-types path capability)
Both launchers must now supply `paths` explicitly (the adapter no longer defaults it). The path *layouts*
are host paths under `~/.dreamux` and legitimately host-owned. Consolidate the selection into one host
helper rather than a contract addition:
- For the **dispatcher**: the static defaults `defaultCodexRuntimePaths` / `defaultClaudeCodeRuntimePaths`
  (in each builtin runtime-support.ts). Add a small core helper
  `dispatcherRuntimePaths(providerRef): AgentRuntimePathContext` (the single ref-branch) — core importing
  builtin host modules is allowed (it is all core).
- For the **teammate**: keep `runtimePaths(identity, providerRef)` (teammate/service.ts:1134) as-is — it
  builds per-identity host paths and already branches on `BUILTIN_CLAUDE_CODE_PROVIDER_REF`.
- **Decision:** the `if (ref === BUILTIN_CLAUDE_CODE_PROVIDER_REF)` branch is retained (host selecting host
  path layouts), NOT removed. Fully de-leaking it requires a neutral provider `defaultPaths`/`buildPaths`
  capability — a dreamux-types addition beyond the enumerated settled scope. Flagged as an optional
  follow-up (R5), not part of this PR. This keeps the create-context neutral (the contract carries neutral
  `AgentRuntimePathContext`) while leaving host path-layout selection in host code.

### D1.9 — provider-loader bug #2
Already done in A2 (no duplicate work).

**D1 checkpoint:**
```
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
DREAMUX_SKIP_LIVE_CODEX=1 node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js test --only @excitedjs/dreamux   # codex live, if codex installed
```
Target `tests/codex-0135-live.test.ts`, the doctor tests, and dispatcher/teammate launch tests. Confirm
`dreamux doctor` still reports codex home/version checks (the neutralized diagnostic path).

---

## 6. Step D2 — Channel neutral-contract convergence

Goal (Decision #2): inbound submit returns a neutral result; core holds `Map<string, ChannelSession>`;
egress addressed by `channelId`; remove the `as unknown as DispatcherFeishuConfig` casts.

### D2.1 — Strengthen the neutral channel contract
- `packages/dreamux-types/src/channel.ts:105–107` `ChannelRoutes`: import `InboundTurnInput`,
  `InboundDeliveryHooks`, `InboundDeliveryResult` from `./turn.js`; change
  ```ts
  deliver(envelope: ChannelInboundEnvelope): Promise<void>;
  ```
  to
  ```ts
  deliver(
    envelope: ChannelInboundEnvelope,
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<InboundDeliveryResult>;
  ```
  (`InboundDeliveryResult` already covers `duplicate | stopped | { submitted; turnId } | { failed; error }`
  — turn.ts:48–52.) Rebuild `dreamux-types`.
  - **Return-type narrowing (required, else D2 won't compile):** core's `deliver` body ends with
    `?? runtime.channelInput(input, hooks)`, and `channelInput` returns `Promise<AgentRuntimeTurnResult>`
    (= `InboundDeliveryResult | NoticeInjectionResult`, agent-runtime.ts:245/318). `NoticeInjectionResult`
    carries `{ status: 'skipped' }`, which is NOT in `InboundDeliveryResult`, so the union is not
    assignable to the strengthened return. `'skipped'` only ever arises from `systemInput`, never channel
    inbound — so core narrows the `channelInput` result before returning (treat a (never-occurring)
    `'skipped'` as `'submitted'` or assert-unreachable). The `routeChannelInput` test-seam return type must
    also be the narrowed `InboundDeliveryResult`, not the raw union.

### D2.2 — Fix the feishu-channel bridge (no more synthesized status)
- `packages/channel/feishu-channel/src/provider.ts:107–114` `NeutralFeishuChannelSession.start`: change
  `submitTurn: async (_input, envelope) => { await routes.deliver(...); return { status: 'submitted', turnId: envelope.messageId }; }`
  to `submitTurn: async (input, envelope, hooks) => routes.deliver(inboundEnvelopeToNeutral(this.channel_id, envelope), input, hooks)`.
  `inboundEnvelopeToNeutral` (81–95) already pre-embeds the resolved `target`.

### D2.3 — Thread a channel-provider catalog into the dispatcher agent service (prerequisite)
- `dispatcher/service.ts` `DispatcherAgentServiceOptions`: add a `channelProviders: ChannelProviderCatalog`
  field (the channel-kind analogue of `agentRuntimeProviders`). Thread it from `server.ts` wiring
  (`registerBuiltinChannelProviders` already builds the registry). Without it, `doStartDispatcher` cannot
  call `channelProviders.resolve(spec.provider).createSession(...)`.

### D2.4 — Core holds neutral `ChannelSession`; rewrite the session-creation loop
- `dispatcher/service.ts` imports (1–17): drop `FeishuChannelSession`, `createFeishuChannelSession`,
  `FeishuInboundEnvelope` from `../../channel/feishu/feishu-channel.js`; add `ChannelSession`,
  `ChannelInboundEnvelope`, `InboundDeliveryResult` from `@excitedjs/dreamux-types`.
- `DispatcherAgentSlot.channels` (74): `Map<string, FeishuChannelSession>` → `Map<string, ChannelSession>`.
- `DispatcherAgentServiceOptions.routeChannelInput` (56–63): `envelope: FeishuInboundEnvelope` →
  `ChannelInboundEnvelope`; return `Promise<InboundDeliveryResult>`.
- `doStartDispatcher` loop (404–441) — **rebuild preserving A4's early `slots.set` + catch `slots.delete`**:
  `new Map<string, ChannelSession>()`; for each spec, `session = channelProviders.resolve(spec.provider)
  .createSession({ dispatcher_id: id, channel_id: spec.channelId, provider: spec.provider, config:
  spec.rawConfig, logger: channelLog-as-DreamuxLogger, state_root: <dispatcher state-dir builder>,
  cache_root: <dispatcher cache-dir builder> })` — name the existing host path builders (the state/cache
  roots `createFeishuChannelSession` resolves today) rather than leaving them implicit; `channels.set(channelId,
  session)`; `await session.start({ deliver: (envelope, input, hooks) => this.opts.routeChannelInput?.(id,
  channelId, envelope, input, hooks) ?? <narrowed>(runtime.channelInput(input, hooks)) })` (narrowing per
  D2.1). Catch loop keeps iterating local `channels`.
  - `createFeishuChannelSession` host adapter survives only for the sessionless `list_chat_bots` helper
    (channel Risk 2) — do not delete it.
  - The Feishu-specific enumeration `dispatcherFeishuChannels` is replaced by provider-agnostic channel
    enumeration (`dispatcher.channels.map(c => ({ channelId: c.id, provider: c.provider, rawConfig: c.config }))`).
    `assertRunnableChannelShape` (the `builtin:feishu`-only guard, dispatcher/service.ts:360) becomes a
    catalog-presence check (channel Risk 7) — generalize it to "provider ref is a registered channel
    provider".

### D2.5 — Feishu-specific method calls → neutral `ChannelSession` members
- `callFeishuMcpTool` (264–275): keep the `list_chat_bots` fast-exit (267–269); replace
  `session.handleMcpTool(toolName, arguments)` with
  `session.handleTool?.({ name: input.toolName, arguments: input.arguments }, { dispatcher_id:
  input.dispatcherId, channel_id: slot.row.dispatcher_id })` + a fallback throw if `handleTool` absent.
- `feishuMessageBelongsToChat` (277–290): make `async`; replace
  `session.messageBelongsToChat(messageId, chatId)` with
  `await session.messageBelongsToTarget?.({ target: { target_type: 'group', target_key: chatId, bindable:
  true }, message_id: messageId })`. Returns `Promise<boolean>`.
- `sessionFor()` (298–318): return `ChannelSession`.
- `resolveChannelTarget` (329–338): make `async`, `await session.resolveTarget(meta)`, return
  `Promise<ChannelTarget>`.

### D2.6 — Propagate async + neutral envelope to outer service + admin
- `dispatcher-service/service.ts:191–231` `routeChannelInput`: `envelope: ChannelInboundEnvelope`;
  return `Promise<InboundDeliveryResult>`; replace the `resolveChannelTarget(...)` call (202–208) with
  `envelope.target` (the envelope already carries the resolved target). Remove the now-unused Feishu-field
  extraction.
- `dispatcher-service/service.ts:323–341` `bindTeamChannel` and `:344–360` `transferTeamChannelBack`: add
  `async` + `await` on the `resolveChannelTarget(...)` calls (330, 350). Confirm their admin callers
  already `await` the returned promise (channel Risk 5).
- `admin/methods.ts:411–417` (`assertFeishuScope`): add `await` before
  `feishuMessageBelongsToChat(...)` (already inside an async fn). Consider renaming the
  `DispatcherService` method `feishuMessageBelongsToChat` → `channelMessageBelongsToTarget` and the chatId
  param to a target struct (channel Risk 3) — optional within this PR; if renamed, update this single
  caller.

### D2.7 — Replace the config casts with a validating extractor
- `config.ts`: add `function extractFeishuConfig(raw: Record<string, unknown>): DispatcherFeishuConfig`
  that throws unless `app_id`/`app_secret` are non-empty strings. Replace the L681
  (`feishuConfigFromChannels`) and L763 (`dispatcherFeishuChannels`) `as unknown as DispatcherFeishuConfig`
  casts with `extractFeishuConfig(...)`. (The L700 cast already vanished in C2.)

### D2.8 — Tests + docs
- Update test fakes wiring `routeChannelInput` (new envelope type + `InboundDeliveryResult` return) and
  any `FeishuChannelSession`-typed channel fixtures (channel Risk 4).
- `packages/dreamux/CLAUDE.md` `channel/feishu/` row and the channel boundary notes: reflect that core now
  holds neutral `ChannelSession` and resolves sessions via the channel catalog.

**No rush change** is required for D2 by itself (no config/state/path format change). If the binding-target
shape surfaced to operators changes, re-evaluate.

**D2 checkpoint:**
```
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
DREAMUX_SKIP_LIVE_CODEX=1 node common/scripts/install-run-rush.js test
```
Target the channel-binding, dispatcher channel-routing, admin scope, and multi-channel tests. Confirm the
RECEIVED/IN_PROGRESS reaction ledger now keys off the real `InboundDeliveryResult` (no spurious IN_PROGRESS
on duplicate/stopped).

---

## 7. New neutral contract shapes (precise)

**Channel inbound submit (D2.1)** — `packages/dreamux-types/src/channel.ts`:
```ts
export interface ChannelRoutes {
  deliver(
    envelope: ChannelInboundEnvelope,
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<InboundDeliveryResult>;
}
```
`InboundDeliveryResult = { status: 'duplicate' } | { status: 'stopped' } | { status: 'submitted'; turnId: string } | { status: 'failed'; error: Error }` (existing, turn.ts:48–52).

**Diagnostic context (D1.1)** — `packages/dreamux-types/src/agent-runtime.ts`:
```ts
export interface AgentRuntimeDiagnosticContext<TConfig = unknown> {
  runtime_id: string;
  config: TConfig;
  env: DreamuxEnvironment;
  scope: 'foreground' | 'managedService';
  cwd: string;                 // NEW — codex home doctor needs it; claude ignores it
}
```

**Neutral launch-context owner (D1.2)** — `packages/dreamux/src/agent-runtime/host-context.ts`:
`buildNeutralAgentRuntimeContext<TConfig>(inputs)` is the ONE place core maps host inputs
(row→identity, DispatcherStore→`AgentRuntimeStateCallbacks`, host log→`DreamuxLogger`, host path layout→
`AgentRuntimePathContext`) into the neutral `AgentRuntimeCreateContext<TConfig>`. Config is produced by the
launcher calling `provider.readConfig` first. Both launchers (`dispatcher/service.ts`,
`teammate/service.ts`) call it; the per-builtin `provider.ts` no longer translates context.

---

## 8. New-package build-config checklist (Step B)
- `rush.json` projects entry (`shouldPublish: true`).
- `rush update` after the entry and after every `package.json` dependency edit.
- `package.json`: `type: module`, `main`/`types`/`exports` → `dist/index`, `files: ["dist", ...]`,
  `repository` (provenance), `dependencies: { "@excitedjs/dreamux-types": "workspace:*" }`,
  devDeps mirroring `dreamux-types` (NO direct `eslint-plugin-n`).
- `tsconfig.json` mirroring codex (no `references`/`composite`), `tsconfig.tests.json`,
  `eslint.config.js` re-export, `src/index.ts` barrel.
- pnpm workspace: handled by `rush.json` + `rush update` (Rush 5.140 `useWorkspaces: true`); no
  `common/config/rush/` change needed.

---

## 9. rush change files + CLAUDE.md / decision-record updates

CI runs a change-file gate: **every touched publishable package needs a change file** (else the gate
fails). Touched publishable packages this PR: `@excitedjs/dreamux-types`, `@excitedjs/dreamux`,
`@excitedjs/dreamux-utils`, `@excitedjs/agent-runtime-codex`, `@excitedjs/agent-runtime-claude-code`,
`@excitedjs/feishu-channel`. Run `rush change` once at the end and answer for each.

- **rush change (C4):** BREAKING `@excitedjs/dreamux` minor — provider-ref uniqueness. Lead with
  `BREAKING:` + `Rebuild:` lines.
- **rush change (D2 — `@excitedjs/dreamux-types`): BREAKING (semver-relevant public-contract break).**
  `ChannelRoutes.deliver` changed from `(envelope): Promise<void>` to
  `(envelope, input, hooks?): Promise<InboundDeliveryResult>`. External channel-provider authors call
  `routes.deliver(...)` inside their `start()` and must now pass `(envelope, input, hooks)` and consume the
  result — a break of the exact package #209 created for external authors. The `cwd` add to
  `AgentRuntimeDiagnosticContext` is additive/non-breaking. Type: `minor` in 0.x (pre-1.0), but the comment
  must lead `BREAKING:` and describe the deliver-signature migration for external authors.
- **rush change (B):** a non-breaking change file for `@excitedjs/dreamux` and the runtime/channel
  packages (`agent-runtime-codex`, `agent-runtime-claude-code`, `feishu-channel`, `dreamux-utils`) noting
  the dreamux-utils extraction (internal helper relocation; no user rebuild). Patch/minor; no `BREAKING:`.
- **CLAUDE.md (root):** add `@excitedjs/dreamux-utils` to the publishable-packages list — "pure shared
  utilities (config-validate, os, completion-body, turn-render), depends on `@excitedjs/dreamux-types`
  only". Note the new `@excitedjs/dreamux-utils` edge to the "runtime packages depend on dreamux-types
  only" rule.
- **packages/dreamux/src/agent-runtime/CLAUDE.md:** update the "neutral process helpers in
  `platform/process.ts`" line (process.ts deleted; shared helpers now in `@excitedjs/dreamux-utils`);
  update the codex/claude `builtin/<name>/` rows — `provider.ts` is now a host-hooks factory + neutral
  diagnostic (no host→neutral context translation), catalog holds the neutral provider, diagnostic context
  is neutral.
- **packages/dreamux/CLAUDE.md:** update the `channel/feishu/` row + channel boundary notes (D2), and the
  `platform/` row (owner-only-dir / process / logs moved to dreamux-utils).
- **packages/channel/feishu-channel/CLAUDE.md:** acknowledge the new `@excitedjs/dreamux-utils` dependency
  (still never `@excitedjs/dreamux`).
- **New `.agents/decisions/` record** — draft in §12; also reconcile the PR #224 multi-channel record for
  the #4 capability scope-down.

---

## 10. Build / test / lint recipe + per-step gating
Fast inner loop (seconds): `lint --only <pkg>` (no build needed; pure-syntactic).
Leaf-first build: `build --to @excitedjs/dreamux-utils` then `build --to @excitedjs/dreamux`.
Per-package test: `test --only <pkg>`; full: `test`. Use `DREAMUX_SKIP_LIVE_CODEX=1` for the fast path
(~15s vs ~41s for the dreamux package); run at least once WITHOUT it (codex installed) before declaring D1
done. Gate after every step A→B→C→D1→D2 with `build` + `lint` + `test` (skip-live), and a full
non-skip `test` after D1 and at the end. **Final gate must also verify the change-file requirement** for
all six touched publishable packages (§9) — `rush change --verify` (or the repo's equivalent CI gate) —
since the per-step build/lint/test checkpoints do not exercise it.

---

## 11. Risks, open questions, and SCOPE CHANGES (read before starting)

**R1 (SCOPE — blocks a correct D1): diagnostic neutralization is forced and needs a dreamux-types touch.**
The investigation (`inv:agent-runtime`) said "diagnostic is DEFERRED — keep host `AgentRuntimeDiagnosticContext`."
That is wrong given the settled "catalog typed on neutral" decision. Primary evidence: the codex/claude
**packages ship no diagnostic** (no `packages/agent-runtime/*/src/diagnostic.ts`); the diagnostic lives
only in core's host adapters (`builtin/codex/diagnostic.ts` reads `context.dispatcher.cwd/.id`,
`dispatcherCodexConfig(context.dispatcher)`, and host `codex-home.ts`). The neutral
`AgentRuntimeProvider<TConfig>` embeds `diagnostic?: AgentRuntimeDiagnostic<TConfig>`; once the catalog
returns the neutral provider, `doctor.ts` must construct the **neutral** diagnostic context and the host
adapters must read it — so they cannot stay host-shaped. This requires (a) adding `cwd` to the neutral
`AgentRuntimeDiagnosticContext` in dreamux-types (a spec touch the enumerated scope did not list), and (b)
a `doctor.ts` rewrite to call `provider.readConfig` per dispatcher and pass `cwd`. Plan folds this into
D1.1/D1.6. The advisor pre-authorized the `cwd` addition as the fallback once the gap was verified — it is
verified.

**R2 (SCOPE — reverses a shipped feature): Decision #4 ADD nullifies PR #224.** Forbidding two channels
with the same provider ref kills multi-feishu-per-dispatcher (commit `63cd886`). It does NOT contradict
Decision #2: #2's "egress by channelId" supports multi-**provider** (feishu + future slack); #4 forbids
multiple instances of the **same** provider. Consistent in intent, but it still removes a capability on the
same issue lineage. Needs a BREAKING rush change (C4) + docstring/comment/test reconciliation +
**one-line maintainer confirm that this scope-down is intended.**

**R3 (SCOPE — D2 ripple beyond channel): admin + MCP + a new option.** `feishuMessageBelongsToChat` → async
(admin `await`); its chatId param ideally becomes a target struct; `callFeishuMcpTool` → `handleTool`; and
`doStartDispatcher` needs a **new `channelProviders` catalog option** threaded from `server.ts` — a
prerequisite (D2.3), not a leaf edit. The `list_chat_bots` sessionless fast-exit and the
`createFeishuChannelSession` helper survive (cannot be deleted in this PR).

**R4 (resolved): external providers + the catalog `<unknown>` question.** Launcher operates on
`AgentRuntimeProvider<unknown>`; `readConfig(raw): unknown` feeds the same provider's
`createRuntime(ctx<unknown>)` — type-consistent with no per-provider typed handle. No open question; stated
as the resolution in D1.4.

**R5 (deliberately deferred): the teammate `runtimePaths` ref-branch is retained.** Removing
`if (ref === BUILTIN_CLAUDE_CODE_PROVIDER_REF)` needs a neutral provider `defaultPaths`/`buildPaths`
capability (a dreamux-types addition) beyond the enumerated scope. Host path-layout selection stays in host
code (D1.8); the create-context itself is fully neutral. This is the one place `grep claude-code` outside
the builtin remains non-zero — note it in the agent-runtime CLAUDE.md as a known, bounded exception.

**R6 (ordering hazards):**
- `dispatcherFeishuAppId` deletion (config.ts) and its caller (`dispatcher-store.ts:235`) must change in
  the same slice.
- #5 package index export must precede the core shim re-export (single `rush build` satisfies this).
- B is atomic: `rush.json` entry + `rush update` before any `workspace:*` repoint.
- D1.1 (`cwd` add) + rebuild `dreamux-types` before D1.6 edits.

**R7 (verify-before-delete):** confirm `platform/process.ts` has zero importers with a repo grep before
deleting (dup-utils claims orphan — re-verify). Confirm the codex/claude import-boundary tests grep
`@excitedjs/dreamux` exactly (not a prefix that would catch `@excitedjs/dreamux-utils`).

**R8 (resolved — config is pre-parsed; do NOT re-parse):** Verified that config load (config.ts:440–450)
stores `provider.readConfig`'s parsed output into `agents[id].config`, which becomes `dispatcher.runtime.config`
(521–524); `dispatcherCodexConfig`/`dispatcherClaudeCodeConfig` merely **cast** it. So `dispatcher.runtime.config`
is already `TConfig`. The launcher and doctor pass it **directly** as the neutral `config` and must NOT call
`provider.readConfig` again — re-parsing a parsed object risks non-idempotent transforms / unknown-key
rejection, and the launcher would otherwise need to synthesize `{file,prefix,agentId}` it does not have.
This makes the launcher fully provider-agnostic. One verify point remains: the defensive
`dispatcher === null → default*Config()` fallback in the current builtin adapters — keep that fallback
inside the builtin provider factory if the no-config path is reachable; a normally-started dispatcher always
has a parsed `runtime.config`.

---

## 12. Decision record draft

> Path: `.agents/decisions/neutral-provider-contract-convergence.md`
> Title: **Core drives all providers through the dreamux-types neutral contract**

**Status:** accepted (issue #209 cleanup, PR #223).

**Context.** After the package split, core kept a *parallel host* provider contract
(`agent-runtime/types.ts` `AgentRuntimeProvider` / `AgentRuntimeCreateContext` with
`row`/`dispatcher`/`dispatchers`/`log`) and bridged to the published packages per-builtin in
`builtin/<name>/provider.ts` (duplicated `loggerFromHostLog`, identity mapping, `dispatchers→state`
adapters, and an `as unknown as DispatcherProviderConfig` cast). External `npm:` agentRuntime providers
were typed on the *host* contract, so a `@excitedjs/dreamux-types`-only plugin author could not implement
them. The channel side had the same disease: core held `Map<string, FeishuChannelSession>` (concrete) and
called the result-returning `session.start({ submitTurn })`, while the neutral `ChannelSession` /
`ChannelRoutes.deliver` returned `void`, forcing a synthesized `{ status: 'submitted' }` in the bridge.

**Decision.**
1. The catalog and the external loader are typed on the **neutral** `@excitedjs/dreamux-types`
   `AgentRuntimeProvider<TConfig>`. Core builds the neutral `AgentRuntimeCreateContext` **once**, at the
   launcher, in `agent-runtime/host-context.ts` (`buildNeutralAgentRuntimeContext`,
   `dispatchersToStateCallbacks`, `loggerFromHostLog`). Each builtin `provider.ts` shrinks to a host-hooks
   factory (socket allocator, package-bin env, codex-home doctor) that returns the package provider with a
   **neutral** diagnostic attached. External providers are driven through the same neutral context with no
   adapter. The provider diagnostic is neutral too: `AgentRuntimeDiagnosticContext<TConfig>` gains `cwd`
   (the codex home doctor needs it); `doctor.ts` constructs the neutral context and resolves config via
   `provider.readConfig`.
2. The neutral channel inbound-submit returns a result: `ChannelRoutes.deliver(envelope, input, hooks):
   Promise<InboundDeliveryResult>`. Core holds `Map<string, ChannelSession>` (neutral), resolves sessions
   via a channel-provider catalog, addresses egress by `channelId`, and uses the neutral `handleTool` /
   `messageBelongsToTarget` / `resolveTarget` members. The `as unknown as DispatcherFeishuConfig` casts are
   replaced by a validating `extractFeishuConfig`. This is a **breaking change to the published
   `@excitedjs/dreamux-types` provider-authoring contract**: external channel authors must update their
   `start()` to call `routes.deliver(envelope, input, hooks)` and consume the `InboundDeliveryResult` (a
   rush change file leads with `BREAKING:`).
3. The byte-identical pure helpers duplicated across codex/claude/feishu-channel/core (config-validate, os,
   completion-body, turn-render) move to a new leaf package **`@excitedjs/dreamux-utils`** (depends on
   `@excitedjs/dreamux-types` only; no third-party). This adds a **dreamux-utils edge** to the prior rule
   that "runtime/channel packages depend on `dreamux-types` only": they may now also depend on
   `@excitedjs/dreamux-utils`. They still must never depend on `@excitedjs/dreamux`.

**Consequences.** The host `AgentRuntimeProvider`/`AgentRuntimeCreateContext`/`AgentRuntimeStateStore`/
`AgentRuntimeDiagnostic(Context)` types collapse to re-exports of the neutral ones; the per-builtin
context-translation adapters and two `as unknown as` casts are deleted; `runtime_id`/`checkpoint_id`
derivation for teammates is preserved verbatim. Host path-layout *selection* stays in host code (the
`runtimePaths` ref-branch is retained; a provider `defaultPaths` capability is a future option). `cwd` is
now part of the neutral diagnostic context. Channel reaction state keys off the real delivery result. This
record supersedes the host-contract framing in `agent-runtime/CLAUDE.md` and the channel-session framing in
`packages/dreamux/CLAUDE.md`.
