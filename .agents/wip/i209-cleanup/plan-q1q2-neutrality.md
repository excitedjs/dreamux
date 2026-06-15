# Plan — Q1 (channel MCP neutrality) + Q2 (one provider-loading path)

> Working scratch under `.agents/wip/` — NOT a settled decision record; delete
> before merge. Authoritative for the REMAINING neutrality work on branch
> `feature/i209-core-neutrality-cleanup`. Read `state.md` for history; this file
> supersedes the stale "STILL feishu-named ... NOT a leak" line in state.md's
> 2026-06-15 log — the maintainer rejected that carve-out: it IS debt and must go.

## Prime directive (maintainer, 2026-06-15)

**Architecture is the goal. Green unit tests are formalism, not the goal.** Do
NOT preserve garbage code to keep a test passing. A test that only exists to pin
removed machinery (the static builtin-registration path, the core feishu MCP
surface, a Server codex seam) is DELETED, not migrated. Tests that assert real
behavior are migrated to the neutral seam. "单测该删就删."

NORTH STAR (unchanged): pluginization = polymorphism. Core calls only the two
neutral `@excitedjs/dreamux-types` interfaces (`AgentRuntimeProvider`,
`ChannelProvider`) and is unaware of which class implements them. `builtin:*` is
a provider indistinguishable from an `npm:*` provider — only ref→package-name
resolution differs. Every provider-specific concept lives in its owning package.

---

## THE 门禁 / responsibility split (the most important architectural point)

This is the contract that governs Q1. Write it into the KB decision record at the
end; it must be unambiguous.

### Channel package (`@excitedjs/feishu-channel`) owns the inbound GATE

- Owns allowlist / grouplist / trustbot — the entire inbound access decision.
- Persists it self-contained in `access.json` + `chat-bots.json`, keyed off the
  host-supplied `state_root` directory (`ChannelSessionCreateContext.state_root`
  / `ChannelSessionlessToolContext.state_root`). Verified: `provider.ts:287`
  `const stateDir = context.state_root ?? '.'`; `chat-bots-store.ts` +
  `loadDispatcherAccess(stateDir)` (`feishu-channel.ts:316`).
- After the gate passes, every compliant inbound flows into dreamux. The channel
  decides compliance; dreamux never second-guesses it.
- Core applies **ZERO** access logic. Core never names allowlist/trust/chat-bot.

### Dreamux core owns inbound ROUTING (and only routing)

- Maintains the channel → TeamMate-session delivery routing table: this is the
  `bind_channel` / `transfer_back` Team capability (already core-owned, root
  CLAUDE.md). Neutral routing — keyed by channel id / target, never by a Feishu
  field.
- Core's ONLY contribution to the gate is **a directory**: it hands the channel
  `state_root` and lets the channel read/write `access.json` there. Nothing else.

### One-line statement

> Channel = the gate (allowlist/grouplist/trustbot, self-contained in
> access.json under a host-given directory). Dreamux = routing of all gated
> inbound (bind_channel). Core's sole gift to the gate is a directory.

---

## Q1 — neutralize the channel MCP surface in core

### Reconciliation: what already exists (DONE — do NOT redesign)

The neutral contract and the package implementation already landed:

- dreamux-types `channel.ts`: `ChannelMcpDescriptorContext` (137),
  `ChannelSession.mcpServerDescriptor?(ctx)` (194), `tools?()` (173),
  `handleTool?(call,ctx)` (179), `ChannelSessionlessToolContext` (155),
  `ChannelProvider.handleSessionlessTool?(name,args,ctx)` (219),
  `getIdentity?(config)` (213).
- feishu-channel `provider.ts`: `mcpServerDescriptor` (132) builds the feishu-mcp
  stdio descriptor from neutral `context.command`+`adminSocketPath`;
  `handleSessionlessTool` (240) services `list_chat_bots` from `state_root`;
  `tools` (186), `handleTool` (194), `getIdentity` (235).

