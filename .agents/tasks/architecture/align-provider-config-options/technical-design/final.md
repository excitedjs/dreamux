# Technical Solution — Align Agent-Runtime Provider Config Options

Requirement input: [requirement.md](/.agents/tasks/architecture/align-provider-config-options/requirement.md).

## 1. Summary and Entropy Delta

All three agent-runtime providers (`@excitedjs/agent-runtime-codex`, `@excitedjs/agent-runtime-claude-code`, `@excitedjs/agent-runtime-antigravity`) converge on:
1. One shared base `agents[].config` shape (`bin`, `model`, `effort`, `extra_args`, `extra_env`), keeping only genuinely provider-specific options (`remote_control` on Claude Code, `transport` on Antigravity).
2. One uniform unattended approval/sandbox model: disable interactive tool-call approval strictly through each engine's CLI flag (`-c approval_policy=never` / `--dangerously-skip-permissions`), delete all protocol-level auto-allow code (fail fast / reject any unexpected permission callback), and pass zero sandbox flags so sandbox policy stays 100% in the user's native CLI configuration.

What is removed:
- 4 config fields: `codex.sandbox_mode`, `codex.initialize_timeout_ms`, `claude-code.permission_mode`, `claude-code.turn_timeout_ms`.
- 6 allowlists / config-default constants: `ALLOWED_SANDBOX_MODES`, `DEFAULT_SANDBOX_MODE`, `DEFAULT_INITIALIZE_TIMEOUT_MS`, `ALLOWED_CLAUDE_CODE_PERMISSION_MODES`, `DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS` (kept private in `runtime.ts`), and `ANTIGRAVITY_EFFORTS`.
- 2 protocol-level auto-allow paths: Claude Code `buildCanUseToolAllow` / `can_use_tool` auto-allow in `control-rpc.ts`, and Antigravity ACP `allow_once` / `allow_always` auto-selection in `session/request_permission`.
- 1 dead internal dependency field (`CodexRuntimeDeps.handshakeTimeoutMs`) and 1 intermediate wrapper (`ParsedCodexArgs` / `codexArgsFromConfig` + `codexArgsToCli` collapsed into `codexCliArgs`).

What is added:
- `model` and `effort` on `codex` (emitting `-c model=<toml>` and `-c model_reasoning_effort=<toml>`).
- `effort` (emitting `--effort <effort>`) and `--dangerously-skip-permissions` on `claude-code`, plus fail-fast `buildControlError` for unexpected `can_use_tool` requests.
- Uniform non-empty string validation on `model` and `effort` across all three providers.

Core (`@excitedjs/dreamux/src/**`) and `@excitedjs/dreamux-types` are untouched: provider config and CLI flags stay strictly provider-owned.

## 2. Owning Components and Intended Behavior

### 2.1 `@excitedjs/agent-runtime-codex`

- `packages/agent-runtime/codex/src/config.ts`:
  - `DispatcherCodexConfig` becomes:
    ```ts
    export interface DispatcherCodexConfig {
      bin: string;
      model: string | null;
      effort: string | null;
      extra_args: string[];
      extra_env: Record<string, string>;
    }
    ```
  - Keep `DEFAULT_CODEX_BIN = 'codex'`; remove `DEFAULT_INITIALIZE_TIMEOUT_MS`, `DEFAULT_SANDBOX_MODE`, `ALLOWED_SANDBOX_MODES`.
  - `defaultDispatcherCodexConfig()` returns `{ bin: DEFAULT_CODEX_BIN, model: null, effort: null, extra_args: [], extra_env: {} }`.
  - `readDispatcherCodexConfig()` reads `bin` (non-empty string, default `"codex"`), `model` (`null` when omitted/null; otherwise non-empty string), `effort` (`null` when omitted/null; otherwise non-empty string), `extra_args`, and `extra_env`. Rejects blank/whitespace-only `bin`, `model`, or `effort` with `RuleViolation`. Unrecognized keys (including retired `approval_policy`, `sandbox_mode`, `initialize_timeout_ms`, `turn_timeout_ms`) remain tolerated and ignored under R21.
