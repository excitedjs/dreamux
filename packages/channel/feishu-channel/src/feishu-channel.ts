import { isBotSenderType } from '@excitedjs/feishu-transport';
import type {
  AgentRuntimeTurnResult,
  ChannelTarget,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import type {
  CreateBotOptions,
  FeishuBot,
  FeishuInboundEvent,
} from './bot.js';
import {
  channelOutboundToFeishuTarget,
  createFeishuBot,
} from './bot.js';
import {
  detectIntroduce,
  introduceAckText,
  introduceDenyReason,
  introducedPeers,
} from './introduce.js';
import { formatFeishuMessageForRuntime } from './feishu-message.js';
import {
  clearBaselineIfCurrent,
  listChatBots,
  observeKnownBot,
  pendingBaseline,
  recordBotAdded,
  trustIntroducedBots,
  trustedBotIds,
  type PeerBot,
} from './chat-bots-store.js';
import {
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
} from './feishu-gate.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';
import {
  parseFeishuMcpToolInput,
  type FeishuMcpListChatBotsInput,
  type FeishuMcpReactInput,
  type FeishuMcpReplyInput,
  type FeishuMcpToolName,
} from './feishu-mcp-tools.js';

export const RECEIVED_REACTION_EMOJI = 'Get';
export const IN_PROGRESS_REACTION_EMOJI = 'OnIt';
const MAX_PENDING_RECEIVED_REACTION_CLEARS = 1024;

/**
 * Appended to every delivered inbound's content as a standing guardrail: a
 * channel message must be answered with the channel reply tool, not a plain
 * assistant message. English to match the other model-facing strings in this
 * layer (`FEISHU_SKILL_FALLBACK_NOTE`, the `<group_bots>` note). Placed at the
 * very end of the body the runtime wraps into its `<channel>` block.
 */
const CHANNEL_REMINDER =
  '<channel-reminder>A message from this channel must be answered with the channel reply tool, not a plain assistant message. Acknowledge it with a brief reply through that tool first, then start the work.</channel-reminder>';

type InboundReactionState = 'received' | 'in_progress';

interface InboundReactionLedgerEntry {
  chatId: string;
  reactionId: string;
  state: InboundReactionState;
}

interface FeishuChannelState {
  inboundReactions: Map<string, InboundReactionLedgerEntry>;
  pendingReceivedReactionClears: Set<string>;
  messageChats: Map<string, string>;
}

export interface WireChatBot {
  open_id: string;
  name?: string;
}

export interface FeishuMcpListChatBotsResult {
  chat_id: string;
  known: WireChatBot[];
  trusted: WireChatBot[];
}

export interface FeishuChannelSessionOptions {
  /** The owning dispatcher id — used only for log fields, never for paths. */
  dispatcherId: string;
  /** Feishu bot app id (host resolves it from config). */
  appId: string;
  /** Feishu bot app secret (host resolves it; empty string skips auth in tests). */
  appSecret: string;
  /**
   * The dispatcher's durable state directory. The session derives
   * `access.json` / `chat-bots.json` under it — supplied by the host so the
   * package owns no Dreamux state-layout contract.
   */
  stateDir: string;
  /** The dispatcher's inbound-attachment cache directory (host-supplied). */
  attachmentCacheDir: string;
  /**
   * The host's neutral logger (`DreamuxLogger`, pino-shaped fields-first). It is
   * used as-is by the session and handed straight to the transport — both are
   * pino-compatible, so there is no per-boundary adapter.
   */
  log: DreamuxLogger;
  /** Inject a fake bot (tests). Host wraps its `(row, secret)` seam into this. */
  botFactory?: () => FeishuBot;
}

export interface FeishuInboundSubmitter {
  submitTurn(
    input: InboundTurnInput,
    envelope: FeishuInboundEnvelope,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult>;
}

export interface FeishuInboundEnvelope {
  provider: 'builtin:feishu';
  chatId: string;
  chatType: 'group' | 'p2p';
  messageId: string;
}

export class FeishuChannelCapabilityError extends Error {
  constructor(readonly toolName: string) {
    super(
      `${BUILTIN_FEISHU_PROVIDER_REF} does not expose the ${JSON.stringify(toolName)} MCP tool`,
    );
    this.name = 'FeishuChannelCapabilityError';
  }
}

export class FeishuChannelSession {
  readonly ref = BUILTIN_FEISHU_PROVIDER_REF;
  readonly bot: FeishuBot;
  private readonly state: FeishuChannelState = {
    inboundReactions: new Map(),
    pendingReceivedReactionClears: new Set(),
    messageChats: new Map(),
  };

  constructor(private readonly opts: FeishuChannelSessionOptions) {
    this.bot = opts.botFactory !== undefined
      ? opts.botFactory()
      : createFeishuBot({
          appId: opts.appId,
          appSecret: opts.appSecret,
          // DreamuxLogger is pino-shaped; the transport's `TransportLogger` is
          // the same fields-first shape, so it passes through directly.
          logger: opts.log,
        } satisfies CreateBotOptions);
  }

  async start(submitter: FeishuInboundSubmitter): Promise<void> {
    await this.bot.start({
      onBotMemberAdded: async (added) => {
        await recordBotAdded(
          this.opts.stateDir,
          added.chatId,
          added.eventId,
        );
      },
      onMessage: async (event) => {
        await this.onMessage(event, submitter);
      },
    });
  }

  async close(): Promise<void> {
    await this.bot.close();
  }

  async handleMcpTool(
    toolName: FeishuMcpToolName,
    rawArguments: unknown,
  ): Promise<Record<string, unknown> | FeishuMcpListChatBotsResult> {
    const parsed = parseFeishuMcpToolInput(toolName, rawArguments);
    switch (parsed.toolName) {
      case 'reply':
        return this.sendReply(parsed.input);
      case 'react':
        return this.addReaction(parsed.input);
      case 'list_chat_bots':
        return this.readChatBots(parsed.input);
    }
  }

  messageBelongsToChat(messageId: string, chatId: string): boolean {
    return this.state.messageChats.get(messageId) === chatId;
  }

  /**
   * Provider-owned target resolution (issue #209 binding store v2). Normalizes a
   * Feishu selector `{ chat_id, chat_type }` into a neutral `ChannelTarget` whose
   * `target_key` is the durable routing key core stores and routes by. For Feishu
   * the stable key is the chat id itself; group chats are bindable, P2P chats are
   * not (they always route to the dispatcher). Pure — no platform call.
   */
  resolveTarget(meta: unknown): ChannelTarget {
    const obj = (meta ?? {}) as Record<string, unknown>;
    const chatId = obj['chat_id'];
    if (typeof chatId !== 'string' || chatId === '') {
      throw new Error('feishu resolveTarget requires a non-empty chat_id');
    }
    const type = obj['chat_type'] === 'p2p' ? 'p2p' : 'group';
    return {
      target_type: type,
      target_key: chatId,
      bindable: type === 'group',
      meta: { chat_id: chatId, chat_type: type },
    };
  }

  private async readChatBots(
    input: FeishuMcpListChatBotsInput,
  ): Promise<FeishuMcpListChatBotsResult> {
    const listing = await listChatBots(this.opts.stateDir, input.chatId);
    return {
      chat_id: input.chatId,
      known: listing.known.map(toWireChatBot),
      trusted: listing.trusted.map(toWireChatBot),
    };
  }

  private async sendReply(
    input: FeishuMcpReplyInput,
  ): Promise<{ message_ids: string[] }> {
    let result: { messageIds: string[] };
    try {
      result = await this.bot.send(
        channelOutboundToFeishuTarget({
          conversationId: input.chatId,
          ...(input.messageId !== undefined ? { replyTo: input.messageId } : {}),
          ...(input.mentionUserIds !== undefined
            ? { mentionUsers: input.mentionUserIds }
            : {}),
        }),
        input.text,
      );
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          chat_id: input.chatId,
          message_id: input.messageId,
          err: errInfo(err),
        },
        'feishu reply failed',
      );
      throw err;
    }
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: input.chatId,
        message_id: input.messageId,
        message_ids: result.messageIds,
      },
      'feishu reply sent',
    );
    if (input.messageId !== undefined) {
      await this.clearInboundReaction(input.messageId);
    }
    return { message_ids: result.messageIds };
  }

  private async addReaction(
    input: FeishuMcpReactInput,
  ): Promise<{ reaction_id: string }> {
    let reactionId: string;
    try {
      reactionId = await this.bot.addReaction(input.messageId, input.emoji);
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: input.messageId,
          emoji: input.emoji,
          err: errInfo(err),
        },
        'feishu react failed',
      );
      throw err;
    }
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        message_id: input.messageId,
        emoji: input.emoji,
        reaction_id: reactionId,
      },
      'feishu react sent',
    );
    return { reaction_id: reactionId };
  }

  private async onMessage(
    event: FeishuInboundEvent,
    submitter: FeishuInboundSubmitter,
  ): Promise<void> {
    const access = await loadDispatcherAccess(this.opts.stateDir);

    if (
      event.chatType === 'group' &&
      isBotSenderType(event.senderType) &&
      access.group.allow_chats.includes(event.chatId)
    ) {
      await observeKnownBot(this.opts.stateDir, event.chatId, {
        openId: event.senderId,
        ...(event.senderName !== '' ? { name: event.senderName } : {}),
      });
    }
    if (detectIntroduce(event.messageType, event.rawContent, event.mentions)) {
      const denyReason = introduceDenyReason(access, {
        chatType: event.chatType,
        chatId: event.chatId,
        senderId: event.senderId,
      });
      if (denyReason === null) {
        const peers = introducedPeers(event.mentions, this.bot.botOpenId);
        if (peers.length > 0) {
          await trustIntroducedBots(this.opts.stateDir, event.chatId, peers);
          await this.sendIntroduceAck(event, peers);
        }
        this.opts.log.info(
          {
            chat_id: event.chatId,
            sender_id: event.senderId,
            trusted_peers: peers.length,
          },
          'introduce consumed',
        );
        return;
      }
      this.opts.log.info(
        {
          chat_id: event.chatId,
          sender_id: event.senderId,
          message_id: event.messageId,
          reason: denyReason,
        },
        'introduce detected but not authorized',
      );
    }

    const trustedBots =
      event.chatType === 'group'
        ? await trustedBotIds(this.opts.stateDir, event.chatId)
        : undefined;
    const gate = dreamuxFeishuGate({
      senderId: event.senderId,
      senderType: event.senderType,
      chatId: event.chatId,
      chatType: event.chatType,
      mentions: event.mentions,
      botOpenId: this.bot.botOpenId,
      ...(trustedBots !== undefined ? { trustedBotIds: trustedBots } : {}),
    }, access);
    await saveDispatcherAccess(this.opts.stateDir, gate.access);
    if (gate.warning !== null) {
      this.opts.log.warn(
        { chat_id: event.chatId, warning: gate.warning },
        'trust-domain warning',
      );
    }
    if (gate.action === 'drop') {
      this.opts.log.info(
        {
          chat_id: event.chatId,
          chat_type: event.chatType,
          sender_id: event.senderId,
          ...(event.senderUnionId !== undefined && event.senderUnionId !== ''
            ? { sender_union_id: event.senderUnionId }
            : {}),
          message_id: event.messageId,
          reason: gate.reason,
        },
        'feishu inbound dropped',
      );
      return;
    }
    this.state.messageChats.set(event.messageId, event.chatId);

    const baseline =
      event.chatType === 'group'
        ? await pendingBaseline(this.opts.stateDir, event.chatId)
        : null;
    const injectBots =
      baseline !== null && baseline.needsBaseline && baseline.trusted.length > 0;
    const formatted = await formatFeishuMessageForRuntime(
      event,
      {
        cacheDir: this.opts.attachmentCacheDir,
        resourceFetcher: this.bot,
        ...(injectBots ? { trustedBots: baseline.trusted } : {}),
      },
    );
    // Hand the runtime structured pieces, not pre-rendered XML: each runtime
    // wraps these into its own channel block (today both render the native
    // `<channel source="feishu" …>` envelope). `source`/`attrs` are opaque
    // display passthrough — the runtime never routes on them; reply targeting
    // stays here via the Feishu reply MCP tool. `text` carries the body as a
    // neutral fallback for any runtime that ignores the structured fields.
    // Append the standing channel-reminder on its own line at the very end. It
    // goes into `body` (the field both runtimes render into the `<channel>`
    // block via renderChannelInput) AND the neutral `text` fallback — `text`
    // alone is discarded for channel turns, so the reminder must ride `body` to
    // reach the model.
    const body = `${formatted.body}\n\n${CHANNEL_REMINDER}`;
    const input: InboundTurnInput = {
      sourceId: event.messageId,
      source: 'feishu',
      text: body,
      attrs: formatted.attrs,
      body,
      attachments: formatted.attachments.map((attachment) => ({
        kind: attachment.type,
        ...(attachment.name !== undefined ? { name: attachment.name } : {}),
        ...(attachment.path !== undefined ? { localPath: attachment.path } : {}),
      })),
    };
    const envelope: FeishuInboundEnvelope = {
      provider: BUILTIN_FEISHU_PROVIDER_REF,
      chatId: event.chatId,
      chatType: event.chatType === 'group' ? 'group' : 'p2p',
      messageId: event.messageId,
    };
    const delivery = await submitter.submitTurn(
      input,
      envelope,
      {
        onAccepted: async () => {
          await this.setInboundReaction(
            event.messageId,
            event.chatId,
            RECEIVED_REACTION_EMOJI,
            'received',
          );
        },
      },
    );
    if (delivery.status === 'submitted') {
      this.opts.log.info(
        {
          chat_id: event.chatId,
          sender_id: event.senderId,
          message_id: event.messageId,
        },
        'feishu inbound submitted',
      );
      if (injectBots) {
        await clearBaselineIfCurrent(
          this.opts.stateDir,
          event.chatId,
          baseline.generation,
        );
      }
      await this.setInboundReaction(
        event.messageId,
        event.chatId,
        IN_PROGRESS_REACTION_EMOJI,
        'in_progress',
      );
    } else if (delivery.status === 'failed') {
      this.opts.log.error(
        {
          chat_id: event.chatId,
          message_id: event.messageId,
          err: errInfo(delivery.error),
        },
        'failed to submit feishu inbound',
      );
    }
  }

  private async sendIntroduceAck(
    event: FeishuInboundEvent,
    peers: PeerBot[],
  ): Promise<void> {
    const text = introduceAckText(peers);
    if (text === null) return;
    let result: { messageIds: string[] };
    try {
      result = await this.bot.send(
        channelOutboundToFeishuTarget({ conversationId: event.chatId }),
        text,
      );
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          chat_id: event.chatId,
          message_id: event.messageId,
          peer_count: peers.length,
          err: errInfo(err),
        },
        'introduce ack failed',
      );
      return;
    }
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: event.chatId,
        message_id: event.messageId,
        peer_count: peers.length,
        message_ids: result.messageIds,
      },
      'introduce ack sent',
    );
  }

  private async setInboundReaction(
    messageId: string,
    chatId: string,
    emoji: string,
    state: InboundReactionState,
  ): Promise<void> {
    if (messageId === '') return;
    if (this.state.pendingReceivedReactionClears.has(messageId)) return;

    const previous = this.state.inboundReactions.get(messageId);
    let reactionId: string;
    try {
      reactionId = await this.bot.addReaction(messageId, emoji);
    } catch (err) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: messageId,
          err: errInfo(err),
        },
        `failed to add the ${state} reaction`,
      );
      return;
    }
    if (reactionId === '') {
      this.opts.log.warn(
        { dispatcher_id: this.opts.dispatcherId, message_id: messageId },
        `Feishu returned no reaction_id for the ${state} reaction`,
      );
      return;
    }

    if (this.state.pendingReceivedReactionClears.has(messageId)) {
      try {
        await this.bot.removeReaction(messageId, reactionId);
      } catch (err) {
        this.opts.log.warn(
          {
            dispatcher_id: this.opts.dispatcherId,
            message_id: messageId,
            err: errInfo(err),
          },
          `failed to clear the late ${state} reaction`,
        );
      }
      return;
    }

    this.state.inboundReactions.set(messageId, {
      chatId,
      reactionId,
      state,
    });

    if (previous !== undefined) {
      try {
        await this.bot.removeReaction(messageId, previous.reactionId);
      } catch (err) {
        this.opts.log.warn(
          {
            dispatcher_id: this.opts.dispatcherId,
            message_id: messageId,
            err: errInfo(err),
          },
          `failed to replace the ${previous.state} reaction`,
        );
      }
    }
  }

  private async clearInboundReaction(messageId: string): Promise<void> {
    this.rememberPendingReceivedReactionClear(messageId);
    const reaction = this.state.inboundReactions.get(messageId);
    if (reaction === undefined) return;
    try {
      await this.bot.removeReaction(messageId, reaction.reactionId);
      this.state.inboundReactions.delete(messageId);
    } catch (err) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: messageId,
          err: errInfo(err),
        },
        `failed to clear the ${reaction.state} reaction`,
      );
    }
  }

  private rememberPendingReceivedReactionClear(messageId: string): void {
    this.state.pendingReceivedReactionClears.add(messageId);
    while (
      this.state.pendingReceivedReactionClears.size >
      MAX_PENDING_RECEIVED_REACTION_CLEARS
    ) {
      const oldest = this.state.pendingReceivedReactionClears.values().next().value;
      if (typeof oldest !== 'string') return;
      this.state.pendingReceivedReactionClears.delete(oldest);
    }
  }
}

/**
 * Map a peer bot to the `list_chat_bots` wire shape. Exported so the core-owned
 * `handleFeishuListChatBots` host helper (which resolves a dispatcher id to a
 * state dir) can reuse it without re-implementing the projection.
 */
export function toWireChatBot(bot: PeerBot): WireChatBot {
  return {
    open_id: bot.openId,
    ...(bot.name !== undefined && bot.name !== '' ? { name: bot.name } : {}),
  };
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
