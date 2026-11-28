# Verification

Date: 2026-11-29 (follow-up Codex `danger-full-access` regression-fix slice after PR #498).

## Local repository gates

Commands run against the complete current worktree:

- `node common/scripts/install-run-rush.js build` — passed (10/10 packages).
- `node common/scripts/install-run-rush.js lint` — passed (10/10 packages).
- `node common/scripts/install-run-rush.js test` — passed across all packages (initial 64-way parallel run hit one transient tmux startup flake in untouched `@excitedjs/agent-runtime-antigravity` `tests/tmux-runtime.test.ts` `has-session failed (server exited unexpectedly)`; rerun `rush test --only @excitedjs/agent-runtime-antigravity` passed cleanly).
- `node common/scripts/install-run-rush.js typecheck:tests` — passed (9/9 packages).
- `node common/scripts/install-run-rush.js change --verify --no-fetch --target-branch next` — passed (2 change files verified: `@excitedjs/agent-runtime-codex`, `@excitedjs/dreamux`).
- `node .agents/scripts/check.mjs` — passed.
- `git diff --check` — passed.

## Acceptance criteria coverage

1. `codexCliArgs()` emits `['-c', 'approval_policy=never', '-c', 'sandbox_mode=danger-full-access']` ahead of optional `-c model=<toml>`, `-c model_reasoning_effort=<toml>`, and `extra_args`: verified in `packages/agent-runtime/codex/tests/config-and-args.test.ts`.
2. Explicit `extra_args` overrides (e.g. `-c sandbox_mode=read-only`) remain appended after generated defaults so Codex's last-write-wins `-c` override applies: verified in `packages/agent-runtime/codex/tests/config-and-args.test.ts` and live `codex-cli 0.171.0` `app-server` probe.
3. `DispatcherCodexConfig` remains unchanged (`bin`, `model`, `effort`, `extra_args`, `extra_env`) and retired keys (`approval_policy`, `sandbox_mode`, `initialize_timeout_ms`, `turn_timeout_ms`) remain tolerated under R21: verified in `packages/agent-runtime/codex/tests/config-and-args.test.ts`.
4. Live Codex test helpers (`packages/dreamux/tests/helpers/live-codex-provider.ts` and `packages/dreamux/tests/codex-inbound-live.test.ts`) no longer pass a redundant `extra_args: ['-c', 'sandbox_mode=danger-full-access']` workaround: verified by `packages/dreamux` tests and `rush typecheck:tests`.
5. `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md`, `packages/dreamux/README.md`, and `docs/configuration.md` synchronized with the default `-c sandbox_mode=danger-full-access` launch flag: verified by `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts`.

## Review adjudication

- Follow-up slice ([PR #499](https://github.com/excitedjs/dreamux/pull/499)): [Devbox review](https://github.com/excitedjs/dreamux/pull/499#pullrequestreview-6099518603) **APPROVED** with full 13-file diff coverage, independent `codex-cli 0.172.0` app-server smoke check, independent full monorepo gate rerun (`build`, `lint`, `test`, `typecheck:tests`, `change --verify`), and zero code or documentation findings (only the expected Draft-stage `State: review` KB check, resolved by this closeout).
- Prior merged slice ([PR #498](https://github.com/excitedjs/dreamux/pull/498), [Devbox review](https://github.com/excitedjs/dreamux/pull/498#pullrequestreview-6088215089)): operator adjudicated on 2026-11-28 ("仅修 1&2，3 留待后续 (Recommended)"); findings 1 and 2 landed in PR #498, finding 3 deferred below.

## Deferred cleanup trail

- `@excitedjs/dreamux-utils` (`packages/dreamux-utils/src/config-validate.ts`): in a future utils cleanup pass, consider promoting the identical `readOptionalNonEmptyString` helper shared across `codex`, `claude-code`, and `antigravity` into `config-validate.ts`, and evaluate retiring `readPositiveInt` (currently zero production callers in the monorepo, kept for now to avoid expanding package release boundaries).

## Knowledge-owner closeout

| Owner | Status | Notes |
| --- | --- | --- |
| Task record (`.agents/tasks/architecture/align-provider-config-options/`) | Updated | Reconciled requirement, solution, operator rulings, Devbox review approval, verification, and set `State: done`. |
| `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md` | Updated | Updated current-state Codex launch note (`-c approval_policy=never` and `-c sandbox_mode=danger-full-access`, overridable via `extra_args`). |
| `.agents/domains/provider-runtime.md` | N/A | Does not hardcode Codex `sandbox_mode` CLI flags; unaffected by this slice. |
| `.agents/product/README.md` | N/A | No existing product-catalog promise contradicted. |
| `.agents/domains/state-config-and-files.md` | N/A | Host `config.json` envelope and R21 unknown-key tolerance unchanged. |
| Directory `CLAUDE.md`, `.agents/glossary.md`, `.agents/root.md` | N/A | No local invariant, term definition, or routing rule moved. |

## Coverage limits and residual risks

- Live model execution against real `codex` binary was not run under `DREAMUX_RUN_LIVE_MODEL_GATE=1`; live `codex-cli 0.171.0` `app-server` probes verified `-c sandbox_mode=danger-full-access` overriding `~/.codex/config.toml` (`sandbox_mode` and `default_permissions`) and last-write-wins override via `extra_args`, and unit tests verify generated CLI args.
- Under `approval_policy=never` + `sandbox_mode=danger-full-access`, Codex still enforces user `.rules` (`forbidden`/`prompt`) and its built-in forced-`rm` (`rm -f`/`rm -rf`) / dangerous PowerShell heuristic unless explicitly allowed in `.rules`.
- Operators who relied on `~/.codex/config.toml` `sandbox_mode` to restrict Dreamux-managed Codex sessions must move that override into `agents[].config.extra_args`.
