/**
 * The live Feishu session: this Channel's whole authority, in one object.
 *
 * It owns external transport, message interpretation, access and trust policy,
 * its own routing document, its own Collaboration Space policy, the automatic
 * provisioning it runs in memory, and the visible-message anchors its cards
 * hang under. What it hands Core is a body and, when its own routing chose a
 * Team, that Team's name; what it takes from Core is a `turn_id` and a live
 * event stream.
 *
 * The lifecycle is deliberately three calls. `initialize` loads durable state
 * and subscribes without opening the platform, which is what makes
 * "subscribed before anything is admitted" provable rather than hopeful.
 * `start` opens the platform and lets messages in. `close` fences, drains this
 * Channel's own commit queue, and releases the bot.
 */
import type {
  ChannelCoreEvent,
  ChannelCorePort,
  ChannelEventSubscription,
  ChannelMcpCaller,
  DreamuxLogger,
  JsonInvoker,
  JsonValue,
  TeamSubmitResult,
} from '@excitedjs/dreamux-types';
import type {
  CreateBotOptions,
  FeishuBot,
  FeishuCardActionEvent,
} from './bot.js';
import { createFeishuBot } from './bot.js';
import {
  listChatBots,
  recordBotAdded,
  type PeerBot,
} from './chat-bots-store.js';
import { AsyncMutex } from './lib/mutex.js';
import {
  alwaysActiveSessionFence,
  type FeishuSessionFence,
} from './feishu-inbound-work.js';
import {
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from './feishu-bounded-operation.js';
import { FeishuCotSessionSeam } from './feishu-cot-session.js';
import { FeishuProvisioning } from './feishu-provisioning.js';
import { FeishuBindingOperations } from './feishu-session-bindings.js';
import {
  commandErrorCode,
  errorMessage,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
} from './feishu-submit.js';
import {
  handleCardAction as sessionHandleCardAction,
  sendCard as sessionSendCard,
  sendReply as sessionSendReply,
  addReaction as sessionAddReaction,
  sessionHandle,
  type SessionHandle,
} from './feishu-session-ops.js';
import { onMessage as sessionOnMessage } from './feishu-session-inbound.js';
import { FeishuTargetRouter } from './feishu-target-router.js';
import { FeishuRouting } from './routing/index.js';
import { FeishuRoutingStore } from './routing/store.js';
import {
  chatTarget,
  describeTarget,
  type FeishuTarget,
} from './routing/target.js';
import type {
  FeishuListChatBotsResult,
  FeishuToolSession,
  WireChatBot,
} from './tools/types.js';

/**
 * Logger shape used throughout the Feishu channel session — pino-style,
 * fields-first, matching the neutral `DreamuxLogger` contract from the host.
 */
export type ChannelLogger = DreamuxLogger;
export type { WireChatBot, FeishuListChatBotsResult };

export interface FeishuChannelSessionOptions {
  /** The owning dispatcher id — used only for log fields, never for paths. */
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
}

interface FeishuSessionLifecycle {
  controller: AbortController;
  fence: FeishuSessionFence;
  inFlight: Set<Promise<unknown>>;
}

const FEISHU_BINDING_NOTIFICATION_SEND_TIMEOUT_MS = 20_000;

export class FeishuChannelSession {
  readonly bot: FeishuBot;
  readonly routing: FeishuRouting;
  private readonly store: FeishuRoutingStore;
  private readonly targetRouter: FeishuTargetRouter;
  private readonly cot: FeishuCotSessionSeam;
  private readonly bindings: FeishuBindingOperations;
  private readonly provisioning: FeishuProvisioning;
  private readonly _accessMutex = new AsyncMutex();
  private readonly inactiveFence = alwaysActiveSessionFence();
  /** Live leader names, learned from `team.state`; never durable. */
  private readonly leaderNames = new Map<string, string>();
  private lifecycle: FeishuSessionLifecycle | undefined;
  private subscription: ChannelEventSubscription | undefined;
  private invoker: JsonInvoker | undefined;

  constructor(private readonly opts: FeishuChannelSessionOptions) {
    this.bot = opts.botFactory !== undefined
      ? opts.botFactory()
      : createFeishuBot({
          appId: opts.appId,
          appSecret: opts.appSecret,
          logger: opts.log,
        } satisfies CreateBotOptions);
    this.targetRouter = new FeishuTargetRouter({
      chatModes: this.bot,
      log: opts.log,
    });
    this.store = new FeishuRoutingStore({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      stateDir: opts.stateDir,
    });
    this.routing = new FeishuRouting({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      store: this.store,
    });
    this.cot = new FeishuCotSessionSeam({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      cotClient: () => this.bot.cot,
    });
    this.bindings = new FeishuBindingOperations({
      routing: this.routing,
      cot: this.cot,
      notify: (target, card, anchorTeamName) =>
        this.notify(target, card, anchorTeamName),
    });
    this.provisioning = new FeishuProvisioning({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      routing: this.routing,
      submitter: { submit: (team, input) => this.submit(team, input) },
      invoke: (command, payload) => this.invoke(command, payload),
      announce: (input) => this.bindings.announceProvisioned(input),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async initialize(port: ChannelCorePort): Promise<void> {
    if (this.lifecycle !== undefined) {
      throw new Error('Feishu channel session is already initialized');
    }
    await this.store.load();
    this.invoker = port.invoke;
    const controller = new AbortController();
    const lifecycle: FeishuSessionLifecycle = {
      controller,
      inFlight: new Set(),
      fence: {
        signal: controller.signal,
        isCurrent: () =>
          this.lifecycle === lifecycle && !controller.signal.aborted,
      },
    };
    this.lifecycle = lifecycle;
    this.cot.start(() => lifecycle.fence.isCurrent());
    this.subscription = port.events.subscribe((event) => {
      this.onCoreEvent(event);
    });
  }

  async start(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (lifecycle === undefined) {
      throw new Error('Feishu channel session was started before initialize');
    }
    try {
      await this.bot.start({
        onBotMemberAdded: async (added) => {
          if (!lifecycle.fence.isCurrent()) return;
          await this.track(
            lifecycle,
            recordBotAdded(this.opts.stateDir, added.chatId, added.eventId),
          );
        },
        onMessage: async (event) => {
          if (!lifecycle.fence.isCurrent()) return;
          await this.track(
            lifecycle,
            sessionOnMessage(this.handleForFence(lifecycle.fence), event),
          );
        },
        onCardAction: async (event) => {
          if (!lifecycle.fence.isCurrent()) return {};
          return this.track(lifecycle, this.onCardAction(event));
        },
      });
      if (!lifecycle.fence.isCurrent()) {
        await this.bot.close();
        throw new Error('Feishu channel session was closed during startup');
      }
    } catch (error) {
      await this.teardown(lifecycle);
      throw error;
    }
  }

  async close(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (lifecycle !== undefined) {
      await this.teardown(lifecycle);
    } else {
      this.subscription?.unsubscribe();
      this.subscription = undefined;
      await this.cot.close();
    }
    await this.bot.close();
  }

  private async teardown(lifecycle: FeishuSessionLifecycle): Promise<void> {
    lifecycle.controller.abort();
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.leaderNames.clear();
    // Interrupt every live card before the bot goes away. The adapter fences
    // itself first and drains within a bounded window, so a slow Feishu can
    // never hold session shutdown open.
    await this.cot.close();
    await Promise.allSettled([...lifecycle.inFlight]);
    // Only now is the Channel's own commit queue empty: a listener that
    // removed a binding queued its commit without awaiting it.
    await this.store.drain();
    if (this.lifecycle === lifecycle) this.lifecycle = undefined;
  }

  // ── Core facts ─────────────────────────────────────────────────────────

  /**
   * The single subscription, demultiplexed.
   *
   * Nothing here awaits. The COT seam projects synchronously, and a closed
   * Team's routes are removed through the store's ordinary commit, queued
   * rather than waited on, because the event stream must not stall behind a
   * disk write. Until that commit lands one more message can still route to
   * the closed Team — Core rejects it before admission, and the fallback
   * removes the route again on its way to the Dispatcher Agent.
   */
  private onCoreEvent(event: ChannelCoreEvent): void {
    try {
      this.cot.handle(event);
      if (event.kind !== 'team.state') return;
      if (event.status !== 'closed') {
        this.leaderNames.set(event.team_name, event.leader_name);
        return;
      }
      this.leaderNames.delete(event.team_name);
      void this.forgetTeamRoutes(event.team_name, 'team_closed');
    } catch (err) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          channel_id: this.opts.channelId,
          event_kind: event.kind,
          err: { message: errorMessage(err) },
        },
        'Feishu core-event listener failed',
      );
    }
  }

  /**
   * Commit the removal of every route to a Team, and say what it removed.
   *
   * Both reasons reach the same durable change, so they share the one commit
   * path the store owns rather than growing a second authority beside it. A
   * commit that fails is logged and nothing more: the route is still live, and
   * the next message to it earns the same rejection and the same attempt.
   *
   * Only a closed Team is announced. That is a transition the conversation
   * lived through — it had a Team, and the Team ended — while a stale route is
   * this Channel correcting its own document on the way to delivering a
   * message, and telling a group about it would be noise about nothing the
   * group did.
   */
  private async forgetTeamRoutes(
    teamName: string,
    reason: 'team_closed' | 'stale_route',
  ): Promise<void> {
    const scope = {
      dispatcher_id: this.opts.dispatcherId,
      channel_id: this.opts.channelId,
      team_name: teamName,
      reason,
    };
    try {
      const { removed } = await this.routing.forgetTeam(teamName);
      if (removed.length === 0) return;
      this.opts.log.info(
        { ...scope, targets: removed.map((row) => describeTarget(row.target)) },
        'removed Feishu bindings for a Team that can no longer answer',
      );
      // Past the commit: the rows are gone from disk, and what follows is
      // presentation over what they said.
      if (reason === 'team_closed') {
        this.bindings.announceTeamClosed({ teamName, removed });
      }
    } catch (err) {
      this.opts.log.warn(
        { ...scope, err: { message: errorMessage(err) } },
        'could not commit the removal of Feishu bindings',
      );
    }
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
   * A `teamName` reaches that Team's TeamLeader; `null` omits the target and
   * reaches the Dispatcher Agent, which is the recipient for a conversation
   * no binding or Collaboration Space claims. Core decides nothing about
   * which: omission *is* the Channel's decision, stated in the Command.
   *
   * The returned `turn_id` is what closes the presentation loop. It names the
   * exact turn this call created, so claiming the matching submitted event is
   * proof of ownership even when several sessions submit to one recipient at
   * the same instant.
   */
  async submit(
    teamName: string | null,
    submission: FeishuSubmission,
  ): Promise<FeishuSubmitOutcome> {
    if (this.lifecycle?.fence.isCurrent() !== true) {
      return { status: 'error', message: 'Feishu session is not live' };
    }
    try {
      const raw = await this.invoke('team.submit', {
        ...(teamName !== null ? { team_name: teamName } : {}),
        attrs: submission.attrs,
        text: submission.text,
        ...(submission.reminder !== ''
          ? { reminder: submission.reminder }
          : {}),
        source_id: submission.sourceId,
      } as JsonValue);
      const outcome = submitOutcome(raw as unknown as TeamSubmitResult);
      if (outcome.status === 'submitted' && outcome.turnId !== null) {
        this.cot.attachInboundAnchor(outcome.turnId, submission.anchor);
      }
      return outcome;
    } catch (err) {
      const code = commandErrorCode(err);
      if (code === 'TEAM_NOT_FOUND' || code === 'TEAM_CLOSED') {
        return { status: 'rejected', code, message: errorMessage(err) };
      }
      return { status: 'error', message: errorMessage(err) };
    }
  }

  /** Deliver one accepted message wherever this Channel routes it. */
  async deliver(input: {
    target: FeishuTarget;
    containerChatId: string | null;
    submission: FeishuSubmission;
  }): Promise<FeishuSubmitOutcome> {
    const plan = this.routing.plan(input.target, input.containerChatId);
    const { submission } = input;
    if (plan.kind === 'dispatcher') {
      return this.submit(null, submission);
    }
    const outcome = plan.kind === 'bound'
      ? await this.submit(plan.teamName, submission)
      : await this.provisioning.provisionForInbound({
          space: plan.space,
          target: input.target,
          display: null,
          submission,
        });
    if (outcome.status !== 'rejected' && outcome.status !== 'unsubmitted') {
      return outcome;
    }
    // Nothing was admitted, and it is proven rather than assumed: Core refused
    // this Team before creating anything, or provisioning never reached a
    // Command at all. The message still has a recipient — the Dispatcher
    // Agent, as every conversation this Channel cannot hand to a Team does.
    //
    // Exactly once. The fallback is an ordinary submission and its own answer
    // is final: past that point an ambiguous admission or an unknown failure
    // proves nothing about whether a turn exists, and nothing is sent twice on
    // a guess.
    if (plan.kind === 'bound') {
      // Only a rejection can arrive from that branch, and its code says what
      // kind of evidence removed the row. `TEAM_CLOSED` is the same close the
      // `team.state` event proves, and it usually arrives here first: dissolve
      // raises the Team's closing fence before it publishes the final state,
      // so the message that gets refused precedes the event. It is announced
      // for that reason. `TEAM_NOT_FOUND` is a row pointing at nothing, which
      // is this Channel correcting its own document and stays silent.
      await this.forgetTeamRoutes(
        plan.teamName,
        outcome.status === 'rejected' && outcome.code === 'TEAM_CLOSED'
          ? 'team_closed'
          : 'stale_route',
      );
    }
    return this.submit(null, submission);
  }

  // ── MCP tool backing ───────────────────────────────────────────────────

  toolSession(caller: ChannelMcpCaller): FeishuToolSession {
    return {
      logger: this.opts.log,
      channelId: this.opts.channelId,
      sendText: async (chatId, text, sendOpts) =>
        this.sendReply(
          {
            chatId,
            text,
            ...(sendOpts?.messageId !== undefined
              ? { messageId: sendOpts.messageId }
              : {}),
            ...(sendOpts?.mentionUserIds !== undefined
              ? { mentionUserIds: sendOpts.mentionUserIds }
              : {}),
          },
          caller,
        ),
      react: async (chatId, messageId, emoji) =>
        this.addReaction({
          messageId,
          emoji,
          ...(chatId !== undefined ? { chatId } : {}),
        }),
      listKnownChatBots: async (chatId) => this.readChatBots(chatId),
      bindChannel: (input) => this.bindings.bindChannel(input),
      unbindChannel: (input, requireOwner) =>
        this.bindings.unbindChannel(input, requireOwner),
      listBindings: () => this.routing.listBindings(),
      bindSpace: (input) => this.bindings.bindSpace(input),
      unbindSpace: (spaceName) => this.bindings.unbindSpace(spaceName),
      getSpace: (spaceName) => this.routing.spaceByName(spaceName),
      listSpaces: () => this.routing.listSpaces(),
    };
  }

  // ── Outbound primitives ────────────────────────────────────────────────

  private async sendReply(
    input: {
      chatId: string;
      text: string;
      messageId?: string;
      mentionUserIds?: string[];
    },
    caller: ChannelMcpCaller,
  ): Promise<{ message_ids: string[] }> {
    const lifecycle = this.lifecycle;
    const result = await sessionSendReply(this.handle, {
      ...input,
      ...(caller.kind === 'team_leader'
        ? {
            onMessageCreated: ({ messageId }: { messageId: string }) => {
              if (lifecycle?.fence.isCurrent() !== true) return;
              const target = this.outboundTarget(input.chatId, input.messageId);
              this.targetRouter.observe(messageId, target);
              this.cot.refreshReplyNextAnchor({
                caller,
                anchor: { chatId: input.chatId, messageId, target },
              });
            },
          }
        : {}),
    });
    return { message_ids: result.messageIds };
  }

  /** Where a reply landed, in this Channel's own terms. */
  private outboundTarget(
    chatId: string,
    replyToMessageId: string | undefined,
  ): FeishuTarget {
    const observed = replyToMessageId === undefined
      ? undefined
      : this.targetRouter.targetForMessage(replyToMessageId);
    return observed !== undefined && observed.chatId === chatId
      ? observed
      : chatTarget(chatId, 'group');
  }

  private async addReaction(input: {
    messageId: string;
    emoji: string;
    chatId?: string;
  }): Promise<{ reaction_id: string }> {
    return { reaction_id: await sessionAddReaction(this.handle, input) };
  }

  private async readChatBots(
    chatId: string,
  ): Promise<FeishuListChatBotsResult> {
    const listing = await listChatBots(this.opts.stateDir, chatId);
    return {
      chat_id: chatId,
      known: listing.known.map(toWireChatBot),
      trusted: listing.trusted.map(toWireChatBot),
    };
  }

  private async onCardAction(event: FeishuCardActionEvent): Promise<unknown> {
    return sessionHandleCardAction(this.handle, event);
  }

  // ── Notifications ──────────────────────────────────────────────────────

  private notify(
    target: FeishuTarget,
    card: unknown,
    anchorTeamName: string | null,
  ): void {
    const lifecycle = this.lifecycle;
    if (lifecycle === undefined || !lifecycle.fence.isCurrent()) return;
    void this.track(
      lifecycle,
      this.sendNotification(lifecycle, target, card, anchorTeamName),
    ).catch(() => undefined);
  }

  private async sendNotification(
    lifecycle: FeishuSessionLifecycle,
    target: FeishuTarget,
    card: unknown,
    anchorTeamName: string | null,
  ): Promise<void> {
    const outbound = this.targetRouter.notificationTarget(target);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!lifecycle.fence.isCurrent()) return;
      const requestController = new AbortController();
      const abortRequest = (): void => requestController.abort();
      lifecycle.controller.signal.addEventListener('abort', abortRequest, {
        once: true,
      });
      if (lifecycle.controller.signal.aborted) abortRequest();
      try {
        const result = await runFeishuBoundedOperation({
          signal: lifecycle.controller.signal,
          deadlineAt: Date.now() + FEISHU_BINDING_NOTIFICATION_SEND_TIMEOUT_MS,
          operation: () => sessionSendCard(
            this.handleForFence(lifecycle.fence),
            {
              target: outbound,
              card,
              signal: requestController.signal,
              mode: 'background',
            },
          ),
        });
        this.onNotificationSent(target, anchorTeamName, result.messageIds[0]);
        return;
      } catch (err) {
        if (isFeishuOperationError(err, 'aborted')) return;
        requestController.abort();
        const retrying = attempt === 1 && lifecycle.fence.isCurrent();
        this.opts.log.warn(
          {
            dispatcher_id: this.opts.dispatcherId,
            channel_id: this.opts.channelId,
            target: describeTarget(target),
            attempt,
            err: { message: errorMessage(err) },
          },
          retrying
            ? 'Feishu binding notification failed; retrying once'
            : 'Feishu binding notification failed after retry',
        );
        if (!retrying) return;
      } finally {
        lifecycle.controller.signal.removeEventListener('abort', abortRequest);
      }
    }
  }

  /**
   * A sent notification is also the first message this session has seen in a
   * freshly provisioned topic, which makes it two useful things: an address
   * this Channel can reply into later, and a fallback anchor for the Team's
   * first card if it speaks before anyone writes to it.
   */
  private onNotificationSent(
    target: FeishuTarget,
    anchorTeamName: string | null,
    messageId: string | undefined,
  ): void {
    if (messageId === undefined || messageId === '') return;
    this.targetRouter.observe(messageId, target);
    if (anchorTeamName === null) return;
    const leaderName = this.leaderNames.get(anchorTeamName);
    if (leaderName === undefined) return;
    this.cot.setBindingFallbackAnchor(anchorTeamName, leaderName, {
      chatId: target.chatId,
      messageId,
      target,
    });
  }

  // ── Handles ────────────────────────────────────────────────────────────

  get handle(): SessionHandle {
    return this.handleForFence(this.lifecycle?.fence ?? this.inactiveFence);
  }

  private handleForFence(fence: FeishuSessionFence): SessionHandle {
    return sessionHandle({
      opts: this.opts,
      bot: this.bot,
      accessMutex: this._accessMutex,
      botDisplayName: this.bot.botDisplayName ?? 'Dreamux bot',
      targetRouter: this.targetRouter,
      sessionFence: fence,
      delivery: this,
    });
  }

  private async track<T>(
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
}

function submitOutcome(result: TeamSubmitResult): FeishuSubmitOutcome {
  switch (result.status) {
    case 'submitted':
      return { status: 'submitted', turnId: result.turn_id ?? null };
    case 'duplicate':
    case 'stopped':
      return { status: result.status };
    default:
      return { status: result.status, error: result.error ?? null };
  }
}

/** Map a peer bot to the `list_chat_bots` wire shape. */
export function toWireChatBot(bot: PeerBot): WireChatBot {
  return {
    open_id: bot.openId,
    ...(bot.name !== undefined && bot.name !== '' ? { name: bot.name } : {}),
  };
}
