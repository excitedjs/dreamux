# Technical Solution — Align Agent-Runtime Provider Config Options (Codex `danger-full-access` Follow-Up)

Requirement input: [requirement.md](/.agents/tasks/architecture/align-provider-config-options/requirement.md).

## 1. Summary and Entropy Delta

PR #498 aligned `agents[].config` schemas across `@excitedjs/agent-runtime-codex`, `@excitedjs/agent-runtime-claude-code`, and `@excitedjs/agent-runtime-antigravity` and stopped passing `-c sandbox_mode=...` to Codex. That created an unintended asymmetry: Claude Code and Antigravity run with `--dangerously-skip-permissions` (unrestricted default unattended execution), whereas Codex's `-c approval_policy=never` only disables interactive escalation prompts and leaves untrusted directories (including newly created Dreamux git worktrees) in Codex's default `read-only` offline sandbox.

This follow-up slice performs the minimal alignment fix:
- Emit `-c sandbox_mode=danger-full-access` directly after `-c approval_policy=never` in `codexCliArgs()` (`packages/agent-runtime/codex/src/args.ts`), matching the exact pair set by Codex CLI's `--dangerously-bypass-approvals-and-sandbox`.
- Keep `extra_args` last so operators who want a narrower sandbox (e.g., `-c sandbox_mode=workspace-write` or `read-only`) can override it via Codex's last-write-wins `-c` parsing.
- Remove the now-redundant PR #498 `extra_args: ['-c', 'sandbox_mode=danger-full-access']` workaround from the two live Codex test files so they exercise default launch args directly.
- Synchronize `builtin-codex.md`, `packages/dreamux/README.md`, and `docs/configuration.md`.

Entropy delta:
- Zero new config fields, entities, abstractions, or Core/type contract changes.
- Removes the live-test `extra_args` workaround in two files and eliminates the semantic mismatch between Codex and Claude Code / Antigravity's unattended launch posture.

## 2. Owning Components and Intended Behavior

### 2.1 `@excitedjs/agent-runtime-codex`

- `packages/agent-runtime/codex/src/args.ts`:
  - Update `codexCliArgs()` to start with:
    ```ts
    const args = [
      '-c',
      'approval_policy=never',
      '-c',
      'sandbox_mode=danger-full-access',
    ];
    ```
  - Keep optional `-c model=<toml>` and `-c model_reasoning_effort=<toml>` immediately after, followed by `...config.extra_args` last (last-write-wins).
  - Update the file header comment to document both defaults (`approval_policy=never` and `sandbox_mode=danger-full-access`) and the `extra_args` override path.
- `packages/agent-runtime/codex/tests/config-and-args.test.ts`:
  - Update `codexCliArgs` tests to assert `['-c', 'approval_policy=never', '-c', 'sandbox_mode=danger-full-access']` when `model`, `effort`, and `extra_args` are unset, and assert `-c sandbox_mode=read-only` in `extra_args` still appears after the defaults so Codex's last-write-wins override applies.
- `packages/agent-runtime/codex/src/config.ts`: unchanged (`DispatcherCodexConfig` remains `{ bin, model, effort, extra_args, extra_env }`; retired `sandbox_mode` stays ignored under R21).

### 2.2 `@excitedjs/dreamux` Docs, Maintenance Reference, and Live Test Helpers

- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md`:
  - Update the launch note to state that Dreamux launches Codex with `-c approval_policy=never` and `-c sandbox_mode=danger-full-access` (overridable via `extra_args`) and rejects unexpected approval callbacks fail-fast.
- `packages/dreamux/README.md` and `docs/configuration.md`:
  - Update the Codex launch description to match `-c approval_policy=never` + `-c sandbox_mode=danger-full-access` and `extra_args` override behavior. Keep all field names and retired-key wording required by `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts`.
- `packages/dreamux/tests/helpers/live-codex-provider.ts` and `packages/dreamux/tests/codex-inbound-live.test.ts`:
  - Remove the redundant `extra_args: ['-c', 'sandbox_mode=danger-full-access']` workaround added in PR #498.

### 2.3 Rush Change Files

- Add `patch` change files under `common/changes/` for `@excitedjs/agent-runtime-codex` (emit `-c sandbox_mode=danger-full-access` alongside `-c approval_policy=never` by default) and `@excitedjs/dreamux` (synchronize Codex docs and maintenance skill reference).

## 3. Implementation Boundary

Files in scope:
- `packages/agent-runtime/codex/src/args.ts`
- `packages/agent-runtime/codex/tests/config-and-args.test.ts`
- `packages/dreamux/tests/helpers/live-codex-provider.ts`
- `packages/dreamux/tests/codex-inbound-live.test.ts`
- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md`
- `packages/dreamux/README.md`
- `docs/configuration.md`
- `.agents/tasks/architecture/align-provider-config-options/{README.md,requirement.md,technical-design/final.md,verification.md}`
- Rush change files under `common/changes/`

Explicitly out of scope:
- `packages/agent-runtime/claude-code/**`, `packages/agent-runtime/antigravity/**`
- `packages/dreamux/src/**`, `packages/dreamux-types/**`, `packages/dreamux-utils/**`, `packages/channel/**`, `packages/plugins/**`
- Operator-local `~/.dreamux/config.json` and `~/.codex/config.toml`

## 4. Compatibility and Upgrade Impact

- **Persisted config compatibility**: Zero schema change. Existing `config.json` files continue to load cleanly; retired keys (`sandbox_mode`, `approval_policy`, `initialize_timeout_ms`, `turn_timeout_ms`) remain tolerated and ignored under R21. No `BREAKING:` / `Rebuild:` note is needed.
- **Behavioral effect**: Codex runtimes launched by Dreamux now default to `-c sandbox_mode=danger-full-access` (instead of falling back to `read-only` on untrusted directories / new git worktrees). Operators who want a stricter sandbox in Codex must pass `-c sandbox_mode=<mode>` via `agents[].config.extra_args`, since the CLI `-c` flag takes precedence over `~/.codex/config.toml`.

## 5. Verification Plan

1. Unit tests: `packages/agent-runtime/codex/tests/config-and-args.test.ts` and `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts`.
2. Full monorepo gates:
   - `node common/scripts/install-run-rush.js build`
   - `node common/scripts/install-run-rush.js lint`
   - `node common/scripts/install-run-rush.js test`
   - `node common/scripts/install-run-rush.js typecheck:tests`
   - `node common/scripts/install-run-rush.js change --verify --no-fetch --target-branch next`
   - `node .agents/scripts/check.mjs`
   - `git diff --check`
3. Independent review: request review via `@Devbox` on the PR before final closeout and merge authorization.

## 6. Known Limitations

- Under `approval_policy=never` + `sandbox_mode=danger-full-access`, Codex still enforces user `.rules` `forbidden`/`prompt` policies and its built-in forced-`rm` (`rm -f` / `rm -rf`) / dangerous PowerShell heuristic unless explicitly overridden by an `allow` rule in `.rules`.
- Operators who relied on `~/.codex/config.toml` `sandbox_mode` to restrict Dreamux-managed Codex sessions must move that override into `agents[].config.extra_args` (e.g. `["-c", "sandbox_mode=workspace-write"]`).
- Fine-grained per-tool approval routing via an optional Core approval seam and Feishu interactive cards is deferred to a separate future task.
