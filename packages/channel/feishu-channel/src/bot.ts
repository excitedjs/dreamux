/**
 * The `FeishuBot` adapter — one per Dispatcher (D3: 1 Dispatcher = 1 Bot).
 *
 * Since issue #25 PR1 this is a thin adapter over `@excitedjs/feishu-transport`
 * (the shared platform-I/O core): all Feishu SDK I/O — the inbound WebSocket,
 * markdown→card render, content parse, the outbound message API — lives in the
 * core, the single importer of `@larksuiteoapi/node-sdk`. This file only shapes
 * the core's surface into the `FeishuBot` interface the server already wires:
 *   - `start(routes)` takes one handler per Feishu event type (issue #62 seam):
 *     `onMessage` for `im.message.receive_v1` (normalized via the core's
 *     `parseInbound` into a `FeishuInboundEvent`) and an optional
 *     `onBotMemberAdded` for `im.chat.member.bot.added_v1`. Each route awaits
 *     its handler, so the server gates and submits accepted inbound before the
 *     SDK acks.
 *   - `send(target, text)` delegates to the core transport, preserving reply
 *     threading / @-back metadata from the in-memory inbound batch.
 *   - `botOpenId` / `botDisplayName` surface the core transport's bot-info
 *     fields, resolved from `/open-apis/bot/v3/info` during startup.
 *
 * Tests supply package-local `FeishuBot` doubles through the provider's
 * `botFactory` seam instead of opening a live connection.
 */

import {
  BOT_MEMBER_ADDED_EVENT_TYPE,
  createFeishuTransport,
  narrowMetaFromEvent,
  normalizeBotMemberAddedEvent,
  parseInbound,
  toChannelInbound,
  type FeishuBotMemberAddedEvent,
  type FeishuMessageResourceFetcher,
  type FeishuMessageResourceRequest,
  type FeishuMessageResourceResponse,
  type FeishuMessageReadRequest,
  type FeishuMessageReadResponse,
  type FeishuAppOwnerIdentity,
  type FeishuChatMode,
  type FeishuTransport,
  type FeishuUserNameEntry,
  type FeishuUserNameLookupOptions,
  type InboundContentPart,
  type InboundResource,
  type Mention,
  type OutboundTarget,
  type TransportLogger,
} from '@excitedjs/feishu-transport';
import type {
  FeishuInviteMembersInput,
  FeishuInviteMembersResult,
} from '@excitedjs/feishu-transport';
export type {
  FeishuInviteMembersInput,
  FeishuInviteMembersResult,
} from '@excitedjs/feishu-transport';

/** The Feishu event_type carrying inbound chat messages. */
const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1';

export interface FeishuInboundEvent {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group' | ...
  /** Stable Feishu topic identity when the event belongs to a thread/topic. */
  threadId?: string;
  /** Diagnostic reply ancestry; never used as a topic identity fallback. */
  rootId?: string;
  parentId?: string;
  /** Post-gate, best-effort type of the actionable reply/quote parent. */
  parentMessageType?: string;
  senderId: string;
  /**
   * The sender's `union_id`, when Feishu provides it. Diagnostic only — it is
   * surfaced in inbound-drop logs to help tell "same bot, different app-scoped
   * open_id" apart from "different entity", and is never used for access
   * gating. Absent when Feishu omits it.
   */
  senderUnionId?: string;
  senderType: string;
  /**
   * Best-effort event display name. Feishu normally omits it, so the accepted
   * inbound path may later enrich an empty value through the transport seam.
   */
  senderName: string;
  messageType: string;
  /** Raw JSON-encoded content as Feishu delivered it. */
  rawContent: string;
  /** Parsed text after the core's content flattening / mention substitution. */
  parsedText: string;
  /** Untrusted visible content in Feishu source order. */
  contentParts?: InboundContentPart[];
  /** Structured Feishu resources discovered in the message content. */
  resources?: InboundResource[];
  /** The local projection omitted or could not resolve visible content. */
  contentIncomplete?: boolean;
  mentions: Mention[];
  createTime: string;
  /** The full original Feishu event payload (for storage / audit). */
  raw: unknown;
}

