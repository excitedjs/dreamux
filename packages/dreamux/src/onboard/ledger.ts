import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  OnboardFileLedger,
  OnboardFileLedgerEntry,
  OnboardFileStatus,
} from './types.js';

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

export function ensureDirectory(
  path: string,
  ledger: OnboardFileLedger,
  reason: string,
  options: { dryRun?: boolean } = {},
): void {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) {
      throw new Error(`expected directory but found a file: ${path}`);
    }
    ledger.record(path, 'unchanged', reason);
    return;
  }
  if (!options.dryRun) {
    mkdirSync(path, { recursive: true });
  }
  ledger.record(path, 'created', reason);
}

export function writeTextFile(
  path: string,
  content: string,
  ledger: OnboardFileLedger,
  reason: string,
  options: WriteOptions = {},
): OnboardFileStatus {
  const parent = dirname(path);
  ensureDirectory(parent, ledger, `parent directory for ${reason}`, {
    dryRun: options.dryRun,
  });

  let status: OnboardFileStatus;
  if (!existsSync(path)) {
    status = 'created';
  } else {
    const current = readFileSync(path, 'utf8');
    status = current === content ? 'unchanged' : 'modified';
  }

  if (!options.dryRun && status !== 'unchanged') {
    writeFileSync(path, content, {
      mode: options.mode,
    });
  }
  ledger.record(path, status, reason);
  return status;
}

export function ensureTextFile(
  path: string,
  initialContent: string,
  ledger: OnboardFileLedger,
  reason: string,
  options: WriteOptions = {},
): OnboardFileStatus {
  const parent = dirname(path);
  ensureDirectory(parent, ledger, `parent directory for ${reason}`, {
    dryRun: options.dryRun,
  });
  if (existsSync(path)) {
    ledger.record(path, 'unchanged', reason);
    return 'unchanged';
  }
  if (!options.dryRun) {
    writeFileSync(path, initialContent, {
      mode: options.mode,
    });
  }
  ledger.record(path, 'created', reason);
  return 'created';
}

export function snapshotFiles(root: string): FileSnapshot {
  const out: FileSnapshot = new Map();
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const stat = statSync(current);
    if (stat.isFile()) {
      out.set(current, readFileSync(current));
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current)) {
      stack.push(join(current, entry));
    }
  }
  return out;
}

export function recordFileTreeChanges(
  root: string,
  before: FileSnapshot,
  ledger: OnboardFileLedger,
  reason: string,
): void {
  const after = snapshotFiles(root);
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
  return 'unchanged';
}
