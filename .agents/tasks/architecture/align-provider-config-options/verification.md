# Verification

Date: 2026-11-28.

## Local repository gates

Commands run against the complete current worktree (including review-correction changes):

- `node common/scripts/install-run-rush.js build` — passed (10/10 packages).
- `node common/scripts/install-run-rush.js lint` — passed (10/10 packages).
- `node common/scripts/install-run-rush.js test` — passed across all packages (initial 64-way parallel run hit one transient tmux startup failure in `@excitedjs/agent-runtime-antigravity` `tests/tmux-runtime.test.ts` `has-session failed (server exited unexpectedly)`; rerun passed cleanly, and post-fix full validation re-ran cleanly).
- `node common/scripts/install-run-rush.js typecheck:tests` — passed (9/9 packages).
- `node common/scripts/install-run-rush.js change --verify --no-fetch --target-branch next` — passed (4 change files verified).
- `node .agents/scripts/check.mjs` — passed.
- `git diff --check` — passed.

## Acceptance criteria coverage

1. Aligned base fields (`bin`, `model`, `effort`, `extra_args`, `extra_env`) plus provider-specific `remote_control` (`claude-code`) and `transport` (`antigravity`): verified by `packages/agent-runtime/codex/tests/config-and-args.test.ts`, `packages/agent-runtime/claude-code/tests/config-and-args.test.ts`, and `packages/agent-runtime/antigravity/tests/config.test.ts`.
2. Non-empty string or `null` validation for `model`/`effort` with no effort allowlist across all three providers: verified in the three config unit suites.
3. Codex `-c approval_policy=never`, TOML-quoted `-c model=...` and `-c model_reasoning_effort=...` ahead of `extra_args`, no `-c sandbox_mode=...`, internal 10s handshake timeout, fail-fast approval handler: verified in `codex/tests/config-and-args.test.ts` and `codex/tests/codex-runtime.test.ts`.
4. Claude Code `--dangerously-skip-permissions`, `--model`/`--effort` ahead of `extra_args`, no `--permission-mode`, fail-fast `can_use_tool` error response, internal 600s stream-inactivity timeout: verified in `claude-code/tests/config-and-args.test.ts`, `claude-code/tests/stream.test.ts`, `claude-code/tests/rpc.test.ts`, and `claude-code/tests/log-permissions.test.ts`.
5. Antigravity open non-empty `effort` passthrough and ACP `session/request_permission` fail-fast `{ outcome: { outcome: 'cancelled' } }`: verified in `antigravity/tests/config.test.ts` and `antigravity/tests/acp-runtime.test.ts`.
6. R21 tolerance for retired keys (`sandbox_mode`, `initialize_timeout_ms`, `permission_mode`, `turn_timeout_ms`, `approval_policy`): verified in `codex/tests/config-and-args.test.ts` and `claude-code/tests/config-and-args.test.ts`.
7. Public export contract, bundled maintenance skill references, READMEs, and docs: verified by `packages/dreamux/tests/official-provider-entries.test.ts`, `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts`, and `packages/dreamux/tests/onboard.test.ts`.

## Review adjudication

Independent review target: [PR #498](https://github.com/excitedjs/dreamux/pull/498) ([Devbox review](https://github.com/excitedjs/dreamux/pull/498#pullrequestreview-6088215089), full diff coverage, zero correctness defects). Operator adjudicated findings on 2026-11-28 via interactive card ("仅修 1&2，3 留待后续 (Recommended)").

| Finding | Disposition | Evidence and reason | Operator ruling affected |
| --- | --- | --- | --- |
| Stale comment `approval-policy=never (or auto-approve)` at `packages/agent-runtime/codex/src/runtime.ts:52` | Accept | Confirmed in source; protocol auto-allow was removed across all providers. Updated comment to `Dreamux runs Codex with approval_policy=never.` within approved boundary. | Confirmed by 2026-11-28 review ruling |
| Unused `_request` param on `ClaudeCodeControlRpc.onControlRequest` and unread `request` field on `ParsedLine` (`control_request`) in `claude-code/src/{control-rpc.ts,rpc.ts,stream.ts,types.ts}` | Accept | Confirmed zero readers across source and tests after removing `buildCanUseToolAllow`. Deleted parameter, call-site argument, and parsed field within approved boundary. | Confirmed by 2026-11-28 review ruling |
| Consolidate duplicate `readOptionalNonEmptyString` into `@excitedjs/dreamux-utils` and remove unused `readPositiveInt` | Defer | Verified `packages/dreamux-utils/src/config-validate.ts` owns config primitives and `readPositiveInt` has no remaining monorepo production callers, but `@excitedjs/dreamux-utils` was excluded from this task's approved boundary and `readPositiveInt` is a public export. Recorded below as a follow-up cleanup candidate. | Confirmed by 2026-11-28 review ruling ("仅修 1&2，3 留待后续") |

## Deferred cleanup trail

- `@excitedjs/dreamux-utils` (`packages/dreamux-utils/src/config-validate.ts`): in a future utils cleanup pass, consider promoting the identical `readOptionalNonEmptyString` helper shared across `codex`, `claude-code`, and `antigravity` into `config-validate.ts`, and evaluate retiring `readPositiveInt` (currently zero production callers in the monorepo, kept for now to avoid expanding this PR's package release boundary).

## Knowledge-owner closeout

| Owner | Status | Notes |
| --- | --- | --- |
| Task record (`.agents/tasks/architecture/align-provider-config-options/`) | Updated | Final requirement, technical solution, operator rulings, review adjudication, cleanup trail, and verification reconciled. |
| `.agents/domains/provider-runtime.md` | Updated | Updated Claude Code interrupt note to reflect `--dangerously-skip-permissions` and fail-fast `can_use_tool` error rejection. |
| `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/{builtin-codex.md,builtin-claude-code.md}` | Updated | Synchronized current-state-only provider config references; `SKILL.md` routing verified unchanged. |
| `.agents/product/README.md` | N/A | No existing product-catalog promise was contradicted; provider config schemas and unattended approval rules live in `provider-runtime.md` and the maintenance references. |
| `.agents/domains/state-config-and-files.md` | N/A | Host `config.json` envelope and R21 unknown-key tolerance are unchanged. |
| Directory `CLAUDE.md`, `.agents/glossary.md`, `.agents/root.md` | N/A | No local invariant, term definition, or routing rule moved. |

## Coverage limits and residual risks

- Live model execution against real `codex`, `claude`, and `agy` binaries was not run (`DREAMUX_RUN_LIVE_MODEL_GATE` unset); config validation, CLI flag rendering, and permission-callback rejection are verified deterministically via unit and fake-transport tests.
- Claude Code CLI refuses `--dangerously-skip-permissions` when running as Linux `root`/`sudo`; running Dreamux under a non-root user is required for `builtin:claude-code`.
- Existing installations relying on `config.sandbox_mode` or `config.permission_mode` must move those settings to native CLI configuration (`~/.codex/config.toml` / Claude settings) or `extra_args`.
