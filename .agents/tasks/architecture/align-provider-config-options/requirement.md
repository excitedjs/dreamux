# Requirement

## Initial request

- Operator, 2026-11-27: align and simplify the config options of the `codex`, `claude-code`, and `antigravity` agent-runtime providers. Provider-specific options are acceptable when useful, but options that make little practical difference should be trimmed, inconsistent configuration styles should be aligned, and `model` and `effort` are the primary options of interest.
- Follow-up alignment, 2026-11-27: unify the default approval and sandbox posture across all three providers — disable interactive tool-call approval solely via each engine's CLI flag, remove protocol-level auto-allow code (fail fast / reject instead), and leave sandbox policy entirely to the user's native CLI configuration.

## Current alignment

- Status: Final (all 6 blocking decisions resolved by operator rulings on 2026-11-27; ready for solution approval).
- Desired outcome: Clean, aligned `agents[].config` option schemas and uniform unattended approval/sandbox semantics across `@excitedjs/agent-runtime-codex`, `@excitedjs/agent-runtime-claude-code`, and `@excitedjs/agent-runtime-antigravity`.

### Desired behavior

1. **Shared base options inside each provider's `agents[].config`.** All three providers accept the same five base optional fields with uniform semantics and defaults:
   - `bin`: non-empty string (`"codex"` / `"claude"` / `"agy"`).
   - `model`: non-empty string or `null` (default `null`). When `null` or omitted, the provider emits no model override and lets the native engine decide.
   - `effort`: non-empty string or `null` (default `null`). When `null` or omitted, the provider emits no effort override and lets the native engine decide. No provider maintains a Dreamux-side effort enum allowlist; non-empty strings pass through to the native CLI or protocol.
   - `extra_args`: string array (default `[]`), appended after provider-generated CLI arguments so explicit `extra_args` overrides win.
   - `extra_env`: string-to-string map (default `{}`).
2. **Provider-specific options kept only where genuinely needed:**
   - `codex`: no extra provider-specific config options.
   - `claude-code`: `remote_control` (`boolean`, default `false`).
   - `antigravity`: `transport` (`"tmux" | "acp"`, default `"tmux"`).
3. **Uniform unattended tool-call approval and native sandbox posture across all three providers:**
   - **CLI approval bypass**: each provider passes its engine's tool-call approval bypass flag on launch without touching OS sandbox settings:
     - `codex`: `-c approval_policy=never` (unchanged).
     - `claude-code`: `--dangerously-skip-permissions` (added).
     - `antigravity`: `--dangerously-skip-permissions` on both `acp` and `tmux` (unchanged).
   - **No protocol-level auto-allow**: remove all protocol-level permission auto-approval handlers; unexpected permission callbacks fail fast / reject instead of silently allowing:
     - `codex`: retains existing `createFailFastApprovalHandler` (rejects with error + warn log).
     - `claude-code`: removes `can_use_tool` auto-allow (`buildCanUseToolAllow`) and replies with an error `control_response` + warn log if `can_use_tool` is ever received.
     - `antigravity`: removes `allow_once` / `allow_always` auto-selection in ACP `session/request_permission` and replies directly with `{ outcome: { outcome: 'cancelled' } }` + warn log.
   - **Sandbox untouched**: none of the three providers pass sandbox flags (`codex` stops emitting `-c sandbox_mode=...`; `claude-code` passes no sandbox flags; `antigravity` does not pass `--sandbox`). Sandbox behavior follows each user's native CLI configuration (`~/.codex/config.toml`, `~/.claude/settings.json`, `agy` settings) or explicit `extra_args`.
4. **Retired config options (tolerated and ignored under R21):**
   - `codex` removes `sandbox_mode` and `initialize_timeout_ms` from config (joining previously retired `approval_policy` and `turn_timeout_ms`). Handshake timeout stays an internal `10_000` ms constant. Emits optional `-c model=<toml-string>` and `-c model_reasoning_effort=<toml-string>` ahead of `extra_args`.
   - `claude-code` removes `permission_mode` and `turn_timeout_ms` from config. Stream-inactivity timeout stays an internal `600_000` ms constant. Emits optional `--model <model>` and `--effort <effort>` ahead of `extra_args`.
   - `antigravity` removes its closed `ANTIGRAVITY_EFFORTS` allowlist and validates `model` and `effort` as non-empty strings when non-null.
5. **Core remains neutral.** `agents[]` envelope and `AgentRuntimeCreateContext` do not add `model` or `effort` concepts.

### Scope

