import { pathExists } from '../platform/fs-errors.js';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  OnboardFileLedger,
  OnboardFileLedgerEntry,
  OnboardFileStatus,
} from './types.js';

type WriteFileStatus = Exclude<OnboardFileStatus, 'skipped'>;

export class TransparentFileLedger implements OnboardFileLedger {
  private readonly seen = new Map<string, OnboardFileLedgerEntry>();

  entries(): OnboardFileLedgerEntry[] {
    return Array.from(this.seen.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }

  record(path: string, status: OnboardFileStatus, reason: string): void {
    const existing = this.seen.get(path);
    if (existing === undefined) {
      this.seen.set(path, { path, status, reason });
      return;
    }
    this.seen.set(path, {
      path,
      status: mergeStatus(existing.status, status),
      reason: existing.reason === reason ? reason : `${existing.reason}; ${reason}`,
    });
  }
}

export interface WriteOptions {
  mode?: number;
  dryRun?: boolean;
}

export type FileSnapshot = Map<string, Buffer>;

export async function ensureDirectory(
  path: string,
  ledger: OnboardFileLedger,
  reason: string,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  if (await pathExists(path)) {
    if (!(await stat(path)).isDirectory()) {
      throw new Error(`expected directory but found a file: ${path}`);
    }
    ledger.record(path, 'unchanged', reason);
    return;
  }
  if (!options.dryRun) {
    await mkdir(path, { recursive: true });
  }
  ledger.record(path, 'created', reason);
}

export async function writeTextFile(
  path: string,
  content: string,
  ledger: OnboardFileLedger,
  reason: string,
  options: WriteOptions = {},
): Promise<WriteFileStatus> {
  const parent = dirname(path);
  await ensureDirectory(parent, ledger, `parent directory for ${reason}`, {
    dryRun: options.dryRun,
  });

  let status: WriteFileStatus;
  if (!(await pathExists(path))) {
    status = 'created';
  } else {
    const current = await readFile(path, 'utf8');
    status = current === content ? 'unchanged' : 'modified';
  }

  if (!options.dryRun && status !== 'unchanged') {
    await writeFile(path, content, {
      mode: options.mode,
    });
  }
  ledger.record(path, status, reason);
  return status;
}

export async function ensureTextFile(
  path: string,
  initialContent: string,
  ledger: OnboardFileLedger,
  reason: string,
  options: WriteOptions = {},
): Promise<WriteFileStatus> {
  const parent = dirname(path);
  await ensureDirectory(parent, ledger, `parent directory for ${reason}`, {
    dryRun: options.dryRun,
  });
  if (await pathExists(path)) {
    ledger.record(path, 'unchanged', reason);
    return 'unchanged';
  }
  if (!options.dryRun) {
    await writeFile(path, initialContent, {
      mode: options.mode,
    });
  }
  ledger.record(path, 'created', reason);
  return 'created';
}

export async function snapshotFiles(root: string): Promise<FileSnapshot> {
  const out: FileSnapshot = new Map();
  if (!(await pathExists(root))) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const info = await stat(current);
    if (info.isFile()) {
      out.set(current, await readFile(current));
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const entry of await readdir(current)) {
      stack.push(join(current, entry));
    }
  }
  return out;
}

export async function recordFileTreeChanges(
  root: string,
  before: FileSnapshot,
  ledger: OnboardFileLedger,
  reason: string,
): Promise<void> {
  const after = await snapshotFiles(root);
  for (const [path, content] of after) {
    const previous = before.get(path);
    const status =
      previous === undefined
        ? 'created'
        : Buffer.compare(previous, content) === 0
          ? 'unchanged'
          : 'modified';
    ledger.record(path, status, reason);
  }
}

function mergeStatus(
  a: OnboardFileStatus,
  b: OnboardFileStatus,
): OnboardFileStatus {
  if (a === 'created' || b === 'created') return 'created';
  if (a === 'modified' || b === 'modified') return 'modified';
  if (a === 'skipped' || b === 'skipped') return 'skipped';
  return 'unchanged';
}
