# Verification

Date: 2026-11-27.

## Local repository gates

Commands run against the complete current worktree:

- `node common/scripts/install-run-rush.js install` — passed.
- `node common/scripts/install-run-rush.js build` — passed (10/10 packages).
- `node common/scripts/install-run-rush.js lint` — passed (10/10 packages).
- `node common/scripts/install-run-rush.js test` — passed for `@excitedjs/agent-runtime-codex`, `@excitedjs/agent-runtime-claude-code`, `@excitedjs/dreamux` (with existing live-Codex model-gate warning), `@excitedjs/feishu-channel`, `@excitedjs/feishu-transport`, `@excitedjs/dreamux-utils`, `@excitedjs/dreamux-types`, and `@excitedjs/dreamux-plugin-bootstrap`. During the initial 64-way parallel run, `@excitedjs/agent-runtime-antigravity` hit one transient tmux startup failure (`tests/tmux-runtime.test.ts` `has-session failed (server exited unexpectedly)`); rerun via `node common/scripts/install-run-rush.js test --only @excitedjs/agent-runtime-antigravity` passed cleanly.
- `node common/scripts/install-run-rush.js typecheck:tests` — passed (9/9 packages).
- `git diff --check` — passed.

## Acceptance criteria coverage

1. Aligned base fields (`bin`, `model`, `effort`, `extra_args`, `extra_env`) plus provider-specific `remote_control` (`claude-code`) and `transport` (`antigravity`): verified by new unit suites `packages/agent-runtime/codex/tests/config-and-args.test.ts`, `packages/agent-runtime/claude-code/tests/config-and-args.test.ts`, and updated `packages/agent-runtime/antigravity/tests/config.test.ts`.
2. Non-empty string or `null` validation for `model`/`effort` with no effort allowlist across all three providers: verified in the three config unit suites.
3. Codex `-c approval_policy=never`, TOML-quoted `-c model=...` and `-c model_reasoning_effort=...` ahead of `extra_args`, no `-c sandbox_mode=...`, internal 10s handshake timeout, fail-fast approval handler: verified in `codex/tests/config-and-args.test.ts` and `codex/tests/codex-runtime.test.ts`.
4. Claude Code `--dangerously-skip-permissions`, `--model`/`--effort` ahead of `extra_args`, no `--permission-mode`, fail-fast `can_use_tool` error response, internal 600s stream-inactivity timeout: verified in `claude-code/tests/config-and-args.test.ts`, `claude-code/tests/stream.test.ts`, `claude-code/tests/rpc.test.ts`, and `claude-code/tests/log-permissions.test.ts`.
5. Antigravity open non-empty `effort` passthrough and ACP `session/request_permission` fail-fast `{ outcome: { outcome: 'cancelled' } }`: verified in `antigravity/tests/config.test.ts` and `antigravity/tests/acp-runtime.test.ts`.
6. R21 tolerance for retired keys (`sandbox_mode`, `initialize_timeout_ms`, `permission_mode`, `turn_timeout_ms`, `approval_policy`): verified in `codex/tests/config-and-args.test.ts` and `claude-code/tests/config-and-args.test.ts`.
7. Public export contract, bundled maintenance skill references, READMEs, and docs: verified by `packages/dreamux/tests/official-provider-entries.test.ts`, `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts`, and `packages/dreamux/tests/onboard.test.ts`.

## Coverage limits and residual risks

- Live model execution against real `codex`, `claude`, and `agy` binaries was not run (`DREAMUX_RUN_LIVE_MODEL_GATE` unset); CLI flag rendering, permission-callback rejection, and config parsing are verified deterministically via unit and fake-transport tests.
- Claude Code CLI refuses `--dangerously-skip-permissions` when running as Linux `root`/`sudo`; running Dreamux under a non-root user is required for `builtin:claude-code`.
- Existing installations relying on `config.sandbox_mode` or `config.permission_mode` must move those settings to native CLI configuration (`~/.codex/config.toml` / Claude settings) or `extra_args`.

## Review adjudication

Pending independent review via Devbox.
