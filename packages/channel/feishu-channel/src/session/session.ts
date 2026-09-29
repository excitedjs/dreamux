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
 * Every collaborator this session hands to another layer (inbound, tools, the
 * extension api) is a real, narrow object built once here — there is no
 * `SessionHandle` bag threading the whole private surface through free
 * functions. A function that used to take that bag now lives here as a
 * method, or takes only the one collaborator it actually needs.
 */
import { join } from 'node:path';

import type {
  ChannelCorePort,
  ChannelEventSubscription,
  ChannelMcpCaller,
  DreamuxLogger,
  JsonInvoker,
  JsonValue,
} from '@excitedjs/dreamux-types';
import {
  errorInfo,
  PublicInvokeFailure,
  TransactionalStore,
} from '@excitedjs/dreamux-utils';
import type {
  CreateBotOptions,
  FeishuBot,
  FeishuInboundRoutes,
} from '../bot.js';
import { createFeishuBot } from '../bot.js';
import {
  CHAT_BOTS_FILENAME,
  listChatBots,
  loadChatBots,
  recordBotAdded,
  type ChatBotsState,
  type PeerBot,
} from '../chat-bots-store.js';
import {
  buildInstanceApi,
  FeishuExtensionRegistry,
  FeishuSessionExtensions,
  type FeishuBoundExtensionTool,
} from '../feishu-extensions.js';
import { FeishuOutbound } from '../outbound/index.js';
import { onMessage, type FeishuInboundHandle } from '../inbound/pipeline.js';
import {
  createAskUserRegistry,
  type AskUserExpiry,
  type AskUserRegistry,
} from '../ask-user/registry.js';
import type { AskUserQuestionSpec } from '../cards/ask-user.js';
import { FeishuAccess } from '../access/index.js';
import {
  createFeishuCoreCommands,
  type FeishuCoreCommands,
} from '../feishu-core-commands.js';
import { FeishuDocumentComments } from '../feishu-document-comments.js';
import { FeishuCotAdapter } from '../cot/adapter.js';
import { FeishuProvisioning } from '../feishu-provisioning.js';
import {
  FeishuBindingOperations,
  rejectedDeliveryNotice,
} from '../routing/operations.js';
import {
  dispatchFeishuSlashCommand,
  type FeishuSlashCommandInvocation,
  type FeishuSlashCommandReply,
} from '../feishu-slash-commands.js';
import {
  errorMessage,
  submissionProvesNoAdmission,
  type FeishuChatSubmission,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
} from '../feishu-submit.js';
import { FeishuInboundTargeting } from '../inbound/target.js';
import { FeishuRouting } from '../routing/index.js';
import { describeTarget, type FeishuTarget } from '../routing/target.js';
import { FeishuCardActions } from './card-actions.js';
import {
  createFeishuLifecycle,
  type OwnedFeishuLifecycle,
} from './lifecycle.js';
import type {
  FeishuListChatBotsResult,
  FeishuToolSession,
  WireChatBot,
} from '../tools/types.js';

/**
 * Logger shape used throughout the Feishu channel session — pino-style,
 * fields-first, matching the neutral `DreamuxLogger` contract from the host.
 */
