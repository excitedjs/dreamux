/**
 * Core-owned adapter for the built-in Feishu channel (issue #209 slice 5).
 *
 * The Feishu channel session — platform I/O, access/trust, inbound
 * normalization, attachment handling, and MCP tool backing — now lives in the
 * published `@excitedjs/feishu-channel` package, which depends on
 * `@excitedjs/dreamux-types` + `@excitedjs/feishu-transport` only. Core keeps the
 * host contracts the package must not reconstruct: the bot-secret resolution,
 * the per-dispatcher state dir (`access.json` / `chat-bots.json`) and the
 * attachment cache dir, and the `dispatcher id -> chat-bots state` listing
 * helper. Routing, binding, authorization, Team lifecycle, and the Feishu MCP
 * server descriptor / admin routing stay core-owned (here and in
 * `feishu-mcp-surface.ts`).
 */
import {
  FeishuChannelSession,
  FeishuChannelCapabilityError,
  listChatBots,
  parseFeishuMcpToolInput,
  toWireChatBot,
  type FeishuBot,
  type FeishuMcpListChatBotsResult,
} from '@excitedjs/feishu-channel';
import type { DispatcherRow } from '../../state/dispatcher-store.js';
import type { DreamuxConfig } from '../../config/config.js';
import { resolveBotSecret } from '../../platform/secrets.js';
import {
  dispatcherDir,
  dispatcherFeishuAttachmentCacheDir,
} from '../../platform/paths.js';
import type { DreamuxLogger } from '../../platform/logger.js';

export {
  FeishuChannelSession,
  FeishuChannelCapabilityError,
  RECEIVED_REACTION_EMOJI,
  IN_PROGRESS_REACTION_EMOJI,
} from '@excitedjs/feishu-channel';
export type {
  FeishuInboundEnvelope,
  FeishuInboundSubmitter,
  FeishuMcpListChatBotsResult,
  WireChatBot,
  FeishuChannelSessionOptions,
} from '@excitedjs/feishu-channel';

/** Host-shaped options the dispatcher service constructs a Feishu session with. */
export interface CreateFeishuChannelSessionHostOptions {
  dispatcherId: string;
  row: DispatcherRow;
  config: DreamuxConfig;
  /** Per-dispatcher channel logger (pino; fields-first, satisfies the package logger). */
  log: DreamuxLogger;
  botFactory?: (row: DispatcherRow, secret: string) => FeishuBot;
  skipBotSecret?: boolean;
  /**
   * Per-channel bot identity (issue #209 live multi-channel routing). When set,
   * the session connects as THIS channel's bot instead of the dispatcher row's
   * single bot, so a dispatcher can run one session per configured Feishu
   * channel. Omitted for the legacy single-channel path, where the row's
   * `bot_app_id` / `bot_secret_ref` (which the sole channel seeds) is identical.
   */
  channel?: { appId: string; appSecret: string };
}

/**
 * Construct the package Feishu session from host inputs: resolve the bot secret
 * + app id from the per-channel config (live multi-channel) or the dispatcher
 * row/config (legacy single-channel), and supply the host state/cache dirs. The
 * `(row, secret)` bot-factory test seam is wrapped into the package's neutral
 * `() => FeishuBot` factory. State and attachment-cache dirs stay per-dispatcher
 * (one trust/access policy per dispatcher), shared across its channels.
 */
export function createFeishuChannelSession(
  opts: CreateFeishuChannelSessionHostOptions,
): FeishuChannelSession {
  const appId = opts.channel?.appId ?? opts.row.bot_app_id;
  const secret =
    opts.skipBotSecret === true
      ? ''
      : (opts.channel?.appSecret ??
        resolveBotSecret(opts.row.bot_secret_ref, opts.config));
  return new FeishuChannelSession({
    dispatcherId: opts.dispatcherId,
    appId,
    appSecret: secret,
    stateDir: dispatcherDir(opts.dispatcherId),
    attachmentCacheDir: dispatcherFeishuAttachmentCacheDir(opts.dispatcherId),
    log: opts.log,
    ...(opts.botFactory !== undefined
      ? { botFactory: (): FeishuBot => opts.botFactory!(opts.row, secret) }
      : {}),
  });
}

/**
 * Sessionless `list_chat_bots` host helper (the dispatcher-level admin path that
 * has no live session). Resolves the dispatcher's state dir, then reuses the
 * package's chat-bots store + wire projection.
 */
export async function handleFeishuListChatBots(
  dispatcherId: string,
  rawArguments: unknown,
): Promise<FeishuMcpListChatBotsResult> {
  const parsed = parseFeishuMcpToolInput('list_chat_bots', rawArguments);
  if (parsed.toolName !== 'list_chat_bots') {
    throw new FeishuChannelCapabilityError(parsed.toolName);
  }
  const listing = await listChatBots(dispatcherDir(dispatcherId), parsed.input.chatId);
  return {
    chat_id: parsed.input.chatId,
    known: listing.known.map(toWireChatBot),
    trusted: listing.trusted.map(toWireChatBot),
  };
}
