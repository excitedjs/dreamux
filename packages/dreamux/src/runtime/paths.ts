/**
 * Filesystem layout for dreamux-owned runtime state and logs.
 *
 * Effective MVP layout:
 *   ~/.dreamux/
 *     state/
 *       server.json
 *       admin.sock
 *       <dispatcher-id>/
 *         status.json
 *         access.json
 *         codex.sock          Codex app-server Unix socket
 *         teammate/           Server-hosted TeamMate task ledger
 *     logs/
 *       dreamux-server.log
 *       codex-app-server/
 *         <dispatcher-id>.log
 *
 * `stateRoot()` is the single root for dreamux-owned state. The old
 * `runtime_dir` concept (and its `runtimeRoot()` alias) was retired in issue #98.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILT_IN_DEFAULTS,
  type DreamuxConfig,
} from './config.js';
import { validateDispatcherId } from './dispatcher-id.js';

export const DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES = 103;
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

export function stateRoot(): string {
  return join(dreamuxRoot(), 'state');
}

export function serverJsonPath(): string {
  return join(stateRoot(), 'server.json');
}

/**
 * One-shot marker dropped by `dreamux daemon restart --notify-resumed` before
 * it triggers the service-manager restart. The freshly started server reads it
 * once, deletes it, and injects a "restart completed" notice into the named
 * resumed dispatchers. Server-owned state; safe to delete.
 */
export function restartIntentPath(): string {
  return join(stateRoot(), 'restart-intent.json');
}

export function logsRoot(): string {
  return join(dreamuxRoot(), 'logs');
}

export function adminSocketPath(): string {
  return assertUnixSocketPathBudget(
    join(stateRoot(), 'admin.sock'),
    'admin socket path',
  );
}

export function dispatcherDir(id: string): string {
  return join(stateRoot(), dispatcherPathSegment(id));
}

export function dispatcherCodexCwd(id: string): string {
  return join(dispatcherDir(id), 'cwd');
}

/**
 * Per-dispatcher Claude Code runtime state dir (issue #110 PR6). Holds the
 * generated Claude Code MCP config; kept under the dispatcher's state dir, not
 * the workspace cwd, so it never pollutes the operator's repo.
 */
export function dispatcherClaudeCodeDir(id: string): string {
  return join(dispatcherDir(id), 'claude-code');
}

/** The generated Claude Code MCP config file (`--mcp-config <path>`). */
export function dispatcherClaudeCodeMcpConfigPath(id: string): string {
  return join(dispatcherClaudeCodeDir(id), 'mcp.json');
}

export function operatorCodexHome(): string {
  return join(homedir(), '.codex');
}

export function dispatcherCodexHome(id: string): string {
  void id;
  return operatorCodexHome();
}

export function dispatcherCodexConfigPath(id: string): string {
  return join(dispatcherCodexHome(id), 'config.toml');
}

export function dispatcherWorkspaceCodexSkillsDir(cwd: string): string {
  return join(cwd, '.codex', 'skills');
}

export function dispatcherWorkspaceSkillDir(
  cwd: string,
  skillName: BundledSkillName,
): string {
  return join(dispatcherWorkspaceCodexSkillsDir(cwd), skillName);
}

export function dispatcherWorkspaceSkillDirs(cwd: string): string[] {
  return BUNDLED_SKILL_NAMES.map((skillName) =>
    dispatcherWorkspaceSkillDir(cwd, skillName),
  );
}

export function dispatcherWorkspaceSkillPath(cwd: string): string {
  return join(dispatcherWorkspaceSkillDir(cwd, 'dispatcher'), 'SKILL.md');
}

export function bundledSkillsDir(): string {
  return join(PACKAGE_ROOT, 'skills');
}