export type InboundHandler = (event: FeishuInboundEvent) => void | Promise<void>;

export type BotMemberAddedHandler = (
  event: FeishuBotMemberAddedEvent,
) => void | Promise<void>;

export interface FeishuCardActionEvent {
  operatorOpenId?: string;
  actionValue: Record<string, unknown>;
  openChatId?: string;
  openMessageId?: string;
  raw: unknown;
}

export type CardActionHandler = (
  event: FeishuCardActionEvent,
) => unknown | Promise<unknown>;

/**
 * The typed event-route seam (issue #62 Phase 1). `start` takes one handler per
 * Feishu event type instead of a single message handler, so a new event type is
 * wired by adding a field here and a transport route, without growing branches
 * in `Server`. This is a small typed seam, not yet a generic
 * `eventType -> handler` registry; if a third event type lands, promote this to
 * a map. Each route still awaits its handler before the SDK acks
 * (queue-before-ACK).
 */
export interface FeishuInboundRoutes {
  /** `im.message.receive_v1` — a chat message. */
  onMessage: InboundHandler;
  /** `im.chat.member.bot.added_v1` — the bot was added to a chat. Optional. */
  onBotMemberAdded?: BotMemberAddedHandler;
  /** `card.action.trigger` — the user clicked an interactive card component. */
  onCardAction?: CardActionHandler;
}

export interface FeishuSendResult {
  /** message_id of each card sent, in order. Empty if Feishu omitted ids. */
  messageIds: string[];
}