- `packages/agent-runtime/codex/src/args.ts`:
  - Replace `ParsedCodexArgs`, `codexArgsFromConfig`, and `codexArgsToCli` (single caller in `provider.ts`) with a single pure helper:
    ```ts
    export function codexCliArgs(
      config: Pick<DispatcherCodexConfig, 'model' | 'effort' | 'extra_args'>,
    ): string[]
    ```
  - Emits:
    1. `['-c', 'approval_policy=never']` (always; tool-call approval bypass matching `createFailFastApprovalHandler`).
    2. When `config.model !== null`: `['-c', \`model=${JSON.stringify(config.model)}\`]`.
    3. When `config.effort !== null`: `['-c', \`model_reasoning_effort=${JSON.stringify(config.effort)}\`]`.
    4. `...config.extra_args` (last, so Codex's last-write-wins semantics let explicit `extra_args` override `model`, `model_reasoning_effort`, or supply `sandbox_mode`).
  - No `-c sandbox_mode=...` is emitted; sandbox policy defers to `~/.codex/config.toml` or `extra_args`.
  - `JSON.stringify` matches `mcp-config.ts`'s `tomlString` (TOML basic strings are a superset of JSON string escapes).
  - `CodexReasoningEffort` automatically observes `-c model_reasoning_effort=...` via `thread/start` (`reasoningEffort`) and cold-resume `config/read` (`config.model_reasoning_effort`).
- `packages/agent-runtime/codex/src/provider.ts`, `src/runtime-deps.ts`, `src/runtime.ts`, `src/index.ts`:
  - `provider.ts` builds `runtimeArgs` from `codexCliArgs(codexConfig)` + `codexMcpServerArgs(context.mcpServers)` and stops passing `handshakeTimeoutMs`.
  - `runtime-deps.ts` drops `handshakeTimeoutMs`; `runtime.ts` calls `performInitializeHandshake(this.client)` (internal `DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000` in `handshake.ts`) and keeps `createFailFastApprovalHandler` unchanged.
  - `index.ts` drops the removed constant exports (`DEFAULT_INITIALIZE_TIMEOUT_MS`, `DEFAULT_SANDBOX_MODE`, `ALLOWED_SANDBOX_MODES`).

### 2.2 `@excitedjs/agent-runtime-claude-code`

- `packages/agent-runtime/claude-code/src/config.ts`:
  - `DispatcherClaudeCodeConfig` becomes:
    ```ts
    export interface DispatcherClaudeCodeConfig {
      bin: string;
      model: string | null;
      effort: string | null;
      remote_control: boolean;
      extra_args: string[];
      extra_env: Record<string, string>;
    }
    ```
  - Remove `permission_mode`, `turn_timeout_ms`, `ALLOWED_CLAUDE_CODE_PERMISSION_MODES`, `DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS` from `config.ts` and `index.ts`.
  - `readDispatcherClaudeCodeConfig()` reads `bin` (non-empty string, default `"claude"`), `model` (`null` or non-empty string), `effort` (`null` or non-empty string), `remote_control` (boolean, default `false`), `extra_args`, `extra_env`. Rejects blank/whitespace-only `bin`, `model`, or `effort` with `RuleViolation`. Unrecognized keys (including retired `permission_mode` and `turn_timeout_ms`) remain tolerated and ignored under R21.
- `packages/agent-runtime/claude-code/src/args.ts`:
  - Always include `'--dangerously-skip-permissions'` in the resident CLI arguments.
  - Remove the `--permission-mode` emission branch.
  - Keep `--model <model>` when `config.model !== null`; add `--effort <effort>` when `config.effort !== null`. Both precede `extra_args`.
- `packages/agent-runtime/claude-code/src/stream.ts` & `src/control-rpc.ts`:
  - Replace `buildCanUseToolAllow` with `buildControlError(requestId: string, error: string)` emitting `{ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }`.
  - In `ClaudeCodeControlRpc.onControlRequest`: when `subtype === 'can_use_tool'`, log a `warn` and reply with `buildControlError(requestId, 'tool permission requests are unsupported in Dreamux-managed runtimes')` instead of auto-allowing. Non-`can_use_tool` control requests retain `buildControlAck(requestId)`.
- `packages/agent-runtime/claude-code/src/runtime.ts`:
  - Define internal `const CLAUDE_CODE_TURN_TIMEOUT_MS = 600_000;` and pass it as `turnTimeoutMs` to `createDefaultClaudeCodeSession(...)`. Keep `turnTimeoutMs` on `ClaudeCodeSessionSpec` / `ClaudeCodeStreamRpcOptions` so existing `rpc.ts` / `session.ts` timeout unit tests stay deterministic.
- `packages/agent-runtime/claude-code/src/index.ts`:
  - Drop `ALLOWED_CLAUDE_CODE_PERMISSION_MODES` and `DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS` exports.

### 2.3 `@excitedjs/agent-runtime-antigravity`

- `packages/agent-runtime/antigravity/src/config.ts`:
  - Keep `AntigravityConfig` fields unchanged (`transport`, `bin`, `model`, `effort`, `extra_args`, `extra_env`).
  - Remove `ANTIGRAVITY_EFFORTS` allowlist.
  - Validate both `model` and `effort` as non-empty strings when non-null (throwing `RuleViolation` on blank/whitespace-only strings), matching `codex` and `claude-code`.
- `packages/agent-runtime/antigravity/src/acp/runtime.ts`:
  - Keep `--dangerously-skip-permissions` in spawn args (and keep omitting `--sandbox`).
  - In `.onRequest('session/request_permission', ...)`, remove the `allow_once` / `allow_always` auto-allow logic; log a `warn` and return `{ outcome: { outcome: 'cancelled' } }` directly (fail-fast rejection matching Codex and Claude Code).
- `packages/agent-runtime/antigravity/src/tmux/session.ts`:
  - Unchanged (already passes `--dangerously-skip-permissions`, omits `--sandbox`, passes `--model` / `--effort` before `extra_args`).

### 2.4 Documentation, Bundled Maintenance Skill, and Knowledge Base

- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md`: update to current fields (`bin`, `model`, `effort`, `extra_args`, `extra_env`), note hardcoded `approval_policy=never` and native default sandbox (current-state-only).
- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-claude-code.md`: update to current fields (`bin`, `model`, `effort`, `remote_control`, `extra_args`, `extra_env`), note `--dangerously-skip-permissions` (current-state-only).
- `packages/dreamux/README.md`, `packages/agent-runtime/antigravity/README.md`, `docs/configuration.md`, `docs/getting-started.md`: update provider config tables, examples, and approval/sandbox behavior notes.
- `.agents/domains/provider-runtime.md`: update the Claude Code interrupt note that previously stated "where every callback allows" (now `--dangerously-skip-permissions` avoids permission prompts and unexpected `can_use_tool` callbacks fail fast) and verify no stale field lists remain.

## 3. Implementation Boundary

Files in scope:
- `packages/agent-runtime/codex/src/{config.ts,args.ts,provider.ts,runtime-deps.ts,runtime.ts,index.ts}` and `packages/agent-runtime/codex/tests/*`
- `packages/agent-runtime/claude-code/src/{config.ts,args.ts,stream.ts,control-rpc.ts,runtime.ts,index.ts}` and `packages/agent-runtime/claude-code/tests/*`
- `packages/agent-runtime/antigravity/src/{config.ts,acp/runtime.ts}`, `packages/agent-runtime/antigravity/README.md`, and `packages/agent-runtime/antigravity/tests/{config.test.ts,acp-runtime.test.ts}`
- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/{builtin-codex.md,builtin-claude-code.md}`
- `packages/dreamux/README.md`, `docs/{configuration.md,getting-started.md}`
- `packages/dreamux/tests/{official-provider-entries.test.ts,feishu-allow-chats-release-contract.test.ts,helpers/live-codex-provider.ts,codex-inbound-live.test.ts,onboard.test.ts}` (only assertions coupled to removed exports/fields)
- `.agents/` task record and affected domain pages
- Rush change files under `common/changes/` (`minor` for the three 0.x runtime provider packages; `patch` for `@excitedjs/dreamux`)

Explicitly out of scope:
- `packages/dreamux/src/**`, `packages/dreamux-types/**`, `packages/dreamux-utils/**`, `packages/channel/**`, `packages/plugins/**`
- Operator-local `~/.dreamux/config.json`

## 4. Compatibility and Upgrade Impact

- **Persisted config compatibility**: Under R21, all three provider config readers tolerate and ignore unrecognized keys. Existing `config.json` files containing `sandbox_mode`, `initialize_timeout_ms`, `permission_mode`, `turn_timeout_ms`, or `approval_policy` continue to start without error.
- **Behavioral changes to document plainly in change notes**:
  - Codex agents that previously relied on `config.sandbox_mode` (or Dreamux's former `"workspace-write"` default) now defer sandbox mode to `~/.codex/config.toml` or explicit `extra_args: ["-c", "sandbox_mode=..."]`.
  - Claude Code agents always launch with `--dangerously-skip-permissions` (so Linux `root`/`sudo` processes are refused by Claude CLI), no longer read `config.permission_mode`, and reject unexpected `can_use_tool` callbacks instead of auto-allowing.
  - Antigravity ACP rejects unexpected `session/request_permission` callbacks with `cancelled` instead of auto-allowing, and accepts any non-empty `effort` string without a closed allowlist.
  - All three packages stay on `0.x` and use Rush change type `minor` with plain notes (not `BREAKING:` / `Rebuild:`, because persisted files remain readable).

## 5. Verification Plan

1. Unit tests across all three provider packages:
   - Codex: config reader tests (defaults, `model` & `effort` accepted, blank strings rejected, retired keys ignored) + `codexCliArgs` tests (`approval_policy=never` always emitted, no `sandbox_mode`, `-c model=...` / `-c model_reasoning_effort=...` TOML-quoted ahead of `extra_args`).
   - Claude Code: config reader tests (defaults, `model` & `effort` accepted, blank strings rejected, `remote_control` kept, retired keys ignored) + `claudeCodeResidentArgs` tests (`--dangerously-skip-permissions` always emitted, `--model` & `--effort` emitted ahead of `extra_args`, no `--permission-mode`) + `stream.ts` / `rpc.ts` tests verifying `can_use_tool` receives a fail-fast error response.
   - Antigravity: config reader tests (arbitrary non-empty `effort` accepted, blank `model`/`effort` rejected, invalid `transport` still rejected) + `acp-runtime.test.ts` verifying `session/request_permission` returns `{ outcome: { outcome: 'cancelled' } }`.
   - Dreamux host tests: updated `official-provider-entries.test.ts`, README contract test, and live-codex test helpers.
2. Full monorepo gates:
   - `node common/scripts/install-run-rush.js build`
   - `node common/scripts/install-run-rush.js lint`
   - `node common/scripts/install-run-rush.js test`
   - `node common/scripts/install-run-rush.js typecheck:tests`
   - `node .agents/scripts/check.mjs`
   - `git diff --check`
3. Independent review: request review via `@Devbox` in this thread before final closeout and PR to `next`.

## 6. Known Limitations

- Claude Code CLI refuses `--dangerously-skip-permissions` when running as Linux `root`/`sudo`; running Dreamux as a non-root user is required for `builtin:claude-code`.
- Live end-to-end execution against real `codex`, `claude`, and `agy` binaries is subject to environment availability; CLI flag wiring, permission-callback rejection, and config parsing are verified deterministically via unit tests.
- Operators whose existing `~/.dreamux/config.json` relies on `sandbox_mode` or `permission_mode` must move those overrides into native CLI config (`~/.codex/config.toml` / Claude settings) or `extra_args` after upgrading.