export function bundledSkillDir(skillName: BundledSkillName): string {
  return join(bundledSkillsDir(), skillName);
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

export function dispatcherAppServerControlDir(id: string): string {
  return dispatcherDir(id);
}

export function dispatcherSocketPath(id: string): string {
  return assertUnixSocketPathBudget(
    join(dispatcherDir(id), 'codex.sock'),
    `dispatcher '${id}' Codex socket path`,
  );
}

export function dispatcherStdoutLog(id: string): string {
  return dispatcherCodexAppServerLogPath(id);
}

export function dispatcherStderrLog(id: string): string {
  return dispatcherCodexAppServerErrorLogPath(id);
}

export function serverLogPath(): string {
  return join(logsRoot(), 'dreamux-server.log');
}

export function codexAppServerLogDir(): string {
  return join(logsRoot(), 'codex-app-server');
}

export function feishuChannelLogDir(): string {
  return join(logsRoot(), 'feishu-channel');
}

/** Per-dispatcher channel log: gate decisions, inbound, outbound, introduce. */
export function feishuChannelLogPath(id: string): string {
  return join(feishuChannelLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function feishuMcpLogDir(): string {
  return join(logsRoot(), 'feishu-mcp');
}

/**
 * Per-dispatcher Feishu MCP stdio shim log. The shim's stdout is the JSON-RPC
 * transport, so its diagnostics persist here (and to stderr) — never stdout.
 */
export function feishuMcpLogPath(id: string): string {
  return join(feishuMcpLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function teammateMcpLogDir(): string {
  return join(logsRoot(), 'teammate-mcp');
}

/** Per-dispatcher TeamMate scheduling MCP stdio shim diagnostics. */
export function teammateMcpLogPath(id: string): string {
  return join(teammateMcpLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function claudeCodeLogDir(): string {
  return join(logsRoot(), 'claude-code');
}

/**
 * Per-dispatcher Claude Code resident stream-json child diagnostics (issue
 * #120). The child's stdout is the NDJSON data plane (consumed in-process by the
 * runtime), so only its stderr is logged here for crash diagnosis.
 */
export function dispatcherClaudeCodeStreamLogPath(id: string): string {
  return join(claudeCodeLogDir(), `${dispatcherPathSegment(id)}.stderr.log`);
}

export function dispatcherCodexAppServerLogPath(id: string): string {
  return join(codexAppServerLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function dispatcherCodexAppServerErrorLogPath(id: string): string {
  return join(codexAppServerLogDir(), `${dispatcherPathSegment(id)}.stderr.log`);
}

export function dispatcherStatusPath(id: string): string {
  return join(dispatcherDir(id), 'status.json');
}

export function dispatcherAccessPath(id: string): string {
  return join(dispatcherDir(id), 'access.json');
}

/** Per-dispatcher Server-hosted TeamMate state root (issue #110 PR7). */
export function dispatcherTeamMateDir(id: string): string {
  return join(dispatcherDir(id), 'teammate');
}

/** Versioned metadata file for the per-dispatcher TeamMate task ledger. */
export function dispatcherTeamMateLedgerPath(id: string): string {
  return join(dispatcherTeamMateDir(id), 'ledger.json');
}

/** Directory containing one versioned TeamMate task record per file. */
export function dispatcherTeamMateTasksDir(id: string): string {
  return join(dispatcherTeamMateDir(id), 'tasks');
}

/**
 * Root for per-task TeamMate worker session runtime files (issue #126 PR3).
 * Each real Codex worker session binds its own app-server listen socket here.
 */
export function dispatcherTeamMateWorkerDir(id: string): string {
  return join(dispatcherTeamMateDir(id), 'workers');
}

/**
 * Listen socket for one TeamMate worker's Codex app-server (issue #126 PR3).
 *
 * The task id is hashed into a short, fixed-width stem and placed under a
 * deliberately terse `teammate/w/` segment so the absolute path stays within
 * the Unix socket byte budget (the worker path is necessarily deeper than the
 * dispatcher's own `state/<id>/codex.sock`); the full id still names the
 * per-task log file. Guarded by {@link assertUnixSocketPathBudget} so an
 * over-long deployment root fails loudly at session start rather than as an
 * opaque bind error.
 */
export function dispatcherTeamMateWorkerSocketPath(
  id: string,
  taskId: string,
): string {
  const stem = createHash('sha256').update(taskId).digest('hex').slice(0, 12);
  return assertUnixSocketPathBudget(
    join(dispatcherTeamMateDir(id), 'w', `${stem}.sock`),
    `dispatcher '${id}' TeamMate worker Codex socket path`,
  );
}

/** Per-task TeamMate worker Codex app-server stdout log (issue #126 PR3). */
export function dispatcherTeamMateWorkerLogPath(
  id: string,
  taskId: string,
): string {
  return join(
    codexAppServerLogDir(),
    'teammate',
    dispatcherPathSegment(id),
    `${teamMateWorkerLogStem(taskId)}.log`,
  );
}

/** Per-task TeamMate worker Codex app-server stderr log (issue #126 PR3). */
export function dispatcherTeamMateWorkerErrorLogPath(
  id: string,
  taskId: string,
): string {
  return join(
    codexAppServerLogDir(),
    'teammate',
    dispatcherPathSegment(id),
    `${teamMateWorkerLogStem(taskId)}.stderr.log`,
  );
}

/**
 * Task ids are `^tmtsk_[a-z0-9]+_[a-z0-9]+$` (ledger-validated), so they are
 * already filesystem-safe. This guard keeps the log builder honest if a future
 * id shape leaks a separator or traversal segment in via an injected id.
 */
function teamMateWorkerLogStem(taskId: string): string {
  return taskId.replace(/[^a-z0-9_]/gi, '_');
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

/** Per-dispatcher Feishu inbound attachment cache, owned by the server. */
export function dispatcherFeishuAttachmentCacheDir(id: string): string {
  return join(dispatcherDir(id), 'feishu-attachments');
}

export function unixSocketPathFitsBudget(path: string): boolean {
  return Buffer.byteLength(path, 'utf8') <= DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES;
}

export function assertUnixSocketPathBudget(path: string, label: string): string {
  if (unixSocketPathFitsBudget(path)) return path;
  const bytes = Buffer.byteLength(path, 'utf8');
  throw new Error(
    `${label} is too long for Unix sockets (${bytes} bytes > ${DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES} safe bytes): ${path}`,
  );
}

export function dispatcherPathSegment(id: string): string {
  return validateDispatcherId(id);
}
