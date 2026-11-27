# Verification

## Implementation summary

- Added `packages/dreamux/src/service/worktree/setup.ts` implementing `<sourceRepo>/.dreamux-worktree.json` reading, strict schema validation, platform override resolution (`darwin` / `linux` / `win32`), and foreground/background script execution with UTF-8 stream decoding (`setEncoding('utf8')`), bounded 4096-code-unit output tail capture, `exit`-based completion settlement (with a 50 ms pipe-flush window on non-zero/signal exits so open-pipe descendants never hang foreground launch), unified logging, and `DREAMUX_SOURCE_REPO` / `DREAMUX_WORKTREE_PATH` environment variables.
- Updated `packages/dreamux/src/service/worktree/manager.ts` to validate `.dreamux-worktree.json` before creating `.workspace/` directories or running `git worktree add`, execute the resolved setup script on newly created managed worktrees (`createdCheckout === true`), and roll back newly created checkouts on foreground setup failure via a shared private `removeRegisteredWorktree(repo, path, force)` helper (always rolling back failed newly created checkouts without deleting Git branches or touching `sourceRepo`).
- Wired `opts.log` into `new WorktreeManager({ log: opts.log })` in `packages/dreamux/src/service/dispatcher-service/index.ts`.
- Extended `packages/dreamux/src/admin/client.ts` (`timeoutMs?: number | null`, `signal?: AbortSignal`) and updated `packages/dreamux/src/mcp/shim.ts` to pass `timeoutMs: null` and an `AbortController` signal for `mcp.toolcall` (aborted in `finally` when `runMcpServer` ends so pending sockets tear down cleanly on stdin EOF) while keeping the 10s default for `mcp.describe` and CLI callers.
- Added behavioral and integration tests in `packages/dreamux/tests/worktree-setup.test.ts` (23 cases) and `packages/dreamux/tests/mcp-shim-socket.test.ts` (12 cases total, +2 end-to-end `runDreamuxMcp` timeout & transport-close abort cases).

## Post-review local checks (after applying R1–R5 rulings)

| Command | Result | Notes |
| --- | --- | --- |
| `node common/scripts/install-run-rush.js build` | Passed | All workspace packages built cleanly. |
| `node common/scripts/install-run-rush.js lint` | Passed | ESLint (incl. no-sync-IO & 700-line cap), Prettier, dependency-cruiser, and knip passed across all 10 packages. |
| `node common/scripts/install-run-rush.js typecheck:tests` | Passed | All 9 testable packages passed TypeScript test typechecking. |
| `node common/scripts/install-run-rush.js test` | Passed (with 1 unrelated tmux re-run) | `@excitedjs/dreamux` (incl. 23 cases in `tests/worktree-setup.test.ts`, 14 cases in `tests/worktree-manager.test.ts`, 12 cases in `tests/mcp-shim-socket.test.ts`) and 7 other packages passed on first run; `@excitedjs/agent-runtime-antigravity` hit one transient tmux `has-session` flake under parallel load and passed cleanly on immediate re-run (`rush test --only @excitedjs/agent-runtime-antigravity`). |

## Skipped checks, coverage limits, and residual risks

- **Skipped checks**: Live Codex model-behavior cases gated behind `DREAMUX_RUN_LIVE_MODEL_GATE=1` were excluded by default; live Codex protocol tests ran and passed.
- **Coverage limits**:
  - Tests ran on Linux (`process.platform === 'linux'`). Platform override selection for `darwin`, `linux`, and `win32` was unit-tested via `readWorktreeSetup(root, platform)`, and Windows `cmd.exe` execution was not directly run on a Windows host in this environment (CI Windows matrix will cover it).
  - Full `node .agents/scripts/check.mjs` runs in `knowledge-closeout` once task state moves to `done` and KB/product catalog updates land.
- **Residual risks**:
  - Host-user trust boundary: `.dreamux-worktree.json` runs under the Dreamux host user (not inside an agent sandbox).
  - Managed-service PATH: launchd/systemd environments may not include interactive shell shims (nvm/volta).
  - Background script lifetime: piped background scripts retain `output_tail` on normal failures, and may terminate with SIGPIPE if the Dreamux daemon restarts/exits mid-run.
  - Mid-setup daemon crash on reopen: if the daemon exits after `git worktree add` during reopen, the next `send` sees an existing registered checkout (`createdCheckout: false`) and skips setup.
  - Upstream MCP client timeout: very long foreground scripts triggered via Dispatcher MCP `team_create` / `teammate_spawn` can still hit the upstream MCP client's own timeout (e.g. Codex `tool_timeout_sec`); use `background: true` for multi-minute installs.
