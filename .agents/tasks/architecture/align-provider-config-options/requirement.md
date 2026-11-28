# Requirement

## Initial request

- Operator, 2026-11-27: align and simplify the config options of the `codex`, `claude-code`, and `antigravity` agent-runtime providers. Provider-specific options are acceptable when useful, but options that make little practical difference should be trimmed, inconsistent configuration styles should be aligned, and `model` and `effort` are the primary options of interest.
- Follow-up alignment, 2026-11-27: unify the default approval and sandbox posture across all three providers — disable interactive tool-call approval solely via each engine's CLI flag, remove protocol-level auto-allow code (fail fast / reject instead), and leave sandbox policy entirely to the user's native CLI configuration.
- Post-PR-#498 regression fix, 2026-11-29: operator directed minimal alignment first — pass `sandbox_mode=danger-full-access` to Codex so its default unattended execution aligns with Claude Code and Antigravity's current `--dangerously-skip-permissions` behavior, and confirmed reusing this task directory via interactive card ("复用原任务 (Recommended)").

## Current alignment

- Status: Final for the reopened PR #498 regression-fix slice (all blocking decisions settled; awaiting solution/development authorization card).
- Desired outcome: Fix the PR #498 Codex sandbox regression by emitting `-c sandbox_mode=danger-full-access` alongside `-c approval_policy=never` ahead of `extra_args`, aligning Codex's default unattended behavior with Claude Code and Antigravity while keeping `agents[].config` unchanged and preserving `extra_args` last-write-wins overrides.

### Desired behavior

1. **Shared base options inside each provider's `agents[].config`.** All three providers accept the same five base optional fields with uniform semantics and defaults (unchanged from PR #498):
   - `bin`: non-empty string (`"codex"` / `"claude"` / `"agy"`).
   - `model`: non-empty string or `null` (default `null`). When `null` or omitted, the provider emits no model override and lets the native engine decide.
   - `effort`: non-empty string or `null` (default `null`). When `null` or omitted, the provider emits no effort override and lets the native engine decide. No provider maintains a Dreamux-side effort enum allowlist; non-empty strings pass through to the native CLI or protocol.
   - `extra_args`: string array (default `[]`), appended after provider-generated CLI arguments so explicit `extra_args` overrides win.
   - `extra_env`: string-to-string map (default `{}`).
2. **Provider-specific options kept only where genuinely needed:**
   - `codex`: no extra provider-specific config options.
   - `claude-code`: `remote_control` (`boolean`, default `false`).
   - `antigravity`: `transport` (`"tmux" | "acp"`, default `"tmux"`).
