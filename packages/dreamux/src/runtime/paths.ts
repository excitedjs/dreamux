/**
 * Filesystem layout for the codex-host server runtime.
 *
 * Default root: ~/.codex-host/  (override via env CODEX_HOST_RUNTIME_DIR
 * or `runtime_dir` in ~/.dreamux/config.json — env wins, see config.ts).
 * Layout:
 *   <root>/
 *     state.db                  SQLite database (dispatchers + inbound_buffer)
 *     admin.sock                server-ctl admin Unix socket
 *     dispatchers/<id>/
 *       app-server-control/     Codex app-server control sockets
 *       stdout.log              Codex stdout
 *       stderr.log              Codex stderr (load-bearing for debug)
 *
 * Dispatchers intentionally inherit the operator's existing CODEX_HOME (or
 * Codex's own default when the env var is unset). Runtime/socket/log/db state
 * is still owned by dreamux under runtimeRoot(). Dispatcher cwd is configured
 * during onboard and stored on the dispatcher row; dispatcherCodexCwd() exists
 * only as a legacy fallback.
 *
 * Issue ~/.dreamux/ config (feat/global-config-dir): paths.* functions
 * read an optionally-injected `DreamuxConfig` snapshot for non-env
 * defaults. Server.start() calls setRuntimeConfig() once at boot; bare
 * tests / standalone callers fall back to the built-in defaults.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  BUILT_IN_DEFAULTS,
  expandHome,
  type DreamuxConfig,
} from './config.js';

let currentConfig: DreamuxConfig = BUILT_IN_DEFAULTS;

/**
 * Set the active configuration snapshot. Called once by Server.start() with
 * the result of loadOrInitConfig(); tests can call it to inject a custom
 * snapshot. Idempotent.
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

export function runtimeRoot(): string {
  const fromEnv = process.env['CODEX_HOST_RUNTIME_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return expandHome(currentConfig.runtime_dir) || join(homedir(), '.codex-host');
}

export function databasePath(): string {
  return join(runtimeRoot(), 'state.db');
}

export function adminSocketPath(): string {
  const fromEnv = process.env['CODEX_HOST_ADMIN_SOCKET'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (currentConfig.admin_socket !== null) {
    return expandHome(currentConfig.admin_socket);
  }
  return join(runtimeRoot(), 'admin.sock');
}

export function dispatcherDir(id: string): string {
  return join(runtimeRoot(), 'dispatchers', id);
}

export function dispatcherCodexCwd(id: string): string {
  return join(dispatcherDir(id), 'cwd');
}

export function operatorCodexHome(): string {
  const fromEnv = process.env['CODEX_HOME'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), '.codex');
}

export function dispatcherCodexHome(id: string): string {
  void id;
  return operatorCodexHome();
}

export function dispatcherCodexConfigPath(id: string): string {
  return join(dispatcherCodexHome(id), 'config.toml');
}

export function dispatcherCodexPluginsDir(id: string): string {
  return join(dispatcherCodexHome(id), 'plugins');
}

export function dispatcherAppServerControlDir(id: string): string {
  return join(dispatcherDir(id), 'app-server-control');
}

export function dispatcherSocketPath(id: string): string {
  return join(dispatcherAppServerControlDir(id), 'as.sock');
}

export function dispatcherStdoutLog(id: string): string {
  return join(dispatcherDir(id), 'stdout.log');
}

export function dispatcherStderrLog(id: string): string {
  return join(dispatcherDir(id), 'stderr.log');
}