export interface FeishuBot extends FeishuMessageResourceFetcher {
  readonly appId: string;
  readonly botOpenId: string | undefined;
  readonly botDisplayName: string | undefined;
  start(routes: FeishuInboundRoutes): Promise<void>;
  send(target: OutboundTarget, text: string): Promise<FeishuSendResult>;
  sendCard(target: OutboundTarget, card: unknown): Promise<FeishuSendResult>;
  inviteMembers(input: FeishuInviteMembersInput): Promise<FeishuInviteMembersResult>;
  /** Optional for externally supplied bots; absence disables topic projection. */
  getChatMode?(chatId: string): Promise<FeishuChatMode | undefined>;
  addReaction(messageId: string, emoji: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  fetchMessageResource(
    request: FeishuMessageResourceRequest,
  ): Promise<FeishuMessageResourceResponse>;
  /** Optional for externally supplied bots; absence keeps event-only content. */
  readMessage?(
    request: FeishuMessageReadRequest,
  ): Promise<FeishuMessageReadResponse>;
  /** Optional cache seed for accepted mention names. */
  observeUserNames?(entries: FeishuUserNameEntry[]): void;
  /** Optional contact lookup for an accepted human sender. */
  resolveUserName?(
    openId: string,
    options?: FeishuUserNameLookupOptions,
  ): Promise<string | undefined>;
  resolveAppOwner(): Promise<FeishuAppOwnerIdentity>;
  close(): Promise<void>;
}

export interface CreateBotOptions {
  appId: string;
  appSecret: string;
  /**
   * Structured logger for the underlying transport's own diagnostics (Lark SDK
   * logging, WebSocket connection lifecycle, best-effort fetch/close failures).
   * Forwarded verbatim to `createFeishuTransport`. Omit to keep the transport's
   * historical stderr behavior. The server injects the dispatcher's
   * per-dispatcher channel logger here so connection/SDK lines land in
   * `logs/channel/<id>.log` alongside the host's own channel decisions.
   */
  logger?: TransportLogger;
}

export interface CreateFeishuBotDeps {
  createTransport?: (opts: CreateBotOptions) => FeishuTransport;
}

export interface ChannelOutboundTarget {
  /** Stable channel-local conversation id. */
  conversationId: string;
  /** Optional channel-local source message to thread under. */
  replyTo?: string;
  /** Optional channel-local participants to bring into the reply. */
  mentionUsers?: string[];
  /** Optional host/runtime routing hint, opaque to the channel adapter. */
  conversationKey?: string;
}

export function createFeishuBot(
  opts: CreateBotOptions,
  deps: CreateFeishuBotDeps = {},
): FeishuBot {
  const transport = deps.createTransport?.(opts) ??
    createFeishuTransport(
      {
        appId: opts.appId,
        appSecret: opts.appSecret,
      },
      // Forward the host's logger so the transport's own SDK / connection
      // diagnostics fold into the per-dispatcher channel log. `undefined` keeps
      // the transport's default stderr behavior, so always passing the option
      // object is safe and keeps the real wiring path explicit.
      { logger: opts.logger },
    );

  return {
    get appId(): string {
      return transport.appId;
    },
    get botOpenId(): string | undefined {
      return transport.selfId;
    },
    get botDisplayName(): string | undefined {
      return transport.selfName;
    },

    async start(routes: FeishuInboundRoutes): Promise<void> {
      // The core opens the WebSocket and awaits each route handler before the
      // SDK acks; awaiting here keeps gate/submission work before ACK.
      // `start` rejects if the connection does not come up, so the server's
      // try/catch can fail the dispatcher loudly rather than leave it dark.
      const table: Record<string, (raw: unknown) => Promise<unknown>> = {
        [IM_MESSAGE_EVENT_TYPE]: async (raw: unknown) => {
          const event = normalizeInboundEvent(raw);
          if (event === null) return;
          await routes.onMessage(event);
        },
      };
      if (routes.onBotMemberAdded !== undefined) {
        const onBotMemberAdded = routes.onBotMemberAdded;
        table[BOT_MEMBER_ADDED_EVENT_TYPE] = async (raw: unknown) => {
          const event = normalizeBotMemberAddedEvent(raw);
          if (event === null) return;
          await onBotMemberAdded(event);
        };
      }
      if (routes.onCardAction !== undefined) {
        const onCardAction = routes.onCardAction;
        table['card.action.trigger'] = async (raw: unknown) =>
          normalizeCardActionAck(
            await onCardAction(normalizeCardActionEvent(raw)),
            opts.logger,
          );
      }
      await transport.start(table);
    },

    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      const { messageIds } = await transport.send(target, text);
      return { messageIds };
    },

    async sendCard(target: OutboundTarget, card: unknown): Promise<FeishuSendResult> {
      const { messageIds } = await transport.sendCard(target, card);
      return { messageIds };
    },

    inviteMembers(input: FeishuInviteMembersInput): Promise<FeishuInviteMembersResult> {
      return transport.inviteMembers(input);
    },

    getChatMode(chatId: string): Promise<FeishuChatMode | undefined> {
      return transport.getChatMode?.(chatId) ?? Promise.resolve(undefined);
    },

    addReaction(messageId: string, emoji: string): Promise<string> {
      return transport.addReaction(messageId, emoji);
    },

    removeReaction(messageId: string, reactionId: string): Promise<void> {
      return transport.removeReaction(messageId, reactionId);
    },

    fetchMessageResource(
      request: FeishuMessageResourceRequest,
    ): Promise<FeishuMessageResourceResponse> {
      return transport.fetchMessageResource(request);
    },

    ...(transport.readMessage !== undefined
      ? {
          readMessage(
            request: FeishuMessageReadRequest,
          ): Promise<FeishuMessageReadResponse> {
            return transport.readMessage?.(request) ?? Promise.resolve({ items: [] });
          },
        }
      : {}),

    ...(transport.observeUserNames !== undefined
      ? {
          observeUserNames(entries: FeishuUserNameEntry[]): void {
            transport.observeUserNames?.(entries);
          },
        }
      : {}),

    ...(transport.resolveUserName !== undefined
      ? {
          resolveUserName(
            openId: string,
            options?: FeishuUserNameLookupOptions,
          ): Promise<string | undefined> {
            return transport.resolveUserName?.(openId, options) ??
              Promise.resolve(undefined);
          },
        }
      : {}),

    resolveAppOwner(): Promise<FeishuAppOwnerIdentity> {
      return transport.resolveAppOwner();
    },

    close(): Promise<void> {
      return transport.close();
    },
  };
}

