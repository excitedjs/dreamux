# Technical Solution: Repository Worktree Setup Script Execution

## 1. Summary

Add repository-scoped post-worktree setup script execution directly inside Dreamux's worktree layer (`packages/dreamux/src/service/worktree/`). When `WorktreeManager.prepare` creates a new managed Git worktree (`createdCheckout === true`), it reads and validates `<sourceRepo>/.dreamux-worktree.json` before `git worktree add`, and after `git worktree add` runs the resolved `setup.script` inside the new worktree (`cwd = runtimeCwd`) via the OS default shell with `DREAMUX_SOURCE_REPO` and `DREAMUX_WORKTREE_PATH` in the environment.

- When `background: false` (default), `WorktreeManager.prepare` awaits script completion before returning, strictly preventing TeamLeader or TeamMate creation/launch and initial prompt submission until setup succeeds; a failure rolls back the newly created unclaimed worktree checkout and throws loudly.
- When `background: true`, `WorktreeManager.prepare` spawns the script and returns immediately while logging completion/failure asynchronously to Dreamux structured logs.
- Because `mcp.toolcall` over `admin.sock` currently inherits a 10-second socket timeout (`packages/dreamux/src/admin/client.ts`), also remove the 10-second request timer for `mcp.toolcall` in `packages/dreamux/src/mcp/shim.ts` (keeping the 10-second timeout for `mcp.describe` and CLI commands) so Dispatcher MCP `team_create` / `teammate_spawn` calls do not spuriously time out during legitimate foreground setup scripts.

## 2. Owning Components and Design

### 2.1 New module: `packages/dreamux/src/service/worktree/setup.ts`

Layer: `service-primitives` (same directory and layer as `WorktreeManager`; imports only `node:child_process`, `node:fs/promises`, `node:path`, `@excitedjs/dreamux-types`, `@excitedjs/dreamux-utils`, and `../../platform/fs-errors.js`).

Responsibilities:

1. **Config constant & types**:
   - `WORKTREE_CONFIG_FILENAME = '.dreamux-worktree.json'`
   - `WorktreeSetupPlatform = 'darwin' | 'linux' | 'win32'`
   - `ResolvedWorktreeSetup = { readonly script: string; readonly background: boolean }`
2. **Reading and validating `<sourceRepo>/.dreamux-worktree.json`** (`readWorktreeSetup(sourceRepo, platform = process.platform)`):
   - Reads `join(sourceRepo, WORKTREE_CONFIG_FILENAME)` with `readFile(..., 'utf8')`.
   - `ENOENT` (`isNotFound`) returns `null` (no-op). Any other filesystem error propagates.
   - Parses JSON with `JSON.parse`; syntax errors throw `Error` naming the config path and parse failure.
   - Strict schema validation (fail-loud on typos such as top-level `script`, `setup.command`, or `setup.macos`):
     - Root must be a plain object; allowed keys: `setup`.
     - If `root.setup === undefined`, returns `null`.
     - `root.setup` must be a plain object; allowed keys: `script`, `background`, `darwin`, `linux`, `win32`.
     - `script` (if present) must be a `string`.
     - `background` (if present) must be a `boolean`.
     - Every present platform key (`darwin`, `linux`, `win32`) is validated upfront regardless of the host OS: must be a plain object with allowed keys `script` (`string`) and `background` (`boolean`).
   - Resolves effective config for `platform`:
     - `override = (platform === 'darwin' || platform === 'linux' || platform === 'win32') ? setup[platform] : undefined`
     - `script = override?.script ?? setup.script`
     - `background = override?.background ?? setup.background ?? false`
     - If `script === undefined || script.trim() === ''`, returns `null` (no-op; allows platform-specific disable via `""`).
     - Otherwise returns `{ script, background }`.
