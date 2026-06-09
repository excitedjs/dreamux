import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import type {
  FeishuMessageResourceFetcher,
  InboundResource,
  Mention,
} from '@excitedjs/feishu-transport';

export const FEISHU_SKILL_FALLBACK_NOTE =
  'Parser note: message text may be incomplete. Use the Feishu skill with the chat_id and message_id above to fetch the original message when needed.';

export type FeishuAttachmentReason =
  | 'no_key'
  | 'missing_scope'
  | 'too_large'
  | 'timeout'
  | 'api_error'
  | 'unsupported_type'
  | 'cache_error';

export type FeishuAttachmentStatus = 'downloaded' | 'not_downloaded';

export interface FeishuChannelMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  senderType: string;
  senderName: string;
  messageType: string;
  rawContent: string;
  parsedText: string;
  mentions: Mention[];
  createTime: string;
  resources?: InboundResource[];
}

export interface FeishuPeerBot {
  openId: string;
  name?: string;
}

export interface FormatFeishuMessageOptions {
  /**
   * Trusted peer bots to surface once, as a `<group_bots>` block (issue #69).
   * Injected only on the first delivered group message after an `/introduce`
   * (or bot-added) so the model can map a bot open_id to a name. Trusted only.
   */
  trustedBots?: FeishuPeerBot[];
  /** Per-dispatcher cache directory owned by the host. Required for downloads. */
  cacheDir?: string;
  /** Raw Feishu resource fetcher from the transport boundary. */
  resourceFetcher?: FeishuMessageResourceFetcher;
  /** Defaults to 25 MiB per resource. */
  maxBytes?: number;
  /** Defaults to 20 seconds per resource. */
  timeoutMs?: number;
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
  formattedText: string;
  attachments: FormattedFeishuAttachment[];
  diagnostics: string[];
}

const DEFAULT_MAX_RESOURCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_RESOURCE_TIMEOUT_MS = 20_000;

export async function formatFeishuMessageForCodex(
  event: FeishuChannelMessage,
  options: FormatFeishuMessageOptions = {},
): Promise<FormatFeishuMessageResult> {
  const attachments = await resolveAttachments(event, options);
  const attrs: Array<[string, string]> = [
    ['chat_id', event.chatId],
    ['chat_type', event.chatType],
    ['message_id', event.messageId],
    ['sender_id', event.senderId],
    ['sender_name', event.senderName],
    ['create_time', formatFeishuCreateTime(event.createTime)],
  ];
  const body = renderMessageBody(event);
  const fallback = shouldAddFallbackNote(event)
    ? `\n\n${FEISHU_SKILL_FALLBACK_NOTE}`
    : '';
  const attachmentBlock = renderAttachments(event.messageId, attachments);
  const groupBots = renderGroupBots(options.trustedBots ?? []);

  const renderedAttrs = attrs
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`)
    .join('');

  return {
    formattedText: [
      `<channel source="feishu"${renderedAttrs}>`,
      `${body}${fallback}${attachmentBlock}${groupBots}`,
      '</channel>',
    ].join('\n'),
    attachments,
    diagnostics: attachments
      .filter((attachment) => attachment.status === 'not_downloaded')
      .map((attachment) =>
        `attachment ${attachment.type} was not downloaded: ${attachment.reason ?? 'api_error'}`),
  };
}

function renderGroupBots(trustedBots: FeishuPeerBot[]): string {
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

function renderMessageBody(event: FeishuChannelMessage): string {
  const rawText = extractRawText(event);
  if (rawText !== null) {
    return renderTextWithMentions(rawText, event.mentions);
  }
  return escapeXmlText(event.parsedText);
}

function extractRawText(event: FeishuChannelMessage): string | null {
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

function shouldAddFallbackNote(event: FeishuChannelMessage): boolean {
  if (event.parsedText === '(unparseable message)') return true;
  if (event.messageType === 'text' && extractRawText(event) === null) return true;
  return event.parsedText === `(${event.messageType} message)`;
}

async function resolveAttachments(
  event: FeishuChannelMessage,
  options: FormatFeishuMessageOptions,
): Promise<FormattedFeishuAttachment[]> {
  const resources = event.resources ?? [];
  const out: FormattedFeishuAttachment[] = [];
  for (const resource of resources) {
    out.push(await resolveAttachment(event.messageId, resource, options));
  }
  return out;
}

async function resolveAttachment(
  messageId: string,
  resource: InboundResource,
  options: FormatFeishuMessageOptions,
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

  try {
    const cacheRoot = resolve(options.cacheDir);
    const path = attachmentPath(cacheRoot, resource);
    if (await fileExists(path)) return { ...base, status: 'downloaded', path };

    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const response = await options.resourceFetcher.fetchMessageResource({
      messageId,
      fileKey: resource.key,
      type: resource.type,
    });
    const bytes = await readStreamWithLimit(
      response.stream,
      options.maxBytes ?? DEFAULT_MAX_RESOURCE_BYTES,
      options.timeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS,
    );
    const tmpPath = `${path}.tmp-${globalThis.process.pid}-${Date.now()}`;
    try {
      await writeFile(tmpPath, bytes, { mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, path);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
    return { ...base, status: 'downloaded', path };
  } catch (err) {
    return { ...base, reason: reasonFromError(err) };
  }
}

function renderAttachments(
  messageId: string,
  attachments: FormattedFeishuAttachment[],
): string {
  if (attachments.length === 0) return '';
  return attachments.map((attachment) => renderAttachment(messageId, attachment)).join('');
}

function renderAttachment(
  messageId: string,
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

  if (attachment.status === 'downloaded') {
    return `\n\n<attachment ${attrText} />`;
  }

  const key = attachment.key ?? `${attachment.type.toUpperCase()}_KEY`;
  const outputName = attachment.type === 'image'
    ? 'feishu-attachment-image'
    : 'feishu-attachment-file';
  const command = [
    'lark-cli im +messages-resources-download',
    `--message-id ${shellArg(messageId)}`,
    `--file-key ${shellArg(key)}`,
    `--type ${attachment.type}`,
    `--output ./${outputName}`,
  ].join(' ');
  return [
    `\n\n<attachment ${attrText}>`,
    'Use lark-cli to fetch it if needed:',
    escapeXmlText(command),
    '</attachment>',
  ].join('\n');
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

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function readStreamWithLimit(
  stream: Readable,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.destroy(new DownloadTimeoutError());
  }, timeoutMs);

  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        stream.destroy(new DownloadTooLargeError());
        throw new DownloadTooLargeError();
      }
      chunks.push(bytes);
    }
  } catch (err) {
    if (timedOut) throw new DownloadTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return Buffer.concat(chunks, total);
}

function reasonFromError(err: unknown): FeishuAttachmentReason {
  if (err instanceof DownloadTooLargeError) return 'too_large';
  if (err instanceof DownloadTimeoutError) return 'timeout';
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

class DownloadTimeoutError extends Error {
  constructor() {
    super('Feishu resource download timed out');
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

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
