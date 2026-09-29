/**
 * Idempotent-write tracking: create-or-leave-alone a directory or text file
 * and report what actually happened. `onboard/run.ts`'s `runOnboard` and
 * `daemon/install.ts`'s `runDaemonInstall` both write the same kind of
 * dreamux-owned file (config, state dirs, log files, the service unit)
 * through this one ledger contract and its one implementation, so both
 * report an identical created/modified/unchanged file list instead of each
 * keeping its own tracking.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { pathExists } from './fs-errors.js';

export type FileLedgerStatus = 'created' | 'modified' | 'unchanged' | 'skipped';

export interface FileLedgerEntry {
  path: string;
  status: FileLedgerStatus;
  reason: string;
}

export interface FileLedger {
  entries(): FileLedgerEntry[];
  record(path: string, status: FileLedgerStatus, reason: string): void;
}

type WriteFileStatus = Exclude<FileLedgerStatus, 'skipped'>;

export class TransparentFileLedger implements FileLedger {
  private readonly seen = new Map<string, FileLedgerEntry>();

  entries(): FileLedgerEntry[] {
    return Array.from(this.seen.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }

  record(path: string, status: FileLedgerStatus, reason: string): void {
    const existing = this.seen.get(path);
    if (existing === undefined) {
      this.seen.set(path, { path, status, reason });
      return;
    }
    this.seen.set(path, {
      path,
      status: mergeStatus(existing.status, status),
      reason:
        existing.reason === reason ? reason : `${existing.reason}; ${reason}`,
    });
  }
}

export interface WriteOptions {
  mode?: number;
  dryRun?: boolean;
}

export async function ensureDirectory(
  path: string,
  ledger: FileLedger,
  reason: string,
  options: { dryRun?: boolean | undefined } = {},
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
  ledger: FileLedger,
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
  ledger: FileLedger,
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

function mergeStatus(
  a: FileLedgerStatus,
  b: FileLedgerStatus,
): FileLedgerStatus {
  if (a === 'created' || b === 'created') return 'created';
  if (a === 'modified' || b === 'modified') return 'modified';
  if (a === 'skipped' || b === 'skipped') return 'skipped';
  return 'unchanged';
}