export function channelOutboundToFeishuTarget(
  target: ChannelOutboundTarget,
): OutboundTarget {
  return {
    chatId: target.conversationId,
    ...(target.replyTo !== undefined
      ? { replyToMessageId: target.replyTo }
      : {}),
    ...(target.mentionUsers !== undefined
      ? { mentionUserIds: target.mentionUsers }
      : {}),
    ...(target.conversationKey !== undefined
      ? { conversationKey: target.conversationKey }
      : {}),
  };
}

/**
 * Reshape a raw `im.message.receive_v1` payload into a `FeishuInboundEvent`,
 * using the core's `parseInbound` + `narrowMetaFromEvent` + `toChannelInbound`
 * for content flattening and event-envelope metadata. Returns `null` for a
 * payload missing the message_id or chat_id that make it routable.
 */
function normalizeInboundEvent(raw: unknown): FeishuInboundEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const event = (root['event'] ?? root) as Record<string, unknown>;
  const message = (event['message'] ?? {}) as Record<string, unknown>;
  const messageType = (message['message_type'] as string) ?? '';
  const rawContent = (message['content'] as string) ?? '';
  const mentions = (message['mentions'] as Mention[] | undefined) ?? [];
  const parsed = parseInbound({
    message_type: messageType,
    content: rawContent,
    mentions,
  });
  const payload = toChannelInbound({
    ...parsed,
    meta: narrowMetaFromEvent(raw),
  });
  const messageId = payload.meta['message_id'] ?? '';
  const chatId = payload.meta['chat_id'] ?? '';
  const chatType = payload.meta['chat_type'] ?? '';
  const threadId = payload.meta['thread_id'] ?? '';
  const rootId = payload.meta['root_id'] ?? '';
  const parentId = payload.meta['parent_id'] ?? '';
  const senderId = payload.meta['sender_id'] ?? '';
  const senderUnionId = payload.meta['sender_union_id'] ?? '';
  const senderType = payload.meta['sender_type'] ?? '';
  const createTime = payload.meta['create_time'] ?? '';
  const senderName = extractSenderName(raw);

  if (messageId === '' || chatId === '') return null;

  return {
    messageId,
    chatId,
    chatType,
    ...(threadId !== '' ? { threadId } : {}),
    ...(rootId !== '' ? { rootId } : {}),
    ...(parentId !== '' ? { parentId } : {}),
    senderId,
    ...(senderUnionId !== '' ? { senderUnionId } : {}),
    senderType,
    senderName,
    messageType,
    rawContent,
    parsedText: payload.text,
    ...(parsed.parts !== undefined ? { contentParts: parsed.parts } : {}),
    resources: parsed.resources ?? [],
    ...(parsed.incomplete === true ? { contentIncomplete: true } : {}),
    mentions,
    createTime,
    raw,
  };
}