export type ChannelLogger = DreamuxLogger;
export type { WireChatBot, FeishuListChatBotsResult };

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
  /** Inject a fake bot (tests), instead of a live Lark connection. */
  botFactory?: () => FeishuBot;
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
  private readonly extensions: FeishuSessionExtensions;
  private readonly cardActions: FeishuCardActions;
  private readonly _chatBotsStore: TransactionalStore<ChatBotsState>;
  private readonly access: FeishuAccess;
  /**
   * This session's one liveness value, built once here rather than lazily at
   * `initialize()`: every collaborator built in this constructor closes over
   * it directly, so nothing needs a null-object stand-in for "not started
   * yet" — `initialized` below is the only phase flag this class keeps.
   */
  private readonly lifecycle: OwnedFeishuLifecycle;
  private readonly askUser: AskUserRegistry;
  private initialized = false;
  private subscription: ChannelEventSubscription | undefined;
  private invoker: JsonInvoker | undefined;

  constructor(private readonly opts: FeishuChannelSessionOptions) {
    this.lifecycle = createFeishuLifecycle();
    this.askUser = createAskUserRegistry({
      onExpire: (expiry) => {
        void this.expireAskUserQuestion(expiry);
      },
    });
    this.bot =
      opts.botFactory !== undefined
        ? opts.botFactory()
        : createFeishuBot({
            appId: opts.appId,
            appSecret: opts.appSecret,
            logger: opts.log,
          } satisfies CreateBotOptions);
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
      cotClient: () => this.bot.cot,
    });
    this.commands = createFeishuCoreCommands((command, payload) =>
      this.invoke(command, payload),
    );
    this.bindings = new FeishuBindingOperations({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      routing: this.routing,
      cot: this.cot,
      commands: this.commands,
      notify: (target, card, replyTo) => this.notify(target, card, replyTo),
    });
    this.provisioning = new FeishuProvisioning({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      routing: this.routing,
      submit: (team, input) => this.submit(team, input),
      commands: this.commands,
      announce: (input) => this.bindings.announceProvisioned(input),
    });
    this.docComments = new FeishuDocumentComments({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      routing: this.routing,
      submit: (team, submission) => this.submit(team, submission),
      bot: this.bot,
      access: this.access,
    });
    this.extensions = new FeishuSessionExtensions(opts.extensions, opts.log);
    this.cardActions = new FeishuCardActions({
      dispatcherId: opts.dispatcherId,
      log: opts.log,
      bot: this.bot,
      access: this.access,
      extensions: this.extensions,
      askUser: this.askUser,
      targetRouter: this.targetRouter,
      outbound: this.outbound,
      deliver: (input) => this.deliver(input),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async initialize(port: ChannelCorePort): Promise<void> {
    if (this.initialized) {
      throw new Error('Feishu channel session is already initialized');
    }
    this.initialized = true;
    await this.routing.initialize();
    this.invoker = port.invoke;
    this.cot.start(() => this.lifecycle.isLive());
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
          track: (work) => this.lifecycle.track(work),
          routing: this.routing,
          bindings: this.bindings,
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

  private invoke(command: string, payload: JsonValue): Promise<JsonValue> {
    const invoker = this.invoker;
    if (invoker === undefined) {
      return Promise.reject(
        new Error('Feishu channel session has no Core port'),
      );
    }
    return invoker.invoke(command, payload);
  }

  // ── Submission ─────────────────────────────────────────────────────────

  /**
   * One turn, to whoever this Channel's routing chose.
   *
   * A `teamName` invokes `team.submit` and reaches that Team's TeamLeader;
   * `null` invokes `dispatcher.submit` and reaches the addressed Dispatcher's
   * own Agent, which is the recipient for a conversation no binding or
   * Collaboration Space claims. Core decides nothing about which: naming a Team
   * or naming none is the Channel's decision, stated in the Command.
   *
   * The Channel takes its own anchor before invoking Core. The caller-owned
   * source id is retained only to recognize the submitted turn whose body is
   * already visible at that anchor; placement never waits on projection.
   */
  async submit(
    teamName: string | null,
    submission: FeishuSubmission,
  ): Promise<FeishuSubmitOutcome> {
    if (!this.lifecycle.isLive()) {
      return { status: 'error', message: 'Feishu session is not live' };
    }
    // Only a chat submission has a visible message to hang a card under; a
    // document comment opens none, and registers no correlation to suppress.
    const inbound =
      submission.kind === 'chat'
        ? this.cot.beginInboundSubmission({
            teamName,
            anchor: submission.anchor,
            sourceId: submission.sourceId,
          })
        : null;
    try {
      const outcome =
        teamName !== null
          ? await this.commands.teamSubmit(teamName, submission)
          : await this.commands.dispatcherSubmit(submission);
      if (submissionProvesNoAdmission(outcome)) inbound?.retire();
      return outcome;
    } finally {
      inbound?.release();
    }
  }

  /** Execute a recognized command after route projection, without submission. */
  command(input: {
    command: FeishuSlashCommandInvocation;
    target: FeishuTarget;
    containerChatId: string | null;
    messageId: string;
  }): Promise<FeishuSlashCommandReply> {
    const plan = this.routing.plan(input.target, input.containerChatId);
    return dispatchFeishuSlashCommand(input.command, {
      plan,
      target: input.target,
      messageId: input.messageId,
      bindChannel: (bind) => this.bindings.bindChannel(bind),
      bindings: this.routing.listBindings(),
      // A rejected Core command does not reconcile this Channel's routing. It is not
      // proof the route is finished — `TEAM_CLOSED` is raised for a dissolve
      // that is still only pending, and a dissolve that then fails lowers the
      // fence and leaves the Team open again (`TeamService.runDissolve`). The
      // two paths that do reconcile hold the proof this one lacks: the final
      // `team.state` for closure, a rejected delivery for a row pointing at
      // nothing. Removing rows here would take the announcement away from
      // both, because the first remover is the only one with anything to
      // announce.
      commands: this.commands,
      // The only place that knows a bot may not offer the lookup at all. Below
      // this line a chat name is simply something you ask for and may not get.
      resolveChatName: (chatId) =>
        this.bot.resolveChatName?.(chatId) ?? Promise.resolve(undefined),
    });
  }

  /**
   * Deliver one accepted message wherever this Channel routes it.
   *
   * `dispatcher` goes to the Dispatcher Agent; `bound` goes to the named Team,
   * and a pre-admission `TEAM_NOT_FOUND`/`TEAM_CLOSED` drops the stale routes
   * and falls back once to the Dispatcher Agent; `provision` runs automatic
   * provisioning and its outcome is final — `unsubmitted`/`rejected` get no
   * Dispatcher fallback, the inbound path posts a failure notice instead.
   */
  async deliver(input: {
    target: FeishuTarget;
    containerChatId: string | null;
    submission: FeishuChatSubmission;
  }): Promise<FeishuSubmitOutcome> {
    const plan = this.routing.plan(input.target, input.containerChatId);
    const { submission } = input;
    if (plan.kind === 'dispatcher') {
      return this.submit(null, submission);
    }
    if (plan.kind === 'provision') {
      return this.provisioning.provisionForInbound({
        space: plan.space,
        target: input.target,
        display: null,
        submission,
      });
    }
    const outcome = await this.submit(plan.teamName, submission);
    if (outcome.status !== 'rejected') return outcome;
    // Nothing was admitted, so the message is safe to deliver once more: drop
    // the stale routes and hand it to the Dispatcher Agent, as every
    // conversation this Channel cannot route is. Past that fallback, an
    // ambiguous admission or unknown failure proves nothing about a turn, so
    // nothing is sent twice on a guess.
    await this.bindings.forgetTeamRoutes(
      plan.teamName,
      rejectedDeliveryNotice(outcome.code),
    );
    return this.submit(null, submission);
  }

  // ── MCP tool backing ───────────────────────────────────────────────────

  toolSession(): FeishuToolSession {
    return {
      logger: this.opts.log,
      channelId: this.opts.channelId,
      sendText: async (chatId, text, opts) =>
        this.sendReply({
          chatId,
          text,
          messageId: opts.messageId,
          callerTeamName: opts.callerTeamName,
        }),
      react: async (chatId, messageId, emoji) =>
        this.addReaction({ messageId, emoji, chatId }),
      listKnownChatBots: async (chatId) => this.readChatBots(chatId),
      askUserQuestion: async (input) => this.askUserQuestion(input),
      bindings: this.bindings,
      routing: this.routing,
      docComments: this.docComments,
    };
  }

  /**
   * Runs `work` only while this session is live, tracked so `close()` waits
   * for it — the same fence and tracking an extension tool call gets. Shared
   * by `extensionTool` below and by `tools/session-mcp.ts`'s built-in-tool
   * branch, so a call of either kind reaching this session after it began
   * tearing down is refused the same way.
   */
  async fencedToolCall<T>(work: () => Promise<T>): Promise<T> {
    if (!this.lifecycle.isLive()) {
      throw new PublicInvokeFailure(
        'The Feishu channel is not accepting tool calls',
      );
    }
    return this.lifecycle.track(work());
  }

  /**
   * An extension tool bound to this session: refused once the session stopped
   * taking calls, and tracked so closing waits for it before extensions close.
   */
  extensionTool(
    name: string,
    kind: ChannelMcpCaller['kind'],
  ): FeishuBoundExtensionTool | undefined {
    const tool = this.extensions.tool(name, kind);
    if (tool === undefined) return undefined;
    return {
      def: tool.def,
      invoke: (caller, raw) =>
        this.fencedToolCall(() => tool.invoke(caller, raw)),
    };
  }

  // ── Outbound primitives ────────────────────────────────────────────────

  /**
   * A Reply is an outbound message, and only that.
   *
   * It is not Channel user input, so its success receipt never creates,
   * replaces, or retires a recipient's anchor and never touches an open card.
   */
  private async sendReply(input: {
    chatId: string;
    text: string;
    messageId?: string | undefined;
    callerTeamName: string | null;
  }): Promise<{ message_ids: string[] }> {
    const result = await this.outbound.sendText(input);
    return { message_ids: result.messages.map((m) => m.messageId) };
  }

  private async addReaction(input: {
    messageId: string;
    emoji: string;
    chatId?: string | undefined;
  }): Promise<{ reaction_id: string }> {
    return { reaction_id: await this.outbound.react(input) };
  }

  private async readChatBots(
    chatId: string,
  ): Promise<FeishuListChatBotsResult> {
    const listing = await listChatBots(this._chatBotsStore, chatId);
    return {
      chat_id: chatId,
      known: listing.known.map(toWireChatBot),
      trusted: listing.trusted.map(toWireChatBot),
    };
  }

  // ── Ask-user ───────────────────────────────────────────────────────────

  /**
   * Send a question card and return the round's id.
   *
   * Nothing is awaited beyond the send. The click that answers arrives on the
   * card-action route, and the answer reaches Core as an inbound submission, so
   * the tool that called this is long finished by the time the user decides.
   *
   * `messageId` addresses the card the way `reply` addresses a message: the card
   * is sent as a reply to it, which is what puts it in that message's topic.
   * Without one the card is a new message in the chat, and in a topic group that
   * opens a topic of its own — right for a question that belongs to no particular
   * message, wrong for one that does. Where the answer goes is not decided here;
   * it is read back from the card that was actually sent.
   *
   * The round is put in play only once the card is really sent, so a send that
   * throws leaves no question behind and fails where the model can see it.
   */
  private async askUserQuestion(input: {
    chatId: string;
    text?: string;
    questions: readonly AskUserQuestionSpec[];
    messageId?: string;
  }): Promise<{ request_id: string }> {
    const opened = this.askUser.open(input);
    const sent = await this.outbound.sendCard({
      target: {
        chatId: input.chatId,
        ...(input.messageId !== undefined
          ? { replyToMessageId: input.messageId }
          : {}),
      },
      card: opened.card,
      mode: 'inbound',
    });
    opened.activate(sent.messages[0]);
    return { request_id: opened.requestId };
  }

  /**
   * Close out a round that ran out of time.
   *
   * Both halves are best-effort and independent: the model is told there is no
   * answer, and the card is repainted so the user is not left looking at a
   * question that silently stopped working. A failed repaint must not cost the
   * model its notification, which is why the patch is awaited separately.
   */
  private async expireAskUserQuestion(expiry: AskUserExpiry): Promise<void> {
    await this.cardActions.deliverAskUserSettlement(expiry.settlement);
    const messageId = expiry.settlement.cardMessageId;
    if (messageId === undefined) return;
    try {
      await this.bot.editCard(messageId, expiry.card);
    } catch (err) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: messageId,
          ask_user_request_id: expiry.settlement.requestId,
          err: errorInfo(err),
        },
        '[ask-user] expired card repaint failed',
      );
    }
  }

  // ── Notifications ──────────────────────────────────────────────────────

  private notify(
    target: FeishuTarget,
    card: unknown,
    replyTo: string | null,
  ): void {
    if (!this.lifecycle.isLive()) return;
    void this.lifecycle
      .track(this.sendNotification(target, card, replyTo))
      .catch(() => undefined);
  }

  private async sendNotification(
    target: FeishuTarget,
    card: unknown,
    replyTo: string | null,
  ): Promise<void> {
    if (target.kind === 'topic' && replyTo === null) {
      // No persisted root for this topic yet: replying under nothing would
      // land in the wrong place (a fresh top-level message opens a topic of
      // its own), so this notice is dropped rather than guessed. A topic
      // only gets a root when automatic provisioning binds it, from the
      // message that triggered provisioning; a manual bind carries an
      // existing root forward but never supplies one, so a topic bound that
      // way keeps missing its notices until it is provisioned or its row
      // otherwise gains a root.
      this.opts.log.info(
        {
          dispatcher_id: this.opts.dispatcherId,
          channel_id: this.opts.channelId,
          target: describeTarget(target),
        },
        'Feishu binding notification skipped: topic has no root message yet',
      );
      return;
    }
    await this.outbound.sendNotification({
      target: {
        chatId: target.chatId,
        ...(replyTo !== null ? { replyToMessageId: replyTo } : {}),
      },
      card,
      logFields: {
        dispatcher_id: this.opts.dispatcherId,
        channel_id: this.opts.channelId,
        target: describeTarget(target),
      },
    });
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
      delivery: this,
    };
  }
}

/** Map a peer bot to the `list_chat_bots` wire shape. */
export function toWireChatBot(bot: PeerBot): WireChatBot {
  return {
    open_id: bot.openId,
    ...(bot.name !== undefined && bot.name !== '' ? { name: bot.name } : {}),
  };
}
