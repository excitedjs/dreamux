import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  describeType,
  errorInfo,
  errorMessage,
  isPlainObject,
} from '@excitedjs/dreamux-utils';

import { isNotFound } from '../../platform/fs-errors.js';

/** Repository-root JSON config controlling post-worktree setup execution. */
export const WORKTREE_CONFIG_FILENAME = '.dreamux-worktree.json';

type WorktreeSetupPlatform = 'darwin' | 'linux' | 'win32';

const SUPPORTED_PLATFORMS: readonly WorktreeSetupPlatform[] = [
  'darwin',
  'linux',
  'win32',
];

const ALLOWED_ROOT_KEYS = new Set<string>(['setup']);
const ALLOWED_SETUP_KEYS = new Set<string>([
  'script',
  'background',
  ...SUPPORTED_PLATFORMS,
]);
const ALLOWED_PLATFORM_KEYS = new Set<string>(['script', 'background']);

/** Bounded UTF-16 character tail kept per script run so noisy installs stay bounded. */
const OUTPUT_TAIL_LIMIT = 4096;

/** Brief pipe flush window after a non-zero exit so stderr tail is not lost on fast exits. */
const FAILURE_PIPE_FLUSH_MS = 50;

interface ResolvedWorktreeSetup {
  readonly script: string;
  readonly background: boolean;
}

interface SetupFields {
  readonly script: string | undefined;
  readonly background: boolean | undefined;
}

