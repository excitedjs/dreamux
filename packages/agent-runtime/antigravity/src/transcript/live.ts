import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import { parseNativeRecord, type NativeRecord } from './records.js';

export type TranscriptBaseline =
  | { readonly kind: 'missing'; readonly offset: 0 }
  | {
      readonly kind: 'existing';
      readonly device: number;
      readonly inode: number;
      readonly offset: number;
    };

export interface LiveTranscriptRecord {
  readonly record: NativeRecord;
  readonly offset: number;
}

type ExistingBaseline = Extract<TranscriptBaseline, { kind: 'existing' }>;

export async function snapshotTranscript(
  path: string,
): Promise<TranscriptBaseline> {
  const file = await openTranscript(path);
  if (!file) return { kind: 'missing', offset: 0 };
  try {
    return await snapshot(file);
  } finally {
    await file.close();
  }
}

/** An incremental cursor bound to one native full transcript. EOF at open is
 * historical. A transcript absent at open is tailed from its first byte. */
export class LiveTranscript {
  private offset: number;
  private lineOffset: number;
  private fragments: Buffer[] = [];
  private discardPartial: boolean;
  private operation: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private baseline: TranscriptBaseline,
    discardPartial: boolean,
  ) {
    this.offset = baseline.offset;
    this.lineOffset = baseline.offset;
    this.discardPartial = discardPartial;
  }

  static async open(path: string): Promise<LiveTranscript> {
    const file = await openTranscript(path);
    if (!file)
      return new LiveTranscript(path, { kind: 'missing', offset: 0 }, false);
    try {
      const baseline = await snapshot(file);
      const last = Buffer.alloc(1);
      if (baseline.offset > 0) {
        await file.read(last, 0, 1, baseline.offset - 1);
      }
      return new LiveTranscript(
        path,
        baseline,
        baseline.offset > 0 && last[0] !== 10,
      );
    } finally {
      await file.close();
    }
  }

  snapshot(): Promise<TranscriptBaseline> {
    return this.serialize(async () => {
      const current = await snapshotTranscript(this.path);
      this.bind(current);
      return current;
    });
  }

  /** Read only new, newline-terminated records in native file order. */
  read(): Promise<readonly LiveTranscriptRecord[]> {
    return this.serialize(() => this.readNew());
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private bind(current: TranscriptBaseline): void {
    if (this.baseline.kind === 'existing') {
      if (
        current.kind === 'missing' ||
        this.baseline.device !== current.device ||
        this.baseline.inode !== current.inode ||
        current.offset < this.baseline.offset
      ) {
        throw new Error(
          'Antigravity full transcript disappeared, was replaced, or was truncated',
        );
      }
    }
    this.baseline = current;
  }

  private async readNew(): Promise<readonly LiveTranscriptRecord[]> {
    const file = await openTranscript(this.path);
    if (!file) {
      this.bind({ kind: 'missing', offset: 0 });
      return [];
    }
    try {
      const current = await snapshot(file);
      this.bind(current);
      const records: LiveTranscriptRecord[] = [];
      while (this.offset < current.offset) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, current.offset - this.offset),
        );
        const { bytesRead } = await file.read(
          chunk,
          0,
          chunk.length,
          this.offset,
        );
        if (bytesRead === 0)
          throw new Error(
            'Antigravity full transcript was truncated during observation',
          );
        this.decode(chunk.subarray(0, bytesRead), records);
        this.offset += bytesRead;
      }
      return records;
    } finally {
      await file.close();
    }
  }

  private decode(chunk: Buffer, records: LiveTranscriptRecord[]): void {
    let cursor = 0;
    for (
      let newline = chunk.indexOf(10);
      newline !== -1;
      newline = chunk.indexOf(10, cursor)
    ) {
      if (this.discardPartial) {
        this.discardPartial = false;
      } else {
        this.fragments.push(chunk.subarray(cursor, newline));
        const record = parseNativeRecord(
          Buffer.concat(this.fragments).toString('utf8'),
        );
        if (record) records.push({ record, offset: this.lineOffset });
        this.fragments = [];
      }
      cursor = newline + 1;
      this.lineOffset = this.offset + cursor;
    }
    if (cursor < chunk.length && !this.discardPartial)
      this.fragments.push(chunk.subarray(cursor));
  }
}

async function snapshot(file: FileHandle): Promise<ExistingBaseline> {
  const { dev: device, ino: inode, size: offset } = await file.stat();
  return { kind: 'existing', device, inode, offset };
}

async function openTranscript(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
