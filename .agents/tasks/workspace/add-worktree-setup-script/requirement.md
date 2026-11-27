# Requirement

## Initial request

- Operator request (2026-11-27):
  - Introduce an automatic post-worktree script execution mechanism for Dreamux.
  - Configuration can only live in the repository (at the repository root).
  - Behavior aligns with OpenAI Codex's worktree setup script, using **JSON** format, so Dreamux runs a script after creating a worktree.
  - The script supports foreground or background execution: when `background` is `false`, TeamLeader can only be launched after the script finishes; otherwise (`background` is `true`), TeamLeader can be launched after triggering the script.

## Current alignment

- Status: Confirmed (with review rulings R1–R5 reconciled).
- Confirmed current behavior and evidence:
  - All managed Git worktree creation goes through `WorktreeManager.prepare` in `packages/dreamux/src/service/worktree/manager.ts`, which executes `git worktree add` when the target path does not yet exist (`createdCheckout: !exists`).
  - Three callers invoke `WorktreeManager.prepare`:
    1. `TeamCollection.prepareWorkspace` (`packages/dreamux/src/service/team/index.ts`), invoked during `team.create` (including Feishu Collaboration Space auto-provisioning in `packages/channel/feishu-channel/src/feishu-provisioning.ts`).
    2. `resolveSpawnWorkspace` (`packages/dreamux/src/service/worktree/workspaces.ts`), invoked by Dispatcher-root `teammate.spawn` with `repo.mode: "managed"`.
    3. `reprepareDeletedManagedWorktree` (`packages/dreamux/src/service/worktree/workspaces.ts`), invoked when reopening a closed managed TeamMate whose worktree was deleted (`packages/dreamux/src/service/agent/runtime-generation.ts`).
  - `TeamService.createNew` creates the Team record and TeamLeader identity without starting a runtime process; the TeamLeader runtime starts on the initial `prompt` in `TeamService.startCreated` or on the first subsequent submission (`team.submit`).
  - Today, Dreamux has no repository-level worktree setup configuration or post-checkout script execution.
- Desired outcome:
  - When Dreamux creates a new managed Git worktree for a repository containing `<sourceRepo>/.dreamux-worktree.json`, Dreamux reads the JSON config and executes the resolved `setup` script inside the new worktree — either blocking agent/TeamLeader launch until completion (`background: false`, default) or launching immediately after starting the script (`background: true`).
- Desired behavior:
  1. **Config file location & resolution**:
     - Path: `<sourceRepo>/.dreamux-worktree.json` (read from the source repository root, so both committed configs and local/untracked/excluded configs in shared repos work uniformly).
     - If `.dreamux-worktree.json` does not exist (`ENOENT`), worktree preparation proceeds unchanged as a no-op.
  2. **JSON config schema**:
     ```json
     {
       "setup": {
         "script": "pnpm install",
         "background": false,
         "darwin": { "script": "...", "background": false },
         "linux": { "script": "..." },
         "win32": { "script": "..." }
       }
     }
     ```
     - `setup`: optional object; if omitted, no setup script runs.
     - `setup.script`: optional string.
     - `setup.background`: optional boolean, defaults to `false`.
     - `setup.darwin` / `setup.linux` / `setup.win32`: optional per-platform override objects (keyed by `process.platform`), each accepting optional `script` (string) and `background` (boolean) that override the base `setup` fields on that OS.
     - After resolving platform overrides, if the effective `script` is absent or empty/whitespace-only, no script is executed.
     - Malformed JSON or invalid field types fail loudly.
  3. **Trigger scope & timing**:
     - Runs uniformly for all newly created managed Git worktrees (`createdCheckout === true`), covering `team.create`, Dispatcher-root `teammate.spawn(managed)`, and reopening a closed managed TeamMate whose worktree was previously deleted.
     - Does **not** run for `reuse-cwd`, default non-git workspaces, or already-existing managed worktree checkouts (`createdCheckout === false`).
     - Executes with `cwd` set to the newly created worktree root (`runtimeCwd`), via the OS default shell, with `DREAMUX_SOURCE_REPO` (source repository root) and `DREAMUX_WORKTREE_PATH` (new worktree root) provided in the environment.
  4. **Foreground vs background execution**:
     - `background: false` (default): `WorktreeManager.prepare` awaits script completion before returning, ensuring TeamLeader/TeamMate launch cannot start until the setup script succeeds.
     - `background: true`: `WorktreeManager.prepare` starts the setup script process and returns without awaiting its completion, allowing TeamLeader/TeamMate launch immediately after triggering.
  5. **Failure handling & observability**:
     - Invalid `.dreamux-worktree.json` (malformed JSON or invalid schema) fails loudly before creating the worktree (or cleans up if already created) and aborts creation without launching TeamLeader/TeamMate.
     - Foreground (`background: false`) script failure (spawn error or non-zero exit code) fails loudly, aborts creation without launching TeamLeader/TeamMate, cleans up the newly created unclaimed worktree checkout (never touching the source repository or deleting branches), and surfaces a clear error to the caller and logs.
     - Background (`background: true`) script failure (spawn error or non-zero exit code) is recorded in Dreamux structured logs without affecting the already-launched TeamLeader/TeamMate.
