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

export interface DispatcherCodexHomeDoctorContext {
  dispatcherId: string;
  codexHome: string;
  configPath: string;
  pluginsDir: string;
  appServerControlDir: string;
  socketPath: string;
}

export interface DispatcherCodexHomeDoctorResult {
  ok: boolean;
  errors: string[];
  context: DispatcherCodexHomeDoctorContext;
}

export type DispatcherCodexHomeDoctor = (
  context: DispatcherCodexHomeDoctorContext,
) => void | Promise<void>;

interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
}

export function dispatcherCodexHomeDoctorContext(
  dispatcherId: string,
): DispatcherCodexHomeDoctorContext {
  return {
    dispatcherId,
    codexHome: dispatcherCodexHome(dispatcherId),
    configPath: dispatcherCodexConfigPath(dispatcherId),
    pluginsDir: dispatcherCodexPluginsDir(dispatcherId),
    appServerControlDir: dispatcherAppServerControlDir(dispatcherId),
    socketPath: dispatcherSocketPath(dispatcherId),
  };
}

export function validateDispatcherCodexHome(
  dispatcherId: string,
  options: DoctorOptions = {},
): DispatcherCodexHomeDoctorResult {
  const context = dispatcherCodexHomeDoctorContext(dispatcherId);
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
  if (!existsSync(context.appServerControlDir)) {
    errors.push(
      `missing dispatcher app-server control directory: ${context.appServerControlDir}`,
    );
  }
  if (isTmpPath(context.socketPath)) {
    errors.push(
      `dispatcher app-server socket must not be under /tmp: ${context.socketPath}`,
    );
  }
  if (!codexmuxPluginExists(context.pluginsDir)) {
    errors.push(`missing codexmux plugin under: ${context.pluginsDir}`);
  }

  if (parsedConfig !== null) {
    if (!hasNetworkEnabledProfile(parsedConfig)) {
      errors.push(
        'dispatcher Codex config must select a network-enabled sandbox/profile',
      );
    }
    if (!hasModel(parsedConfig, env)) {
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
  const result = validateDispatcherCodexHome(context.dispatcherId);
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

function hasNetworkEnabledProfile(config: Record<string, unknown>): boolean {
  const sandboxMode = stringValue(config['sandbox_mode']);
  if (sandboxMode === 'danger-full-access') return true;
  if (sandboxMode === 'workspace-write') {
    const workspaceWrite = recordValue(config['sandbox_workspace_write']);
    if (workspaceWrite !== null && boolValue(workspaceWrite['network_access']) === true) {
      return true;
    }
  }

  const profileName =
    stringValue(config['profile']) ??
    stringValue(config['default_profile']) ??
    stringValue(config['permission_profile']) ??
    stringValue(config['default_permissions']);
  if (profileName === null) return false;

  const profiles = recordValue(config['profiles']);
  if (profiles !== null) {
    const profile = recordValue(profiles[profileName]);
    if (profile !== null && profileAllowsNetwork(profile)) return true;
  }

  const permissions = recordValue(config['permissions']);
  if (permissions !== null) {
    const profile = recordValue(permissions[profileName]);
    if (profile !== null && profileAllowsNetwork(profile)) return true;
  }

  return false;
}

function profileAllowsNetwork(profile: Record<string, unknown>): boolean {
  if (stringValue(profile['sandbox_mode']) === 'danger-full-access') return true;
  if (boolValue(profile['network_access']) === true) return true;
  if (stringValue(profile['network']) === 'enabled') return true;

  const sandbox = recordValue(profile['sandbox_workspace_write']);
  if (sandbox !== null && boolValue(sandbox['network_access']) === true) return true;

  return false;
}

function hasModel(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): boolean {
  const fromConfig = stringValue(config['model']);
  if (fromConfig !== null && fromConfig.trim() !== '') return true;
  const fromEnv = env['CODEX_MODEL'];
  return fromEnv !== undefined && fromEnv.trim() !== '';
}

function hasAuth(codexHome: string, env: NodeJS.ProcessEnv): boolean {
  if (existsSync(join(codexHome, 'auth.json'))) return true;
  return env['OPENAI_API_KEY'] !== undefined || env['CODEX_API_KEY'] !== undefined;
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