### What is STILL wrong in core (the debt to remove)

- `channel/feishu-mcp-surface.ts` — core's parallel copy: `feishuMcpAdminMethod`
  (reply→`mcp.reply`), `feishuMcpAdminParams` (builds `chat_id`/`message_id`/
  `emoji`/`mention_user_ids`), `feishuMcpServerDescriptor`, `handleFeishuListChatBots`,
  `FEISHU_MCP_SERVER_NAME`.
- `mcp/feishu-mcp.ts` — the stdio shim hardcodes the feishu vocabulary via those
  helpers; `tools/list` imports `feishuMcpTools` from the package directly.
- `dispatcher-service/service.ts:91` + `dispatcher-service/dispatcher/service.ts:557`
  call core's `feishuMcpServerDescriptor` instead of the session's
  `mcpServerDescriptor`. `dispatcher/service.ts:280` calls `handleFeishuListChatBots`
  instead of the provider's `handleSessionlessTool`.
- `server.ts` re-exports `IN_PROGRESS_REACTION_EMOJI` / `RECEIVED_REACTION_EMOJI`
  from feishu-channel (a feishu constant surfaced through core — test-only).
- Possibly still feishu-named: `callFeishuMcpTool`, `FeishuChannelToolCall`,
  `feishuMessageBelongsToChat` (verify; neutralize via `handleTool`).

### Target architecture: core is a BLIND MCP conduit

Core never names a channel tool, method, or param. Two generic admin methods,
one generic shim.

1. **Descriptor**: dispatcher-service builds the MCP server descriptor via the
   neutral `session.mcpServerDescriptor({ command, adminSocketPath, dispatcher_id,
   callerKind, team_id, leader_name })`. Delete core's `feishuMcpServerDescriptor`.
   The descriptor's `name` is the provider's (not hardcoded `'feishu'`), and its
   `args[0]` selects a GENERIC core shim subcommand (rename `feishu-mcp` →
   `channel-mcp`; the package emits `['channel-mcp','--provider',ref,...]`).
2. **Generic shim** `mcp/channel-mcp.ts` (was `feishu-mcp.ts`): pure MCP↔admin
   bridge, zero channel vocabulary.
   - `tools/list` → admin `channel.list_tools { dispatcher_id, provider_ref, caller }`
     → core routes to the live `session.tools()` (or provider tool listing) →
     returns the neutral `{name,description,inputSchema}[]` blob verbatim.
   - `tools/call` → admin `channel.invoke_tool { dispatcher_id, provider_ref,
     name, arguments, caller }` → core routes: live session present →
     `session.handleTool({name,arguments})`; otherwise →
     `provider.handleSessionlessTool(name, arguments, { dispatcher_id, state_root,
     logger })`.
3. **Admin** gains exactly two neutral methods (`channel.list_tools`,
   `channel.invoke_tool`); delete the feishu-specific `mcp.reply`/`mcp.react`/
   `mcp.list_chat_bots` routing. Core picks session-vs-sessionless by binding
   presence — it never enumerates which tools are sessionless (the provider
   throws for an unknown sessionless tool, which is the feature-detect).
4. **Delete** `channel/feishu-mcp-surface.ts` entirely; drop the
   `IN_PROGRESS/RECEIVED_REACTION_EMOJI` re-export (tests import from the package).

### Q1 acceptance (architecture, not tests)

- `grep packages/dreamux/src` for `reply|react|chat_id|emoji|list_chat_bots|
  app_id|app_secret|mention_user` → no MATCH in core src (a `builtin:feishu` ref
  string or the provider id is fine; a tool/field/method NAME is not).
- `feishu-mcp-surface.ts` deleted; the shim is `channel-mcp`, generic.
- Core MCP path drives only `session.mcpServerDescriptor` / `session.tools` /
  `session.handleTool` / `provider.handleSessionlessTool` — the existing neutral
  contract. No new contract invented.

---

## Q2 — collapse provider loading to ONE dynamic path

