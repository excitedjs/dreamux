import { execFile } from 'node:child_process';
import { opendir, realpath } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { promisify } from 'node:util';

import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';
import { isPathWithin } from '@excitedjs/dreamux-utils';

import {
  createClaudeScanBudget,
  type ClaudeScanBudget,
} from './budget.js';
import { ClaudeActivityError } from './error.js';
import { claudeNativePathHash } from './native-hash.js';
import {
  openClaudeRollout,
  validateClaudeSessionEvidence,
} from './opened-file.js';

const MAX_SANITIZED_LENGTH = 200;
const SESSION_FILENAME = /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i;
const execFileAsync = promisify(execFile);

export interface ClaudeHistoryRoots {
  configHome: string;
  projects: string;
}

export interface ClaudeValidatedHistory {
  path: string;
  root: string;
  size: number;
  dev: number | bigint;
  ino: number | bigint;
}

export function claudeHistoryRoots(
  env: DreamuxEnvironment = process.env,
  runtimeCwd = process.cwd(),
): ClaudeHistoryRoots {
  const configured = env['CLAUDE_CONFIG_DIR'];
  const configHome = (
    configured === undefined || configured === ''
      ? join(requireHome(env), '.claude')
      : isAbsolute(configured)
        ? configured
        : resolve(runtimeCwd, configured)
  ).normalize('NFC');
  return { configHome, projects: join(configHome, 'projects') };
}

export async function deriveClaudeHistoryPath(
  sessionId: string,
  cwd: string,
  env: DreamuxEnvironment = process.env,
): Promise<string> {
  assertSessionId(sessionId);
  const roots = claudeHistoryRoots(env, cwd);
  const canonicalCwd = await canonicalRuntimeCwd(cwd);
  const path = join(
    roots.projects,
    sanitizePath(canonicalCwd.normalize('NFC')),
    `${sessionId}.jsonl`,
  );
  return canonicalProspectivePath(path, roots.projects);
}

export async function locateClaudeHistory(input: {
  sessionId: string;
  cwd: string;
  locator?: string | null;
  env?: DreamuxEnvironment;
  budget?: ClaudeScanBudget;
  worktreePaths?: readonly string[];
}): Promise<ClaudeValidatedHistory> {
  assertSessionId(input.sessionId);
  const budget = input.budget ?? createClaudeScanBudget();
  const roots = claudeHistoryRoots(input.env, input.cwd);
  if (input.locator !== null && input.locator !== undefined) {
    try {
      return await validateClaudeHistoryPath(
        input.locator,
        input.sessionId,
        roots,
      );
    } catch (error) {
      if (
        !(error instanceof ClaudeActivityError) ||
        error.detail !== 'not_found'
      ) {
        throw error;
      }
    }
  }
  const candidates = await discoveryCandidates({
    roots,
    sessionId: input.sessionId,
    cwd: input.cwd,
    env: input.env,
    budget,
    worktreePaths: input.worktreePaths,
  });
  for (const candidate of candidates) {
    try {
      return await validateClaudeHistoryPath(
        candidate,
        input.sessionId,
        roots,
      );
    } catch (error) {
      if (
        error instanceof ClaudeActivityError &&
        error.detail === 'not_found'
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new ClaudeActivityError(
    'not_found',
    'Claude Code activity is unavailable',
  );
}

export async function validateClaudeHistoryPath(
  candidate: string,
  sessionId: string,
  roots: ClaudeHistoryRoots,
): Promise<ClaudeValidatedHistory> {
  if (
    !isAbsolute(candidate) ||
    !SESSION_FILENAME.test(candidate.split(/[\\/]/).at(-1) ?? '') ||
    !candidate.endsWith(`${sessionId}.jsonl`)
  ) {
    throw new ClaudeActivityError(
      'invalid',
      'Claude Code activity locator is not a native session path',
    );
  }
  const canonicalProjects = await canonicalExistingRoot(roots.projects);
  const opened = await openClaudeRollout(candidate, canonicalProjects);
  try {
    if (opened.size === 0) {
      throw new ClaudeActivityError(
        'not_found',
        'Claude Code activity is unavailable',
      );
    }
    await validateClaudeSessionEvidence(opened, sessionId);
    return {
      path: opened.path,
      root: canonicalProjects,
      size: opened.size,
      dev: opened.dev,
      ino: opened.ino,
    };
  } finally {
    await opened.handle.close();
  }
}

function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return (
    `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-` +
    claudeNativePathHash(name)
  );
}

async function discoveryCandidates(input: {
  roots: ClaudeHistoryRoots;
  sessionId: string;
  cwd: string;
  env?: DreamuxEnvironment;
  budget: ClaudeScanBudget;
  worktreePaths?: readonly string[];
}): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  let projectDirectories: Promise<string[]> | null = null;
  const readProjects = (): Promise<string[]> => {
    projectDirectories ??= readProjectDirectories(input.roots, input.budget);
    return projectDirectories;
  };
  const pushProjectCandidates = async (cwd: string): Promise<void> => {
    const canonical = await canonicalRuntimeCwd(cwd);
    const exact = await deriveClaudeHistoryPath(
      input.sessionId,
      canonical,
      input.env,
    );
    pushUnique(result, seen, exact);
    const sanitized = sanitizePath(canonical.normalize('NFC'));
    if (sanitized.length <= MAX_SANITIZED_LENGTH) return;
    const prefix =
      sanitized.slice(0, MAX_SANITIZED_LENGTH) + '-';
    const entries = await readProjects();
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        pushUnique(
          result,
          seen,
          join(input.roots.projects, entry, `${input.sessionId}.jsonl`),
        );
      }
    }
  };
  await pushProjectCandidates(input.cwd);
  const worktrees =
    input.worktreePaths ?? (await discoverWorktreePaths(input.cwd));
  for (const worktree of worktrees) {
    input.budget.inspect();
    if (resolve(worktree) !== resolve(input.cwd)) {
      await pushProjectCandidates(worktree);
    }
  }
  const projects = await readProjects();
  for (const project of projects) {
    pushUnique(
      result,
      seen,
      join(input.roots.projects, project, `${input.sessionId}.jsonl`),
    );
  }
  return result;
}

