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

  if (!existsSync(context.configPath)) {
    errors.push(`missing Codex config: ${context.configPath}`);
  } else {
    try {
      const parsed = parseToml(readFileSync(context.configPath, 'utf8'));
      if (!isRecord(parsed)) {
        errors.push(`Codex config must be a TOML table: ${context.configPath}`);
      }
    } catch (err) {
      errors.push(formatTomlError(err, context.configPath));
    }
  }

  if (!existsSync(context.codexHome)) {
    errors.push(`missing Codex home directory: ${context.codexHome}`);
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

  if (!hasAuth(context.codexHome, env)) {
    errors.push(
      `missing Codex auth state in ${context.codexHome} or a supported auth environment variable`,
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
  const header = `dispatcher '${result.context.dispatcherId}' Codex home is not ready`;
  return [header, ...result.errors.map((e) => `- ${e}`)].join('\n');
}

function formatTomlError(err: unknown, file: string): string {
  if (err instanceof TomlError) {
    const where =
      typeof err.line === 'number' && typeof err.column === 'number'
        ? `${file}:${err.line}:${err.column}`
        : file;
    return `Codex config parse error at ${where}: ${err.message}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Codex config parse error in ${file}: ${msg}`;
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

function isTmpPath(path: string): boolean {
  const normalized = normalize(path);
  return normalized === '/tmp' || normalized.startsWith(`/tmp${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
