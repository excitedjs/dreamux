import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, normalize, sep } from 'node:path';

import { parse as parseToml, TomlError } from 'smol-toml';

import {
  dispatcherAppServerControlDir,
  dispatcherCodexConfigPath,
  dispatcherCodexHome,
  dispatcherCodexPluginsDir,
  dispatcherSocketPath,
} from './paths.js';

export const DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES = 103;

export interface DispatcherCodexHomeDoctorContext {
  dispatcherId: string;
  codexHome: string;
  configPath: string;
  pluginsDir: string;
  appServerControlDir: string;
  socketPath: string;
  codexCliArgs: string[];
}

export interface DispatcherCodexHomeDoctorResult {
  ok: boolean;
  errors: string[];
  context: DispatcherCodexHomeDoctorContext;
}

export type DispatcherCodexHomeDoctor = (
  context: DispatcherCodexHomeDoctorContext,
) => void | Promise<void>;

interface DoctorContextOptions {
  codexCliArgs?: string[];
}

interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  codexCliArgs?: string[];
}

export function dispatcherCodexHomeDoctorContext(
  dispatcherId: string,
  options: DoctorContextOptions = {},
): DispatcherCodexHomeDoctorContext {
  return {
    dispatcherId,
    codexHome: dispatcherCodexHome(dispatcherId),
    configPath: dispatcherCodexConfigPath(dispatcherId),
    pluginsDir: dispatcherCodexPluginsDir(dispatcherId),
    appServerControlDir: dispatcherAppServerControlDir(dispatcherId),
    socketPath: dispatcherSocketPath(dispatcherId),
    codexCliArgs: options.codexCliArgs ?? [],
  };
}

