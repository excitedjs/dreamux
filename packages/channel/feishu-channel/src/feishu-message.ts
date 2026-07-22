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
  Mention,
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
import { markdownFenceCloser } from './feishu-markdown-fence.js';
import {
  normalizeFeishuMessageTypeToken,
  replyAncestryParentId,
} from './feishu-reply-ancestry.js';

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
   * The full pre-rendered, escaped inner content: message body (+ mentions) +
   * parser fallback note + attachment refs + group-bots block. Everything that
   * previously lived inside the per-message wrapper, so moving the wrapping to
   * the runtime drops no model-visible content.
   */
  body: string;
  /** Whether a requested one-shot trusted-bot baseline reached the body. */
  groupBotsRendered: boolean;
  attachments: FormattedFeishuAttachment[];
  diagnostics: string[];
}

const MAX_RICH_BODY_CHARS = 160_000;
const RICH_BODY_TRUNCATION_MARKER = '\n[message content truncated: 160000-character limit reached]';

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
  const attrs: Array<[string, string]> = [
    ['chat_id', event.chatId],
    ['chat_type', event.chatType],
  ];
  if (event.threadId !== undefined && event.threadId !== '') {
    attrs.push(['thread_id', event.threadId]);
  }
  attrs.push(
    ['message_id', event.messageId],
    ['sender_id', event.senderId],
    ['sender_name', event.senderName],
    ['create_time', formatFeishuCreateTime(event.createTime)],
  );
  const body = renderMessageBody(event);
  const fallback = shouldAddFallbackNote(event)
    ? `\n\n${FEISHU_SKILL_FALLBACK_NOTE}`
    : '';
  const attachmentBlock = renderAttachments(attachments);
  const attachmentOmission = resolution.omittedCount === 0
    ? ''
    : `\n\n[${resolution.omittedCount} attachment(s) omitted: resource limit reached]`;
  const groupBots = renderGroupBots(options.trustedBots ?? []);
  const ancestry = renderReplyAncestry(event);

  const renderedPrefix = `${body}${ancestry}${fallback}${attachmentBlock}${attachmentOmission}`;
  let groupBotsRendered = groupBots !== '';
  let renderedBody: string;
  if (!isRichMessage(event.messageType)) {
    renderedBody = `${renderedPrefix}${groupBots}`;
  } else if (
    groupBots !== '' &&
    renderedPrefix.length + groupBots.length <= MAX_RICH_BODY_CHARS
  ) {
    renderedBody = `${renderedPrefix}${groupBots}`;
  } else if (
    groupBots !== '' &&
    groupBots.length + RICH_BODY_TRUNCATION_MARKER.length <= MAX_RICH_BODY_CHARS
  ) {
    renderedBody = `${truncateEscapedRichBody(
      renderedPrefix,
      MAX_RICH_BODY_CHARS - groupBots.length,
    )}${groupBots}`;
  } else {
    groupBotsRendered = false;
    renderedBody = truncateEscapedRichBody(renderedPrefix);
  }
  return {
    attrs,
    body: renderedBody,
    groupBotsRendered,
    attachments,
    diagnostics: attachments
      .filter((attachment) => attachment.status === 'not_downloaded')
      .map((attachment) =>
        `attachment ${attachment.type} was not downloaded: ${attachment.reason ?? 'api_error'}`),
  };
}

function renderGroupBots(trustedBots: PeerBot[]): string {
  if (trustedBots.length === 0) return '';
  const lines = trustedBots.map((bot) => {
    const name = bot.name ?? '';
    return `  <bot name="${escapeXmlAttribute(name)}" open_id="${escapeXmlAttribute(bot.openId)}" />`;
  });
  return [
    '\n\n<group_bots note="trusted bots in this group; a bot speaks without @-mentioning us">',
    ...lines,
    '</group_bots>',
  ].join('\n');
}

export function formatFeishuCreateTime(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const epochMs = Math.abs(numeric) < 1_000_000_000_000
      ? numeric * 1000
      : numeric;
    const date = new Date(epochMs);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return trimmed;
}

function renderMessageBody(event: FeishuInboundEvent): string {
  if (event.messageType === 'merge_forward') {
    const messageId = escapeXmlText(event.messageId);
    return `Merged-forward message: message_id=${messageId}.`;
  }
  const rawText = extractRawText(event);
  if (rawText !== null) {
    return renderTextWithMentions(rawText, event.mentions);
  }
  const escaped = escapeXmlText(event.parsedText);
  return escaped;
}

function extractRawText(event: FeishuInboundEvent): string | null {
  if (event.messageType !== 'text') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.rawContent);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const text = (parsed as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : null;
}

function renderTextWithMentions(text: string, mentions: Mention[]): string {
  let out = escapeXmlText(text);
  for (const mention of mentions) {
    const id = mention.id?.open_id ?? mention.id?.union_id ?? mention.id?.user_id;
    if (mention.key === '' || id === undefined || mention.name === undefined) {
      continue;
    }
    out = out.split(escapeXmlText(mention.key)).join(
      `<at id="${escapeXmlAttribute(id)}">${escapeXmlText(mention.name)}</at>`,
    );
  }
  return out;
}

function shouldAddFallbackNote(event: FeishuInboundEvent): boolean {
  if (event.messageType === 'merge_forward') return false;
  if (event.contentIncomplete === true) return true;
  if (event.parsedText === '(unparseable message)') return true;
  if (event.messageType === 'text' && extractRawText(event) === null) return true;
  return event.parsedText === `(${event.messageType} message)`;
}