- Scope:
  - Core worktree config reading, validation, and setup script execution in `packages/dreamux/src/service/worktree/` (and wiring logger into `WorktreeManager`).
  - Unit and integration tests covering config parsing/validation, platform overrides, foreground blocking & failure cleanup, background non-blocking & failure logging, scope boundaries (`createdCheckout: false`, `reuse-cwd`, missing config), and Team creation ordering.
  - Knowledge-base and product catalog updates in `.agents/` (and Rush change file if applicable).
- Non-goals:
  - Putting worktree setup configuration in `~/.dreamux/config.json`.
  - Codex UI-specific fields (`actions`, `name`, `version`).
  - Claude Code `.worktreeinclude`, `symlinkDirectories`, `sparsePaths`, or `WorktreeCreate`/`WorktreeRemove` VCS-replacement hooks.
  - Pushing background script completion/failure messages into TeamLeader chat turns or adding a new persistent background-job registry/MCP tool.
  - Adding an arbitrary default script timeout cap.
- Constraints and invariants:
  - Config lives only in the repository at `<sourceRepo>/.dreamux-worktree.json` (JSON format).
  - No synchronous blocking I/O in `/packages/*/src/**` (`rush lint` no-sync-IO gate).
  - Cleanup on foreground setup failure must never remove the source repository or delete Git branches.
  - Existing behavior for repositories without `.dreamux-worktree.json`, `reuse-cwd`, default workspaces, and existing worktree checkouts remains unchanged.

## Acceptance criteria

1. When `<sourceRepo>/.dreamux-worktree.json` is absent, managed worktree creation behaves identically to before.
2. When `<sourceRepo>/.dreamux-worktree.json` defines `setup.script` with `background: false` (or omitted):
   - The script executes with `cwd` = new worktree root and `DREAMUX_SOURCE_REPO` / `DREAMUX_WORKTREE_PATH` set.
   - TeamLeader (or TeamMate) launch does not start until the script exits with code `0`.
   - If the script exits non-zero or fails to spawn, creation fails loudly with an error, the agent is not launched, and the newly created checkout directory is removed.
3. When `<sourceRepo>/.dreamux-worktree.json` defines `setup.script` with `background: true`:
   - The script is started in the new worktree, and `prepare` / Team creation returns and launches TeamLeader without waiting for the script to finish.
   - If the background script later fails or exits non-zero, the failure is logged and does not disrupt the running agent.
4. OS-specific overrides (`setup.darwin` / `setup.linux` / `setup.win32`) override base `setup.script` and `setup.background` on the matching `process.platform`; an empty/missing effective script is a no-op.
5. Malformed JSON or invalid field types in `.dreamux-worktree.json` fail loudly and abort creation without leaving behind a newly created checkout or launching an agent.
6. The setup script triggers on newly created managed worktrees across `team.create`, Dispatcher-root `teammate.spawn(managed)`, and reopen of a deleted managed worktree, and does **not** trigger for `reuse-cwd`, default non-git workspaces, or already-existing worktree checkouts.
7. Build, lint, unit tests, `typecheck:tests`, and `.agents/scripts/check.mjs` all pass.

## Decisions and unknowns

- Confirmed operator decisions:
  - (2026-11-27, initial request): Repository-only JSON config; Codex-aligned post-worktree setup script behavior; `background: false` blocks TeamLeader launch until script finishes, `background: true` launches TeamLeader after triggering the script.
  - (2026-11-27, intake): Task created under new `workspace` capability domain (`workspace/add-worktree-setup-script`).
  - (2026-11-27, Item 1): Config file path is `.dreamux-worktree.json` at the repository root.
  - (2026-11-27, Item 2): Read `.dreamux-worktree.json` from the source repository root (`<sourceRepo>/.dreamux-worktree.json`).
  - (2026-11-27, Item 3): JSON schema uses `setup` with `script`, optional `background` (default `false`), and optional OS-specific override objects (`darwin` / `linux` / `win32`) overriding `script` / `background`.
  - (2026-11-27, Item 4): Trigger uniformly for all newly created managed Git worktrees (`createdCheckout === true`), covering `team.create`, Dispatcher-root `teammate.spawn(managed)`, and reopening a closed managed TeamMate whose worktree was deleted; do not trigger on reused existing directories or `reuse-cwd`.
  - (2026-11-27, Item 5): Malformed/invalid `.dreamux-worktree.json` or foreground (`background: false`) setup script failure aborts creation loudly (no agent launch, cleans up newly created checkout); background (`background: true`) failure logs without disrupting the launched agent.
  - (2026-11-27, Review R1–R5): Synchronous `spawn()` trigger failures fail loud and roll back even when `background: true` (distinct from post-launch background runtime failures); foreground completion settles on direct child `exit` (with brief pipe flush on failure); MCP shim aborts pending `admin.sock` connections on transport close; foreground rollback always removes the newly created checkout regardless of `cleanup: 'keep'` without deleting Git branches; `.dreamux-worktree.json` executes under the Dreamux host user on trusted local repos (no extra sandbox), and background scripts keep `pipe` stdio for failure `output_tail` diagnostics.
- Assumptions (non-blocking, presented for confirmation):
  - Scripts execute via OS default shell (`shell: true`) with `cwd = runtimeCwd` and env vars `DREAMUX_SOURCE_REPO` and `DREAMUX_WORKTREE_PATH`.
  - No artificial default timeout is imposed on setup scripts (real monorepo installs can take minutes).
  - Background script stdout/stderr/exit outcomes are written to Dreamux logs; no separate job store or chat notification is added.
- Blocking unknowns: None.