export function validateDispatcherCodexHome(
  input: string | DispatcherCodexHomeDoctorContext,
  options: DoctorOptions = {},
): DispatcherCodexHomeDoctorResult {
  const context =
    typeof input === 'string'
      ? dispatcherCodexHomeDoctorContext(input, {
          codexCliArgs: options.codexCliArgs,
        })
      : {
          ...input,
          codexCliArgs: options.codexCliArgs ?? input.codexCliArgs,
        };
  const errors: string[] = [];
  const env = options.env ?? process.env;

  let parsedConfig: Record<string, unknown> | null = null;
  if (!existsSync(context.configPath)) {
    errors.push(`missing dispatcher Codex config: ${context.configPath}`);
  } else {
    try {
      const parsed = parseToml(readFileSync(context.configPath, 'utf8'));
      if (isRecord(parsed)) {
        parsedConfig = parsed;
      } else {
        errors.push(`dispatcher Codex config must be a TOML table: ${context.configPath}`);
      }
    } catch (err) {
      errors.push(formatTomlError(err, context.configPath));
    }
  }

  if (!existsSync(context.codexHome)) {
    errors.push(`missing dispatcher CODEX_HOME directory: ${context.codexHome}`);
  }
  if (isTmpPath(context.socketPath)) {
    errors.push(
      `dispatcher app-server socket must not be under /tmp: ${context.socketPath}`,
    );
  }
  if (!socketPathFitsUnixLimit(context.socketPath)) {
    const bytes = Buffer.byteLength(context.socketPath, 'utf8');
    errors.push(
      `dispatcher app-server socket path is too long for Unix sockets (${bytes} bytes > ${DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES} safe bytes): ${context.socketPath}`,
    );
  }
  if (!codexmuxPluginExists(context.pluginsDir)) {
    errors.push(`missing codexmux plugin under: ${context.pluginsDir}`);
  }

  if (parsedConfig !== null) {
    const effectiveConfig = applyCliConfigOverrides(
      parsedConfig,
      context.codexCliArgs,
      errors,
    );
    if (!hasNetworkEnabledRuntime(effectiveConfig)) {
      errors.push(
        'dispatcher Codex runtime config must select a network-enabled sandbox/profile',
      );
    }
    if (!hasModel(effectiveConfig)) {
      errors.push(
        `dispatcher Codex config must define a model in: ${context.configPath}`,
      );
    }
  }

  if (!hasAuth(context.codexHome, env)) {
    errors.push(
      `missing dispatcher Codex auth state in ${context.codexHome} or a supported auth environment variable`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    context,
  };
}

export async function assertDispatcherCodexHomeReady(
  context: DispatcherCodexHomeDoctorContext,
): Promise<void> {
  const result = validateDispatcherCodexHome(context);
  if (result.ok) return;
  throw new Error(formatDispatcherCodexHomeErrors(result));
}

export function formatDispatcherCodexHomeErrors(
  result: DispatcherCodexHomeDoctorResult,
): string {
  const header = `dispatcher '${result.context.dispatcherId}' private CODEX_HOME is not ready`;
  return [header, ...result.errors.map((e) => `- ${e}`)].join('\n');
}

function formatTomlError(err: unknown, file: string): string {
  if (err instanceof TomlError) {
    const where =
      typeof err.line === 'number' && typeof err.column === 'number'
        ? `${file}:${err.line}:${err.column}`
        : file;
    return `dispatcher Codex config parse error at ${where}: ${err.message}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `dispatcher Codex config parse error in ${file}: ${msg}`;
}

function codexmuxPluginExists(root: string): boolean {
  return hasPathSegment(root, 'codexmux', 5);
}

function hasPathSegment(root: string, segment: string, maxDepth: number): boolean {
  if (!existsSync(root)) return false;
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (basename(current.path) === segment) return true;
    if (current.depth >= maxDepth) continue;
    let entries: string[];
    try {
      entries = readdirSync(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current.path, entry);
      try {
        if (statSync(child).isDirectory()) {
          stack.push({ path: child, depth: current.depth + 1 });
        }
      } catch {
        /* ignore transient filesystem races */
      }
    }
  }
  return false;
}

function hasNetworkEnabledRuntime(config: Record<string, unknown>): boolean {
  const sandboxMode = stringValue(config['sandbox_mode']);
  if (sandboxMode === 'danger-full-access') return true;
  if (sandboxMode === 'workspace-write') {
    const workspaceWrite = recordValue(config['sandbox_workspace_write']);
    if (workspaceWrite !== null && boolValue(workspaceWrite['network_access']) === true) {
      return true;
    }
  }

  const profileName = stringValue(config['default_permissions']);
  if (profileName === null) return false;

  const permissions = recordValue(config['permissions']);
  if (permissions !== null) {
    const profile = recordValue(permissions[profileName]);
    if (profile !== null && profileAllowsNetwork(profile)) return true;
  }

  return false;
}

function profileAllowsNetwork(profile: Record<string, unknown>): boolean {
  if (stringValue(profile['sandbox_mode']) === 'danger-full-access') return true;
  const network = recordValue(profile['network']);
  if (network !== null && boolValue(network['enabled']) === true) return true;

  const sandbox = recordValue(profile['sandbox_workspace_write']);
  if (sandbox !== null && boolValue(sandbox['network_access']) === true) return true;

  return false;
}

function hasModel(config: Record<string, unknown>): boolean {
  const fromConfig = stringValue(config['model']);
  return fromConfig !== null && fromConfig.trim() !== '';
}

function hasAuth(codexHome: string, env: NodeJS.ProcessEnv): boolean {
  if (existsSync(join(codexHome, 'auth.json'))) return true;
  return ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].some(
    (name) => {
      const value = env[name];
      return value !== undefined && value.trim() !== '';
    },
  );
}

function socketPathFitsUnixLimit(path: string): boolean {
  return (
    Buffer.byteLength(path, 'utf8') <=
    DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES
  );
}

function applyCliConfigOverrides(
  config: Record<string, unknown>,
  cliArgs: string[],
  errors: string[],
): Record<string, unknown> {
  const effective = cloneRecord(config);
  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if (arg === '-c' || arg === '--config') {
      const next = cliArgs[i + 1];
      if (next === undefined) {
        errors.push(`Codex config override ${arg} is missing key=value`);
      } else {
        applyConfigOverride(effective, next, errors);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--config=')) {
      applyConfigOverride(effective, arg.slice('--config='.length), errors);
    }
  }
  return effective;
}

function applyConfigOverride(
  config: Record<string, unknown>,
  raw: string,
  errors: string[],
): void {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    errors.push(`Codex config override must be key=value: ${raw}`);
    return;
  }

  const key = raw.slice(0, eq).trim();
  const value = parseCodexConfigValue(raw.slice(eq + 1).trim());
  const parts = key.split('.').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) {
    errors.push(`Codex config override has an empty key: ${raw}`);
    return;
  }

  let target = config;
  for (const part of parts.slice(0, -1)) {
    const existing = target[part];
    if (!isRecord(existing)) {
      target[part] = {};
    }
    target = target[part] as Record<string, unknown>;
  }
  target[parts[parts.length - 1] as string] = value;
}

function parseCodexConfigValue(raw: string): unknown {
  try {
    const parsed = parseToml(`value = ${raw}`);
    if (isRecord(parsed)) return parsed['value'];
  } catch {
    /* Codex treats non-TOML override values as literal strings. */
  }
  return raw;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    copy[key] = cloneValue(value);
  }
  return copy;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) return cloneRecord(value);
  return value;
}

function isTmpPath(path: string): boolean {
  const normalized = normalize(path);
  return normalized === '/tmp' || normalized.startsWith(`/tmp${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