async function readProjectDirectories(
  roots: ClaudeHistoryRoots,
  budget: ClaudeScanBudget,
): Promise<string[]> {
  let directory;
  try {
    directory = await opendir(roots.projects);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ClaudeActivityError(
      'unreadable',
      'Claude Code activity root is unreadable',
      { cause: error },
    );
  }
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      budget.inspect();
      if (entry.isDirectory()) entries.push(entry.name);
    }
  } catch (error) {
    if (error instanceof ClaudeActivityError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries;
    throw new ClaudeActivityError(
      'unreadable',
      'Claude Code activity root is unreadable',
      { cause: error },
    );
  }
  return entries;
}

async function discoverWorktreePaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=',
        'worktree',
        'list',
        '--porcelain',
      ],
      { cwd, timeout: 5_000, windowsHide: true },
    );
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
  } catch {
    return [];
  }
}

async function canonicalProspectivePath(
  candidate: string,
  root: string,
): Promise<string> {
  const [canonicalCandidate, canonicalRoot] = await Promise.all([
    canonicalizeProspectivePath(candidate),
    canonicalizeProspectivePath(root),
  ]);
  if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
    throw new ClaudeActivityError(
      'locator_outside_root',
      'Claude Code activity is unavailable for this session',
    );
  }
  return canonicalCandidate;
}

async function canonicalRuntimeCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolve(cwd);
    }
    throw new ClaudeActivityError(
      'unreadable',
      'Claude Code runtime cwd is unreadable',
      { cause: error },
    );
  }
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  let ancestor = absolutePath;
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(
        canonicalAncestor,
        relative(ancestor, absolutePath),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new ClaudeActivityError(
          'unreadable',
          'Claude Code activity path is unreadable',
          { cause: error },
        );
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new ClaudeActivityError(
        'not_found',
        'Claude Code activity root is unavailable',
      );
    }
    ancestor = parent;
  }
}

async function canonicalExistingRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClaudeActivityError(
        'not_found',
        'Claude Code activity root is unavailable',
        { cause: error },
      );
    }
    throw new ClaudeActivityError(
      'unreadable',
      'Claude Code activity root is unreadable',
      { cause: error },
    );
  }
}

function pushUnique(
  result: string[],
  seen: Set<string>,
  value: string,
): void {
  if (seen.has(value)) return;
  seen.add(value);
  result.push(value);
}

function assertSessionId(sessionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)) {
    throw new ClaudeActivityError(
      'invalid',
      'Claude Code session id is invalid',
    );
  }
}

function requireHome(env: DreamuxEnvironment): string {
  const home = env['HOME'];
  if (home === undefined || home === '') {
    throw new ClaudeActivityError(
      'not_found',
      'Claude Code config home is unavailable',
    );
  }
  return home;
}
