import { isBotSenderType } from '@excitedjs/feishu-transport';

import type { InboundDeliveryHooks } from '../../agent-runtime/turn.js';
import type { InboundTurnInput } from '../../agent-runtime/turn.js';
import type { AgentRuntimeTurnResult } from '../../agent-runtime/types.js';
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
import type { AgentRuntimeMcpServer } from '../../agent-runtime/types.js';
import {
  BUILTIN_FEISHU_PROVIDER_REF,
  type DreamuxConfig,
} from '../../config/config.js';
import type { DispatcherRow } from '../../state/dispatcher-store.js';
import {
  dispatcherFeishuAttachmentCacheDir,
} from '../../platform/paths.js';
import {
  feishuMcpServerDescriptor,
  parseFeishuMcpToolInput,
  type FeishuMcpListChatBotsInput,
  type FeishuMcpReactInput,
  type FeishuMcpReplyInput,
  type FeishuMcpToolName,
} from './feishu-mcp-surface.js';
import type { DreamuxLogger } from '../../platform/logger.js';
import { pinoToTransportLogger } from '../../platform/logger.js';
import { resolveBotSecret } from '../../platform/secrets.js';

export const RECEIVED_REACTION_EMOJI = 'Get';
export const IN_PROGRESS_REACTION_EMOJI = 'OnIt';
const MAX_PENDING_RECEIVED_REACTION_CLEARS = 1024;

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
  dispatcherId: string;
  row: DispatcherRow;
  config: DreamuxConfig;
  adminSocketPath: string;
  log: DreamuxLogger;
  botFactory?: (row: DispatcherRow, secret: string) => FeishuBot;
  skipBotSecret?: boolean;
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
    const secret = opts.skipBotSecret === true
      ? ''
      : resolveBotSecret(opts.row.bot_secret_ref, opts.config);
    this.bot = opts.botFactory !== undefined
      ? opts.botFactory(opts.row, secret)
      : createFeishuBot({
          appId: opts.row.bot_app_id,
          appSecret: secret,
          logger: pinoToTransportLogger(opts.log),
        } satisfies CreateBotOptions);
  }

  mcpServerDescriptors(): AgentRuntimeMcpServer[] {
    return [
      feishuMcpServerDescriptor({
        dispatcherId: this.opts.dispatcherId,
        adminSocketPath: this.opts.adminSocketPath,
      }),
    ];
  }

  async start(submitter: FeishuInboundSubmitter): Promise<void> {
    await this.bot.start({
      onBotMemberAdded: async (added) => {
        await recordBotAdded(
          this.opts.dispatcherId,
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

  private async readChatBots(
    input: FeishuMcpListChatBotsInput,
  ): Promise<FeishuMcpListChatBotsResult> {
    const listing = await listChatBots(this.opts.dispatcherId, input.chatId);
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
    const access = await loadDispatcherAccess(this.opts.dispatcherId);

    if (
      event.chatType === 'group' &&
      isBotSenderType(event.senderType) &&
      access.group.allow_chats.includes(event.chatId)
    ) {
      await observeKnownBot(this.opts.dispatcherId, event.chatId, {
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
          await trustIntroducedBots(this.opts.dispatcherId, event.chatId, peers);
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
        ? await trustedBotIds(this.opts.dispatcherId, event.chatId)
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
    await saveDispatcherAccess(this.opts.dispatcherId, gate.access);
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
        ? await pendingBaseline(this.opts.dispatcherId, event.chatId)
        : null;
    const injectBots =
      baseline !== null && baseline.needsBaseline && baseline.trusted.length > 0;
    const formatted = await formatFeishuMessageForRuntime(
      event,
      {
        cacheDir: dispatcherFeishuAttachmentCacheDir(this.opts.dispatcherId),
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
    const input: InboundTurnInput = {
      sourceId: event.messageId,
      source: 'feishu',
      text: formatted.body,
      attrs: formatted.attrs,
      body: formatted.body,
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
          this.opts.dispatcherId,
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

export async function handleFeishuListChatBots(
  dispatcherId: string,
  rawArguments: unknown,
): Promise<FeishuMcpListChatBotsResult> {
  const parsed = parseFeishuMcpToolInput('list_chat_bots', rawArguments);
  if (parsed.toolName !== 'list_chat_bots') {
    throw new FeishuChannelCapabilityError(parsed.toolName);
  }
  const listing = await listChatBots(dispatcherId, parsed.input.chatId);
  return {
    chat_id: parsed.input.chatId,
    known: listing.known.map(toWireChatBot),
    trusted: listing.trusted.map(toWireChatBot),
  };
}

function toWireChatBot(bot: PeerBot): WireChatBot {
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
