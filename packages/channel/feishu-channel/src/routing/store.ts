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

import {
  TransactionalStore,
  ensureOwnerOnlyDir,
} from '@excitedjs/dreamux-utils';

import {
  FEISHU_ROUTING_DOCUMENT_VERSION,
  emptyRoutingDocument,
  type FeishuBindingRecord,
  type FeishuRoutingDocument,
} from './document.js';

const INCOMPATIBLE =
  'feishu routing state is not compatible with this Dreamux version. ' +
  'Move the file aside and recreate the bindings with bind_channel / ' +
  'bind_collaboration_space.';

/**
 * A configured channel id is an operator's own string and may contain anything
 * a path segment must not. The slug keeps the name recognizable and the digest
 * keeps it unique, so two channel ids can never collide on one path.
 */
export function channelPathSegment(channelId: string): string {
  const slug = channelId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const digest = createHash('sha256').update(channelId).digest('hex');
  return `${slug === '' ? 'channel' : slug}.${digest.slice(0, 12)}`;
}

export function routingDocumentFilename(channelId: string): string {
  return `feishu-routing.${channelPathSegment(channelId)}.json`;
}

export interface FeishuRoutingStoreOptions {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly stateDir: string;
}

export class FeishuRoutingStore {
  private readonly held: TransactionalStore<FeishuRoutingDocument>;

  constructor(private readonly opts: FeishuRoutingStoreOptions) {
    this.held = new TransactionalStore({
      path: this.path,
      load: () => this.readDocument(),
    });
  }

  private get path(): string {
    return join(
      this.opts.stateDir,
      routingDocumentFilename(this.opts.channelId),
    );
  }

  /** Read once, at initialize. A malformed or foreign document fails loud. */
  load(): Promise<FeishuRoutingDocument> {
    return this.held.load();
  }

  private async readDocument(): Promise<FeishuRoutingDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyRoutingDocument({
          dispatcherId: this.opts.dispatcherId,
          channelId: this.opts.channelId,
          now: Date.now(),
        });
      }
      throw new Error(`failed to read ${this.path}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `failed to parse ${this.path}: ${(err as Error).message}`,
      );
    }
    return validated(parsed, this.opts, this.path);
  }

  /** The last committed document. Callers read it and never mutate it. */
  get current(): FeishuRoutingDocument {
    return this.held.current;
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
    return this.held
      .update(async (committed) => {
        const next = structuredClone(committed);
        if (!mutator(next)) return committed; // unchanged reference: no write
        // The store's own directory creation is a bare recursive `mkdir`: it
        // neither rejects a symlink at the leaf nor a foreign-uid or
        // group/other-readable directory, and it sets mode only when it
        // creates. So the routing document runs its owner-only check itself,
        // before every commit, as it always has.
        await ensureOwnerOnlyDir(this.opts.stateDir);
        next.updated_at = Date.now();
        return next;
      })
      .then(() => undefined);
  }

  /** Session close awaits this so no queued commit is abandoned. */
  async drain(): Promise<void> {
    await this.held.drain();
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
  // `subscriptions` is the one section a released build may not have written.
  // Absent loses no fact, so it reads as empty; present but not a list is the
  // same corruption as the two beside it and fails the same way. It is
  // materialized here rather than left undefined, because this reconstruction
  // is what every reader sees.
  if (
    document.subscriptions !== undefined &&
    !Array.isArray(document.subscriptions)
  ) {
    throw new Error(
      `${path}: routing state is missing a section. ${INCOMPATIBLE}`,
    );
  }
  return {
    version: FEISHU_ROUTING_DOCUMENT_VERSION,
    dispatcher_id: opts.dispatcherId,
    channel_id: opts.channelId,
    bindings: document.bindings.map((row) => validatedBinding(row, path)),
    spaces: document.spaces,
    subscriptions: document.subscriptions ?? [],
    updated_at:
      typeof document.updated_at === 'number'
        ? document.updated_at
        : Date.now(),
  };
}

/**
 * `root_message_id` is the one binding-row field a released build may not
 * have written. Absent loses no fact — such a row simply predates the
 * feature and has no persisted root until it is rebound — so it reads as
 * `null`; present but not a string or `null` is the same corruption every
 * other field fails on.
 */
function validatedBinding(
  row: FeishuBindingRecord,
  path: string,
): FeishuBindingRecord {
  const raw = (row as { root_message_id?: unknown }).root_message_id;
  if (raw === undefined) return { ...row, root_message_id: null };
  if (raw !== null && typeof raw !== 'string') {
    throw new Error(`${path}: a binding row is malformed. ${INCOMPATIBLE}`);
  }
  return row;
}