3. **Aligned unattended execution posture across all three providers:**
   - **CLI unattended flags**:
     - `codex`: always emit `-c approval_policy=never` and `-c sandbox_mode=danger-full-access` ahead of `-c model=...`, `-c model_reasoning_effort=...`, and `extra_args` (equivalent to Codex CLI's `--dangerously-bypass-approvals-and-sandbox`, which `codex app-server` expresses via `-c` overrides). Operators who want a stricter sandbox can override via `extra_args` (e.g. `["-c", "sandbox_mode=workspace-write"]`) because Codex parses `-c` last-write-wins.
     - `claude-code`: `--dangerously-skip-permissions` (already landed in PR #498; untouched in this slice).
     - `antigravity`: `--dangerously-skip-permissions` on both `acp` and `tmux` (already landed in PR #498; untouched in this slice).
   - **No protocol-level auto-allow**: all three providers retain fail-fast rejection of unexpected permission callbacks (already landed in PR #498; untouched in this slice).
4. **Retired config options (tolerated and ignored under R21):**
   - `codex` continues to omit `sandbox_mode`, `approval_policy`, `initialize_timeout_ms`, and `turn_timeout_ms` from `DispatcherCodexConfig` (tolerating and ignoring them under R21).
5. **Core remains neutral.** `agents[]` envelope and `AgentRuntimeCreateContext` remain unchanged.

### Scope (reopened PR #498 regression-fix slice)

- `@excitedjs/agent-runtime-codex`: `src/args.ts` (emit `-c sandbox_mode=danger-full-access` after `-c approval_policy=never` and before `model`/`effort`/`extra_args`) and `tests/config-and-args.test.ts`.
- `@excitedjs/dreamux`:
  - Synchronize bundled maintenance reference `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md`.
  - Update `packages/dreamux/README.md` and `docs/configuration.md` to document `-c approval_policy=never` + `-c sandbox_mode=danger-full-access` and `extra_args` override semantics.
  - Simplify `packages/dreamux/tests/helpers/live-codex-provider.ts` and `packages/dreamux/tests/codex-inbound-live.test.ts` by removing the now-redundant PR #498 `extra_args: ['-c', 'sandbox_mode=danger-full-access']` workaround so live Codex tests exercise default args.
- `.agents/` task record and Rush change files under `common/changes/`.

### Non-goals

- Reintroducing `sandbox_mode` as a `DispatcherCodexConfig` field.
- Designing or implementing a Core optional approval contract / Feishu approval card flow (separate future task).
- Modifying `claude-code`, `antigravity`, Core (`packages/dreamux/src/**`), `dreamux-types`, `dreamux-utils`, channels, or plugins.
- Editing operator-local `~/.dreamux/config.json` or `~/.codex/config.toml` files.

### Constraints and invariants

- Follow Dreamux R21 persisted-shape policy: retired `sandbox_mode` in existing `config.json` remains tolerated and ignored without error; no `BREAKING:` / `Rebuild:` changelog note is needed.
- `extra_args` remain last in spawned CLI arguments so operators can override `sandbox_mode`, `model`, or `model_reasoning_effort` via Codex's last-write-wins `-c` parsing.
- Synchronize `/packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md` in the same change (`AGENTS.md` maintenance synchronization rule).
- Public repository red line: no internal identifiers, secrets, private paths, or operator config contents in code, tests, docs, or task records.

## Confirmed current behavior and evidence

Verified from current source (`next` after PR #498 merged), live `codex-cli 0.171.0` probes, and Codex source inspection on 2026-11-29:

- `packages/agent-runtime/codex/src/args.ts` currently emits only `['-c', 'approval_policy=never']` plus optional `-c model=...`, `-c model_reasoning_effort=...`, and `extra_args`, omitting `-c sandbox_mode=...`.
- In Codex (`codex-cli 0.171.0` live `app-server` probes and Codex source `default_builtin_permission_profile_name`), `approval_policy=never` only disables interactive escalation prompts (failing closed on sandbox boundary violations), and omitting `sandbox_mode` causes any directory not explicitly registered in `~/.codex/config.toml` `[projects]` — including every newly created Dreamux git worktree — to default to `sandbox: { type: "readOnly", networkAccess: false }`. Even trusted directories default to `workspaceWrite` with `networkAccess: false`.
- In Codex CLI, `--dangerously-bypass-approvals-and-sandbox` sets both `approval_policy = never` and `sandbox_mode = danger-full-access`. `codex app-server` does not expose `--dangerously-bypass-approvals-and-sandbox` directly and accepts `-c approval_policy=never -c sandbox_mode=danger-full-access` instead.
- Live probes confirmed that `-c sandbox_mode=danger-full-access` cleanly overrides `sandbox_mode` and `default_permissions` in `~/.codex/config.toml`, and a later `-c sandbox_mode=workspace-write` in `extra_args` overrides `danger-full-access` (last-write-wins).
- Under `approval_policy=never` + `sandbox_mode=danger-full-access`, filesystem and network sandbox restrictions are disabled, while Codex still enforces explicit `.rules` `forbidden`/`prompt` rules and its built-in forced-`rm` (`rm -f` / `rm -rf`) / dangerous Windows PowerShell heuristic unless explicitly allowed by `.rules`.

## Acceptance criteria

1. `codexCliArgs()` in `packages/agent-runtime/codex/src/args.ts` emits `['-c', 'approval_policy=never', '-c', 'sandbox_mode=danger-full-access']` ahead of optional `-c model=<toml>`, `-c model_reasoning_effort=<toml>`, and `extra_args`.
2. Explicit `extra_args` appended after generated arguments still override `sandbox_mode` via Codex's last-write-wins `-c` behavior, verified by unit tests in `packages/agent-runtime/codex/tests/config-and-args.test.ts`.
3. `DispatcherCodexConfig` remains unchanged (`bin`, `model`, `effort`, `extra_args`, `extra_env`), and retired keys (`approval_policy`, `sandbox_mode`, `initialize_timeout_ms`, `turn_timeout_ms`) remain ignored under R21.
4. Live Codex test helpers (`packages/dreamux/tests/helpers/live-codex-provider.ts` and `packages/dreamux/tests/codex-inbound-live.test.ts`) no longer duplicate `-c sandbox_mode=danger-full-access` in `extra_args`.
5. `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md`, `packages/dreamux/README.md`, `docs/configuration.md`, `.agents/` task records, and Rush change files accurately document the updated Codex launch flags.
6. `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`, `rush change --verify --no-fetch --target-branch next`, `node .agents/scripts/check.mjs`, and `git diff --check` all pass.

## Decisions and unknowns

- Confirmed operator decisions:
  - 2026-11-29, follow-up alignment: operator directed minimal alignment first — add `danger-full-access` to Codex so it aligns with Claude Code and Antigravity's current `--dangerously-skip-permissions` posture.
  - 2026-11-29, task lineage: "复用原任务 (Recommended)" — reuse `.agents/tasks/architecture/align-provider-config-options/` for this PR #498 regression fix.
  - Prior PR #498 rulings (2026-11-27): kept `model`/`effort` in `agents[].config`, removed timeout/sandbox/permission config fields, retained `claude-code.remote_control` and `antigravity.transport`, unified open non-empty `model`/`effort` passthrough, and removed protocol-level auto-allow handlers.
- Assumptions:
  - Removing the redundant `extra_args: ['-c', 'sandbox_mode=danger-full-access']` override from `packages/dreamux/tests/helpers/live-codex-provider.ts` and `packages/dreamux/tests/codex-inbound-live.test.ts` is desirable so those tests exercise default `codexCliArgs()` directly.
- Blocking unknowns: None.