function normalizeCardActionEvent(raw: unknown): FeishuCardActionEvent {
  const root = asRecord(raw) ?? {};
  const event = asRecord(root['event']) ?? root;
  const operator = asRecord(root['operator']) ?? asRecord(event['operator']);
  const action =
    asRecord(root['action']) ??
    asRecord(event['action']) ??
    asRecord(root['card_action']) ??
    asRecord(event['card_action']);
  const context = asRecord(root['context']) ?? asRecord(event['context']) ?? root;
  const actionValue = asRecord(action?.['value']) ?? {};
  const operatorOpenId = firstString(operator?.['open_id'], operator?.['openId']);
  const openChatId = firstString(
    context['open_chat_id'],
    context['openChatId'],
    root['open_chat_id'],
    event['open_chat_id'],
  );
  const openMessageId = firstString(
    context['open_message_id'],
    context['openMessageId'],
    root['open_message_id'],
    event['open_message_id'],
  );
  return {
    ...(operatorOpenId !== '' ? { operatorOpenId } : {}),
    actionValue,
    ...(openChatId !== '' ? { openChatId } : {}),
    ...(openMessageId !== '' ? { openMessageId } : {}),
    raw,
  };
}

function extractSenderName(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const root = raw as Record<string, unknown>;
  const event = asRecord(root['event']) ?? root;
  const sender = asRecord(event['sender']);
  if (sender === undefined) return '';
  return firstString(
    sender['sender_name'],
    sender['display_name'],
    sender['name'],
    sender['user_name'],
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const FEISHU_CARD_TOP_LEVEL_KEYS = new Set([
  'schema',
  'config',
  'card_link',
  'header',
  'i18n_header',
  'elements',
  'i18n_elements',
  'fallback',
  'body',
]);

function normalizeCardActionAck(
  value: unknown,
  logger: TransportLogger | undefined,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const root = asRecord(value);
  if (root === undefined) {
    return invalidCardActionAck(logger, { reason: 'non_object' });
  }
  const allowed = new Set(['toast', 'card']);
  const unknownTopLevel = Object.keys(root).filter((key) => !allowed.has(key));
  const toast = parseCardActionToast(root['toast']);
  if (root['toast'] !== undefined && toast === null) {
    return invalidCardActionAck(logger, { reason: 'invalid_toast', unknownTopLevel });
  }
  const card = parseCardActionCard(root['card'], logger);
  if (root['card'] !== undefined && card === null) {
    return invalidCardActionAck(logger, { reason: 'invalid_card', unknownTopLevel });
  }
  if (unknownTopLevel.length > 0) {
    logger?.warn(
      { unknown_keys: unknownTopLevel },
      'feishu card action response ignored unknown top-level keys',
    );
  }
  return {
    ...(toast !== undefined ? { toast } : {}),
    ...(card !== undefined ? { card } : {}),
  };
}

function parseCardActionToast(value: unknown):
  | { type: 'info' | 'success' | 'error' | 'warning'; content: string }
  | undefined
  | null {
  if (value === undefined) return undefined;
  const toast = asRecord(value);
  if (toast === undefined) return null;
  const type = toast['type'];
  const content = toast['content'];
  if (
    (type !== 'info' && type !== 'success' && type !== 'error' && type !== 'warning') ||
    typeof content !== 'string'
  ) {
    return null;
  }
  return { type, content };
}

function parseCardActionCard(
  value: unknown,
  logger: TransportLogger | undefined,
): { type: 'raw'; data: Record<string, unknown> } | undefined | null {
  if (value === undefined) return undefined;
  const card = asRecord(value);
  if (card === undefined || card['type'] !== 'raw') return null;
  const data = asRecord(card['data']);
  if (data === undefined) return null;
  const unknownDataKeys = Object.keys(data).filter(
    (key) => !FEISHU_CARD_TOP_LEVEL_KEYS.has(key),
  );
  if (unknownDataKeys.length > 0) {
    logger?.warn(
      { unknown_keys: unknownDataKeys },
      'feishu raw card action response stripped unknown card data keys',
    );
  }
  return {
    type: 'raw',
    data: Object.fromEntries(
      Object.entries(data).filter(([key]) => FEISHU_CARD_TOP_LEVEL_KEYS.has(key)),
    ),
  };
}

function invalidCardActionAck(
  logger: TransportLogger | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  logger?.warn(fields, 'invalid feishu card action response');
  return {
    toast: {
      type: 'error',
      content: '卡片回调响应格式错误',
    },
  };
}