- `@excitedjs/agent-runtime-codex` config, CLI arg builder, provider wiring, public exports, tests.
- `@excitedjs/agent-runtime-claude-code` config, CLI arg builder (`--dangerously-skip-permissions`, `--effort`, remove `--permission-mode`), `stream.ts` / `control-rpc.ts` fail-fast `can_use_tool` rejection, runtime internal timeout wiring, public exports, tests.
- `@excitedjs/agent-runtime-antigravity` config validation (remove `ANTIGRAVITY_EFFORTS`, reject blank `model`/`effort`), ACP `session/request_permission` fail-fast cancellation, README, tests.
- `@excitedjs/dreamux` bundled maintenance skill references (`builtin-codex.md`, `builtin-claude-code.md`), package README, affected tests (`official-provider-entries.test.ts`, live Codex test helpers/specs, README contract tests).
- Public docs (`docs/configuration.md`, `docs/getting-started.md`) and `.agents/` knowledge base updates.
- Rush change files for the modified packages.

### Non-goals

- Promoting `model`/`effort` to top-level `agents[]` fields or adding runtime `/model` / `/effort` switching commands and `identity.json` persistence (remains separate in `promote-runtime-model-and-effort`).
- Changing Antigravity's `transport` (`tmux` / `acp`) selection or `tmux` `trustedWorkspaces` setting.
- Changing Claude Code's `remote_control` protocol or non-`can_use_tool` control-request ack.
- Changing Codex's `ultrathink` keyword handling.
- Adding workarounds for running `claude --dangerously-skip-permissions` under Linux `root`/`sudo` (known upstream CLI restriction).
- Editing operator-local `~/.dreamux/config.json` files outside this repository.

### Constraints and invariants

- Follow Dreamux R21 persisted-shape policy: unrecognized keys in `agents[].config` (including retired `sandbox_mode`, `initialize_timeout_ms`, `permission_mode`, `turn_timeout_ms`, `approval_policy`) are tolerated and ignored without failing startup. No `BREAKING:` / `Rebuild:` changelog note is needed for removed optional keys.
- Empty or whitespace-only strings for `model` or `effort` are rejected with `RuleViolation`, consistent with `bin`; `null` or omitted means unset.
- `extra_args` remain last in spawned CLI arguments so operators can override generated flags or pass native options such as `-c sandbox_mode=...` or `--permission-mode ...`.
- Synchronize `/packages/dreamux/skills/dispatcher/dreamux-maintenance/` references (`builtin-codex.md`, `builtin-claude-code.md`) in the same change.
- Public repository red line: no internal identifiers, secrets, private paths, or operator config contents in code, tests, docs, or task records.

## Confirmed current behavior and evidence

Verified from current source and live CLI probes on 2026-11-27:

- **Host `agents[]` envelope** (`packages/dreamux/src/config/config.ts`): owns `id`, `provider`, optional `description`, `tags`, `developerInstructions`, and opaque provider-owned `config`.
- **`builtin:codex`** (`packages/agent-runtime/codex/src/{config.ts,args.ts,provider.ts,handshake.ts,runtime.ts}`): accepts `bin`, `sandbox_mode` (default `"workspace-write"`), `extra_args`, `extra_env`, `initialize_timeout_ms` (default `10000`); lacks `model` and `effort`. Always passes `-c approval_policy=never` and uses `createFailFastApprovalHandler` (no auto-allow). `CodexReasoningEffort` reads `thread.reasoningEffort` on fresh start and `config/read` (`config.model_reasoning_effort`) on cold resume.
- **`builtin:claude-code`** (`packages/agent-runtime/claude-code/src/{config.ts,args.ts,runtime.ts,stream.ts,control-rpc.ts}`): accepts `bin`, `model`, `permission_mode`, `remote_control`, `extra_args`, `extra_env`, `turn_timeout_ms` (default `600000`); lacks `effort`. Verified `claude --help` supports `--effort <level>` and `--dangerously-skip-permissions`. Currently omits `--dangerously-skip-permissions` and auto-allows `can_use_tool` in `control-rpc.ts`.
- **`npm:@excitedjs/agent-runtime-antigravity`** (`packages/agent-runtime/antigravity/src/{config.ts,acp/runtime.ts,tmux/session.ts}`): accepts `transport`, `bin`, `model`, `effort`, `extra_args`, `extra_env`, with a closed 5-value `ANTIGRAVITY_EFFORTS` allowlist. Both `acp` and `tmux` pass `--dangerously-skip-permissions` and do not pass `--sandbox`. ACP also auto-selects `allow_once`/`allow_always` in `session/request_permission`. Live `agy acp` `session/new` returns separate `model` (base model ids) and `thought_level` options.

## Acceptance criteria

