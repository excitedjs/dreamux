/**
 * The single writer for one session's routing document, and the only reader
 * of record.
 *
 * One live session owns one file: a configured channel is built once per
 * dispatcher process and the filename carries the channel id, so two sessions
 * never address the same document. `FeishuRouting` holds the
 * `TransactionalStore<FeishuRoutingDocument>` directly — this module owns no
 * wrapping class, only the `load` callback `FeishuRouting` builds that store with
 * (`readRoutingDocument`) and the one real write policy every mutation goes
 * through (`updateRoutingDocument`: an isolated copy of the last committed
 * document, an owner-only-dir check, an `updated_at` stamp, and a no-op short
 * circuit when the mutator reports nothing changed), mirroring
 * `chat-bots-store.ts`'s free-functions-over-a-held-store convention for the
 * session's other stores.
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
  ensureOwnerOnlyDir,
  type TransactionalStore,
} from '@excitedjs/dreamux-utils';

import {
  FEISHU_ROUTING_DOCUMENT_VERSION,
  emptyRoutingDocument,
  type FeishuBindingRecord,
  type FeishuRoutingDocument,
  type FeishuSpaceRecord,
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

export interface FeishuRoutingDocumentOptions {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly stateDir: string;
}

/** The one file this session's routing document lives at. */
export function routingDocumentPath(
  opts: FeishuRoutingDocumentOptions,
): string {
  return join(opts.stateDir, routingDocumentFilename(opts.channelId));
}

/**
 * The `load` option `FeishuRouting`'s `TransactionalStore<FeishuRoutingDocument>` is
 * built with. Read once, at initialize. A malformed or foreign document fails
 * loud.
 */
export async function readRoutingDocument(
  opts: FeishuRoutingDocumentOptions,
): Promise<FeishuRoutingDocument> {
  const path = routingDocumentPath(opts);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRoutingDocument({
        dispatcherId: opts.dispatcherId,
        channelId: opts.channelId,
        now: Date.now(),
      });
    }
    throw new Error(`failed to read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
  return validated(parsed, opts, path);
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
export async function updateRoutingDocument(
  store: TransactionalStore<FeishuRoutingDocument>,
  stateDir: string,
  mutator: (document: FeishuRoutingDocument) => boolean,
): Promise<void> {
  await store
    .update(async (committed) => {
      const next = structuredClone(committed);
      if (!mutator(next)) return committed; // unchanged reference: no write
      // The store's own directory creation is a bare recursive `mkdir`: it
      // neither rejects a symlink at the leaf nor a foreign-uid or
      // group/other-readable directory, and it sets mode only when it
      // creates. So the routing document runs its owner-only check itself,
      // before every commit, as it always has.
      await ensureOwnerOnlyDir(stateDir);
      next.updated_at = Date.now();
      return next;
    })
    .then(() => undefined);
}

function validated(
  parsed: unknown,
  opts: FeishuRoutingDocumentOptions,
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
    spaces: document.spaces.map((row) => validatedSpace(row)),
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
 *
 * This is also the write projection: it copies out only `FeishuBindingRecord`'s
 * own fields, so a row still carrying a retired field (for example a previous
 * `origin`) reads fine but stops round-tripping that field forward on the
 * next rewrite instead of copying it verbatim.
 */
function validatedBinding(
  row: FeishuBindingRecord,
  path: string,
): FeishuBindingRecord {
  const raw = (row as { root_message_id?: unknown }).root_message_id;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new Error(`${path}: a binding row is malformed. ${INCOMPATIBLE}`);
  }
  return {
    target: row.target,
    display: row.display,
    team_name: row.team_name,
    space_id: row.space_id,
    root_message_id: raw ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The write projection for a space row: copies out only `FeishuSpaceRecord`'s
 * own fields, so a row still carrying a retired field (for example a previous
 * `generation`) reads fine but stops round-tripping that field forward on
 * the next rewrite instead of copying it verbatim.
 */
function validatedSpace(row: FeishuSpaceRecord): FeishuSpaceRecord {
  return {
    space_id: row.space_id,
    space_name: row.space_name,
    container_chat_id: row.container_chat_id,
    display: row.display,
    leader_agent_runtime: row.leader_agent_runtime,
    identity: row.identity,
    repo: row.repo,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
