/**
 * Codex home/auth pre-start validation (issue #209 cleanup — relocated from
 * Dreamux core into the owning package).
 *
 * This is the codex-engine readiness check: it validates that the Codex home a
 * runtime will actually use (its `extra_env`'s `CODEX_HOME` override, or else
 * `~/.codex` — see `paths.ts`'s `resolveCodexHomeDir`) exists, parses its
 * `config.toml`, carries usable auth, and that the representative app-server
 * socket placement is sane. It is codex-specific and carries NO `~/.dreamux`
 * knowledge — the host's socket placement arrives as a neutral sample
 * (`socketPath`) computed from the path context's `runtimeSocketDirs()`, and
 * `dispatcherCwd` is optional (the validation never reads it).
 */
import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

import { parse as parseToml, TomlError } from 'smol-toml';

import {
  DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES,
  pathExists,
  unixSocketPathFitsBudget,
} from '@excitedjs/dreamux-utils';
import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';

import { resolveCodexHomeDir } from './paths.js';

export const DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES =
  DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES;

export interface DispatcherCodexHomeDoctorContext {
  dispatcherId: string;
  codexHome: string;
  configPath: string;
  /**
   * The runtime working directory. Optional/empty by default: the validation
   * never reads it, so a caller that does not have it (e.g. doctor) omits it.
   */
  dispatcherCwd: string;
  /**
   * A representative socket allocation (issue #182: sockets are random per
   * start, so this is a sample of the policy, not the path a runtime will
   * bind). Doctor checks placement (never shared /tmp) and the path budget. An
   * empty string skips the socket checks (no host candidate dirs were supplied).
   */
  socketPath: string;
  codexCliArgs: string[];
}

export interface DispatcherCodexHomeDoctorResult {
  ok: boolean;
  errors: string[];
  context: DispatcherCodexHomeDoctorContext;
}

interface DoctorContextOptions {
  codexCliArgs?: string[] | undefined;
  dispatcherCwd?: string;
  /** Representative socket sample (from the path context's `runtimeSocketDirs()`). */
  socketPath?: string;
}

interface DoctorOptions {
  env?: DreamuxEnvironment;
  codexCliArgs?: string[];
}

/**
 * Build the doctor context for a runtime, from the same env its Codex child
 * would actually spawn with — a per-agent `CODEX_HOME` override in
 * `extra_env` must be reflected here too, not just in the runtime's own spawn
 * path. Pass `paths.ts`'s `codexSpawnEnv` result, not the ambient diagnostic
 * env.
 */
export function dispatcherCodexHomeDoctorContext(
  dispatcherId: string,
  env: DreamuxEnvironment,
  options: DoctorContextOptions = {},
): DispatcherCodexHomeDoctorContext {
  const codexHome = resolveCodexHomeDir(env);
  return {
    dispatcherId,
    codexHome,
    configPath: join(codexHome, 'config.toml'),
    dispatcherCwd: options.dispatcherCwd ?? '',
    socketPath: options.socketPath ?? '',
    codexCliArgs: options.codexCliArgs ?? [],
  };
}

export async function validateDispatcherCodexHome(
  input: DispatcherCodexHomeDoctorContext,
  options: DoctorOptions = {},
): Promise<DispatcherCodexHomeDoctorResult> {
  const context: DispatcherCodexHomeDoctorContext = {
    ...input,
    codexCliArgs: options.codexCliArgs ?? input.codexCliArgs,
  };
  const errors: string[] = [];
  const env = options.env ?? process.env;
  let config: Record<string, unknown> = {};

  if (await pathExists(context.configPath)) {
    try {
      const parsed = parseToml(await readFile(context.configPath, 'utf8'));
      if (isRecord(parsed)) {
        config = parsed;
      } else {
        errors.push(`Codex config must be a TOML table: ${context.configPath}`);
      }
    } catch (err) {
      errors.push(formatTomlError(err, context.configPath));
    }
  }

  if (!(await pathExists(context.codexHome))) {
    errors.push(`missing Codex home directory: ${context.codexHome}`);
  }
  // An empty socketPath means no host candidate dirs were supplied — skip the
  // placement/budget checks (a real allocation still fails loud at start time).
  if (context.socketPath !== '') {
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
  }
  // The bundled dispatcher skill is no longer symlinked into the workspace
  // (issue #209 slice 6); core injects it at runtime by role via
  // `skills/extraRoots/set`, so the doctor no longer checks for an on-disk skill.

  if (!(await hasAuth(context.codexHome, config, env))) {
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

async function hasAuth(
  codexHome: string,
  config: Record<string, unknown>,
  env: DreamuxEnvironment,
): Promise<boolean> {
  if (await pathExists(join(codexHome, 'auth.json'))) return true;
  if (providerCarriesAuth(config, env)) return true;
  return ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].some(
    (name) => isSet(env[name]),
  );
}

/**
 * A home whose selected `model_provider` is a `[model_providers.<id>]` table
 * authenticates through that table: a literal `experimental_bearer_token`, or
 * the variable its `env_key` names. Such a home has no `auth.json` and needs
 * none of the OpenAI variables.
 */
function providerCarriesAuth(
  config: Record<string, unknown>,
  env: DreamuxEnvironment,
): boolean {
  const selected = config['model_provider'];
  const providers = config['model_providers'];
  if (typeof selected !== 'string' || !isRecord(providers)) return false;
  const provider = providers[selected];
  if (!isRecord(provider)) return false;
  const token = provider['experimental_bearer_token'];
  if (typeof token === 'string' && token.trim() !== '') return true;
  const envKey = provider['env_key'];
  return typeof envKey === 'string' && isSet(env[envKey]);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function isTmpPath(path: string): boolean {
  const normalized = normalize(path);
  return normalized === '/tmp' || normalized.startsWith(`/tmp${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
