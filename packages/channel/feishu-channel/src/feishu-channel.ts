import type {
  ChannelContainer,
  ChannelCoreEventSource,
  ChannelCoreEventSubscription,
  ChannelBindingCollaborationSpaceEvent,
  ChannelBindingRouteEvent,
  ChannelTarget,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import type {
  CreateBotOptions,
  FeishuBot,
  FeishuCardActionEvent,
} from './bot.js';
import {
  channelOutboundToFeishuTarget,
  createFeishuBot,
} from './bot.js';
import {
  listChatBots,
  recordBotAdded,
  type PeerBot,
} from './chat-bots-store.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';
import { AsyncMutex } from './lib/mutex.js';
import {
  alwaysActiveSessionFence,
  type FeishuSessionFence,
} from './feishu-inbound-work.js';
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
import { FeishuTargetRouter } from './feishu-target-router.js';
import {
  collaborationSpaceNotification,
  routeBindingNotification,
} from './feishu-binding-notification-card.js';

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
  readonly coreEvents?: ChannelCoreEventSource;
  submitTurn(
    input: InboundTurnInput,
    envelope: FeishuInboundEnvelope,
  ): Promise<import('@excitedjs/dreamux-types').AgentRuntimeTurnResult>;
}

export interface FeishuInboundEnvelope {
  provider: 'builtin:feishu';
  /** Retained for compatibility with the pre-topic public submitter contract. */
  chatId: string;
  chatType: 'group' | 'p2p';
  /** Production sessions always supply the provider-normalized target. */
  target?: ChannelTarget;
  container?: ChannelContainer;
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

interface FeishuSessionLifecycle {
  controller: AbortController;
  fence: FeishuSessionFence;
  inFlight: Set<Promise<unknown>>;
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
  };
  private readonly targetRouter: FeishuTargetRouter;
  private readonly _accessMutex = new AsyncMutex();
  private readonly inactiveFence = alwaysActiveSessionFence();
  private lifecycle: FeishuSessionLifecycle | undefined;
  private readonly coreEventSubscriptions: ChannelCoreEventSubscription[] = [];
  private bindingNotificationQueue: Promise<void> = Promise.resolve();

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
    this.targetRouter = new FeishuTargetRouter({
      chatModes: this.bot,
      log: opts.log,
    });
  }

  /**
   * Build a package-private handle the session helpers operate on. Keeps the
   * class's `private` fields truly private while still letting extracted free
   * functions reach them — structural typing + circular type imports make
   * this cost-free.
   */
  private get handle(): SessionHandle {
    return this.handleForFence(this.lifecycle?.fence ?? this.inactiveFence);
  }

  private handleForFence(fence: FeishuSessionFence): SessionHandle {
    return sessionHandle(
      this.opts,
      this.state,
      this.bot,
      this._accessMutex,
      this.bot.botDisplayName ?? 'Dreamux bot',
      this.targetRouter,
      fence,
    );
  }

  private async trackLifecycleTask<T>(
    lifecycle: FeishuSessionLifecycle,
    task: Promise<T>,
  ): Promise<T> {
    lifecycle.inFlight.add(task);
    try {
      return await task;
    } finally {
      lifecycle.inFlight.delete(task);
    }
  }

  async start(submitter: FeishuInboundSubmitter): Promise<void> {
    if (this.lifecycle !== undefined && !this.lifecycle.controller.signal.aborted) {
      throw new Error('Feishu channel session is already started');
    }
    const controller = new AbortController();
    const lifecycle: FeishuSessionLifecycle = {
      controller,
      inFlight: new Set(),
      fence: {
        signal: controller.signal,
        isCurrent: () =>
          this.lifecycle === lifecycle &&
          !controller.signal.aborted,
      },
    };
    this.lifecycle = lifecycle;
    this.subscribeBindingNotifications(submitter.coreEvents);
    try {
      await this.bot.start({
        onBotMemberAdded: async (added) => {
          if (!lifecycle.fence.isCurrent()) return;
          await this.trackLifecycleTask(
            lifecycle,
            recordBotAdded(
              this.opts.stateDir,
              added.chatId,
              added.eventId,
            ),
          );
        },
        onMessage: async (event) => {
          if (!lifecycle.fence.isCurrent()) return;
          await this.trackLifecycleTask(
            lifecycle,
            sessionOnMessage(
              this.handleForFence(lifecycle.fence),
              event,
              submitter,
            ),
          );
        },
        onCardAction: async (event) => {
          if (!lifecycle.fence.isCurrent()) return {};
          return this.trackLifecycleTask(lifecycle, this.onCardAction(event));
        },
      });
      if (!lifecycle.fence.isCurrent()) {
        await this.bot.close();
        throw new Error('Feishu channel session was closed during startup');
      }
    } catch (error) {
      controller.abort();
      this.unsubscribeBindingNotifications();
      if (this.lifecycle === lifecycle) this.lifecycle = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const lifecycle = this.lifecycle;
    lifecycle?.controller.abort();
    this.unsubscribeBindingNotifications();
    await this.bindingNotificationQueue;
    await this.bot.close();
    if (lifecycle !== undefined) {
      await Promise.allSettled([...lifecycle.inFlight]);
      if (this.lifecycle === lifecycle) this.lifecycle = undefined;
    }
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

  messageBelongsToTarget(messageId: string, target: ChannelTarget): boolean {
    return this.targetRouter.messageBelongsToTarget(messageId, target);
  }

  /** @deprecated Prefer exact target ownership for topic-safe authorization. */
  messageBelongsToChat(messageId: string, chatId: string): boolean {
    return this.targetRouter.messageBelongsToChat(messageId, chatId);
  }

  /**
   * Provider-owned target resolution. A known `message_id` resolves through the
   * session's authoritative inbound ledger. Standalone topic selectors are
   * rejected because safe topic egress requires replying to an observed source
   * message. Core receives only the resulting neutral target.
   */
  resolveTarget(meta: unknown): ChannelTarget {
    return this.targetRouter.resolveTarget(meta);
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

  private async onCardAction(
    event: FeishuCardActionEvent,
  ): Promise<unknown> {
    return sessionHandleCardAction(this.handle, event);
  }

  private subscribeBindingNotifications(
    coreEvents: ChannelCoreEventSource | undefined,
  ): void {
    if (coreEvents === undefined) return;
    this.coreEventSubscriptions.push(
      coreEvents.on('binding.route', (event) => {
        this.enqueueBindingNotification(event);
      }),
    );
    this.coreEventSubscriptions.push(
      coreEvents.on('binding.collaboration_space', (event) => {
        this.enqueueBindingNotification(event);
      }),
    );
  }

  private unsubscribeBindingNotifications(): void {
    for (const subscription of this.coreEventSubscriptions.splice(0)) {
      subscription.unsubscribe();
    }
  }

  private enqueueBindingNotification(
    event: ChannelBindingRouteEvent | ChannelBindingCollaborationSpaceEvent,
  ): void {
    const provider = event.kind === 'binding.route'
      ? event.endpoint.provider
      : event.container.provider;
    if (provider !== BUILTIN_FEISHU_PROVIDER_REF) return;
    const run = this.bindingNotificationQueue
      .catch(() => undefined)
      .then(() => this.sendBindingNotification(event));
    this.bindingNotificationQueue = run.catch(() => undefined);
  }

  private async sendBindingNotification(
    event: ChannelBindingRouteEvent | ChannelBindingCollaborationSpaceEvent,
  ): Promise<void> {
    const notification = event.kind === 'binding.route'
      ? routeBindingNotification(event)
      : collaborationSpaceNotification(event);
    if (notification === null) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          event_kind: event.kind,
          action: event.action,
        },
        'skipped Feishu binding notification with incomplete provider metadata',
      );
      return;
    }
    try {
      const result = await this.bot.sendCard(
        channelOutboundToFeishuTarget({
          conversationId: notification.target.chatId,
          ...(notification.target.messageId !== undefined
            ? { replyTo: notification.target.messageId }
            : {}),
        }),
        notification.card,
      );
      this.opts.log.info(
        {
          dispatcher_id: this.opts.dispatcherId,
          event_kind: event.kind,
          action: event.action,
          message_ids: result.messageIds,
        },
        'Feishu binding notification sent',
      );
    } catch (err) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          event_kind: event.kind,
          action: event.action,
          err: errInfo(err),
        },
        'Feishu binding notification failed',
      );
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