1. All three providers expose aligned base config fields `bin`, `model`, `effort`, `extra_args`, and `extra_env`, plus only `remote_control` on `claude-code` and `transport` on `antigravity`.
2. In all three providers, `model` and `effort` accept a non-empty string or `null`/omitted (default `null`), reject non-string or blank/whitespace-only string values with `RuleViolation`, and impose no hardcoded effort enum allowlist.
3. Codex emits `-c approval_policy=never`, optional `-c model=<toml-string>` and `-c model_reasoning_effort=<toml-string>`, followed by `extra_args`, emits no `-c sandbox_mode=...`, keeps fail-fast approval rejection, and uses the internal 10_000 ms handshake timeout.
4. Claude Code always emits `--dangerously-skip-permissions`, emits optional `--model <model>` and `--effort <effort>` ahead of `extra_args`, emits no `--permission-mode`, rejects any `can_use_tool` control request with an error `control_response` instead of auto-allowing, keeps `remote_control`, and uses the internal 600_000 ms stream-inactivity timeout.
5. Antigravity passes through any non-empty `model` and `effort` string to `tmux` (`--model` / `--effort`) and `acp` (`session/set_config_option`), keeps `--dangerously-skip-permissions` on both transports without passing `--sandbox`, and replies `{ outcome: { outcome: 'cancelled' } }` to ACP `session/request_permission` instead of auto-allowing.
6. Existing `config.json` files carrying retired keys (`sandbox_mode`, `initialize_timeout_ms`, `permission_mode`, `turn_timeout_ms`, `approval_policy`) still load cleanly without error.
7. Package public exports, bundled maintenance skill references (`builtin-codex.md`, `builtin-claude-code.md`), READMEs, `docs/`, `.agents/` docs, and Rush change files reflect the aligned schema and behavior, and `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`, and `node .agents/scripts/check.mjs` all pass.

## Decisions and unknowns

- Confirmed operator decisions:
  - 2026-11-27, task lineage: "新建独立任务 (Recommended)" — create an independent task for aligning and simplifying provider config options rather than reusing `promote-runtime-model-and-effort`.
  - 2026-11-27, Decision 1 (`model` / `effort` layer placement): "放在 config 内 (Recommended)" — keep `model` and `effort` inside each provider's `agents[].config` rather than promoting them to the top-level `agents[]` envelope; Core and `AgentRuntimeCreateContext` remain unchanged.
  - 2026-11-27, Decision 2 (timeout options): "全部移除改内部常量 (Recommended)" — remove `initialize_timeout_ms` from `codex` config and `turn_timeout_ms` from `claude-code` config, keeping 10s / 600s as internal provider constants; leftover fields in existing configs are ignored under R21.
  - 2026-11-27, Decision 3 (permission/sandbox options): "全部移除交给原生默认" — remove `sandbox_mode` from `codex` config and `permission_mode` from `claude-code` config, leaving sandbox policy to native user config or `extra_args`.
  - 2026-11-27, Decision 4 (`claude-code.remote_control`): "保留 remote_control (Recommended)" — keep `remote_control` (boolean, default `false`) as a Claude Code provider-specific option alongside `antigravity.transport`.
  - 2026-11-27, Decision 5 (`effort` validation policy): "统一透传给原生引擎 (Recommended)" — validate `model` and `effort` uniformly as non-empty string or `null` across all three providers, removing Antigravity's closed effort allowlist and passing values directly to the native CLI/protocol.
  - 2026-11-27, Decision 6 (converged approval & sandbox posture): "采用此收敛方案 (Recommended)" — disable tool-call approval solely via CLI flags (`codex`: `-c approval_policy=never`; `claude-code` & `antigravity`: `--dangerously-skip-permissions`), delete all protocol-level auto-allow code (fail-fast reject `can_use_tool` in Claude Code and cancel `session/request_permission` in Antigravity ACP, matching Codex's fail-fast handler), and leave sandbox untouched across all three providers.
- Assumptions:
  - Removing `sandbox_mode`, `initialize_timeout_ms`, `permission_mode`, `turn_timeout_ms` from the TypeScript config interfaces and removing their dead constants (`ALLOWED_SANDBOX_MODES`, `DEFAULT_SANDBOX_MODE`, `DEFAULT_INITIALIZE_TIMEOUT_MS`, `ALLOWED_CLAUDE_CODE_PERMISSION_MODES`, `DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS`) from package public exports is desired as part of the cleanup (packages stay on 0.x and record Rush `minor` change files).
  - Live Codex tests (`packages/dreamux/tests/helpers/live-codex-provider.ts`, `packages/dreamux/tests/codex-inbound-live.test.ts`) pass `-c sandbox_mode=danger-full-access` via `extra_args` so they remain deterministic regardless of the host's `~/.codex/config.toml`.
- Blocking unknowns: None.
