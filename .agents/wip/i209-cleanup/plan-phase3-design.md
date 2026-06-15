# Phase 3 implementation design — i209 cleanup (north-star convergence)

> WIP scratch (under `.agents/wip/`, not a settled record). Synthesizes the four
> Phase-3a investigations + the hardened scope into a single build-safe
> implementation spine for Phase 3b. Grounded against the working tree on branch
> `feature/i209-npm-package-split` (PR #223). The settled decision record is
> written into `.agents/decisions/` only at Phase 4.

## North star (the rule this design serves)

Pluginization = polymorphism. Core (`@excitedjs/dreamux`) holds **no built-in
implementations** and calls only the published `@excitedjs/dreamux-types`
interfaces, unaware of which class implements them. `builtin:codex` /
`builtin:claude-code` / `builtin:feishu` are providers indistinguishable from any
npm provider except for ref→package-name resolution. **Two SEPARATE interface
families** stay separate (NOT merged): `AgentRuntimeProvider<TConfig>` +
`AgentRuntimeCreateContext` (agent-runtime.ts) and `ChannelProvider<TConfig>` +
`ChannelSession` / `ChannelRoutes` (channel.ts). No `if (ref === BUILTIN_…)`
branch anywhere in core. Core never names `app_id` / `app_secret` / `codex-home`
or any provider config field.

## dreamux-types contract inventory (rebuild FIRST — all consumers depend on it)

Two BREAKING, three additive. Both BREAKING notes lead the dreamux-types rush
change (Phase 3 §6).

| # | Change | File | Kind | Migration |
|---|---|---|---|---|
| B1 | `ChannelRoutes.deliver(envelope): Promise<void>` → `Promise<InboundDeliveryResult>` | channel.ts:106 | BREAKING | author-facing; external channel authors update their `routes.deliver` consumer |
| B2 | `AgentRuntimePathContext`: drop `stdoutLogPath(id)` + `stderrLogPath(id)`, add `logsDir(): string` | agent-runtime.ts:145-158 | BREAKING | author-facing ONLY — codex/claude compose identical on-disk paths from `logsDir()`; **no user log-path migration** |
| A1 | `ChannelSession.mcpServerDescriptor?(ctx: ChannelMcpDescriptorContext): AgentRuntimeMcpServer \| null` + new `ChannelMcpDescriptorContext` interface | channel.ts | additive | none |
| A2 | `ChannelProvider.handleSessionlessTool?(name, args, ctx): Promise<unknown>` | channel.ts:136 | additive | none |
| A3 | `ChannelProvider.getIdentity?(config: TConfig): string` | channel.ts:136 | additive | none |

B2 requires `channel.ts` to `import type { InboundDeliveryResult } from './turn.js'`
and `import type { AgentRuntimeMcpServer } from './agent-runtime.js'` (intra-package,
declaration-only — no cycle). `ChannelMcpDescriptorContext`:
`{ command: string; adminSocketPath: string; dispatcher_id: string; team_id?: string; leader_name?: string }`.

B1 narrowing: `deliver` returns `InboundDeliveryResult` (the
`duplicate|stopped|submitted{turnId}|failed{error}` union from `turn.ts`), NOT
`NoticeInjectionResult` — channel input never yields `'skipped'`.

**`AgentRuntimeDiagnosticContext` gets NO `cwd` field.** Primary-source check:
`validateDispatcherCodexHome` (codex-home.ts:70-126) reads `configPath`,
`codexHome`, `socketPath`, auth — it never reads `dispatcherCwd`. The stale plan
R1 (add `cwd`) is overridden; instead the moved codex-home makes `dispatcherCwd`
optional with an empty default. The neutral context `{ runtime_id, config, env,
scope }` (agent-runtime.ts:353-358) is sufficient as-is.

---

## §1 — Core adopts the two existing dreamux-types interfaces; delete host parallels

### 1.1 What is deleted from `agent-runtime/types.ts` (entire file → DELETE)

Field-by-field, every host-coupled interface has a neutral equivalent already in
`@excitedjs/dreamux-types`. **No genuinely core-only type needs a new home** —
there is no orphan to relocate; this is a pure delete + repoint.

| Host (types.ts) | Neutral (dreamux-types) | Delta |
|---|---|---|
| `AgentRuntimeStateStore` (:76) `status: DispatcherStatus` | `AgentRuntimeStateCallbacks` (:226) `status: AgentRuntimeStatus` | pure rename; both are the same 6-literal union |
| `AgentRuntime` (:97) `getStatus(): DispatcherStatus` | `AgentRuntime` (:309) `getStatus(): AgentRuntimeStatus` | pure rename |
| `AgentRuntimeCreateContext` (:129) `row` / `dispatcher` / `dispatchers` / `log` / `state?: StateStore` | `AgentRuntimeCreateContext<TConfig>` (:269) `identity` / `config` / `logger?` / `state?: StateCallbacks` | **structural** — translation moves into the launcher (§2.4) |
| `AgentRuntimeDiagnosticContext` (:181) `dispatcher: DispatcherConfig`, `env: NodeJS.ProcessEnv` | `AgentRuntimeDiagnosticContext<TConfig>` (:353) `runtime_id`, `config`, `env: DreamuxEnvironment` | **structural** — doctor builds neutral (§2.5) |
| `AgentRuntimeDiagnostic` (:194) non-generic | `AgentRuntimeDiagnostic<TConfig>` (:369) generic | consequence of above |
| `AgentRuntimeProvider` (:202) `descriptor: ProviderDescriptor`, `readConfig→DispatcherProviderConfig`, `createRuntime(host ctx)` | `AgentRuntimeProvider<TConfig>` (:381) `descriptor: AgentRuntimeProviderDescriptor`, `readConfig→TConfig`, `createRuntime(neutral ctx)` | catalog re-typed (§2.3) |
| `AgentRuntimeTurnResult` (:95) | `AgentRuntimeTurnResult` (:245) | redundant redeclare; gone |
| neutral re-exports (:54-74) | source | importers repoint to source |

`DispatcherStatus` (dispatcher-store.ts:21) is **kept** — it is the persisted
`status.json` schema type. Only its cross-layer use as the runtime status type
stops; `AgentRuntimeStatus` is structurally identical, so the boundary adapter is
a no-op assignment.

### 1.2 `agent-runtime/turn.ts` (entire file → DELETE)

Already a pure re-export shim. Repoint: type exports → `@excitedjs/dreamux-types`;
`renderChannelInput` / `renderChannelBlock` / `DEFAULT_MESSAGE_ID_DEDUPE_WINDOW` →
`@excitedjs/dreamux-utils`.

### 1.3 `platform/paths.ts` `teamMateCompletionOutputPath` re-export (line 374 → DELETE)

No core src importer. Three tests repoint to `@excitedjs/dreamux-utils`
(codex-completion.test.ts:7, completion-body.test.ts:14, claude-code-runtime.test.ts:29-30).

### 1.4 Importer repoint table (core src — types.ts + turn.ts + index barrel)

| File:line | Symbol | Repoint to |
|---|---|---|
| agent-runtime/catalog.ts:11 | `AgentRuntimeProvider` | `AgentRuntimeProvider<unknown>` from dreamux-types |
| agent-runtime/index.ts:6 | `export * from './types.js'` | direct re-exports from dreamux-types (1.5) |
| channel/feishu/feishu-mcp-surface.ts:12 | `AgentRuntimeMcpServer` | dreamux-types |
| channel/plugin.ts:10 | `AgentRuntimeMcpServer` | dreamux-types |
| config/config.ts:18 | `AgentRuntimeProvider` | `AgentRuntimeProvider<unknown>` dreamux-types |
| dispatcher-service/team/mcp-config.ts:2 | `AgentRuntimeMcpServer` | dreamux-types |
| dispatcher-service/teammate/mcp-config.ts:2 | `AgentRuntimeMcpServer` | dreamux-types |
| dispatcher-service/service.ts:7 | `InboundDeliveryHooks`, `InboundTurnInput` | dreamux-types |
| dispatcher-service/teammate/runtime-state.ts:1-2 | `AgentRuntimeStateStore`→`AgentRuntimeStateCallbacks`; `DispatcherStatus`→`AgentRuntimeStatus` | dreamux-types (update `implements` + `setStatus` param) |
| dispatcher-service/teammate/types.ts:1,153,363,506 | add `AgentRuntimeStatus`; `runtime_status: DispatcherStatus\|null`→`AgentRuntimeStatus\|null`; `runtimeStatusToIdentityStatus` param | dreamux-types (via barrel) |
| dispatcher-service/dispatcher/service.ts:9 | `AgentRuntime`, `AgentRuntimeProvider` types | dreamux-types |
| dispatcher-service/teammate/service.ts:14-15 | `AgentRuntime`, `AgentRuntimePathContext`, `TurnSettledSignal`, `AgentRuntimeCapabilities` | dreamux-types |
| cli/doctor.ts:23-25 | `AgentRuntimeBinCheck`, `AgentRuntimeDiagnosticContext`, `AgentRuntimeDoctorResult` | dreamux-types (`<unknown>` where generic) |

Test repoints (turn.ts/types.ts → dreamux-types or dreamux-utils):
agent-runtime-provider.test.ts:22, channel-input-format.test.ts:18 (render→utils),
channel-routing.test.ts:17, smoke.test.ts:83, team-service.test.ts:31,
teammate-agent-service.test.ts:21-22, teammate-completion-e2e.test.ts:22,
bundled-skill-sources.test.ts:22, completion-body.test.ts:15,
codex-completion.test.ts:22, claude-code-runtime.test.ts:34,42-43.

### 1.5 `agent-runtime/index.ts` after cleanup

Remove `export * from './builtin/codex/provider.js'` (:3), `./builtin/claude-code/provider.js'`
(:4), `./types.js'` (:6). Keep `catalog.js`, `bundled-skill-sources.js`,
`external-provider.js`. Add `export * from './host-context.js'`,
`export * from './host-paths.js'`, and direct re-exports of the neutral types
core modules consume by barrel today (`AgentRuntimeRole`, `AgentRuntimeStatus`,
`AgentRuntimeCapabilities`, `AgentRuntimeMcpServer`, `AgentRuntimePathContext`,
`CompletionEnvelope`, etc.) from `@excitedjs/dreamux-types`.

### 1.6 Catalog / external-provider re-typing

`catalog.ts`: `AgentRuntimeProviderCatalog.list()/resolve()` return
`AgentRuntimeProvider<unknown>`; `asAgentRuntimeProvider()` narrows to the neutral
shape. `external-provider.ts` already loads against the neutral contract via the
generic provider-loader; confirm its `AgentRuntimeProvider` import is the
dreamux-types one (it should no longer reach `./types.js`). The builtin-registration
functions are rewritten in §2.3.

---

## §2 — `builtin/` deletion plan

End state: `packages/dreamux/src/agent-runtime/builtin/` does not exist
(`find … builtin` returns nothing). 20 files. Three new core modules absorb the
host-only logic; the rest is shim deletion or relocation into the packages.

### 2.1 New core module `agent-runtime/host-paths.ts` (provider-AGNOSTIC)

Eliminates the R5 ref-branch by removing log-file naming from core entirely
(enabled by B2 `logsDir()`). Builds neutral `AgentRuntimePathContext` keyed by
runtime identity; the provider package composes its own log subpaths inside
`logsDir()`.

```ts
import { dispatcherDir, dispatcherCompletionSpillDir, logsRoot,
         dispatcherTeamMateRuntimeDir } from '../platform/paths.js';
import type { AgentRuntimePathContext } from '@excitedjs/dreamux-types';

export function dispatcherHostPaths(): AgentRuntimePathContext {
  return { dispatcherDir, logsDir: logsRoot, completionSpillDir: dispatcherCompletionSpillDir };
}
export function teammateHostPaths(dispatcherId: string, runtimeIdentity: string): AgentRuntimePathContext {
  return {
    dispatcherDir: () => dispatcherTeamMateRuntimeDir(dispatcherId, runtimeIdentity),
    logsDir: logsRoot,
    completionSpillDir: () => dispatcherCompletionSpillDir(dispatcherId),
  };
}
```

`teammate/service.ts:1134-1173` `runtimePaths(identity, providerRef)` collapses to
`teammateHostPaths(identity.dispatcher_id, runtimeIdentity)` — the `providerRef`
param and the `if (providerRef === BUILTIN_CLAUDE_CODE_PROVIDER_REF)` branch are
deleted. The two packages compose: codex →
`join(paths.logsDir(), 'codex-app-server', <id>.log)` (and `.stderr.log`); claude
→ `join(paths.logsDir(), 'claude-code', <id>.log)` (single stream). Socket
allocation (`allocateCodexSocketPath`) is NOT a path-context method — it stays a
codex provider-factory host hook (§2.3).

### 2.2 New core module `agent-runtime/host-context.ts` (neutral adapter builders)

Merges the two byte-identical helpers duplicated across both `provider.ts` files:

- `hostLogAdapter(log: (level,msg,err)=>void): DreamuxLogger` — the `loggerFromHostLog`
  body (forwards info/warn/error, no-op debug/trace).
- `dispatchersToStateCallbacks(dispatchers: DispatcherStore): AgentRuntimeStateCallbacks`
  — merges `codexRowStateStore` + `claudeCodeRowStateStore` (identical bodies;
  `DispatcherStatus` ≡ `AgentRuntimeStatus`).

### 2.3 New core module `agent-runtime/register-builtins.ts` (host-hook injection)

Replaces `catalog.ts`'s `registerBuiltinAgentRuntimeProviders` /
`createBuiltinAgentRuntimeProviderCatalog`. Imports the **package** provider
factories directly and injects host hooks; preserves the idempotency contract
(factory-bearing server registration wins; factory-less load/doctor registration
no-ops on already-registered builtins via the registry's "skip if implementation
exists" guard).

```ts
import { createCodexAgentRuntimeProvider } from '@excitedjs/agent-runtime-codex';
import { createClaudeCodeAgentRuntimeProvider } from '@excitedjs/agent-runtime-claude-code';
import { allocateRuntimeSocketPath } from '../platform/runtime-sockets.js';
import { dispatcherProcessEnv } from '../platform/package-bin.js';
// registry.registerImplementation(codexDescriptor.id, createCodexAgentRuntimeProvider({
//   descriptor, allocateSocketPath: (id)=>allocateRuntimeSocketPath(`dispatcher '${id}' agent socket path`),
//   baseProcessEnv: (extra)=>dispatcherProcessEnv(process.env, extra),
//   ...test-seam overrides (codexProcessFactory/codexClientFactory/sessionFactory) }));
```

Each package **factory builds and attaches its own `provider.diagnostic`** (§5) —
core never imports or attaches a diagnostic const. (Today the core adapter
attaches it, codex provider.ts:115-119; after the move the package factory owns
it.) Critically, the codex diagnostic closes over the injected `allocateSocketPath`
hook (it needs a socket sample for the budget/placement check), so it CANNOT be a
static export — see §5.1.
Options bag (`RegisterBuiltinAgentRuntimeProvidersOptions`) keeps the test-seam
factory overrides — the only reason it survives. The `createRuntime`
host→neutral translation that lived in the adapters is GONE: the package
`createRuntime` takes the neutral context the launcher now builds (§2.4).

**Resolved fork (register-builtins vs generic-loader):** inv:core-adoption proposed
routing builtins through the generic dynamic-import loader (`BUILTIN_PROVIDER_PACKAGES`).
Rejected for this PR: the generic loader passes only the descriptor and cannot
inject the host hooks (`allocateSocketPath`, `baseProcessEnv`, test-seam factories)
the builtins require. register-builtins (authoritative per hardened scope) keeps
those hooks. Residual north-star gap logged in §8.

### 2.4 Launchers build the neutral create context

**dispatcher/service.ts** `doStartDispatcher` createRuntime call: build
`AgentRuntimeCreateContext<unknown>`:
`identity: { runtime_id: id, checkpoint_id: row.thread_id }`, `config:
dispatcher.runtime.config` (already parsed at load — plan R8; do NOT re-call
`readConfig`), `logger: hostLogAdapter(channelLog)`, `state:
dispatchersToStateCallbacks(dispatchers)`, `paths: dispatcherHostPaths()`, plus
`role`/`cwd`/`mcpServers`/`skillSources`/`systemPromptContent`. Drop
`row`/`dispatcher`/`dispatchers`/`log`.

**teammate/service.ts:898-955** same pattern; delete `runtimeRow()` (:1108-1124,
synthetic `DispatcherRow` gone — also removes the `bot_app_id`/`bot_secret_ref`
leak there), `paths: teammateHostPaths(...)`, `state` via the renamed
`TeamMateRuntimeStateStore` (now `implements AgentRuntimeStateCallbacks`). The
teammate's typed config is its resolved agent's `agent.config`.

### 2.5 doctor builds the neutral diagnostic context

cli/doctor.ts: iterate providers, call `provider.diagnostic?.runDiagnostic({
runtime_id: dispatcher.id, config: dispatcher.runtime.config, env, scope }, runner)`
and `.binChecks(...)`. Zero codex/claude branching. `resolveCodexBinPath` import
(doctor.ts) repoints to `@excitedjs/agent-runtime-codex`. The empty-dispatchers
codex-default bin check (doctor.ts:545-554) is a residual leak — see §8.

### 2.6 File-by-file fate of `builtin/`

| File | Fate |
|---|---|
| codex/{args,config,supervisor,rpc,handshake,types}.ts | DELETE (pure shims); importers → `@excitedjs/agent-runtime-codex` |
| codex/mcp-config.ts | DELETE; `feishuMcpCodexArgs` is test-only → inline in test (do NOT relocate; avoids feishu↔codex coupling) |
| codex/diagnostic.ts | MOVE INTO `@excitedjs/agent-runtime-codex` as neutral `AgentRuntimeDiagnostic<DispatcherCodexConfig>` (§5) |
| codex/codex-home.ts | MOVE INTO `@excitedjs/agent-runtime-codex` (§5); `DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES` + `unixSocketPathFitsBudget` → `@excitedjs/dreamux-utils` |
| codex/paths.ts | DELETE; `operatorCodexHome`/`dispatcherCodexHome`/`dispatcherCodexConfigPath` → codex package; log fns dissolve (B2); workspace-skill fns → `onboard/legacy-codex-skills.ts`; `allocateCodexSocketPath` → inline host hook in register-builtins |
| codex/runtime-support.ts | DELETE; `codexRowStateStore` → host-context.ts; `defaultCodexRuntimePaths` dissolves (launcher uses host-paths.ts) |
| codex/provider.ts | DELETE; host hooks → register-builtins.ts; `loggerFromHostLog` → host-context.ts; `resolveCodexBinPath` consumed from package |
| claude-code/{args,config,supervisor,mcp-config}.ts | DELETE (pure shims) → package |
| claude-code/paths.ts | DELETE; log fns dissolve (B2); `dispatcherClaudeCodeDir`/`dispatcherClaudeCodeMcpConfigPath` → claude package |
| claude-code/diagnostic.ts | MOVE INTO `@excitedjs/agent-runtime-claude-code` (§5) |
| claude-code/runtime-support.ts | DELETE → host-context.ts / dissolves |
| claude-code/provider.ts | DELETE → register-builtins.ts / host-context.ts |

New core module `onboard/legacy-codex-skills.ts` houses the four
`dispatcherWorkspace*Skill*` fns (used only by `onboard/uninstall.ts` to clean old
`.codex/skills` symlinks; pure path math, no `~/.dreamux` coupling).

### 2.7 Core-src builtin importer repoints (beyond launchers/doctor)

| File | Repoint |
|---|---|
| config/config.ts:39-40,63-64,71-72 | `DispatcherCodexConfig`→`@excitedjs/agent-runtime-codex/config`; `DispatcherClaudeCodeConfig`→`@excitedjs/agent-runtime-claude-code/config` |
| onboard/run.ts:3,16,21 | `codexArgsToCli`/`parseCodexArgs`/`dispatcherCodexHome`/`dispatcherCodexHomeDoctorContext`/`validateDispatcherCodexHome` → codex package (minimal repoint; onboard NOT redesigned — state.md) |
| onboard/types.ts:1 | `DispatcherCodexHomeDoctorResult` → codex package |
| onboard/uninstall.ts:18 | `dispatcherWorkspaceSkillDirs` → `onboard/legacy-codex-skills.ts` |
| server.ts:14-15,30,45 | `CodexProcess`/`CodexWsClient`/`DispatcherCodexHomeDoctor`→codex pkg; `ClaudeCodeSessionFactory`→claude pkg; drop `createBuiltinAgentRuntimeProviderCatalog`→`register-builtins.ts` + `AgentRuntimeProviderCatalog` |
| cli/server.ts:25,54 | `createBuiltinAgentRuntimeProviderCatalog` → register-builtins.ts |
| agent-runtime/load-config.ts:9,21 | `registerBuiltinAgentRuntimeProviders` → register-builtins.ts |

### 2.8 Test repoints (13 files)

`codex-live`, `codex-completion`, `claude-code-runtime`, `claude-code-live`,
`smoke`, `e2e`, `global-config`, `dispatcher-codex-home`, `doctor`, `onboard`,
`runtime-paths`, `runtime-sockets`, `uninstall`. Buckets: builtin shim symbols →
package; `createCodex/ClaudeCodeAgentRuntimeProvider` → package factory (or
`register-builtins.ts` test seam); `teamMateCompletionOutputPath` →
`@excitedjs/dreamux-utils`; `dispatcherWorkspaceSkillDirs` →
`onboard/legacy-codex-skills.ts`; `allocateCodexSocketPath` →
`platform/runtime-sockets.ts`. Two rewrites: `runtime-paths.test.ts` (asserts
codex log-path strings — rewrite to verify neutral `host-paths.ts` shape +
`logsDir()` prefix); `doctor.test.ts` (asserts `codexAppServerLogDir` — assert the
`logsRoot()` prefix or import from codex package).

---

## §3 — De-leak plan (core never names provider config fields)

Scope per state.md: the **runtime-driving + dispatcher path NOW**; onboard's
residual provider-awareness rides with the deferred onboard redesign. Confirmed
safe — onboard does not import the de-leaked helpers (only writes literal
`{app_id, app_secret}` into the feishu channel config block at config-files.ts:79-80,
which IS the feishu provider's schema, legitimately).

### 3.1 Provider self-reports a neutral identity (A3)

`@excitedjs/feishu-channel` `createFeishuChannelProvider()` adds
`getIdentity(config: FeishuChannelConfig): string { return config.appId; }`.
config.ts `parseDispatcherChannels` (around :645-657) — after the existing
synchronous `readConfig` validation — attaches `identity:
provider.getIdentity?.(parsed) ?? ''` to each `DispatcherChannelConfig` record (new
optional `identity?: string` field on the type at config.ts:117-127). Core stores
and displays the opaque string; it never reads `appId`. (feishu `readConfig` is
synchronous — config.ts:647-654 enforces it — so `getIdentity(parsed)` is safe
synchronously.)

### 3.2 config/config.ts deletions

Delete `DispatcherFeishuConfig` (:136-139), `feishuConfigFromChannels` (:669-689),
`dispatcherFeishuConfig` (:691-695), `dispatcherChannelId` (:707-713, dead export),
`dispatcherFeishuChannels` (:727-736). All five filter by
`BUILTIN_FEISHU_PROVIDER_REF` and `as unknown as DispatcherFeishuConfig` — the
exact leak. Rename `redactFeishuSecrets` (:835) → `redactProviderSecrets` (field
set unchanged; pino-style generic secret redaction). `DispatcherFeishuConfig`
already lives in the package as `FeishuChannelConfig` (provider.ts:44-48) — it does
NOT move to dreamux-types (that would be the same leak in a different package).

### 3.3 platform/secrets.ts → DELETE entirely

Sole export `resolveBotSecret` (knows `config:`/`env:` schemes + reads `app_secret`).
Its only caller is the to-be-deleted `feishu-channel.ts` host adapter (§4). After
dissolution, credential resolution is the provider's job inside `createSession`
(the parsed `FeishuChannelConfig.appSecret`). No replacement in core.

### 3.4 platform/logger.ts

Drop `'feishu.app_secret'` + `'*.feishu.app_secret'` from `REDACT_PATHS` (:90-91)
— covered by the generic `'app_secret'`/`'*.app_secret'` entries. Generalize the
comment.

### 3.5 state/dispatcher-store.ts (the `bot_app_id` neutralization)

- `DispatcherRow.bot_app_id` (:31) → `channel_identity: string`.
- `DispatcherRow.bot_secret_ref` (:32) → **delete** (credential resolution is the
  provider's job).
- `DispatcherCreateInput.bot_app_id` (:46) → `channel_identity`; drop
  `bot_secret_ref?` (:47).
- `rowDefaults` (:227): `channel_identity: config.channels[0]?.identity ?? ''`;
  drop the `bot_secret_ref` seed (:228) and the `dispatcherFeishuChannels` import (:5).
- `create`/`upsert` (:97-98,118-119): drop `bot_secret_ref` mapping.

**status.json schema decision (explicit):** `DispatcherStatusFile` (:51-61, the
persisted shape) does **not** contain `bot_app_id` or `bot_secret_ref` — confirmed.
They are config-derived in-memory row fields rebuilt on every boot. **No persisted
schema change, no schema migration.** The rush change covers (a) the in-memory row
rename and (b) the admin-protocol field rename below — soft-breaking only.

### 3.6 Downstream `bot_app_id` rename + leak removal

| File:line | Change |
|---|---|
| admin/methods.ts:62 | `bot_app_id: row.bot_app_id` → `channel_identity: row.channel_identity` (dispatcher.status response) |
| cli/server-ctl.ts:95-96 | delete `'bot-app-id'`/`'bot-secret-ref'` flag mappings (dead — `dispatcher.create` returns UNSUPPORTED) |
| dispatcher-service/dispatcher/service.ts:81,257,480 | `DispatcherSummary.bot_app_id`→`channel_identity`; summarize + ready-log read `row.channel_identity` |
| dispatcher-service/dispatcher/service.ts:401-432 | the `dispatcherFeishuChannels(...)` + `.app_id`/`.app_secret` reads are replaced by the neutral `createSession` path (§4 — this is the merged edit) |
| dispatcher-service/teammate/service.ts:1112-1113 | gone with `runtimeRow()` deletion (§2.4) |

**No bundled skill reads `bot_app_id`** (grep clean) → admin field rename needs no
skill update; it is a soft-breaking admin-protocol field only.

### 3.7 Test repoints

global-config.test.ts:20,650,678 (drop `dispatcherFeishuConfig`; inspect
`config.dispatchers[].channels[0].config` opaquely or import `FeishuChannelConfig`
from the package); smoke.test.ts + dispatcher-store.test.ts (rename `bot_app_id`→
`channel_identity`, drop `bot_secret_ref` in all `DispatcherCreateInput` literals).

---

## §4 — Channel dissolution plan (channel/feishu/ fully dissolved)

Channel stays a **separate** interface family from agent-runtime. The two
investigations (inv:de-leak "thin connector kept"; inv:channel-dissolution "delete
feishu-channel.ts") conflict on the SAME shared files; the hard target (full
dissolution) wins. **The merged substrate is dissolution's neutral `ChannelSession`;
de-leak's field renames layer on top.** Below is one merged edit per shared file.

### 4.1 channel/feishu/ file-by-file fate

| File | Fate |
|---|---|
| bot.ts | DELETE (pure shim) → `@excitedjs/feishu-channel` |
| feishu-channel.ts | DELETE (host adapter). `createFeishuChannelSession` replaced by `channelProvider.createSession(neutralCtx)`; secret resolution → provider; `handleFeishuListChatBots` → provider `handleSessionlessTool` (A2); re-exported emoji/types → package |
| feishu-mcp-surface.ts | DELETE. Tool re-exports → package; `feishuMcpServerDescriptor` → `ChannelSession.mcpServerDescriptor?` (A1); `feishuMcpAdminMethod`/`Label`/`Params` → move into `@excitedjs/feishu-channel` `src/index.ts` |
| plugin.ts | KEEP — repoint `AgentRuntimeMcpServer` import (:10) → dreamux-types |
| builtin-channel-providers.ts, external-channel-provider.ts | KEEP — already neutral |

### 4.2 Neutral `ChannelSession` convergence — merged edits to the 4 shared files

**dispatcher-service/dispatcher/service.ts** (de-leak + dissolution merged):
- `DispatcherAgentSlot.channels` (:75) `Map<string, FeishuChannelSession>` →
  `Map<string, ChannelSession>` (neutral).
- `DispatcherAgentServiceOptions` (:52-53): remove `botFactory`/`skipBotSecret`
  feishu test seams; add a channel-provider resolver (`channelProviders`, §4.4).
- `sessionFor` (:302) returns `ChannelSession`.
- `callFeishuMcpTool` (:265) → `callChannelTool` using `session.handleTool!(call, ctx)`.
- `feishuMessageBelongsToChat` (:278) → `messageTargetBelongsToChannel` using
  `session.messageBelongsToTarget?(check)`.
- channel creation (:401-440): iterate `dispatcherConfig.channels`, resolve the
  `ChannelProvider` per channel from the catalog, call
  `provider.createSession({ dispatcher_id, channel_id, provider: ch.provider,
  config: provider.readConfig(ch.config, …), state_root: dispatcherDir(id),
  cache_root: dispatcherFeishuAttachmentCacheDir(id), logger })`. Core passes the
  opaque config block — never names `app_id`/`app_secret`. Drop `dispatcherFeishuChannels`,
  `botFactory`, `skipBotSecret`.
- `dreamuxMcpServerDescriptors` (:496): iterate `slot.channels.values()` and call
  `session.mcpServerDescriptor?.(ctx)` — drop the hardcoded `feishuMcpServerDescriptor`.
- bot_app_id → channel_identity (:81,257,480 per §3.6).

**dispatcher-service/service.ts** `bindTeamChannel` (~:339): `provider: 'builtin:feishu'`
literal → `provider: session.provider`. Channel-id egress (:161):
`dispatcherFeishuChannels(d).map(ch => ch.channelId)` → `d.channels.map(ch => ch.id)`
(the neutral `DispatcherChannelConfig.id`). Drop the `dispatcherFeishuChannels`
import.

**dispatcher-service/dispatcher/runnable-channel.ts:26** — remove the
`channel.provider !== BUILTIN_FEISHU_PROVIDER_REF` guard. Replace with catalog
resolution (let `channelProviders.resolve(channel.provider)` throw fail-loud for an
unregistered provider). This is the channel-side R5; eliminated, not deferred.

**admin/methods.ts** — `assertFeishuScope` (:395) → `assertChannelScope` using the
neutral `messageTargetBelongsToChannel` (:412); `mcp.reply`/`mcp.react` (:89,106)
→ `callChannelTool`; `mcp.list_chat_bots` (:126): if a live session exists route
through `callChannelTool` (`session.handleTool`), else
`channelProvider.handleSessionlessTool?('list_chat_bots', args, { state_root,
dispatcher_id })`; the response `bot_app_id` (:62) → `channel_identity` (§3.6).

### 4.3 The load-bearing wiring (B1 deliver — not just the signature)

The package header (provider.ts:8-19) is explicit:
`NeutralFeishuChannelSession.start(routes)` is "real-but-not-the-production-path —
its `routes.deliver` is void, so it cannot carry the submit delivery result the
production reaction ledger needs." Full dissolution requires **core's
`ChannelRoutes.deliver` closure to PRODUCE the real `InboundDeliveryResult`
(status/turnId)** the reaction ledger keys off. Changing the signature (B1) is the
easy half; wiring core's `deliver` to the dispatcher submit path that yields the
`turnId` is the load-bearing half. The package then becomes:
`const result = await routes.deliver(neutral); return result;` (retiring the
host-shaped result-returning submitter). **Escape hatch (hardened-scope fallback):**
if `deliver`→turnId cannot be cleanly wired this PR, keep a minimal core session
adapter that owns only the result path, while still deleting bot.ts +
feishu-mcp-surface.ts and converging the Map/catalog. Committing to full
dissolution; this is the §8 risk to watch.

### 4.4 channelProviders catalog (NEW)

There is **no** `ChannelProviderCatalog` today — only `registerBuiltinChannelProviders`
(builtin-channel-providers.ts) registers `createFeishuChannelProvider()` into the
registry, and `external-channel-provider.ts` loads npm channels. Design a
`ChannelProviderCatalog` parallel to `AgentRuntimeProviderCatalog` (a thin
`listByKind('channel')` + `resolve(ref)` view over the same `ProviderRegistry`),
constructed in `server.ts` and threaded into `DispatcherAgentService` and
`runnable-channel.ts`. This is the seam that replaces every `builtin:feishu`
constant with registry resolution.

### 4.5 feishu-channel package additions

- provider.ts `NeutralFeishuChannelSession.start`: return the real
  `await routes.deliver(...)` result (B1).
- provider.ts `mcpServerDescriptor(ctx: ChannelMcpDescriptorContext)`: build the
  `feishu-mcp` stdio descriptor from `ctx.command` + `ctx.adminSocketPath` (same
  arg shape as today's `feishuMcpServerDescriptor`).
- provider.ts `FeishuChannelProvider.handleSessionlessTool('list_chat_bots', args,
  { state_root })`: `listChatBots(state_root, parsed.chat_id)` (replaces
  `handleFeishuListChatBots`).
- `getIdentity` (A3, §3.1).
- src/index.ts: export `feishuMcpAdminMethod`/`Label`/`Params` (moved from core).

### 4.6 feishu importer repoints

mcp/feishu-mcp.ts:14 (`feishuMcpAdminLabel/Method/Params`, `feishuMcpTools`,
`parseFeishuMcpToolInput` → `@excitedjs/feishu-channel`); server.ts:16,54-57
(`FeishuBot`, `IN_PROGRESS_REACTION_EMOJI`, `RECEIVED_REACTION_EMOJI` → package;
drop if `botFactory` removed); dispatcher-service/dispatcher/service.ts:10 +
dispatcher-service/service.ts:12 (`FeishuBot` → package). Tests: channel-provider,
codex-live, e2e, multi-channel-routing, smoke, teammate-completion-delivery,
teammate-completion-e2e (`createFakeFeishuBot`/`FeishuBot`/`feishuMcpTools` →
package).

---

## §5 — Diagnostic + codex-home move INTO packages

### 5.1 `@excitedjs/agent-runtime-codex` new files + exports

- `src/diagnostic.ts` — `codexAgentRuntimeDiagnostic: AgentRuntimeDiagnostic<DispatcherCodexConfig>`.
  Adopt the neutral context: `context.dispatcher.id` → `context.runtime_id`;
  `dispatcherCodexConfig(context.dispatcher)` → `context.config`; delete the
  `context.dispatcher.cwd ?? defaultDispatcherCwd(...)` line (cwd unused in
  validation). Uses the package-internal moved codex-home + the package's existing
  `MIN_CODEX_VERSION`/`codexVersionSatisfies`.
- `src/codex-home.ts` — moved `validateDispatcherCodexHome` /
  `dispatcherCodexHomeDoctorContext` / `DispatcherCodexHomeDoctorResult` /
  `assertDispatcherCodexHomeReady`. `dispatcherCwd` becomes optional (empty
  default). `DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES` + `unixSocketPathFitsBudget`
  consumed from `@excitedjs/dreamux-utils` (relocate them there). The
  representative `socketPath` sample is supplied via the provider factory's
  `allocateSocketPath` host hook (already injected, §2.3) — the package never
  knows `~/.dreamux`.
- `src/paths.ts` (or existing path module) — `operatorCodexHome`,
  `dispatcherCodexHome`, `dispatcherCodexConfigPath` (homedir-only, no `~/.dreamux`).
- `src/index.ts` — export `codexAgentRuntimeDiagnostic`, the codex-home surface,
  `args`/`config`/`supervisor`/`rpc`/`types`/`handshake`/`CodexProcessExitHandler`
  (so every former shim symbol resolves).

**Hook inversion (state explicitly):** today core *injects* a `codexHomeDoctor`
into the package (provider.ts:97-106). After codex-home moves IN, the package owns
validation: both `diagnostic.runDiagnostic` and the runtime readiness check call
the package-internal codex-home. Core stops injecting; the `codexHomeDoctor`
factory option becomes test-only (or is dropped).

### 5.2 `@excitedjs/agent-runtime-claude-code` new files + exports

- `src/diagnostic.ts` — `claudeCodeAgentRuntimeDiagnostic: AgentRuntimeDiagnostic<DispatcherClaudeCodeConfig>`;
  `dispatcherClaudeCodeConfig(context.dispatcher)` → `context.config`; no host deps.
- `src/paths.ts` — `dispatcherClaudeCodeDir` / `dispatcherClaudeCodeMcpConfigPath`
  (the package owns `dispatcherDir + '/claude-code/mcp.json'`; the dir root comes
  from the neutral `paths.dispatcherDir(id)`).
- `src/index.ts` — export `claudeCodeAgentRuntimeDiagnostic`, plus
  `args`/`config`/`mcp-config`/`supervisor`.

Both packages still **never** import `@excitedjs/dreamux`; they may import
`@excitedjs/dreamux-types` (+ `@excitedjs/dreamux-utils`).

### 5.3 dreamux-types diagnostic-context cwd

**Not added.** Resolved above: validation never reads cwd; the moved codex-home
defaults `dispatcherCwd` to empty.

---

## §6 — Docs + rush changes + decision record

### 6.1 Deletes / edits

- DELETE `packages/dreamux/src/agent-runtime/CLAUDE.md` **and** its symlink
  `AGENTS.md` (`AGENTS.md -> CLAUDE.md`; deleting the target alone dangles it).
- Root `CLAUDE.md`: update the per-runtime path rule (no `builtin/<name>/paths.ts`;
  neutral host paths in `agent-runtime/host-paths.ts`), the codex-handshake-shim
  line (importers hit the package directly), and the builtin-adapter framing
  (no `builtin/`).
- `packages/dreamux/CLAUDE.md`: rewrite the two `agent-runtime/builtin/*` table
  rows and the `channel/feishu/` row (dissolved); update the `platform/` row
  (`secrets.ts` removed; per-runtime paths no longer in each builtin).

### 6.2 rush change files

| Package | Lead | Note |
|---|---|---|
| `@excitedjs/dreamux-types` | **BREAKING** ×2 | (1) `ChannelRoutes.deliver` now returns `Promise<InboundDeliveryResult>` — channel authors update their deliver consumer. (2) `AgentRuntimePathContext` replaces `stdoutLogPath`/`stderrLogPath` with `logsDir()` — runtime authors compose log paths; author-facing only, no user data migration |
| `@excitedjs/dreamux` | **BREAKING** | `bot_app_id`→`channel_identity` on the in-memory dispatcher row + the `dispatcher.status` admin field; `bot_secret_ref` removed. No `status.json` schema change, no rebuild required. `Rebuild:` none |
| `@excitedjs/agent-runtime-codex` | (minor) | now ships `diagnostic` + codex-home |
| `@excitedjs/agent-runtime-claude-code` | (minor) | now ships `diagnostic` |
| `@excitedjs/dreamux-utils` | (minor) | gains the unix-socket-budget primitives |

Write via `rush change` (never hand-edit generated CHANGELOG). Decision #4's
duplicate-feishu BREAKING rush change from Phase 2 already exists; do not duplicate.

### 6.3 Decision record (Phase 4)

Extend the convergence decision record (plan §12) into `.agents/decisions/`:
core imports dreamux-types directly; `builtin/` dissolved; channel/feishu/
dissolved; two separate interfaces kept; de-leak (provider self-reports identity);
the two BREAKING dreamux-types changes; the residual north-star gaps (§8).

---

## §7 — Build-safe ordering (the Phase 3b spine)

dreamux-types must rebuild before consumers; shared files (the 4 in §4.2)
edited once with both concerns merged. Each step ends green
(`node common/scripts/install-run-rush.js build` then `… test`,
`DREAMUX_SKIP_LIVE_CODEX=1` fast path; `rush update` after package dep edits).

- **S0 — dreamux-types contract.** Apply B1, B2, A1, A2, A3 + the `channel.ts`
  intra-package imports. `rush update` + build dreamux-types. (Consumers break
  until S2/S5 — expected; gate on dreamux-types compiling alone.)
- **S1 — dreamux-utils + package internals (no core wiring yet).** Move
  unix-socket-budget primitives into dreamux-utils. Add `diagnostic.ts` +
  `codex-home.ts` to the codex package and `diagnostic.ts` to the claude package;
  extend both package `index.ts` exports + the path fns. Implement the package-side
  B1/A1/A2/A3 in feishu-channel (start returns result; `mcpServerDescriptor`;
  `handleSessionlessTool`; `getIdentity`; index exports). Build all packages green.
- **S2 — core host modules.** Add `agent-runtime/host-paths.ts` (logsDir-based),
  `host-context.ts`, `register-builtins.ts`, `onboard/legacy-codex-skills.ts`.
  Re-type catalog + external-provider to `AgentRuntimeProvider<unknown>`.
  (builtin/ still present — adapters not yet deleted.)
- **S3 — launchers + doctor build neutral contexts.** Rewrite dispatcher/teammate
  createRuntime call sites and doctor's diagnostic context onto the neutral shapes,
  wired to S2 modules. Delete `runtimeRow()` + the R5 ref-branch. At this point the
  adapters in builtin/provider.ts are dead.
- **S4 — delete `agent-runtime/{types.ts,turn.ts,builtin/,CLAUDE.md,AGENTS.md}`**
  + the paths.ts shim line; repoint every core-src + test importer (§1.4, §2.7,
  §2.8). `find … builtin` returns nothing. Build + test green.
- **S5 — de-leak + channel dissolution (merged on the 4 shared files).** A3 wiring
  in config.ts; delete config feishu helpers + `platform/secrets.ts`; rename
  `bot_app_id`→`channel_identity` + drop `bot_secret_ref` across store/admin/cli/
  services; add `ChannelProviderCatalog`; converge dispatcher/service.ts onto
  `Map<string,ChannelSession>` + `createSession` + `mcpServerDescriptor`; wire B1
  `deliver`→turnId; admin neutral routing; runnable-channel + bindTeamChannel
  ref-branch removal; delete channel/feishu/{bot,feishu-channel,feishu-mcp-surface}.ts;
  repoint importers. Build + test green.
- **S6 — docs + rush changes** (§6). `.agents/scripts/check.sh` before committing
  KB edits.

Rollback granularity: S0–S2 are additive/green-able independently; S3 is the
neutral-context cutover (largest single risk); S4 is mechanical delete+repoint;
S5 is the merged channel/de-leak cutover (B1 wiring is the watch point).

---

## §8 — Risks / cannot-fully-honor this PR

1. **B1 deliver→turnId wiring (load-bearing, §4.3).** Signature is trivial; making
   core's `ChannelRoutes.deliver` closure yield the real `{status, turnId}` the
   reaction ledger consumes is the hard half. Escape hatch: minimal core session
   adapter owning only the result path while still deleting the shims + converging
   the Map/catalog. Committing to full dissolution; flag as the top watch point.
2. **Residual north-star gap: builtins still need host-hook injection npm providers
   can't get.** `allocateSocketPath` (codex socket under `~/.dreamux/run/sockets/`)
   + `baseProcessEnv` (bundled-bin PATH) are injected at provider-factory time via
   register-builtins; the generic dynamic-import loader (the npm path) cannot carry
   them. So an npm agent-runtime provider needing a host socket allocator has no
   seam today. True parity would move these into the create context (socket
   allocation is codex-only, bloats the neutral path context) — deferred.
3. **doctor empty-dispatchers codex default (doctor.ts:545-554).** Hardcodes
   `resolveCodexBinPath(DEFAULT_CODEX_BIN)` when no dispatcher is declared (code
   comment: "near-zero, not zero"). De-leaking needs a "default provider for empty
   config" concept — a config decision, not a mechanical repoint. Deferred.
4. **onboard residual feishu/codex awareness.** `onboard/{wizard,types,config-files}.ts`
   know `botAppId`/`app_id`/`app_secret` + `provider: BUILTIN_CODEX_PROVIDER_REF`
   defaults. Per state.md the onboard redesign is DEFERRED; Phase 3 gives onboard
   only minimal import repoints to keep it compiling. Confirmed safe (it doesn't
   import the de-leaked config helpers).
5. **`feishuMcpCodexArgs` (codex/mcp-config.ts).** Test-only. Inline
   `codexMcpServerArgs([feishuMcpServerDescriptor(opts)])` in the test rather than
   relocating it (relocation would couple the feishu channel to the codex runtime).
6. **`channelProviders` catalog is new code**, not a repoint — small but real
   surface (parallel to `AgentRuntimeProviderCatalog`).
2. **RESOLVED (was deferred) — see §9.** Risk #2's host-hook asymmetry
   (`baseProcessEnv`/socket) is now closed by the env-boundary rewrite + the
   socket relocation in §9, not deferred.

7. **Edit-surface estimate:** dreamux-types ~5 edits; 4 new core modules
   (host-paths, host-context, register-builtins, legacy-codex-skills) + 1 new
   catalog; ~20 builtin files deleted/moved; 3 channel files deleted; ~15 core-src
   repoints; ~16 test repoints (2 rewrites); 2 package `src/diagnostic.ts` + codex
   `src/codex-home.ts` moved-in; ~5 rush changes; 3 docs. The 4 §4.2 shared files
   carry both de-leak and dissolution edits merged.

---

## §9 — Env-injection boundary + socket relocation + tm retirement (closes Risk #2)

Resolved with the maintainer (state.md settled decision #6). This REPLACES the
"builtins get host hooks npm can't" gap with a clean neutral seam, and folds in
the tm-injection retirement.

### 9.1 The boundary

spawn env = `{ ...process.env, ...core.injectEnv, ...provider-config.extra_env }`

- **`extra_env` consumer = the provider, never core.** The provider reads
  `extra_env` from its OWN config block and merges it itself. Core never sees it.
  Kills the backwards `baseProcessEnv(extraEnv)` flow where the provider hands its
  own extra_env back to a core function to merge.
- **Core keeps a neutral env-injection seam**: add `injectEnv?: Record<string,string>`
  to the neutral `AgentRuntimeCreateContext` (dreamux-types — additive,
  non-breaking). Core's launcher populates it; EMPTY today (tm injection retired).
  This is the npm/builtin parity fix: every provider (builtin + npm) gets the same
  env-injection channel from the create context — no factory-time host hook.

### 9.2 Socket — relocate fully into the codex package

- Today: core's `allocateCodexSocketPath` → `platform/runtime-sockets.ts`
  `allocateRuntimeSocketPath` computes the path; the codex supervisor (package)
  already owns mkdir/stale-removal/connect/reap.
- Target (maintainer): core exposes a **host run directory path** via the neutral
  create context (part of the storage-layout path context the provider already
  receives); the codex package allocates `<dir>/<random>.sock` inside it and owns
  the WHOLE socket lifecycle. The sun_path budget primitives move to
  `@excitedjs/dreamux-utils` (already planned, decision #3) so the codex package
  imports them. Core deletes `allocateCodexSocketPath` + the codex-specific socket
  factory hook; `platform/runtime-sockets.ts` keeps only the host-owned
  candidate-dir/run-root selection + sweep (neutral), exposed as a directory.
- Parity: a neutral run-dir in the context is provider-agnostic (claude ignores
  it). No "socket allocator function" injected only to builtins.

### 9.3 Deletions (mechanism + packaging — this PR)

- `baseProcessEnv` factory option on BOTH package provider factories
  (`agent-runtime/codex/src/provider.ts:56,173-174`,
  `agent-runtime/claude-code/src/provider.ts:46,136-137`) + the two core adapters
  (`builtin/codex/provider.ts:90`, `builtin/claude-code/provider.ts:82`).
  Packages read `context.injectEnv` instead (env is per-spawn → create context).
- `platform/package-bin.ts` `dispatcherProcessEnv` (tm-only PATH prepend). KEEP
  `dreamuxBinPath` (MCP shim absolute command) + `resolveExecutableOnPath`.
- codex `runtime-support.ts` `codexProcessEnv`'s `delete env['CODEX_HOME']` (cruft;
  nothing sets CODEX_HOME). Wrapper collapses to an inlined merge. Behavior change
  (ambient CODEX_HOME now inherited) → rush change + note.
- `@excitedjs/tm` dep + `tm` bin (`packages/dreamux/package.json`,
  `packages/dreamux/bin/tm`) — vestigial once injection dies. PENDING a full-repo
  `tm` reference sweep (tests, uninstall reporting, daemon). Update
  `.agents/decisions/dispatcher-tm-packaging.md` (superseded) + rush change (`tm`
  is published CLI surface). Maintainer may veto dep+bin and keep for their tm PR.

### 9.4 NOT this PR (maintainer's next PR — prose/skill track)

- base-prompt.ts tm lines (18/29/30/35; line 71 CODEX_HOME advice STAYS).
- dispatcher bundled SKILL.md tm manual (needs skill-creator). Accepted one-PR
  window of stale tm prose.

### 9.5 Ordering

Folds into the §7 spine: 9.1/9.2 contract bits ride S0 (dreamux-types: add
`injectEnv`, add host run-dir to the path context); package-side reads + socket
relocation + `delete CODEX_HOME` removal ride S1; core launcher populates
`injectEnv` (empty) + run-dir during S2/S3; tm dep/bin/`dispatcherProcessEnv`
deletion + decision-record + rush change ride S5/S6 after the reference sweep.