3. **Executing the setup script** (`runWorktreeSetup({ setup, sourceRepo, worktreePath, log })`):
   - Spawns via `node:child_process`'s async `spawn(setup.script, { cwd: worktreePath, shell: true, env: { ...process.env, DREAMUX_SOURCE_REPO: sourceRepo, DREAMUX_WORKTREE_PATH: worktreePath }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })`. Synchronous `spawn()` trigger failures fail loud and roll back in both foreground and background modes.
   - Calls `setEncoding('utf8')` on `stdout` and `stderr` and drains both continuously into a single bounded tail buffer (max 4096 UTF-16 code units) so verbose monorepo installs (`pnpm install`) neither block on full OS pipe buffers nor accumulate unbounded memory or split multi-byte UTF-8 characters.
   - Single settlement helper observing `'error'` and `'exit'` (with `code` and `signal`), plus a bounded 50 ms pipe-flush window on non-zero/signal exits so stderr from fast-exiting shells is preserved without ever blocking on open-pipe descendants:
     - **Foreground (`background: false`)**: awaits settlement and throws on error, signal, or non-zero exit with exit details and bounded output tail.
     - **Background (`background: true`)**: returns immediately after spawning and logs completion or failure asynchronously via the shared outcome reporter without affecting any running agent.
   - Note on `node:child_process.spawn`: async API (satisfies the `no-sync-IO` ESLint rule), avoids `execa`'s buffered `maxBuffer` failure on noisy monorepo installs, and uses platform-native shell resolution (`sh -c` on POSIX, `cmd.exe` via `ComSpec` on Windows).

### 2.2 Integration in `WorktreeManager` (`packages/dreamux/src/service/worktree/manager.ts`)

- Constructor accepts optional options (zero-arg compatible for existing callers and tests):
  ```ts
  export interface WorktreeManagerOptions {
    log?: DreamuxLogger;
  }
  ```
- In `WorktreeManager.prepare` (`mode === 'managed'`, `!exists` branch only):
  1. Call `const setup = await readWorktreeSetup(sourceRepo)` **before** creating `.workspace/` directories or running `git worktree add`. A malformed/invalid `.dreamux-worktree.json` therefore fails loudly before touching the filesystem or Git.
  2. Prepare `.workspace/` boundary and parent directory, then run `git worktree add ...` as today.
  3. If `setup !== null`, run `await runWorktreeSetup({ setup, sourceRepo, worktreePath: path, log: this.log })`.
  4. If setup throws, roll back the just-created unclaimed checkout via `rollbackCreatedWorktree(sourceRepo, path)` -> shared private `removeRegisteredWorktree(sourceRepo, path, true)`:
     - Calls the existing `assertRemovableWorktree({ repo: sourceRepo, path })` guard (never removes `sourceRepo`, only a registered worktree of `sourceRepo`).
     - Runs `git worktree remove --force <path>` from `--git-common-dir` (safe on Windows, handles untracked/partial files left by the failed setup script, always rolls back failed creation even if `cleanup: 'keep'` was requested, and never deletes Git branches).
     - If rollback itself fails, logs a warning and still rethrows the original setup failure.
- When `exists === true` (`createdCheckout === false`), `mode === 'reuse-cwd'`, or `prepareDefaultWorkspace`: no config read and no script execution.
- Ordering guarantee across all three callers (verified in source):
  - `TeamCollection.createTeam` (`packages/dreamux/src/service/team/index.ts:582`) awaits `prepareWorkspace` -> `worktrees.prepare` before `TeamService.createNew` (599) and `startCreated` (614); `FeishuProvisioning.run` (`packages/channel/feishu-channel/src/feishu-provisioning.ts:143-186`) awaits `createTeam` before binding and `submitter.submit`, and serializes concurrent messages to the same topic behind `inFlight`.
  - `TeammateCollection.spawnAdmitted` (`packages/dreamux/src/service/agent/index.ts:196-199`) awaits `createFreshEntity` -> `resolveSpawnWorkspace` -> `worktrees.prepare` before `entity.submitInput`.
  - `AgentRuntimeGeneration.startFromRecord` (`packages/dreamux/src/service/agent/runtime-generation.ts:211-242`) awaits `reprepareDeletedManagedWorktree` -> `worktrees.prepare` before `createRuntime`.

