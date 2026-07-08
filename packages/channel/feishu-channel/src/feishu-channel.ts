import type {
  ChannelTarget,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import type {
  CreateBotOptions,
  FeishuBot,
  FeishuCardActionEvent,
  FeishuInboundEvent,
} from './bot.js';
import { createFeishuBot } from './bot.js';
import {
  listChatBots,
  recordBotAdded,
  type PeerBot,
} from './chat-bots-store.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';
import { AsyncMutex } from './lib/mutex.js';
import {
  FEISHU_TOOLS,
  type FeishuMcpListChatBotsInput,
  type FeishuMcpReactInput,
  type FeishuMcpReplyInput,
  type FeishuToolName,
  type FeishuToolResultEnvelope,
} from './feishu-mcp-tools.js';
import {
  handleCardAction as sessionHandleCardAction,
  sendReply as sessionSendReply,
  addReaction as sessionAddReaction,
  sessionHandle,
  type FeishuChannelState,
  type SessionHandle,
} from './feishu-session-ops.js';
import { onMessage as sessionOnMessage } from './feishu-session-inbound.js';

/**
 * Logger shape used throughout the Feishu channel session — pino-style,
 * fields-first, matching the neutral `DreamuxLogger` contract from the host.
 * Re-exported from the barrel so tool authors don't need to reach into the
 * private registry module.
 */
export type ChannelLogger = import('./feishu-mcp-tools.js').ChannelLogger;

export const RECEIVED_REACTION_EMOJI = 'Get';
export const IN_PROGRESS_REACTION_EMOJI = 'OnIt';

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
  log: import('@excitedjs/dreamux-types').DreamuxLogger;
  /** Inject a fake bot (tests). Host wraps its `(row, secret)` seam into this. */
  botFactory?: () => FeishuBot;
}

export interface FeishuInboundSubmitter {
  submitTurn(
    input: InboundTurnInput,
    envelope: FeishuInboundEnvelope,
  ): Promise<import('@excitedjs/dreamux-types').AgentRuntimeTurnResult>;
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
  /**
   * In-memory session state. Exposed to the package-local helpers in
   * `feishu-session-ops.ts` through the session handle; the class keeps the
   * field readonly on the outside via typing (helpers only mutate Maps/Sets).
   */
  readonly state: FeishuChannelState = {
    inboundReactions: new Map(),
    pendingReceivedReactionClears: new Set(),
    messageChats: new Map(),
  };
  private readonly _accessMutex = new AsyncMutex();

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

  /**
   * Build a package-private handle the session helpers operate on. Keeps the
   * class's `private` fields truly private while still letting extracted free
   * functions reach them — structural typing + circular type imports make
   * this cost-free.
   */
  private get handle(): SessionHandle {
    return sessionHandle(
      this.opts,
      this.state,
      this.bot,
      this._accessMutex,
      this.bot.botDisplayName ?? 'Dreamux bot',
    );
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
      onCardAction: async (event) => {
        return this.onCardAction(event);
      },
    });
  }

  async close(): Promise<void> {
    await this.bot.close();
  }

  async handleMcpTool(
    toolName: FeishuToolName,
    rawArguments: unknown,
  ): Promise<Record<string, unknown> | FeishuMcpListChatBotsResult> {
    const def = FEISHU_TOOLS.find((t) => t.name === toolName);
    if (def === undefined) {
      throw new FeishuChannelCapabilityError(toolName);
    }
    const ctx = {
      stateDir: this.opts.stateDir,
      session: {
        logger: this.opts.log as ChannelLogger,
        sendText: async (
          chatId: string,
          text: string,
          opts?: { messageId?: string; mentionUserIds?: string[] },
        ) => this.sendReply({
          chatId,
          text,
          ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
          ...(opts?.mentionUserIds !== undefined
            ? { mentionUserIds: opts.mentionUserIds }
            : {}),
        }),
        react: async (
          chatId: string | undefined,
          messageId: string,
          emoji: string,
        ) => this.addReaction({
          messageId,
          emoji,
          ...(chatId !== undefined ? { chatId } : {}),
        }),
        listKnownChatBots: async (chatId: string) => this.readChatBots({ chatId }),
      },
    };
    let parsed: unknown;
    try {
      parsed = def.parse(rawArguments);
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          tool: toolName,
          err: errInfo(err),
        },
        'feishu MCP tool parse failed',
      );
      throw err;
    }
    let result: FeishuToolResultEnvelope;
    try {
      result = await def.handle(ctx, parsed);
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          tool: toolName,
          err: errInfo(err),
        },
        'feishu MCP tool handler failed',
      );
      throw err;
    }
    // Flatten to the legacy wire shape: return `{ status, message, ...details }`
    // so the existing 3 callers (reply / react / list_chat_bots) can keep
    // reading `message_ids`, `reaction_id`, `{known,trusted}` off the top-level
    // result without a refactor in P1.
    return {
      status: result.status,
      message: result.message,
      ...(result.details ?? {}),
    };
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

  // ── Thin wrappers around extracted helpers (kept for handleMcpTool & start)
  private async sendReply(
    input: FeishuMcpReplyInput,
  ): Promise<{ message_ids: string[] }> {
    const r = await sessionSendReply(this.handle, input);
    return { message_ids: r.messageIds };
  }

  private async addReaction(
    input: FeishuMcpReactInput,
  ): Promise<{ reaction_id: string }> {
    const r = await sessionAddReaction(this.handle, input);
    return { reaction_id: r };
  }

  private async onMessage(
    event: FeishuInboundEvent,
    submitter: FeishuInboundSubmitter,
  ): Promise<void> {
    return sessionOnMessage(this.handle, event, submitter);
  }

  private async onCardAction(
    event: FeishuCardActionEvent,
  ): Promise<unknown> {
    return sessionHandleCardAction(this.handle, event);
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