function renderReplyAncestry(event: FeishuInboundEvent): string {
  const parentId = replyAncestryParentId(event);
  if (parentId === undefined) return '';
  const escapedParentId = escapeXmlText(parentId);
  const parentMessageType = event.parentMessageType === undefined
    ? undefined
    : normalizeFeishuMessageTypeToken(event.parentMessageType);
  const typeHint = parentMessageType === undefined
    ? ''
    : `, parent_message_type=${escapeXmlText(parentMessageType)}`;
  return `\n\nReply/quote ancestry: parent_message_id=${escapedParentId}${typeHint}.`;
}

function isRichMessage(messageType: string): boolean {
  return ['post', 'interactive'].includes(messageType);
}

function truncateEscapedRichBody(
  value: string,
  maxChars: number = MAX_RICH_BODY_CHARS,
): string {
  if (value.length <= maxChars) return value;
  let fenceReservation = 0;
  while (true) {
    const truncation = truncateEscapedXmlPrefix(
      value,
      Math.max(
        0,
        maxChars - RICH_BODY_TRUNCATION_MARKER.length - fenceReservation,
      ),
    );
    const fenceCloser = markdownFenceCloser(truncation.content);
    if (fenceCloser.length <= fenceReservation) {
      return `${truncation.content}${fenceCloser}${truncation.xmlClosers}${RICH_BODY_TRUNCATION_MARKER}`;
    }
    fenceReservation = fenceCloser.length;
  }
}

interface EscapedXmlPrefix {
  content: string;
  xmlClosers: string;
}

function truncateEscapedXmlPrefix(
  value: string,
  maxChars: number,
): EscapedXmlPrefix {
  const tags = /<[^>]+>/g;
  const openTags: string[] = [];
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  const closingTags = (stack: string[]): string =>
    [...stack].reverse().map((name) => `</${name}>`).join('');
  const appendText = (text: string): boolean => {
    const closers = closingTags(openTags);
    const budget = Math.max(
      0,
      maxChars - closers.length - output.length,
    );
    if (text.length <= budget) {
      output += text;
      return true;
    }
    output += safeEscapedPrefix(text, budget);
    return false;
  };

  while ((match = tags.exec(value)) !== null) {
    if (!appendText(value.slice(cursor, match.index))) {
      return { content: output, xmlClosers: closingTags(openTags) };
    }
    const tag = match[0];
    const nextOpenTags = updateOpenTags(openTags, tag);
    const required =
      output.length +
      tag.length +
      closingTags(nextOpenTags).length;
    if (required > maxChars) {
      return { content: output, xmlClosers: closingTags(openTags) };
    }
    output += tag;
    openTags.splice(0, openTags.length, ...nextOpenTags);
    cursor = match.index + tag.length;
  }

  appendText(value.slice(cursor));
  return { content: output, xmlClosers: closingTags(openTags) };
}

function safeEscapedPrefix(value: string, budget: number): string {
  let prefix = value.slice(0, budget);
  const lastAmpersand = prefix.lastIndexOf('&');
  const lastSemicolon = prefix.lastIndexOf(';');
  if (lastAmpersand > lastSemicolon) prefix = prefix.slice(0, lastAmpersand);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

function updateOpenTags(openTags: string[], tag: string): string[] {
  const next = [...openTags];
  const closing = /^<\/([A-Za-z][A-Za-z0-9:_-]*)\s*>$/.exec(tag);
  if (closing !== null) {
    if (next.at(-1) === closing[1]) next.pop();
    return next;
  }
  if (/\/>$/.test(tag)) return next;
  const opening = /^<([A-Za-z][A-Za-z0-9:_-]*)\b[^>]*>$/.exec(tag);
  if (opening !== null) next.push(opening[1]);
  return next;
}

async function resolveAttachments(
  event: FeishuInboundEvent,
  options: FormatFeishuMessageOptions,
  work: FeishuInboundWorkContext,
): Promise<AttachmentResolution> {
  const resources = event.resources ?? [];
  const out: FormattedFeishuAttachment[] = [];
  let omittedCount = 0;
  for (const [index, resource] of resources.entries()) {
    const identity = resource.key === undefined || resource.key === ''
      ? `${resource.type}:missing:${index}`
      : `${resource.type}:${resource.key}`;
    if (work.seenResourceKeys.has(identity)) continue;
    if (work.seenResourceKeys.size >= work.maxUniqueResources) {
      omittedCount += 1;
      continue;
    }
    work.seenResourceKeys.add(identity);
    out.push(await resolveAttachment(event.messageId, resource, options, work));
  }
  return { attachments: out, omittedCount };
}

interface AttachmentResolution {
  attachments: FormattedFeishuAttachment[];
  omittedCount: number;
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

function renderAttachments(
  attachments: FormattedFeishuAttachment[],
): string {
  if (attachments.length === 0) return '';
  return attachments.map(renderAttachment).join('');
}

function renderAttachment(
  attachment: FormattedFeishuAttachment,
): string {
  const attrs: Array<[string, string]> = [
    ['type', attachment.type],
    ...(attachment.name !== undefined ? [['name', attachment.name] as [string, string]] : []),
    ...(attachment.key !== undefined ? [['key', attachment.key] as [string, string]] : []),
    ...(attachment.path !== undefined ? [['path', attachment.path] as [string, string]] : []),
    ['status', attachment.status],
    ...(attachment.reason !== undefined ? [['reason', attachment.reason] as [string, string]] : []),
  ];
  const attrText = attrs
    .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
    .join(' ');

  return `\n\n<attachment ${attrText} />`;
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

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