### Why two paths exist (history, code-grounded)

Pre-#209 builtins were the implementation; `registerBuiltin*` is that fossil.
#209 added the dynamic loader `loadProviderPackages` and DESIGNED it for builtins
(`provider-loader.ts` docstring: "`builtin:*` refs ... use the same loading path
as ... `npm:` refs"; proven by `builtin-codex-package-loader.test.ts` ×4). But
production was never migrated off the static path —
`builtin-channel-providers.ts` docstring literally calls the generic channel
loader "a follow-up". `agentProviderRefs` filtered to `npm` only;
`loadChannelProviders` had zero callers. In production the static path passed
empty options (`codex:{}`), so its ONLY live job became test fake-injection. The
#148 import cycle (config.ts must not statically import the runtime catalog) was
the excuse that kept the static path in a composition layer.

### Target: builtin = alias → package, loaded by the one dynamic loader

- `config.ts` loads EVERY referenced provider impl (builtin + npm, both kinds)
  via the dynamic loader before parsing agents/channels. The registry it gets
  needs only the builtin DESCRIPTORS (`createBuiltinProviderRegistry` seeds them);
  the loader fills impls. No static `createCodex/createFeishu` import in core's
  composition path → #148 cycle CANNOT re-form (loader uses runtime `import()`).
- Test fake-injection routes through a test helper that mirrors the EXISTING
  clean `feishuChannelCatalog`: build a descriptor-seeded registry, register a
  codex/claude impl carrying the fakes (`createCodexAgentRuntimeProvider({descriptor,
  ...fakes})`), return an `AgentRuntimeProviderCatalog`. Server drops its
  `codexProcessFactory`/`codexClientFactory`/`codexHomeDoctor`/etc. seams entirely.

### Q2 status (this session)

DONE (tree does NOT build yet — task `cli/doctor/onboard/daemon` repoint pending):
- `config.ts`: single dynamic loader — `agentProviderRefs` returns builtin+npm;
  added `channelProviderRefs` + `providerRefsFrom`; `readConfigFile` calls
  `loadExternalAgentRuntimeProviders` + `loadChannelProviders`; added
  `externalChannelModuleImporter` override; rewrote the two "registered but not
  runnable / no impl" error messages (no more `loadConfigWithBuiltins`).
- `agent-runtime/catalog.ts`: deleted `registerBuiltinAgentRuntimeProviders` +
  `createBuiltinAgentRuntimeProviderCatalog` + their static codex/claude imports.
- `channel/catalog.ts`: deleted `createBuiltinChannelProviderCatalog` + the
  `registerBuiltinChannelProviders` import.
- DELETED files: `channel/builtin-channel-providers.ts`, `agent-runtime/load-config.ts`.
- `server.ts`: dropped all codex/claude seams from `ServerOptions`; catalogs via
  plain `new AgentRuntimeProviderCatalog/ChannelProviderCatalog({registry})`;
  `assertNoExternalRuntimeConfigWithoutRegistry` → `assertRuntimeImplementationsLoaded`
  (impl-aware, covers builtin+npm; message still names loadConfig for the test).

REMAINING:
- `cli/server.ts`: drop `createBuiltinAgentRuntimeProviderCatalog` +
  `registerBuiltinChannelProviders`; after `loadConfig({providerRegistry})` build
  catalogs with plain constructors (or just pass the loaded registry to Server).
- `cli/doctor.ts`: `loadConfigWithBuiltins`→`loadConfig`; `builtinDoctorCatalog`
  becomes async via `loadExternalAgentRuntimeProviders({refs:['builtin:codex',
  'builtin:claude-code']})` then `new AgentRuntimeProviderCatalog`.
- `onboard/run.ts`, `onboard/uninstall.ts`, `daemon/install.ts`:
  `loadConfigWithBuiltins`→`loadConfig` (config now self-loads builtins).
- Tests: add `codexAgentRuntimeCatalog` helper; migrate smoke `buildServer`
  chokepoint + e2e/codex-live/codex-completion/dispatcher-workspace/
  agent-runtime-provider. DELETE tests that only pinned the static path or the
  removed Server seams (per prime directive).
- Optional naming: `loadExternalAgentRuntimeProviders` → `loadAgentRuntimeProviders`
  for symmetry with `loadChannelProviders` (the "External" name now lies). Low risk.

### Q2 acceptance

- Exactly ONE construction path: the dynamic loader. No `register*Builtin*`, no
  `createBuiltin*Catalog`. `loadChannelProviders` has a real caller (config.ts).
- `grep packages/dreamux/src` for `createCodexAgentRuntimeProvider|createFeishuChannelProvider|
  createClaudeCodeAgentRuntimeProvider` → no MATCH in core src (only in tests).
- No orphaned exports; deleted files gone.

---

## Q1 — precise mechanics (authorization-flow findings, code-grounded 2026-06-15)

Core is ALREADY mostly neutral on the live tool path — the residue is naming +
two helpers + the egress authz. Exact map:

- `admin/methods.ts`: `mcp.reply` (89) / `mcp.react` (106) / `mcp.list_chat_bots`
  (126) each do `mustDispatcherId` + `mustExistingDispatcher` (+
  `mustRunningDispatcher` for reply/react) + `const channelId = await
  assertFeishuScope(server,id,params)` + `dispatcherService.callFeishuMcpTool({
  dispatcherId, toolName, arguments: params, channelId? })`.
- `dispatcher/service.ts callFeishuMcpTool` (276): `list_chat_bots` →
  `handleFeishuListChatBots(dispatcherId, arguments)` (sessionless, the core
  copy); else → `session.handleTool({name, arguments}, {dispatcher_id,
  channel_id})` — ALREADY the neutral contract. `sessionFor(slot, channelId)`
  (332) picks the egress channel (named channelId or the primary).
- `feishuMessageBelongsToChat` (299) ALREADY builds a neutral `ChannelTarget`
  from chatId and calls `session.messageBelongsToTarget` — just a feishu-named
  wrapper over the neutral method.
- `assertFeishuScope` (admin/methods.ts:395) — the TeamLeader egress-binding
  authz (SECURITY-SENSITIVE): non-team_leader → returns undefined (no
  restriction). team_leader → requires `chat_id` (else BAD_REQUEST); if
  `message_id` present, requires `feishuMessageBelongsToChat` (else
  CHANNEL_SCOPE_DENIED "react/reply only to messages observed in bound
  channels"); then `teamLeaderCanUseChannel({dispatcherId, teamId, leaderName,
  chatId})` → `{allowed, channelId}`; `!allowed` → CHANNEL_SCOPE_DENIED; returns
  the bound channelId to egress through. Reads `chat_id`/`message_id` by name in
  core — the leak.

### Q1a — neutralize the MCP tool surface + the egress authz (one sequential agent, build-gated)

- Admin: replace the 3 feishu methods with two generic ones: `channel.invoke_tool
  { dispatcher_id, name, arguments, caller }` and `channel.list_tools {
  dispatcher_id, caller }`. The generic shim forwards raw `{name, arguments}`.
- Rename `callFeishuMcpTool` → `invokeChannelTool`, `FeishuChannelToolCall` →
  neutral type. Move the team_leader egress scope check OUT of the admin layer
  INTO `invokeChannelTool` (it has the session): resolve the neutral target via
  `session.resolveTarget(arguments)`; for team_leader, check the binding against
  the NEUTRAL target_key (rename `teamLeaderCanUseChannel`'s `chatId` param →
  `targetKey`, pass `target.target_key`; the binding store keys by that string
  regardless of name — verify before changing). PRESERVE every deny path
  byte-for-behavior: missing target → BAD_REQUEST; unbound → CHANNEL_SCOPE_DENIED;
  message-ownership fail → CHANNEL_SCOPE_DENIED. Core must stop reading
  `chat_id`/`message_id` by name — derive them through `session.resolveTarget` /
  `session.messageBelongsToTarget`.
- Sessionless: `list_chat_bots` (and any tool with no live session) →
  `provider.handleSessionlessTool(name, arguments, { dispatcher_id, state_root,
  logger })`. DELETE `handleFeishuListChatBots`. Rename `feishuMessageBelongsToChat`
  → neutral `messageBelongsToTarget`-based method.
- Descriptor: `session.mcpServerDescriptor({command, adminSocketPath,
  dispatcher_id, callerKind, team_id, leader_name})` at `service.ts:91` and
  `dispatcher/service.ts:557`. DELETE `feishuMcpServerDescriptor`.
- DELETE `channel/feishu-mcp-surface.ts`. Drop the
  `IN_PROGRESS/RECEIVED_REACTION_EMOJI` re-export from `server.ts`.
- Build + lint GREEN. The `mcp/feishu-mcp.ts` shim may KEEP its filename in Q1a
  (forwarding generically) to bound the change; Q1b renames it.

### Q1b — rename feishu-mcp → channel-mcp (one sequential agent, build-gated)

- `mcp/feishu-mcp.ts` → `mcp/channel-mcp.ts`, generic; CLI subcommand
  `feishu-mcp` → `channel-mcp`; feishu-channel `provider.ts mcpServerDescriptor`
  args[0] `'feishu-mcp'` → `'channel-mcp'` (+ `--provider` the ref); root
  CLAUDE.md CLI surface line; rush change for @excitedjs/dreamux (CLI subcommand +
  MCP descriptor args) and @excitedjs/feishu-channel. Build + lint GREEN.

### SECURITY GATE (the maintainer reserves final verification here)

The TeamLeader egress-scope deny paths (BAD_REQUEST missing target,
CHANNEL_SCOPE_DENIED unbound, CHANNEL_SCOPE_DENIED message-not-in-bound-channel)
MUST survive byte-for-behavior. Do NOT call `advisor` (the previous Q1 agent died
on an advisor stream-idle-timeout) — the design is settled here; implement it.

## ESLint guardrail — core must not import the provider packages (maintainer 2026-06-15)

Add a lint gate so the polymorphism boundary cannot regress: `packages/dreamux/src/**`
must NOT import `@excitedjs/agent-runtime-codex`, `@excitedjs/agent-runtime-claude-code`,
or `@excitedjs/feishu-channel` (only `@excitedjs/dreamux-types` + the dynamic
`import()` loader + the `BUILTIN_PROVIDER_PACKAGES` ref→name STRING map are allowed).

- Location: `packages/dreamux/eslint.config.js` (extends `@excitedjs/eslint-config`).
  MERGE with the shared `no-restricted-imports` Sync-IO ban (#85) — do NOT override
  it (flat-config last-wins would drop the #85 red-line gate for dreamux src).
  Use `no-restricted-imports.patterns` for the 3 package names so it composes with
  the shared `paths`-based Sync ban, or extend the shared factory to take extra
  patterns. Verify the #85 Sync ban still fires on dreamux src after the change.
- Timing: add AFTER the Q1 workflow finishes (adding it mid-run fails the
  workflow's lint gate on out-of-scope codex imports and derails it).
- Maintainer decision: **门禁先上 + 标记残留.** After Q1, the feishu-channel
  imports are gone; the residual leaks are codex/claude CONFIG, NOT in Q1/Q2 scope:
  `config/config.ts` (DispatcherCodexConfig/ClaudeCodeConfig types + re-exports of
  dispatcherCodexConfig/DEFAULT_CODEX_BIN/…), `cli/doctor.ts` (resolveCodexBinPath),
  `onboard/types.ts` + `onboard/run.ts` (codex types — onboard redesign is the
  maintainer's deferred item). Give EACH a documented `eslint-disable-next-line
  no-restricted-imports -- Q3: core still names codex/claude config; tracked
  de-leak` (the shared config requires disable descriptions, so these are
  auditable, not hidden). The rule goes live locking in the Q1/Q2-cleaned surface
  and catching regressions; the deep codex-config de-leak is a separate pass (Q3).

### Q3 (separate later pass — NOT now) — core stops naming codex/claude config

Make `ResolvedAgentConfig.config` fully opaque (`DispatcherProviderConfig`), drop
the codex/claude config type union + the config.ts re-exports, repoint
doctor/daemon/dispatcher-service to the provider's neutral diagnostic/config seam,
and fold in the deferred onboard provider-agnostic redesign. Removes the last
codex/claude import from core → the eslint guardrail's disables all disappear.

## 彻底干净 — final acceptance (architecture-first, I verify personally)

1. Core neutrality grep (the real test) — CORRECTED per issue #209's settled
   design (read 2026-06-15): **`chat_id` / `chat_type` are NEUTRAL Dreamux contract
   fields, NOT leaks.** #209 verbatim: "keep `chat_id` and `chat_type`; ... `chat_id`
   means a provider-local neutral chat identifier, not a Feishu-only field. Slack
   channel ids and Telegram chat ids map into the same shape." #209 also assigns
   channel-binding state, routing, and TeamLeader authz to core, keyed by
   `provider + channel_id + chat_id`. So core SHOULD contain
   `chat_id`/`chat_type`/`message_id`/`sender_id` (neutral) in binding/routing/authz/
   the channel envelope. The real leak test is **provider-NAMED** symbols:
   `codex*`/`claude*`/`feishu*` identifiers, a provider's tool/method names used AS
   core vocabulary (`feishuMcpAdminMethod`, `mcp.reply`/`react`/`list_chat_bots`), or
   a static import of a provider package. A `builtin:*` ref string and the neutral
   chat vocabulary are fine.

   Reconciliation of the gate's 10 grep flags against #209: 8 are FALSE POSITIVES
   (neutral `chat_id`/`chat_type`/`message_id`/`sender_id` in `team-mcp` bind
   descriptions, `TeamChannelBindingSummary.chat_id`, `team/service.ts meta["chat_id"]`,
   base-prompt envelope fields — all by-design neutral; the design is sound, no
   re-discussion needed). The 2 genuine ones (`feishuScope` / `--feishu-scope` in
   `teammate/mcp-config.ts`) were DEAD CODE (no setter, no reader, not in tests) and
   are DELETED. `source="feishu"` in base-prompt is a provider VALUE (the actual
   envelope source the model sees) in maintainer-owned prose — left as-is.
2. One provider-construction path (Q2). One blind MCP conduit (Q1).
3. No dead code / orphaned exports; `feishu-mcp-surface.ts` + the static twin gone.
4. Docs stop blessing the debt: `packages/dreamux/CLAUDE.md` channel-table row
   ("core keeps ... the host MCP shim" / feishu-mcp-surface), the package
   `feishu-channel/CLAUDE.md` "Core owns the MCP server descriptor + admin-method
   routing" lines, and any "follow-up/intentional" docstrings — all rewritten to
   the single neutral path.
5. build + lint + test green — AFTER the architecture is right, by migrating or
   DELETING tests, never by re-adding removed code.

Verification method: I run the grep gate + build/lint/test myself, then a
Workflow fan-out of adversarial reviewers (one per dimension above), then I read
all verdicts and personally judge 彻底干净.

## Upgrade-blocker / rush-change reminders

- Renaming the `feishu-mcp` bin subcommand → `channel-mcp` changes the MCP server
  descriptor args (bundled-skill / dispatcher-runtime surface). Needs a rush
  change; check no persisted descriptor is read back.
- Admin protocol method changes (`mcp.reply`→`channel.invoke_tool`) are
  cross-process IPC — internal (shim ↔ server, same release), but note it.
- The dropped `IN_PROGRESS/RECEIVED_REACTION_EMOJI` core re-export is internal.