### 2.3 Logger wiring (`packages/dreamux/src/service/dispatcher-service/index.ts`)

- Update line 177 from `new WorktreeManager()` to `new WorktreeManager({ log: opts.log })` so setup start/completion/failure and rollback warnings land in the dispatcher's structured log.

### 2.4 MCP tool-call transport timeout (`packages/dreamux/src/admin/client.ts` & `packages/dreamux/src/mcp/shim.ts`)

- In `packages/dreamux/src/admin/client.ts`:
  - Widen `AdminInvokerOptions.timeoutMs?: number | null` and add optional `signal?: AbortSignal`.
  - Default remains `DEFAULT_TIMEOUT_MS = 10_000` (unchanged for CLI commands, daemon probes, and `mcp.describe`).
  - When `timeoutMs === null`, `sendOne` omits the request timer and relies on socket response/close/error; aborting `signal` destroys any pending socket immediately and rejects with `TransportError`.
- In `packages/dreamux/src/mcp/shim.ts`:
  - Keep the default 10s invoker for startup `mcp.describe`.
  - Pass `timeoutMs: null` and a shim-scoped `AbortController.signal` for `mcp.toolcall`, aborting in `finally` when `runMcpServer` exits so pending sockets tear down cleanly on stdin EOF.

## 3. Implementation Boundary and Non-Goals

- **In scope**:
  - `packages/dreamux/src/service/worktree/setup.ts` (new)
  - `packages/dreamux/src/service/worktree/manager.ts`
  - `packages/dreamux/src/service/dispatcher-service/index.ts`
  - `packages/dreamux/src/admin/client.ts`
  - `packages/dreamux/src/mcp/shim.ts`
  - Tests under `packages/dreamux/tests/` (worktree setup tests + MCP shim / admin client `timeoutMs: null` test + Team creation ordering test)
  - Knowledge-base updates (`.agents/product/README.md`, `.agents/domains/dispatcher-orchestration.md` / `state-config-and-files.md` if applicable) and Rush change file (`minor` / `patch` — non-breaking additive feature)
- **Out of scope / non-goals**:
  - No changes to `~/.dreamux/config.json`, `packages/dreamux-types`, provider contracts, Channel providers, or persisted Team/TeamMate record schemas.
  - No `actions`, `name`, or `version` fields in `.dreamux-worktree.json`.
  - No persistent background-job tracking, new MCP tools, or chat push notifications for background setup scripts.
  - No changes to `packages/dreamux/skills/dispatcher/dreamux-maintenance/` (since `.dreamux-worktree.json` is repository-owned user content, not a Dreamux server config/state file under `~/.dreamux/`).

## 4. Contracts, Compatibility, and Upgrade Impact

- **Persisted Dreamux state / `~/.dreamux/config.json`**: Unchanged. Zero upgrade blockers; no `BREAKING:` note needed.
- **Repository file contract (new, opt-in)**: `<sourceRepo>/.dreamux-worktree.json`. Repositories without this file see zero behavioral change.
- **Admin client API**: Strictly backward-compatible (`timeoutMs?: number | null`, omitting it preserves the 10s default).
- **Rush change file**: Ordinary `minor` change note for `@excitedjs/dreamux` describing `.dreamux-worktree.json` post-worktree setup script support.

## 5. Verification Plan

1. **Config parsing & validation tests**:
   - Absent `.dreamux-worktree.json` -> no-op.
   - Valid `setup.script` with omitted `background` -> defaults to `background: false`.
   - Platform overrides (`darwin`, `linux`, `win32`) override `script` and/or `background`; empty/whitespace effective `script` is a no-op.
   - Malformed JSON, non-object root/setup/platform, wrong field types (`script`, `background`), and unknown keys fail loudly **before** `git worktree add` runs (leaving no worktree directory and no branch).
