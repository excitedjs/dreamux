/**
 * The single writer for one session's routing document, and the only reader
 * of record.
 *
 * One live session owns one file: a configured channel is built once per
 * dispatcher process and the filename carries the channel id, so two sessions
 * never address the same document. Inside the process every change is queued,
 * prepared on an isolated copy of the last committed document, written
 * atomically, and only then published as the value `current` returns.
 *
 * Disk commit is therefore the authority. What a caller reads is what was
 * persisted, and a change that failed to persist is one nobody ever saw — the
 * caller is told it failed, and that is the truth. The cost is that a change
 * becomes visible a write later, which nothing here depends on: a message that
 * slips through against a route being removed is answered by the typed
 * rejection that removes the route again.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ensureOwnerOnlyDir, writeAtomic } from '@excitedjs/dreamux-utils';

import {
  FEISHU_ROUTING_DOCUMENT_VERSION,
  emptyRoutingDocument,
  type FeishuRoutingDocument,
} from './document.js';

const INCOMPATIBLE =
  'feishu routing state is not compatible with this Dreamux version. ' +
  'Move the file aside and recreate the bindings with bind_channel / ' +
  'bind_collaboration_space.';

/**
 * A configured channel id is an operator's own string and may contain anything
 * a path segment must not. The slug keeps the file recognizable and the digest
 * keeps it unique, so two channel ids can never collide on one document.
 */
export function routingDocumentFilename(channelId: string): string {
  const slug = channelId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const digest = createHash('sha256').update(channelId).digest('hex');
  return `feishu-routing.${slug === '' ? 'channel' : slug}.` +
    `${digest.slice(0, 12)}.json`;
}

export interface FeishuRoutingStoreOptions {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly stateDir: string;
}

export class FeishuRoutingStore {
  private document: FeishuRoutingDocument | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: FeishuRoutingStoreOptions) {}

  private get path(): string {
    return join(
      this.opts.stateDir,
      routingDocumentFilename(this.opts.channelId),
    );
  }

  /** Read once, at initialize. A malformed or foreign document fails loud. */
  async load(): Promise<FeishuRoutingDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.document = emptyRoutingDocument({
          dispatcherId: this.opts.dispatcherId,
          channelId: this.opts.channelId,
          now: Date.now(),
        });
        return this.document;
      }
      throw new Error(
        `failed to read ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `failed to parse ${this.path}: ${(err as Error).message}`,
      );
    }
    this.document = validated(parsed, this.opts, this.path);
    return this.document;
  }

  /** The last committed document. Callers read it and never mutate it. */
  get current(): FeishuRoutingDocument {
    if (this.document === null) {
      throw new Error('feishu routing store was used before it was loaded');
    }
    return this.document;
  }

  /**
   * Prepare a change, persist it, and only then publish it.
   *
   * Preparation is serialized for the same reason the write is: two changes
   * prepared against one base would each persist a document missing the other.
   * Every step copies the document the step before it actually committed, so a
   * step whose write failed leaves the next one copying the last good value —
   * the failed change is gone, exactly as its caller was told.
   *
   * The mutator reports whether anything really changed, so an idempotent
   * repeat costs no write and no false `updated_at` bump. It works on a private
   * copy, which is also what lets a reader hold a record across a later commit
   * and keep the snapshot it captured.
   */
  update(mutator: (document: FeishuRoutingDocument) => boolean): Promise<void> {
    const commit = this.tail.then(async () => {
      const next = structuredClone(this.current);
      if (!mutator(next)) return;
      next.updated_at = Date.now();
      await ensureOwnerOnlyDir(this.opts.stateDir);
      await writeAtomic(
        this.opts.stateDir,
        routingDocumentFilename(this.opts.channelId),
        JSON.stringify(next, null, 2) + '\n',
        0o600,
      );
      this.document = next;
    });
    this.tail = commit.then(() => undefined, () => undefined);
    return commit;
  }

  /** Session close awaits this so no queued commit is abandoned. */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }
}

function validated(
  parsed: unknown,
  opts: FeishuRoutingStoreOptions,
  path: string,
): FeishuRoutingDocument {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${path}: routing state must be an object. ${INCOMPATIBLE}`,
    );
  }
  const document = parsed as Partial<FeishuRoutingDocument>;
  if (document.version !== FEISHU_ROUTING_DOCUMENT_VERSION) {
    throw new Error(`${path}: unsupported version. ${INCOMPATIBLE}`);
  }
  if (document.channel_id !== opts.channelId) {
    throw new Error(
      `${path}: routing state belongs to channel ` +
        `${JSON.stringify(document.channel_id)}. ${INCOMPATIBLE}`,
    );
  }
  if (!Array.isArray(document.bindings) || !Array.isArray(document.spaces)) {
    throw new Error(
      `${path}: routing state is missing a section. ${INCOMPATIBLE}`,
    );
  }
  return {
    version: FEISHU_ROUTING_DOCUMENT_VERSION,
    dispatcher_id: opts.dispatcherId,
    channel_id: opts.channelId,
    bindings: document.bindings,
    spaces: document.spaces,
    updated_at: typeof document.updated_at === 'number'
      ? document.updated_at
      : Date.now(),
  };
}
