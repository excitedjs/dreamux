/**
 * Filesystem layout for dreamux-owned runtime state, volatile run files, and
 * logs.
 *
 * Effective layout (issue #182 PR-1 split durable state from volatile run
 * files):
 *   ~/.dreamux/
 *     run/                    volatile IPC/control artifacts; safe to clear
 *                             when no dreamux server is running
 *       admin.sock            admin control socket (+ admin.sock.lock)
 *       restart-intent.json   one-shot daemon restart marker
 *       sockets/              fallback root for runtime rendezvous sockets
 *                             (see platform/runtime-sockets.ts)
 *     state/                  durable server-owned state
 *       <dispatcher-id>/
 *         status.json
 *         access.json
 *         teammate/           Server-hosted TeamMate records/, turns/, runtime/
 *     logs/
 *       dreamux-server.log
 *       codex-app-server/
 *         <dispatcher-id>.log
 *       channel/
 *         <dispatcher-id>.log
 *     cache/                  rebuildable provider/cache artifacts
 *       <dispatcher-id>/
 *         spill/
 *         <provider-owned subdirs>
 *
 * `stateRoot()` is the single root for dreamux-owned durable state; `runRoot()`
 * is the single root for dreamux-owned volatile run files. The old
 * `runtime_dir` concept (and its `runtimeRoot()` alias) was retired in issue #98.
 */

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertUnixSocketPathBudget,
} from '@excitedjs/dreamux-utils';

import {
  BUILT_IN_DEFAULTS,
  type DreamuxConfig,
} from '../config/config.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(dirname(HERE));

export const BUNDLED_SKILL_NAMES = [
  'dispatcher',
  'team-dev-workflow',
  'dreamux-maintenance',
] as const;

export type BundledSkillName = typeof BUNDLED_SKILL_NAMES[number];

let currentConfig: DreamuxConfig = BUILT_IN_DEFAULTS;

/**
 * Set the active configuration snapshot. Called once by Server.start() with
 * the result of loadConfig(); tests can call it to inject a custom snapshot.
 * Idempotent.
 */
export function setRuntimeConfig(config: DreamuxConfig): void {
  currentConfig = config;
}

/** Test hook: revert to the built-in defaults. */
export function resetRuntimeConfig(): void {
  currentConfig = BUILT_IN_DEFAULTS;
}

export function getRuntimeConfig(): DreamuxConfig {
  return currentConfig;
}

export function dreamuxRoot(): string {
  return join(homedir(), '.dreamux');
}

