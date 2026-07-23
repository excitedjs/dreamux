import { createHash } from 'node:crypto';
import {
  chmod,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { ensureOwnerOnlyDir } from '@excitedjs/dreamux-utils';

import type {
  FeishuMessageResourceFetcher,
  InboundResource,
} from '@excitedjs/feishu-transport';

import type { FeishuInboundEvent } from './bot.js';
import type { PeerBot } from './chat-bots-store.js';
import {
  createFeishuInboundWork,
  FeishuEnrichmentDeadlineError,
  FeishuResourceTimeoutError,
  FeishuSessionRevokedError,
  FEISHU_RESOURCE_TIMEOUT_MS,
  runFeishuInboundWork,
  alwaysActiveSessionFence,
  type FeishuInboundWorkContext,
} from './feishu-inbound-work.js';
import {
  formatFeishuCreateTime,
  renderFeishuStructuredBody,
} from './feishu-message-render.js';

/**
 * @deprecated Retained for source compatibility. Structured Feishu inbound
 * bodies no longer emit tool-directed fallback prose.
 */
export const FEISHU_SKILL_FALLBACK_NOTE =
  'Parser note: message text may be incomplete. Use the Feishu skill with the chat_id and message_id above to fetch the original message when needed.';

export type FeishuAttachmentReason =
  | 'no_key'
  | 'missing_scope'
  | 'too_large'
  | 'timeout'
  | 'api_error'
  | 'unsupported_type'
  | 'cache_error'
  | 'deadline'
  | 'resource_limit'
  | 'aggregate_limit';

export type FeishuAttachmentStatus = 'downloaded' | 'not_downloaded';

export interface FormatFeishuMessageOptions {
  /**
   * Trusted peer bots to surface once, as a `<group_bots>` block (issue #69).
   * Injected only on the first delivered group message after an `/introduce`
   * (or bot-added) so the model can map a bot open_id to a name. Trusted only.
   */
  trustedBots?: PeerBot[];
  /** Per-dispatcher cache directory owned by the host. Required for downloads. */
  cacheDir?: string;
  /** Raw Feishu resource fetcher from the transport boundary. */
  resourceFetcher?: FeishuMessageResourceFetcher;
  /** Defaults to 25 MiB per resource. */
  maxBytes?: number;
  /** Defaults to 20 seconds per resource. */
  timeoutMs?: number;
  /** Shared lifecycle/deadline/resource budget for an accepted inbound. */
  work?: FeishuInboundWorkContext;
}

export interface FormattedFeishuAttachment {
  type: 'file' | 'image';
  name?: string;
  key?: string;
  path?: string;
  status: FeishuAttachmentStatus;
  reason?: FeishuAttachmentReason;
}

export interface FormatFeishuMessageResult {
  /**
   * Opaque display attributes for the runtime's channel block (chat_id,
   * chat_type, optional thread_id, message_id, sender_id, sender_name,
   * create_time). The channel no longer renders the final XML — each runtime
   * wraps these into its own channel envelope.
   */
  attrs: Array<[string, string]>;
  /**
   * The Channel-owned inner markup: ordered content, lookup-only refs, and
   * optional trusted-bot context. The standing reminder is appended separately
   * by the session so it remains the final child.
   */
  body: string;
  /** Whether a requested one-shot trusted-bot baseline reached the body. */
  groupBotsRendered: boolean;
  attachments: FormattedFeishuAttachment[];
  diagnostics: string[];
}

export async function formatFeishuMessageForRuntime(
  event: FeishuInboundEvent,
  options: FormatFeishuMessageOptions = {},
): Promise<FormatFeishuMessageResult> {
  const ownedWork = options.work === undefined
    ? createFeishuInboundWork(alwaysActiveSessionFence(), {
        ...(options.maxBytes !== undefined
          ? { maxResourceBytes: options.maxBytes }
          : {}),
      })
    : undefined;
  const work = options.work ?? ownedWork;
  if (work === undefined) throw new Error('Feishu inbound work context was not created');
  let resolution: AttachmentResolution;
  try {
    resolution = await resolveAttachments(event, options, work);
  } finally {
    ownedWork?.dispose();
  }
  const attachments = resolution.attachments;
  const attrs: Array<[string, string]> = [];
  appendNonEmptyAttr(attrs, 'chat_id', event.chatId);
  appendNonEmptyAttr(attrs, 'chat_type', event.chatType);
  if (event.threadId !== undefined && event.threadId !== '') {
    attrs.push(['thread_id', event.threadId]);
  }
  appendNonEmptyAttr(attrs, 'message_id', event.messageId);
  appendNonEmptyAttr(attrs, 'sender_id', event.senderId);
  appendNonEmptyAttr(attrs, 'sender_name', event.senderName);
  appendNonEmptyAttr(
    attrs,
    'create_time',
    formatFeishuCreateTime(event.createTime),
  );
  const rendered = renderFeishuStructuredBody(
    event,
    options.trustedBots ?? [],
    (resource) => attachmentFor(resource, resolution),
  );
  return {
    attrs,
    body: rendered.body,
    groupBotsRendered: rendered.groupBotsRendered,
    attachments,
    diagnostics: attachments
      .filter((attachment) => attachment.status === 'not_downloaded')
      .map((attachment) =>
        `attachment ${attachment.type} was not downloaded: ${attachment.reason ?? 'api_error'}`),
  };
}

export { formatFeishuCreateTime } from './feishu-message-render.js';

function appendNonEmptyAttr(
  attrs: Array<[string, string]>,
  name: string,
  value: string,
): void {
  if (value !== '') attrs.push([name, value]);
}

async function resolveAttachments(
  event: FeishuInboundEvent,
  options: FormatFeishuMessageOptions,
  work: FeishuInboundWorkContext,
): Promise<AttachmentResolution> {
  const resources = uniqueResourcesForEvent(event);
  const out: FormattedFeishuAttachment[] = [];
  const byIdentity = new Map<string, FormattedFeishuAttachment>();
  const omittedIdentities = new Set<string>();
  for (const resource of resources) {
    const identity = attachmentIdentity(resource);
    if (work.seenResourceKeys.has(identity)) continue;
    if (work.seenResourceKeys.size >= work.maxUniqueResources) {
      omittedIdentities.add(identity);
      continue;
    }
    work.seenResourceKeys.add(identity);
    const resolved = await resolveAttachment(
      event.messageId,
      resource,
      options,
      work,
    );
    out.push(resolved);
    byIdentity.set(identity, resolved);
  }
  return { attachments: out, byIdentity, omittedIdentities };
}

interface AttachmentResolution {
  attachments: FormattedFeishuAttachment[];
  byIdentity: Map<string, FormattedFeishuAttachment>;
  omittedIdentities: Set<string>;
}

function uniqueResourcesForEvent(event: FeishuInboundEvent): InboundResource[] {
  const out: InboundResource[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...(event.resources ?? []),
    ...(event.contentParts ?? []).flatMap((part) =>
      part.kind === 'resource' ? [part.resource] : []),
  ];
  for (const resource of candidates) {
    const identity = attachmentIdentity(resource);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(resource);
  }
  return out;
}

function attachmentIdentity(resource: InboundResource): string {
  return resource.key === undefined || resource.key === ''
    ? `${resource.type}:missing:${resource.name ?? ''}`
    : `${resource.type}:${resource.key}`;
}

function attachmentFor(
  resource: InboundResource,
  resolution: AttachmentResolution,
): FormattedFeishuAttachment {
  const stableIdentity = attachmentIdentity(resource);
  const resolved = resolution.byIdentity.get(stableIdentity);
  if (resolved !== undefined) {
    return {
      ...resolved,
      ...(resource.name !== undefined ? { name: resource.name } : {}),
    };
  }
  return {
    type: resource.type,
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    ...(resource.key !== undefined ? { key: resource.key } : {}),
    status: 'not_downloaded',
    reason: resolution.omittedIdentities.has(stableIdentity)
      ? 'resource_limit'
      : resource.key === undefined || resource.key === ''
        ? 'no_key'
        : 'api_error',
  };
}

async function resolveAttachment(
  messageId: string,
  resource: InboundResource,
  options: FormatFeishuMessageOptions,
  work: FeishuInboundWorkContext,
): Promise<FormattedFeishuAttachment> {
  const base: FormattedFeishuAttachment = {
    type: resource.type,
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    ...(resource.key !== undefined ? { key: resource.key } : {}),
    status: 'not_downloaded',
  };

  if (resource.key === undefined || resource.key === '') {
    return { ...base, reason: 'no_key' };
  }
  if (options.cacheDir === undefined || options.resourceFetcher === undefined) {
    return { ...base, reason: 'unsupported_type' };
  }
  if (work.remainingTimeMs() === 0) return { ...base, reason: 'deadline' };
  if (work.remainingAggregateBytes <= 0) {
    return { ...base, reason: 'aggregate_limit' };
  }

  let publishedPath: string | undefined;
  let tmpPath: string | undefined;
  try {
    const cacheRoot = resolve(options.cacheDir);
    // Owner-only cache dir (issue #182): tighten a pre-existing permissive dir
    // and reject a symlink / foreign-uid dir, matching the run/spill trees.
    // Done BEFORE the cache-hit fast path below, so a pre-existing file in a
    // permissive/symlinked/foreign-owned dir is never returned as `downloaded`
    // without the dir first passing (or being tightened to) the owner-only
    // invariant.
    const resourceDeadline = Math.min(
      work.deadlineAt,
      Date.now() + (options.timeoutMs ?? FEISHU_RESOURCE_TIMEOUT_MS),
    );
    await runFeishuInboundWork(
      work,
      () => ensureOwnerOnlyDir(cacheRoot),
      resourceDeadline,
    );
    const path = attachmentPath(cacheRoot, resource);
    const cachedSize = await runFeishuInboundWork(
      work,
      () => fileSize(path),
      resourceDeadline,
    );
    const perResourceLimit = options.maxBytes ?? work.maxResourceBytes;
    if (cachedSize !== null) {
      if (cachedSize > perResourceLimit) {
        return { ...base, reason: 'too_large' };
      }
      if (cachedSize > work.remainingAggregateBytes) {
        return { ...base, reason: 'aggregate_limit' };
      }
      work.remainingAggregateBytes -= cachedSize;
      return { ...base, status: 'downloaded', path };
    }

    const response = await runFeishuInboundWork(
      work,
      () => options.resourceFetcher?.fetchMessageResource({
        messageId,
        fileKey: resource.key ?? '',
        type: resource.type,
      }) ?? Promise.reject(new Error('Feishu resource fetcher unavailable')),
      resourceDeadline,
      (late) => {
        late.stream.destroy();
      },
    );
    let bytes: Buffer;
    try {
      bytes = await runFeishuInboundWork(
        work,
        () => readStreamWithLimit(response.stream, perResourceLimit, work),
        resourceDeadline,
      );
    } catch (error) {
      // The response stream is already ours even when the shared wrapper
      // rejects before the reader starts (deadline/session boundary).
      response.stream.destroy();
      throw error;
    }
    work.assertEnrichmentActive();
    tmpPath = `${path}.tmp-${globalThis.process.pid}-${Date.now()}`;
    try {
      await runFeishuInboundWork(
        work,
        () => writeFile(tmpPath ?? '', bytes, { mode: 0o600, signal: work.signal }),
        resourceDeadline,
      );
      await runFeishuInboundWork(
        work,
        () => chmod(tmpPath ?? '', 0o600),
        resourceDeadline,
      );
      await runFeishuInboundWork(
        work,
        async () => {
          work.assertEnrichmentActive();
          await rename(tmpPath ?? '', path);
          publishedPath = path;
          if (work.signal.aborted || !work.isSessionActive()) {
            await rm(path, { force: true });
            publishedPath = undefined;
            work.assertEnrichmentActive();
          }
        },
        resourceDeadline,
      );
    } catch (err) {
      if (tmpPath !== undefined) await rm(tmpPath, { force: true });
      if (publishedPath !== undefined) await rm(publishedPath, { force: true });
      throw err;
    }
    return { ...base, status: 'downloaded', path };
  } catch (err) {
    if (err instanceof FeishuSessionRevokedError) throw err;
    return { ...base, reason: reasonFromError(err) };
  }
}

function attachmentPath(cacheRoot: string, resource: InboundResource): string {
  const key = resource.key ?? 'missing-key';
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const displayName = sanitizeFileName(resource.name ?? `${resource.type}.bin`);
  const path = resolve(cacheRoot, `${resource.type}-${digest}-${displayName}`);
  if (!isInside(cacheRoot, path)) throw new CachePathError();
  return path;
}

function sanitizeFileName(value: string): string {
  const safeBase = basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[-.]+/, '')
    .slice(0, 80);
  return safeBase === '' ? 'attachment.bin' : safeBase;
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function readStreamWithLimit(
  stream: Readable,
  maxBytes: number,
  work: FeishuInboundWorkContext,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = (): void => {
    stream.destroy(new FeishuStreamAbortedError());
  };
  work.signal.addEventListener('abort', onAbort, { once: true });
  if (work.signal.aborted) onAbort();

  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const resourceRemaining = Math.max(0, maxBytes - total);
      const aggregateRemaining = work.remainingAggregateBytes;
      total += bytes.byteLength;
      work.remainingAggregateBytes = Math.max(
        0,
        aggregateRemaining - bytes.byteLength,
      );
      if (bytes.byteLength > resourceRemaining) {
        const limitError = resourceRemaining <= aggregateRemaining
          ? new DownloadTooLargeError()
          : new DownloadAggregateLimitError();
        stream.destroy(limitError);
        throw limitError;
      }
      if (bytes.byteLength > aggregateRemaining) {
        const limitError = new DownloadAggregateLimitError();
        stream.destroy(limitError);
        throw limitError;
      }
      chunks.push(bytes);
    }
  } catch (err) {
    if (work.signal.aborted) {
      work.assertEnrichmentActive();
    }
    throw err;
  } finally {
    work.signal.removeEventListener('abort', onAbort);
  }

  return Buffer.concat(chunks, total);
}

function reasonFromError(err: unknown): FeishuAttachmentReason {
  if (err instanceof DownloadTooLargeError) return 'too_large';
  if (err instanceof DownloadAggregateLimitError) return 'aggregate_limit';
  if (err instanceof FeishuResourceTimeoutError) return 'timeout';
  if (err instanceof FeishuEnrichmentDeadlineError) return 'deadline';
  if (err instanceof CachePathError) return 'cache_error';
  if (err instanceof Error && looksLikeMissingScope(err)) return 'missing_scope';
  return 'api_error';
}

function looksLikeMissingScope(err: Error): boolean {
  const message = err.message.toLowerCase();
  return message.includes('scope') || message.includes('permission');
}

class DownloadTooLargeError extends Error {
  constructor() {
    super('Feishu resource exceeds configured byte cap');
  }
}

class DownloadAggregateLimitError extends Error {
  constructor() {
    super('Feishu message aggregate resource byte cap was reached');
  }
}

class FeishuStreamAbortedError extends Error {
  constructor() {
    super('Feishu resource stream was aborted');
  }
}

class CachePathError extends Error {
  constructor() {
    super('Feishu resource cache path escaped cache root');
  }
}
