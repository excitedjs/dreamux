import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from './atomic-write.js';
import { errorMessage } from './error-info.js';
import { isNotFound } from './fs-errors.js';
import { LegacyStateError } from '../service/legacy-state.js';

export interface JsonDocumentStoreOptions<TDoc> {
  version: number;
  parse(raw: unknown, ctx: { path: string }): TDoc;
  empty(): TDoc;
  corruptPolicy?: 'fail-loud' | 'warn-rebuild';
  warn?: (message: string) => void;
}

export class JsonDocumentStore<TDoc> {
  private readonly corruptPolicy: 'fail-loud' | 'warn-rebuild';

  constructor(private readonly opts: JsonDocumentStoreOptions<TDoc>) {
    this.corruptPolicy = opts.corruptPolicy ?? 'fail-loud';
  }

  async read(path: string): Promise<TDoc> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return this.opts.empty();
      throw err;
    }

    try {
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value) || value['version'] !== this.opts.version) {
        throw new LegacyStateError(
          `JSON document ${path} is not version ${this.opts.version}. ` +
            'Dreamux 0.x does not migrate old state; delete the file to rebuild it.',
        );
      }
      return this.opts.parse(value, { path });
    } catch (err) {
      if (this.corruptPolicy === 'warn-rebuild') {
        this.opts.warn?.(
          `Ignoring incompatible JSON document ${path}: ${errorMessage(err)}`,
        );
        return this.opts.empty();
      }
      if (err instanceof LegacyStateError) throw err;
      throw new LegacyStateError(
        `JSON document ${path} is malformed or incompatible. Dreamux 0.x does ` +
          `not migrate old state; delete the file to rebuild it. Cause: ${errorMessage(err)}`,
      );
    }
  }

  async write(path: string, doc: TDoc): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async assertCurrent(path: string): Promise<void> {
    await this.read(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