/** Lexical containment: is `candidate` at or under `root` (both resolved)? */
function pathIsAtOrUnder(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * True when `path` resolves to, or inside, the dreamux home root
 * (`~/.dreamux`). Lexical only — a path that *symlinks* into `~/.dreamux` is not
 * caught here; use {@link isRealPathUnderDreamuxRoot} for the placement guard.
 * Managed worktree creation must fail loud rather than place a worktree under
 * Dreamux's own state/run/cache tree (issue #182 PR-4): a dispatcher workspace
 * must be a real operator project directory, never the retired state-dir
 * fallback or any other path inside `~/.dreamux`.
 */
export function isUnderDreamuxRoot(path: string): boolean {
  return pathIsAtOrUnder(dreamuxRoot(), path);
}

/** realpath, falling back to a lexical resolve when the path does not exist. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Symlink-safe variant of {@link isUnderDreamuxRoot} (issue #182 PR-4, PR #186
 * review P1): canonicalizes BOTH the dreamux root and `path` with `realpath`
 * before the containment check, so a workspace path that lives outside
 * `~/.dreamux` lexically but symlinks into it is still rejected. This is the
 * authoritative guard for managed-worktree placement, where a bypass would put
 * worktrees physically under Dreamux home.
 */
export async function isRealPathUnderDreamuxRoot(path: string): Promise<boolean> {
  const [realRoot, realPath] = await Promise.all([
    canonicalPath(dreamuxRoot()),
    canonicalPath(path),
  ]);
  return pathIsAtOrUnder(realRoot, realPath);
}

export function stateRoot(): string {
  return join(dreamuxRoot(), 'state');
}

/**
 * Root for dreamux-owned volatile run files: IPC sockets, lock files, and
 * one-shot control markers. Nothing under it is durable; it is safe to remove
 * while no dreamux server is running. Durable state stays under `stateRoot()`.
 */
export function runRoot(): string {
  return join(dreamuxRoot(), 'run');
}

/**
 * One-shot marker dropped by `dreamux daemon restart --notify-resumed` before
 * it triggers the service-manager restart. The freshly started server reads it
 * once, deletes it, and injects a "restart completed" notice into the named
 * resumed dispatchers. Volatile run file; safe to delete.
 */
export function restartIntentPath(): string {
  return join(runRoot(), 'restart-intent.json');
}

export function logsRoot(): string {
  return join(dreamuxRoot(), 'logs');
}

/**
 * Root for dreamux-owned cache: rebuildable, droppable artifacts that are
 * neither durable state nor volatile run files (issue #182 PR-2). Holds
 * per-dispatcher completion spill files and inbound attachment caches. Safe to
 * remove while no server is running; nothing here is part of identity, status,
 * history, or checkpoint recovery.
 */
export function cacheRoot(): string {
  return join(dreamuxRoot(), 'cache');
}

export function dispatcherCacheDir(id: string): string {
  return join(cacheRoot(), dispatcherPathSegment(id));
}

/**
 * Per-dispatcher completion-spill directory (issue #182 PR-2): where an
 * over-budget teammate completion result is written so only its path is inlined
 * into the dispatcher turn. Cache, not state — the file is read by no process;
 * it is surfaced to the dispatcher model as text and is safe to delete.
 */
export function dispatcherCompletionSpillDir(id: string): string {
  return join(dispatcherCacheDir(id), 'spill');
}

/**
 * The stable cross-process admin IPC endpoint. Packaged CLI commands and MCP
 * shims resolve it through this builder only — it is a fixed path contract, so
 * an over-budget path (extreme $HOME length) fails loudly instead of moving.
 */
export function adminSocketPath(): string {
  return assertUnixSocketPathBudget(
    join(runRoot(), 'admin.sock'),
    'admin socket path',
  );
}

/**
 * The pre-#182 admin socket location, under durable state. PR-1 moved the live
 * admin socket to `run/admin.sock`; this builder exists only so a new server
 * can detect a still-running OLD-version server (which locks the legacy path)
 * and fail loud — see `assertNoLegacyAdminServer`. Detection only: dreamux
 * never removes or migrates the legacy file.
 */
export function legacyAdminSocketPath(): string {
  return join(stateRoot(), 'admin.sock');
}

export function dispatcherDir(id: string): string {
  return join(stateRoot(), dispatcherPathSegment(id));
}

export function defaultDispatcherCwd(id: string): string {
  return join(dispatcherDir(id), 'cwd');
}

/**
 * The bundled-skills *add-dir parent* (issue #209): the directory Claude Code is
 * pointed at with `--add-dir`, so it discovers skills under its
 * `.claude/skills/<name>` subtree. The skills physically live one level down at
 * `<bundledSkillsDir>/.claude/skills/<name>` so this single on-disk copy serves
 * BOTH engines — Claude Code via `--add-dir <bundledSkillsDir>` and Codex via an
 * extra root of `bundledSkillContainerDir()` (the `.claude/skills` container,
 * whose immediate children are skill dirs). Shipped via the package `files`
 * allowlist (`skills`), which carries the whole subtree.
 */
export function bundledSkillsDir(): string {
  return join(PACKAGE_ROOT, 'skills');
}

/**
 * The container whose immediate children are the bundled skill directories —
 * `<bundledSkillsDir>/.claude/skills`. This is the Codex extra-skills-root for
 * the bundled skills (codex treats an extra root as a dir whose children are
 * skill dirs) and the `.claude/skills` tree Claude Code reads under its add-dir.
 */
export function bundledSkillContainerDir(): string {
  return join(bundledSkillsDir(), '.claude', 'skills');
}

export function bundledSkillDir(skillName: BundledSkillName): string {
  return join(bundledSkillContainerDir(), skillName);
}

/**
 * Packaged changelog files, shipped inside the installed package so that
 * `dreamux changelog` is an offline, deterministic read of the *installed*
 * version's release notes. Both files are rush-generated; they must stay in
 * `package.json` `files` or these paths resolve outside the published tarball.
 */
export function packagedChangelogMarkdownPath(): string {
  return join(PACKAGE_ROOT, 'CHANGELOG.md');
}

export function packagedChangelogJsonPath(): string {
  return join(PACKAGE_ROOT, 'CHANGELOG.json');
}

export function serverLogPath(): string {
  return join(logsRoot(), 'dreamux-server.log');
}

export function channelLogDir(): string {
  return join(logsRoot(), 'channel');
}

/** Per-dispatcher channel log: gate decisions, inbound, outbound, introduce. */
export function channelLogPath(id: string): string {
  return join(channelLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function channelMcpLogDir(): string {
  return join(logsRoot(), 'channel-mcp');
}

/**
 * Per-dispatcher channel MCP stdio shim log. The shim's stdout is the JSON-RPC
 * transport, so its diagnostics persist here (and to stderr) — never stdout.
 */
export function channelMcpLogPath(id: string): string {
  return join(channelMcpLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function teammateMcpLogDir(): string {
  return join(logsRoot(), 'teammate-mcp');
}

/** Per-dispatcher TeamMate scheduling MCP stdio shim diagnostics. */
export function teammateMcpLogPath(id: string): string {
  return join(teammateMcpLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function dispatcherStatusPath(id: string): string {
  return join(dispatcherDir(id), 'status.json');
}

export function dispatcherAccessPath(id: string): string {
  return join(dispatcherDir(id), 'access.json');
}

/** Per-dispatcher server-hosted TeamMate state root. */
export function dispatcherTeamMateDir(id: string): string {
  return join(dispatcherDir(id), 'teammate');
}

/**
 * Directory containing one primary TeamMate record per file (issue #199
 * Slice 3): `teammate/records/<name>.json` is the source for history / list /
 * status. Renamed from the former `teammate/identities/` directory.
 */
export function dispatcherTeamMateRecordsDir(id: string): string {
  return join(dispatcherTeamMateDir(id), 'records');
}

export function dispatcherTeamMateRecordPath(
  id: string,
  teammateName: string,
): string {
  return join(
    dispatcherTeamMateRecordsDir(id),
    `${teamMateNameSegment(teammateName)}.json`,
  );
}

/** Directory of per-name turn archives (issue #199 Slice 3). */
export function dispatcherTeamMateTurnsDir(id: string): string {
  return join(dispatcherTeamMateDir(id), 'turns');
}

/**
 * Per-name append-only TeamMate turns archive (issue #199 Slice 3) — the only
 * JSONL store. One file per concrete teammate name; each line is a compact turn
 * event (submit / settled) folded by `last`. Common recovery facts live on the
 * `teammate/records/<name>.json` record and are not repeated here.
 */
export function dispatcherTeamMateTurnsPath(
  id: string,
  teammateName: string,
): string {
  return join(
    dispatcherTeamMateTurnsDir(id),
    `${teamMateNameSegment(teammateName)}.jsonl`,
  );
}

export function dispatcherTeamMateRuntimeDir(
  id: string,
  teammateName: string,
): string {
  return join(dispatcherTeamMateDir(id), 'runtime', teamMateNameSegment(teammateName));
}

/** Per-dispatcher Team Mode state root. */
export function dispatcherTeamDir(id: string): string {
  return join(dispatcherDir(id), 'team');
}

export function dispatcherTeamRecordsDir(id: string): string {
  return join(dispatcherTeamDir(id), 'records');
}

export function dispatcherTeamRecordPath(id: string, teamId: string): string {
  return join(dispatcherTeamRecordsDir(id), `${teamMateNameSegment(teamId)}.json`);
}

export function dispatcherChannelBindingsPath(id: string): string {
  return join(dispatcherTeamDir(id), 'channel-bindings.json');
}

/**
 * Neutral teammate-name path segment sanitizer. Shared by the neutral
 * teammate-state builders here and by each builtin's teammate log-path builders.
 */
export function teamMateNameSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Per-dispatcher peer-bot awareness/trust store. One file per dispatcher,
 * keyed internally by chat_id, holds the *known* (passively observed) and
 * *trusted* (introduced via an allowlisted `/introduce`) peer-bot open_ids
 * plus the bot-added baseline bookkeeping. Server-owned state; safe to delete.
 */
export function dispatcherChatBotsPath(id: string): string {
  return join(dispatcherDir(id), 'chat-bots.json');
}


export function dispatcherPathSegment(id: string): string {
  return validateDispatcherId(id);
}
