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
 *         teammate/           Server-hosted TeamMate identities and history
 *     logs/
 *       dreamux-server.log
 *       codex-app-server/
 *         <dispatcher-id>.log
 *
 * `stateRoot()` is the single root for dreamux-owned state. The old
 * `runtime_dir` concept (and its `runtimeRoot()` alias) was retired in issue #98.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILT_IN_DEFAULTS,
  type DreamuxConfig,
} from '../config/config.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

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

export function defaultDispatcherCwd(id: string): string {
  return join(dispatcherDir(id), 'cwd');
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

export function serverLogPath(): string {
  return join(logsRoot(), 'dreamux-server.log');
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

/** Directory containing one stable TeamMate identity record per file. */
export function dispatcherTeamMateIdentitiesDir(id: string): string {
  return join(dispatcherTeamMateDir(id), 'identities');
}

export function dispatcherTeamMateIdentityPath(
  id: string,
  teammateName: string,
): string {
  return join(
    dispatcherTeamMateIdentitiesDir(id),
    `${teamMateNameSegment(teammateName)}.json`,
  );
}

/** Forward-only JSONL history for one TeamMate identity. */
export function dispatcherTeamMateHistoryPath(
  id: string,
  teammateName: string,
): string {
  return join(
    dispatcherTeamMateDir(id),
    'history',
    `${teamMateNameSegment(teammateName)}.jsonl`,
  );
}

export function dispatcherTeamMateRuntimeDir(
  id: string,
  teammateName: string,
): string {
  return join(dispatcherTeamMateDir(id), 'runtime', teamMateNameSegment(teammateName));
}

/** Dreamux-managed Git worktrees for one dispatcher. */
export function dispatcherTeamMateWorktreesDir(id: string): string {
  return join(dispatcherTeamMateDir(id), 'worktrees');
}

/** One Dreamux-managed Git worktree path for a teammate slug. */
export function dispatcherTeamMateWorktreePath(id: string, slug: string): string {
  return join(dispatcherTeamMateWorktreesDir(id), teamMateNameSegment(slug));
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

export function dispatcherTeamLedgerPath(id: string, teamId: string): string {
  return join(dispatcherTeamDir(id), 'ledger', `${teamMateNameSegment(teamId)}.jsonl`);
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
 * Spill file for a teammate completion result that overflows the inline budget
 * (see `agent-runtime/completion-body.ts`). Both runtimes write the full result
 * here and inline only this path into the dispatcher turn, so a large result
 * never floods the dispatcher's context. Neutral: a completion is a
 * runtime-agnostic concept, so no runtime specifics appear here.
 *
 * Lives under the OS temp dir (the spec's `/tmp/teammate-{source}-{id}.output`
 * template); `source` and `id` are sanitized for filename safety. The id is
 * unique per completion (teammate name + turn id), so the only realistic
 * collision is two dispatchers producing the same teammate/turn id — acceptable
 * for a short-lived 0600 spill file.
 */
export function teamMateCompletionOutputPath(source: string, id: string): string {
  return `/tmp/teammate-${teamMateNameSegment(source)}-${teamMateNameSegment(id)}.output`;
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
