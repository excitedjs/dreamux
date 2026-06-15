# Hardened scope — SUPERSEDES plan.md §5 (D1) and tightens §6/§9

The maintainer hardened the requirements mid-run. This file is AUTHORITATIVE
over `plan.md` §5 wherever they conflict. `plan.md` steps A/B/C (foundations)
and the D2 channel convergence body remain valid; only the agent-runtime
end-state and the shim policy are tightened here.

## Hard success criteria (task is INCOMPLETE if any fail)

1. **`packages/dreamux/src/agent-runtime/builtin/` is DELETED entirely** — no
   files, no directory. (Maintainer: "如果这个目录没删,就是任务没完成".)
2. **Every re-export shim in the repo is deleted** and each importer points
   DIRECTLY at the real source (the package or `@excitedjs/dreamux-types` or
   `@excitedjs/dreamux-utils`). (Maintainer: "这种重导出都是垃圾代码,全部干掉".)
3. **Core (`@excitedjs/dreamux`) imports `@excitedjs/dreamux-types` directly**
   as the single source of the provider/runtime/channel contracts — NOT a core
   re-export of them. (Maintainer: "dreamux 核心包也要导入 @excitedjs/dreamux-types
   这是架构推荐用法".)
4. **`packages/dreamux/src/agent-runtime/CLAUDE.md` is DELETED.** (Maintainer:
   "同理 ... CLAUDE.md 也可以删掉了".)

## File-by-file fate of `agent-runtime/builtin/` (survey-grounded)

Pure re-export shims → DELETE, repoint importers to the package
(`@excitedjs/agent-runtime-codex` / `@excitedjs/agent-runtime-claude-code`):
- codex: `args.ts`, `config.ts`, `supervisor.ts`, `rpc.ts`, `types.ts`,
  `handshake.ts`, `mcp-config.ts` (also re-exports feishu-mcp-surface helpers →
  repoint those to `channel/feishu/feishu-mcp-surface.ts` directly).
- claude-code: `args.ts`, `config.ts`, `mcp-config.ts`, `supervisor.ts`.
  → Ensure the packages EXPORT every symbol these shims forwarded (extend each
  package `src/index.ts` / `./config` subpath export) so importers resolve.

Real host logic → RELOCATE out of `builtin/` (then delete the file):
- `codex/paths.ts` + `claude-code/paths.ts` (host ~/.dreamux log/socket paths +
  `allocateCodexSocketPath`) → new core module `agent-runtime/host-paths.ts`
  (host per-runtime path layouts + socket allocation; the codex/claude ref-branch
  lives here). Update root CLAUDE.md path rule (per-runtime host paths no longer
  under `builtin/<name>/paths.ts`).
- `codex/codex-home.ts` (doctor for Codex's own ~/.codex home/auth) → MOVE INTO
  `@excitedjs/agent-runtime-codex` (it is codex-engine-specific, resolves home
  from env, has no ~/.dreamux knowledge). Export from package index.
- `codex/diagnostic.ts` + `claude-code/diagnostic.ts` (neutral
  `AgentRuntimeDiagnostic`) → MOVE INTO the respective package (the package ships
  its own diagnostic; matches the "doctor is provider-self-reported" invariant).
  R1's "packages ship no diagnostic" is resolved by moving it in, not by a core
  adapter. The codex diagnostic uses the moved codex-home logic.
- `codex/provider.ts` + `claude-code/provider.ts` (host-hooks factory) → the
  builtin-registration wiring moves to a core module NOT under `builtin/`
  (extend `agent-runtime/load-config.ts` or new `agent-runtime/register-builtins.ts`):
  maps `builtin:codex`/`builtin:claude-code` to the PACKAGE provider factory,
  injecting host hooks (socket allocator from host-paths, `dispatcherProcessEnv`
  from `platform/package-bin.ts`, the package-owned codex-home doctor). The
  package provider now ships its own diagnostic, so no diagnostic attachment in
  core. Then delete provider.ts.
- `codex/runtime-support.ts` + `claude-code/runtime-support.ts`
  (`defaultPaths` + `*RowStateStore`) → `defaultPaths` to `host-paths.ts`;
  the `dispatchers → AgentRuntimeStateCallbacks` adapter to
  `agent-runtime/host-context.ts` (`dispatchersToStateCallbacks`, plan D1.2).

End state: `builtin/` empty → `rmdir`. Verify with `find ... builtin` returning
nothing.

## Core imports dreamux-types directly (criterion 3) — kills the shim layer

- `agent-runtime/types.ts`: do NOT turn it into a re-export shim (plan D1.3 said
  re-export — OVERRIDDEN). DELETE it; repoint every importer to
  `@excitedjs/dreamux-types`. Any genuinely core-only type that has no neutral
  equivalent moves to a clearly-named core file (e.g. `agent-runtime/host-context.ts`
  or wherever it is used), NOT a shim. Confirm field-by-field that
  AgentRuntimeProvider / AgentRuntimeCreateContext / AgentRuntimeStateStore(→Callbacks)
  / AgentRuntimeDiagnostic(Context) / AgentRuntimeStatus all exist in dreamux-types.
- `agent-runtime/turn.ts`: DELETE (plan B kept it as a shim — OVERRIDDEN).
  Repoint importers: types → `@excitedjs/dreamux-types`; render helpers
  (`renderChannelInput`, `renderChannelBlock`, `DEFAULT_MESSAGE_ID_DEDUPE_WINDOW`)
  → `@excitedjs/dreamux-utils`.
- `platform/paths.ts` `teamMateCompletionOutputPath` shim (plan B4 created it —
  OVERRIDDEN): DELETE the shim; repoint importers (tests) directly to
  `@excitedjs/dreamux-utils`. Keep the genuinely-core path builders in paths.ts.
- `channel/feishu/bot.ts` (re-export shim) → DELETE; repoint to
  `@excitedjs/feishu-channel`.
- Sweep the whole repo for any remaining `Re-export shim` / `re-export shim`
  marker and delete+repoint each.

## Importer repoint map (survey; Phase-3 investigation finalizes exact lines)

Core src importing `agent-runtime/builtin/` (must all repoint):
`cli/doctor.ts`, `config/config.ts` (codex+claude config), `dispatcher-service/teammate/service.ts`
(claude paths), `onboard/run.ts` (codex args+paths), `onboard/types.ts` (codex-home),
`onboard/uninstall.ts` (codex paths), `server.ts` (claude supervisor, codex
codex-home/rpc/supervisor).

Tests importing `agent-runtime/builtin/` (13 — repoint to package / new core
modules): `claude-code-live`, `claude-code-runtime`, `codex-completion`,
`codex-live`, `dispatcher-codex-home`, `doctor`, `e2e`, `global-config`,
`onboard`, `runtime-paths`, `runtime-sockets`, `smoke`, `uninstall`.

## Packages gain (so core can import directly)

- `@excitedjs/agent-runtime-codex`: `src/diagnostic.ts` (neutral
  `AgentRuntimeDiagnostic<DispatcherCodexConfig>`), `src/codex-home.ts` (moved);
  export both + args/config/supervisor/rpc/types/handshake/mcp-config/
  CodexProcessExitHandler from `src/index.ts`.
- `@excitedjs/agent-runtime-claude-code`: `src/diagnostic.ts`; export
  args/config/mcp-config/supervisor from index.
- Both packages still must NEVER import `@excitedjs/dreamux`. They MAY import
  `@excitedjs/dreamux-types` (+ `@excitedjs/dreamux-utils`).

## Docs

- DELETE `packages/dreamux/src/agent-runtime/CLAUDE.md`.
- Update root `CLAUDE.md`: the per-runtime path rule (no `builtin/<name>/paths.ts`),
  the codex-handshake-shim line (now imports the package directly), the
  builtin-adapter framing.
- Update `packages/dreamux/CLAUDE.md` agent-runtime rows (no `builtin/`).
- The new decision record (plan §12) already covers the convergence; extend it to
  state builtin/ is dissolved and core imports dreamux-types directly.

## OPEN QUESTION for the maintainer (channel symmetry)

`channel/feishu/` is the channel-side analogue of `builtin/`: `bot.ts` is a pure
shim (DELETE per criterion 2), but `feishu-channel.ts` (host adapter: resolves
bot secret/state/cache dirs + the sessionless `list_chat_bots` helper) and
`feishu-mcp-surface.ts` (host MCP descriptor + admin routing) contain real host
logic. D2 converges core onto neutral `ChannelSession`. QUESTION: should
`channel/feishu/` ALSO be fully dissolved (relocate its host logic out, delete
the directory) the same way as `builtin/`, or only delete its shim (`bot.ts`) +
do the D2 neutral convergence? Awaiting maintainer answer; default assumption
until told otherwise: dissolve shims + D2 convergence, keep the minimal host
adapter for `list_chat_bots` if it cannot be neutralized.
