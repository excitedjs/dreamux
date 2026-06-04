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
 *     logs/
 *       dreamux-server.log
 *       codex-app-server/
 *         <dispatcher-id>.log
 *
 * `runtime_dir` is not an effective runtime contract. The legacy runtimeRoot()
 * function remains as a compatibility alias for stateRoot() while older call
 * sites are retired.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  BUILT_IN_DEFAULTS,
  type DreamuxConfig,
} from './config.js';
import { validateDispatcherId } from './dispatcher-id.js';

export const DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES = 103;

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

/**
 * Legacy compatibility alias. New code should call stateRoot().
 */
export function runtimeRoot(): string {
  return stateRoot();
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

export function dispatcherWorkspaceSkillPath(cwd: string): string {
  return join(dispatcherWorkspaceCodexSkillsDir(cwd), 'dispatcher', 'SKILL.md');
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

/**
 * Per-dispatcher peer-bot awareness/trust store. One file per dispatcher,
 * keyed internally by chat_id, holds the *known* (passively observed) and
 * *trusted* (introduced via an allowlisted `/introduce`) peer-bot open_ids
 * plus the bot-added baseline bookkeeping. Server-owned state; safe to delete.
 */
export function dispatcherChatBotsPath(id: string): string {
  return join(dispatcherDir(id), 'chat-bots.json');
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
