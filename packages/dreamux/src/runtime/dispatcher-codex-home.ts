import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, normalize, sep } from 'node:path';

import { parse as parseToml, TomlError } from 'smol-toml';

import {
  DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES,
  dispatcherAppServerControlDir,
  dispatcherCodexCwd,
  dispatcherCodexConfigPath,
  dispatcherCodexHome,
  dispatcherWorkspaceCodexSkillsDir,
  dispatcherWorkspaceSkillPath,
  dispatcherSocketPath,
  unixSocketPathFitsBudget,
} from './paths.js';

export const DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES =
  DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES;

export interface DispatcherCodexHomeDoctorContext {
  dispatcherId: string;
  codexHome: string;
  configPath: string;
  dispatcherCwd: string;
  skillsDir: string;
  skillPath: string;
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
  dispatcherCwd?: string;
}

interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  codexCliArgs?: string[];
}

export function dispatcherCodexHomeDoctorContext(
  dispatcherId: string,
  options: DoctorContextOptions = {},
): DispatcherCodexHomeDoctorContext {
  const dispatcherCwd = options.dispatcherCwd ?? dispatcherCodexCwd(dispatcherId);
  return {
    dispatcherId,
    codexHome: dispatcherCodexHome(dispatcherId),
    configPath: dispatcherCodexConfigPath(dispatcherId),
    dispatcherCwd,
    skillsDir: dispatcherWorkspaceCodexSkillsDir(dispatcherCwd),
    skillPath: dispatcherWorkspaceSkillPath(dispatcherCwd),
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

  if (existsSync(context.configPath)) {
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
  if (!unixSocketPathFitsBudget(context.socketPath)) {
    const bytes = Buffer.byteLength(context.socketPath, 'utf8');
    errors.push(
      `dispatcher app-server socket path is too long for Unix sockets (${bytes} bytes > ${DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES} safe bytes): ${context.socketPath}`,
    );
  }
  if (!dispatcherSkillExists(context.skillPath)) {
    errors.push(`missing dispatcher skill: ${context.skillPath}`);
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

function dispatcherSkillExists(skillPath: string): boolean {
  return existsSync(skillPath);
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

function isTmpPath(path: string): boolean {
  const normalized = normalize(path);
  return normalized === '/tmp' || normalized.startsWith(`/tmp${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
