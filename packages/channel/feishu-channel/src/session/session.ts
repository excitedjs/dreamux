/**
 * The live Feishu session: this Channel's whole authority, in one object.
 *
 * It owns external transport, message interpretation, access and trust policy,
 * its own routing document, its own Collaboration Space policy, the automatic
 * provisioning it runs in memory, and the visible-message anchors its cards
 * hang under. What it hands Core is a body and, when its own routing chose a
 * Team, that Team's name; what it takes from Core is an admission result and a
 * live event stream.
 *
 * The lifecycle is deliberately three calls. `initialize` loads durable state
 * and subscribes without opening the platform, which is what makes
 * "subscribed before anything is admitted" provable rather than hopeful.
 * `start` opens the platform and lets messages in. `close` fences, drains this
 * Channel's own commit queue, and releases the bot.
 *
 * This object composes and closes collaborators. The submitter owns the
 * liveness/anchor/Core admission operation; the inbound router owns delivery
 * and slash-command routing. Card actions own ask-user IO and observe registry
 * expiry. MCP tools receive a single view of those actual owners.
 */
import { FeishuInboundRouter } from '../inbound/router.js';
import { FeishuTeamSubmitter } from './submitter.js';
import { join } from 'node:path';

import type {
  ChannelCorePort,
  ChannelEventSubscription,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { TransactionalStore } from '@excitedjs/dreamux-utils';
import { FeishuAccess } from '../access/index.js';
import {
  createAskUserRegistry,
  type AskUserRegistry,
} from '../ask-user/registry.js';
import type { FeishuBot, FeishuInboundRoutes } from '../bot.js';
import { createFeishuBot } from '../bot.js';
import {
  CHAT_BOTS_FILENAME,
  loadChatBots,
  recordBotAdded,
  type ChatBotsState,
} from '../chat-bots-store.js';
import { FeishuCotAdapter } from '../cot/adapter.js';
import { FeishuCoreCommands } from '../feishu-core-commands.js';
import { FeishuDocumentComments } from '../feishu-document-comments.js';
import {
  buildInstanceApi,
  FeishuExtensionRegistry,
  FeishuSessionExtensions,
} from '../feishu-extensions.js';
import { FeishuProvisioning } from '../feishu-provisioning.js';
import { errorMessage } from '../feishu-submit.js';
import { onMessage, type FeishuInboundHandle } from '../inbound/pipeline.js';
import { FeishuInboundTargeting } from '../inbound/target.js';
import { FeishuOutbound } from '../outbound/index.js';
import { FeishuRouting } from '../routing/index.js';
import { FeishuBindingOperations } from '../routing/operations.js';
import type {
  FeishuListChatBotsResult,
  FeishuToolSession,
  WireChatBot,
} from '../tools/types.js';
import { FeishuCardActions } from './card-actions.js';
import {
  createFeishuLifecycle,
  type OwnedFeishuLifecycle,
} from './lifecycle.js';

/**
 * Logger shape used throughout the Feishu channel session — pino-style,
 * fields-first, matching the neutral `DreamuxLogger` contract from the host.
 */
export type ChannelLogger = DreamuxLogger;
export type { FeishuListChatBotsResult, WireChatBot };

export interface FeishuChannelSessionOptions {
  /**
   * The owning dispatcher id — used for log fields, and, for an extension's
   * state root only, as a path segment under the Feishu plugin's own state
   * directory (that directory is plugin-scoped, not dispatcher-scoped, so
   * Feishu supplies the dispatcher scoping under it itself).
   */
  dispatcherId: string;
  /** This session's dispatcher-local channel id; its routing document's key. */
  channelId: string;
  /** Feishu bot app id (host resolves it from config). */
  appId: string;
  /** Feishu bot app secret (empty string skips auth in tests). */
  appSecret: string;
  /**
   * The dispatcher's durable state directory. The session derives its access,
   * chat-bots, and routing files under it — supplied by the host so the package
   * owns no Dreamux state-layout contract.
   */
  stateDir: string;
  /** The dispatcher's inbound-attachment cache directory (host-supplied). */
  attachmentCacheDir: string;
  /** The host's neutral logger, handed straight to the transport. */
  log: DreamuxLogger;
  /** The Feishu extensions this session runs; none when omitted. */
  extensions?: FeishuExtensionRegistry;
}

export class FeishuChannelSession {
  readonly bot: FeishuBot;
  readonly routing: FeishuRouting;
  private readonly targetRouter: FeishuInboundTargeting;
  private readonly outbound: FeishuOutbound;
  private readonly cot: FeishuCotAdapter;
  private readonly bindings: FeishuBindingOperations;
  private readonly commands: FeishuCoreCommands;
  private readonly provisioning: FeishuProvisioning;
  private readonly docComments: FeishuDocumentComments;
  readonly extensions: FeishuSessionExtensions;
  private readonly cardActions: FeishuCardActions;
  private readonly _chatBotsStore: TransactionalStore<ChatBotsState>;
  private readonly access: FeishuAccess;
  /**
   * This session's one liveness value, built once here rather than lazily at
   * `initialize()`: every collaborator built in this constructor closes over
   * it directly, so nothing needs a null-object stand-in for "not started
   * yet" — `initialized` below is the only phase flag this class keeps.
   */
  readonly lifecycle: OwnedFeishuLifecycle;
  private readonly askUser: AskUserRegistry;
  private initialized = false;
  private subscription: ChannelEventSubscription | undefined;
  private readonly router: FeishuInboundRouter;
  readonly tools: FeishuToolSession;

  constructor(private readonly opts: FeishuChannelSessionOptions) {
    this.lifecycle = createFeishuLifecycle();
    this.askUser = createAskUserRegistry();
    this.bot = createFeishuBot({
      appId: opts.appId,
      appSecret: opts.appSecret,
      logger: opts.log,
    });
    this.targetRouter = new FeishuInboundTargeting({
      chatModes: this.bot,
      log: opts.log,
    });
    // Loaded at the first peer-bot operation, not here — a corrupt or
    // unreadable file is not security-critical, so nothing about session
    // start depends on this store's first read.
    this._chatBotsStore = new TransactionalStore({
      path: join(opts.stateDir, CHAT_BOTS_FILENAME),
      load: () => loadChatBots(opts.stateDir),
    });
    // Like `_chatBotsStore`, not loaded here — `FeishuAccess` defers its own
    // first read (see its constructor).
    this.access = new FeishuAccess({
      stateDir: opts.stateDir,
      dispatcherId: opts.dispatcherId,
      log: opts.log,
    });
    this.routing = new FeishuRouting({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      stateDir: opts.stateDir,
    });
    this.outbound = new FeishuOutbound({
      channelId: opts.channelId,
      bot: this.bot,
      log: opts.log,
      dispatcherId: opts.dispatcherId,
      lifecycle: this.lifecycle,
      routing: this.routing,
      targetRouter: this.targetRouter,
    });
    this.cot = new FeishuCotAdapter({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      cotClient: this.bot.cot,
      lifecycle: this.lifecycle,
    });
    this.commands = new FeishuCoreCommands();
    const submitter = new FeishuTeamSubmitter({
      lifecycle: this.lifecycle,
      cot: this.cot,
      commands: this.commands,
    });
    this.bindings = new FeishuBindingOperations({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      routing: this.routing,
      cot: this.cot,
      commands: this.commands,
      outbound: this.outbound,
    });
    this.provisioning = new FeishuProvisioning({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      routing: this.routing,
      submitter,
      commands: this.commands,
      bindings: this.bindings,
    });
    this.docComments = new FeishuDocumentComments({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      routing: this.routing,
      submitter,
      bot: this.bot,
      access: this.access,
    });
    this.extensions = new FeishuSessionExtensions(opts.extensions, opts.log);
    this.router = new FeishuInboundRouter({
      log: opts.log,
      routing: this.routing,
      bindings: this.bindings,
      provisioning: this.provisioning,
      submitter,
      commands: this.commands,
      bot: this.bot,
    });
    this.cardActions = new FeishuCardActions({
      dispatcherId: opts.dispatcherId,
      log: opts.log,
      bot: this.bot,
      access: this.access,
      extensions: this.extensions,
      askUser: this.askUser,
      targetRouter: this.targetRouter,
      outbound: this.outbound,
      router: this.router,
    });
    this.tools = {
      logger: opts.log,
      channelId: opts.channelId,
      outbound: this.outbound,
      cardActions: this.cardActions,
      chatBotsStore: this._chatBotsStore,
      bindings: this.bindings,
      routing: this.routing,
      docComments: this.docComments,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async initialize(port: ChannelCorePort): Promise<void> {
    if (this.initialized) {
      throw new Error('Feishu channel session is already initialized');
    }
    this.initialized = true;
    await this.routing.initialize();
    this.commands.initialize(port.invoke);
    // The single subscription, demultiplexed here because this session owns
    // both consumers. Nothing awaits: the COT seam projects synchronously, and
    // a closed Team's routes are removed through the store's ordinary commit,
    // queued rather than waited on, because the event stream must not stall
    // behind a disk write. Until that commit lands one more message can still
    // route to the closed Team — Core rejects it before admission, and the
    // fallback removes the route again on its way to the Dispatcher Agent.
    this.subscription = port.events.subscribe((event) => {
      try {
        this.cot.handle(event);
        if (event.kind !== 'team.state' || event.status !== 'closed') return;
        void this.bindings.forgetTeamRoutes(event.teamName, 'team_closed');
      } catch (error) {
        this.opts.log.warn(
          {
            dispatcher_id: this.opts.dispatcherId,
            channel_id: this.opts.channelId,
            event_kind: event.kind,
            err: { message: errorMessage(error) },
          },
          'Feishu core-event listener failed',
        );
      }
    });
    // Last, so a failing extension tears down a fully initialized session.
    try {
      await this.extensions.initialize({
        dispatcherId: this.opts.dispatcherId,
        channelId: this.opts.channelId,
        signal: this.lifecycle.signal,
        api: buildInstanceApi({
          lifecycle: this.lifecycle,
          outbound: this.outbound,
          bot: this.bot,
          targetRouter: this.targetRouter,
          routing: this.routing,
          bindings: this.bindings,
          commands: this.commands,
        }),
      });
    } catch (error) {
      await this.teardown();
      throw error;
    }
  }

  async start(): Promise<void> {
    if (!this.initialized) {
      throw new Error('Feishu channel session was started before initialize');
    }
    if (!this.lifecycle.isLive()) {
      throw new Error(
        'Feishu channel session was closed before it could start',
      );
    }
    try {
      await this.bot.start(this.inboundRoutes());
      // Tracked so a close landing mid-start waits, then closes what it opened.
      if (this.lifecycle.isLive()) {
        await this.lifecycle.track(this.extensions.start());
      }
      if (!this.lifecycle.isLive()) {
        await this.bot.close();
        throw new Error('Feishu channel session was closed during startup');
      }
    } catch (error) {
      await this.teardown();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.initialized) {
      await this.teardown();
    } else {
      // `initialize()` never ran: nothing was subscribed and nothing is
      // tracked, but the lifecycle still aborts here regardless of whether
      // `start()` ever ran, so a caller holding this session's lifecycle sees
      // it end even on this early-close path.
      this.lifecycle.abort();
      await this.cot.close();
    }
    await this.bot.close();
  }

  private async teardown(): Promise<void> {
    this.lifecycle.abort();
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.askUser.abandonAll();
    // Interrupt every live card before the bot goes away. The adapter fences
    // itself first and drains within a bounded window, so a slow Feishu can
    // never hold session shutdown open.
    await this.cot.close();
    await this.lifecycle.drain();
    // Extension calls are fenced and settled now; no handler holds their state.
    await this.extensions.close();
    // Only now is the Channel's own commit queue empty: a listener that
    // removed a binding queued its commit without awaiting it.
    await this.routing.close();
  }

  // ── Inbound ────────────────────────────────────────────────────────────

  /**
   * The inbound route table this session hands its bot.
   *
   * Every route checks the lifecycle first and runs its work tracked, so
   * closing the session refuses new events and waits for the ones in flight.
   */
  private inboundRoutes(): FeishuInboundRoutes {
    return {
      onBotMemberAdded: async (added) => {
        if (!this.lifecycle.isLive()) return;
        await this.lifecycle.track(
          recordBotAdded(this._chatBotsStore, added.chatId, added.eventId),
        );
      },
      onMessage: async (event) => {
        if (!this.lifecycle.isLive()) return;
        await this.lifecycle.track(onMessage(this.inboundHandle(), event));
      },
      onCardAction: async (event) => {
        if (!this.lifecycle.isLive()) return {};
        return this.lifecycle.track(this.cardActions.handle(event));
      },
      onDocComment: async (event) => {
        if (!this.lifecycle.isLive()) return;
        await this.lifecycle.track(this.docComments.deliver(event));
      },
    };
  }

  /**
   * The narrow view `inbound/pipeline.ts` needs for one accepted event. Built
   * fresh per event rather than cached, because `botDisplayName` resolves
   * from the live transport and may not be known yet the first time this is
   * called — every other field is a stable collaborator, so this costs one
   * cheap object literal, not a lookup.
   */
  private inboundHandle(): FeishuInboundHandle {
    return {
      log: this.opts.log,
      dispatcherId: this.opts.dispatcherId,
      attachmentCacheDir: this.opts.attachmentCacheDir,
      bot: this.bot,
      access: this.access,
      chatBotsStore: this._chatBotsStore,
      botDisplayName: this.bot.botDisplayName ?? 'Dreamux bot',
      targetRouter: this.targetRouter,
      outbound: this.outbound,
      lifecycle: this.lifecycle,
      delivery: this.router,
    };
  }
}