type SetupScriptOutcome =
  | { readonly kind: 'error'; readonly error: Error }
  | {
      readonly kind: 'exit';
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

/**
 * Read and validate `<sourceRepo>/.dreamux-worktree.json` for `platform`.
 *
 * Returns `null` when the file does not exist, omits `setup`, or resolves to
 * an absent/empty script on `platform`. Malformed JSON, unknown keys, or wrong
 * field types fail loud before Git creates a worktree.
 */
export async function readWorktreeSetup(
  sourceRepo: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedWorktreeSetup | null> {
  const configPath = join(sourceRepo, WORKTREE_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid ${configPath}: ${errorMessage(err)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `invalid ${configPath}: root must be an object (got ${describeType(parsed)})`,
    );
  }
  assertAllowedKeys(parsed, ALLOWED_ROOT_KEYS, '', configPath);

  const rawSetup = parsed['setup'];
  if (rawSetup === undefined) return null;
  if (!isPlainObject(rawSetup)) {
    throw new Error(
      `invalid ${configPath}: setup must be an object (got ${describeType(rawSetup)})`,
    );
  }
  assertAllowedKeys(rawSetup, ALLOWED_SETUP_KEYS, 'setup.', configPath);

  const base = readSetupFields(rawSetup, 'setup.', configPath);
  const overrides: Partial<Record<WorktreeSetupPlatform, SetupFields>> = {};
  for (const key of SUPPORTED_PLATFORMS) {
    const rawOverride = rawSetup[key];
    if (rawOverride === undefined) continue;
    if (!isPlainObject(rawOverride)) {
      throw new Error(
        `invalid ${configPath}: setup.${key} must be an object (got ${describeType(rawOverride)})`,
      );
    }
    assertAllowedKeys(
      rawOverride,
      ALLOWED_PLATFORM_KEYS,
      `setup.${key}.`,
      configPath,
    );
    overrides[key] = readSetupFields(rawOverride, `setup.${key}.`, configPath);
  }

  const override = isSupportedPlatform(platform)
    ? overrides[platform]
    : undefined;
  const script = override?.script ?? base.script;
  if (script === undefined || script.trim() === '') return null;
  const background = override?.background ?? base.background ?? false;
  return { script, background };
}

/**
 * Execute a resolved worktree setup script in `worktreePath`.
 *
 * Triggering itself (`spawn()`) is synchronous and fails loud for both modes
 * when the process cannot be created. Once spawned:
 * - Foreground (`background: false`) settles on direct child `exit` (so
 *   descendants inheriting stdio do not block agent launch) and throws on
 *   error, signal, or non-zero exit.
 * - Background (`background: true`) returns immediately and logs completion or
 *   failure asynchronously.
 */
export async function runWorktreeSetup(input: {
  readonly setup: ResolvedWorktreeSetup;
  readonly sourceRepo: string;
  readonly worktreePath: string;
  readonly log?: DreamuxLogger | undefined;
}): Promise<void> {
  const { setup, sourceRepo, worktreePath, log } = input;
  const child = spawn(setup.script, {
    cwd: worktreePath,
    shell: true,
    env: {
      ...process.env,
      DREAMUX_SOURCE_REPO: sourceRepo,
      DREAMUX_WORKTREE_PATH: worktreePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let outputTail = '';
  const appendOutput = (chunk: string): void => {
    outputTail += chunk;
    if (outputTail.length > OUTPUT_TAIL_LIMIT) {
      outputTail = outputTail.slice(-OUTPUT_TAIL_LIMIT);
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);

  const pipesClosed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });

  const exited = new Promise<SetupScriptOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: SetupScriptOutcome): void => {
      if (done) return;
      done = true;
      resolve(outcome);
    };
    child.once('error', (error) => finish({ kind: 'error', error }));
    child.once('exit', (code, signal) =>
      finish({ kind: 'exit', code, signal }),
    );
  });

  const settled = exited.then(async (outcome) => {
    if (outcome.kind === 'exit' && outcome.code !== 0) {
      await waitBrieflyForPipes(pipesClosed);
    }
    return outcome;
  });

  const modeLabel = setup.background ? 'background worktree' : 'worktree';
  const baseFields = {
    source_repo: sourceRepo,
    worktree_path: worktreePath,
  };

  log?.info(
    { ...baseFields, background: setup.background },
    setup.background
      ? 'started background worktree setup script'
      : 'running worktree setup script',
  );

  const reportOutcome = (outcome: SetupScriptOutcome): string | null => {
    const tail = outputTail.trim();
    if (outcome.kind === 'error') {
      log?.warn(
        { ...baseFields, err: errorInfo(outcome.error) },
        `${modeLabel} setup script failed to start`,
      );
      return `worktree setup script failed to start in ${worktreePath}: ${errorMessage(outcome.error)}`;
    }
    if (outcome.code !== 0) {
      const exitDetail =
        outcome.code !== null
          ? `exit code ${outcome.code}`
          : `signal ${outcome.signal ?? 'unknown'}`;
      log?.warn(
        {
          ...baseFields,
          exit_code: outcome.code,
          signal: outcome.signal,
          ...(tail !== '' ? { output_tail: tail } : {}),
        },
        `${modeLabel} setup script failed`,
      );
      return (
        `worktree setup script failed in ${worktreePath} (${exitDetail})` +
        (tail !== '' ? `: ${tail}` : '')
      );
    }
    log?.info(baseFields, `${modeLabel} setup script completed`);
    return null;
  };

  if (setup.background) {
    void settled.then((outcome) => {
      reportOutcome(outcome);
    });
    return;
  }

  const failureMessage = reportOutcome(await settled);
  if (failureMessage !== null) {
    throw new Error(failureMessage);
  }
}

async function waitBrieflyForPipes(pipesClosed: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pipesClosed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FAILURE_PIPE_FLUSH_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  configPath: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`invalid ${configPath}: unknown key "${prefix}${key}"`);
    }
  }
}

function readSetupFields(
  obj: Record<string, unknown>,
  prefix: string,
  configPath: string,
): SetupFields {
  const rawScript = obj['script'];
  if (rawScript !== undefined && typeof rawScript !== 'string') {
    throw new Error(
      `invalid ${configPath}: ${prefix}script must be a string (got ${describeType(rawScript)})`,
    );
  }
  const rawBackground = obj['background'];
  if (rawBackground !== undefined && typeof rawBackground !== 'boolean') {
    throw new Error(
      `invalid ${configPath}: ${prefix}background must be a boolean (got ${describeType(rawBackground)})`,
    );
  }
  return {
    script: rawScript,
    background: rawBackground,
  };
}

function isSupportedPlatform(
  platform: NodeJS.Platform,
): platform is WorktreeSetupPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}