2. **Foreground execution & rollback tests**:
   - Script runs with `cwd === runtimeCwd`, receives `DREAMUX_SOURCE_REPO` and `DREAMUX_WORKTREE_PATH`, and `prepare()` does not resolve until the script finishes (verified with a timed marker file written by the script).
   - Non-zero exit fails loudly with error details, removes the newly created worktree directory (even when the failed script created untracked files inside it), and leaves `sourceRepo` intact.
3. **Background execution tests**:
   - With `background: true`, `prepare()` returns immediately before a gated background script exits; once unblocked, the script finishes in the worktree and logs completion.
   - A failing background script logs a warning/error without throwing or rejecting `prepare()`.
4. **Scope & ordering tests**:
   - Existing managed worktree (`createdCheckout === false`), `reuse-cwd`, and `prepareDefaultWorkspace` do not run the setup script.
   - Team creation integration test proving that under `background: false`, TeamLeader runtime creation/first prompt does not occur until the setup script completes, and under `background: true`, TeamLeader starts before the gated background script finishes.
   - `adminJsonInvoker({ timeoutMs: null })` / MCP shim toolcall does not time out prematurely on a slow tool call while `mcp.describe` retains its timeout.
5. **Monorepo gates**:
   - `node common/scripts/install-run-rush.js build`
   - `node common/scripts/install-run-rush.js lint` (ESLint, Prettier, dependency-cruiser, knip)
   - `node common/scripts/install-run-rush.js test`
   - `node common/scripts/install-run-rush.js typecheck:tests`
   - `node .agents/scripts/check.mjs`

## 6. Known Limitations and Trust Boundary

- **Host-user trust boundary**: `.dreamux-worktree.json` executes under the Dreamux host/daemon OS user and environment (not inside an agent runtime sandbox). Managed worktree repositories configured with Dreamux are trusted local code, matching Codex's `.codex/environments/environment.toml` trust model.
- **Managed-service PATH**: When Dreamux runs as a launchd/systemd managed service, the inherited `PATH` may not include interactive shell shims (such as nvm/volta); scripts should either reference explicit tool paths or configure the service environment accordingly.
- **Background scripts outlive `prepare()`**: Because background setup runs asynchronously without a durable job registry, a Team dissolved while its background script is still writing files in the worktree follows normal dissolve cleanup semantics (dirty check or `--force`). Keeping `pipe` stdio preserves `output_tail` on normal failures; if the Dreamux daemon restarts/exits mid-run, a piped background script may terminate with SIGPIPE.
- **Mid-setup daemon crash on reopen**: If the daemon terminates abruptly mid-setup during a reopened TeamMate's worktree recreation after `git worktree add` registered the directory, the next `send` sees an existing registered checkout (`createdCheckout: false`) and does not re-run setup automatically; inspect or remove the checkout manually if needed.
- **Foreground rollback leaves the created Git branch**: Consistent with Dreamux's standing invariant that automatic worktree cleanup never deletes Git branches, a foreground setup failure removes only the newly created worktree checkout directory (even when `cleanup: 'keep'` was requested). If an explicit `branch` name is retried later, `git worktree add` reuses that branch rather than re-branching from a new `base_ref`. On Windows, if a failing foreground script leaves a descendant running with its `cwd` inside the new worktree, immediate `git worktree remove --force` rollback may hit `EBUSY` (logged as a rollback warning while preserving the original setup failure; POSIX is unaffected).
- **No automatic timeout on setup scripts**: A hung foreground script will block worktree preparation until the direct shell exits or is terminated externally; repositories with slow or interactive setup should use non-interactive flags or `background: true`. Note that `mcp/shim.ts` aborts pending `admin.sock` connections when MCP stdin closes so the shim exits cleanly, while any already-admitted server-side operation continues along its normal lifecycle.
