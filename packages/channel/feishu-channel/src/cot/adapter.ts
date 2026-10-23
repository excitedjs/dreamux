/**
 * Session-owned visible-message COT state machine.
 *
 * One recipient owns one standing anchor and at most one open card. Three
 * facts move it, and nothing else does:
 *
 * - A Channel user message becomes that recipient's anchor before Core is
 *   invoked. If Core later proves there was no admission, that optimistic
 *   anchor is retired; an ambiguous outcome keeps it because it proves nothing.
 * - Everything Core projects for that recipient is shown once it has an
 *   anchor, except the one input body this Channel already displayed as the
 *   visible inbound message that established that anchor.
 * - A `turn.ended` activity closes the card. It is the only terminal a card
 *   has, and it names no submission on purpose: a provider folds any number of
 *   submissions into one native turn, so nothing per-submission could say
 *   whether the card the operator is watching has finished.
 *
 * The standing anchor outlives every card. A create or append that fails
 * abandons that one presentation and nothing else: the anchor stays, and the
 * next opening activity tries to open a card there again.
 *
 * One more thing can give a TeamLeader an anchor, and it initializes without
 * ever moving one: a bind card that was actually sent, while the leader has
 * none (`setFallbackAnchorIfAbsent`). Nothing else is durable or restored, so
 * a leader whose session restarted stays anchorless until a user message.
 *
 * This is also the whole fail-open seam between the live Feishu session and
 * this state machine: every entry point a session subscription or a routing
 * decision reaches (`handle`, `beginInboundSubmission`,
 * `setFallbackAnchorIfAbsent`, `onRouteReleased`, `onRouteClaimed`) is gated
 * on the session's own liveness and wrapped so a bug here degrades to "no
 * card", never to a failed Reply or a stuck close.
 * `start`/`close` are the only two calls a session makes outside that gate.
 */
import type { FeishuLifecycle } from '../session/lifecycle.js';
import { randomUUID } from 'node:crypto';

import type {
  ChannelCoreEvent,
  DreamuxLogger,
  RuntimeActivity,
  TeamStateEvent,
  TeammateActivityEvent,
  TeammateInputEvent,
} from '@excitedjs/dreamux-types';
import type {
  FeishuCotClient,
  FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

import type { FeishuTarget } from '../routing/target.js';
import {
  COT_CONTEXT_COMPACTED_LABEL,
  COT_TURN_INTERRUPTED_LABEL,
  FEISHU_COT_OPENING_LABELS,
  inputDisplayContent,
  mergeAdjacentReasoningDelta,
  runStartedEvent,
  textMessageEvents,
  tokenUsageSummary,
  toolCallResultEvents,
  toolCallStartEvents,
  type CotReasoningActivity,
  type CotToolCallActivity,
  type FeishuCotTerminal,
} from './card.js';
import {
  cotErrorCategory,
  cotLogScope,
  type CotLogScope,
} from './diagnostics.js';
import { FeishuInboundCorrelations } from './inbound-correlations.js';
import {
  closeReasoningParts,
  commitReasoningProjection,
  planReasoningActivity,
} from './reasoning.js';
import {
  CotOutbox,
  CotState,
  LeaderLifecycleFence,
  cotRecipientKey,
  cotRecipientOf,
  ensureCotState,
  inboundRecipient,
  prepareVisibleAnchor,
  type CotAdjacentMerge,
  type CotPresentation,
  type VisibleMessageAnchor,
} from './recipients.js';
import { CotCardWriter } from './writer.js';

const FEISHU_COT_OPEN_TOOL_CALLS_MAX = 512;
const FEISHU_COT_CLOSE_DRAIN_MS = 5_000;

export interface FeishuCotAdapterOptions {
  readonly dispatcherId: string;
  readonly channelId: string | undefined;
  readonly log: DreamuxLogger;
  readonly cotClient: FeishuCotClient | undefined;
  readonly lifecycle: FeishuLifecycle;
  /** Whether native reasoning reaches the card. Off when the config omits it. */
  readonly cotReasoning: boolean;
}

/** One optimistic anchor transition, scoped to the generation it created. */
export interface FeishuCotInboundSubmission {
  /** Release the caller-owned id if no submitted fact consumed it. */
  release(): void;
  /** Retire this anchor only if no newer inbound has replaced it. */
  retire(): void;
}

export class FeishuCotAdapter {
  private readonly states = new Map<string, CotState>();
  private readonly inboundCorrelations = new FeishuInboundCorrelations();
  private readonly leaderFence = new LeaderLifecycleFence();
  private readonly controller = new AbortController();
  private readonly writer: CotCardWriter;
  private closed = false;

  constructor(private readonly opts: FeishuCotAdapterOptions) {
    this.writer = new CotCardWriter({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      log: opts.log,
      cotClient: opts.cotClient,
      signal: this.controller.signal,
      onSettled: (key, state) => this.reapState(key, state),
    });
  }

  /**
   * One subscription, demultiplexed here.
   *
   * Two facts carry the whole conversation, split by producer: Core says what
   * it admitted, and the runtime says what it did. The input echoes the
   * caller-owned id, so a body this session itself submitted is recognized and
   * hidden once rather than shown twice; it does not move the anchor.
   */
  handle(event: ChannelCoreEvent): void {
    this.guardLive(
      'listener failed; display only',
      () => {
        switch (event.kind) {
          case 'teammate.input':
            this.onInput(event);
            return;
          case 'teammate.activity':
            this.onActivity(event);
            return;
          case 'team.state':
            this.onTeamState(event);
            return;
          default:
            return;
        }
      },
      undefined,
    );
  }

  /**
   * Take the Channel's own anchor before invoking Core.
   *
   * The selected recipient is already a Channel routing decision. Moving now
   * means the input fact, its body, and any early activity Core publishes
   * synchronously cannot land on the predecessor. The caller's source id is
   * registered here and consumed by the `teammate.input` fact that carries it,
   * which is how the already-visible user body is recognized as this
   * session's own and not shown a second time.
   */
  beginInboundSubmission(input: {
    readonly teamName: string | null;
    readonly anchor: VisibleMessageAnchor;
    readonly sourceId: string;
  }): FeishuCotInboundSubmission | null {
    return this.guardLive(
      'inbound anchor failed; display only',
      () => this.beginInboundSubmissionUnguarded(input),
      null,
    );
  }

  /**
   * A Team's bind card is on screen, offered as its leader's first anchor.
   *
   * It is the one anchor a recipient may take without a Channel user message,
   * and only while it has none: a leader with no conversation yet has nowhere
   * else to present, and the card announcing the binding is a visible message
   * in the chat it will answer. It only ever initializes. A leader that
   * already holds an anchor keeps it, and that includes an inbound message
   * that arrived while this card was still being sent, so the offer is judged
   * here, when the send has finished, and not when the bind committed. A leader
   * whose Team closed takes nothing. Whether the route still serves the card's
   * conversation is the caller's to check against the routing document: the
   * fence remembers a released target only for a leader that already had COT
   * state. The Dispatcher has no equivalent: its first anchor is always a user
   * message.
   */
  setFallbackAnchorIfAbsent(
    teamName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    this.guardLive(
      'binding fallback anchor failed; notification unchanged',
      () => {
        const identity = inboundRecipient(teamName);
        const prepared = prepareVisibleAnchor(anchor);
        if (identity === null || prepared === null) return;
        const key = cotRecipientKey(identity);
        if (this.leaderFence.blocksAnchor(key, prepared)) return;
        const state = ensureCotState(this.states, identity);
        if (state.anchor !== null) return;
        state.anchor = prepared;
      },
      undefined,
    );
  }

  /** This Channel removed or moved a binding away from a Team. */
  onRouteReleased(input: { teamName: string; target: FeishuTarget }): void {
    this.guardLive(
      'route release failed; display only',
      () => this.onRouteReleasedUnguarded(input),
      undefined,
    );
  }

  /** This Channel installed a binding, so the Team may present there again. */
  onRouteClaimed(input: { teamName: string; target: FeishuTarget }): void {
    this.guardLive(
      'route claim failed; display only',
      () => this.onRouteClaimedUnguarded(input),
      undefined,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.closed = true;
      for (const [key, state] of [...this.states]) {
        state.generation += 1;
        state.anchor = null;
        state.openCalls.clear();
        this.detach(key, state, 'interrupted');
      }
      await this.writer.drain(FEISHU_COT_CLOSE_DRAIN_MS);
      this.controller.abort();
      this.inboundCorrelations.clear();
      this.states.clear();
      this.leaderFence.clear();
    } catch (err) {
      this.logSeamFailure('adapter close failed', err);
    }
  }

  /**
   * The fail-open seam every live entry point runs through: no-op once the
   * session is not live, and a thrown error degrades to a logged warning
   * rather than a failed Reply or a stuck close.
   */
  private guardLive<T>(what: string, run: () => T, fallback: T): T {
    if (this.closed || !this.opts.lifecycle.isLive()) return fallback;
    try {
      return run();
    } catch (err) {
      this.logSeamFailure(what, err);
      return fallback;
    }
  }

  private logSeamFailure(what: string, err: unknown): void {
    try {
      this.opts.log.warn(
        { dispatcher_id: this.opts.dispatcherId, ...cotErrorCategory(err) },
        `Feishu COT ${what}`,
      );
    } catch {
      // Diagnostics are part of the fail-open seam too. A hostile or broken
      // logger must not leak a display-only failure back into Reply or
      // teardown.
    }
  }

  private beginInboundSubmissionUnguarded(input: {
    readonly teamName: string | null;
    readonly anchor: VisibleMessageAnchor;
    readonly sourceId: string;
  }): FeishuCotInboundSubmission | null {
    if (this.closed) return null;
    const anchor = prepareVisibleAnchor(input.anchor);
    if (anchor === null) return null;
    const identity = inboundRecipient(input.teamName);
    if (identity === null) return null;
    const key = cotRecipientKey(identity);
    if (
      identity.kind === 'leader' &&
      this.leaderFence.blocksAnchor(key, anchor)
    ) {
      return null;
    }
    const state = ensureCotState(this.states, identity);
    this.advanceAnchor(key, state, anchor);
    const generation = state.generation;
    const release = this.inboundCorrelations.begin(input.sourceId);
    this.openReceipt(key, state);
    return {
      release,
      retire: () => {
        release();
        if (
          this.closed ||
          this.states.get(key) !== state ||
          state.generation !== generation
        ) {
          return;
        }
        this.advanceAnchor(key, state, null);
      },
    };
  }

  /**
   * Core admitted one input for this recipient.
   *
   * The body is shown unless it is the one this session just submitted, which
   * the operator can already see as their own Feishu message. Recognition is a
   * comparison against the ids this session issued: a `sourceId` is present on
   * cron fires, task push-backs, and restart notices too, so its mere presence
   * proves nothing. What is shown for an automated push-back is the label the
   * presentation layer picks, not the notification the model reads.
   */
  private onInput(event: TeammateInputEvent): void {
    const found = this.stateFor(event);
    if (found === null) return;
    if (this.inboundCorrelations.consume(event.sourceId)) return;
    this.acceptDisplayText(
      found.key,
      found.state,
      'user',
      randomUUID(),
      inputDisplayContent(event),
      'input',
    );
  }

  /** Pick one independent flavour label when this append-only card opens. */
  private openReceipt(key: string, state: CotState): void {
    const label =
      FEISHU_COT_OPENING_LABELS[
        Math.floor(Math.random() * FEISHU_COT_OPENING_LABELS.length)
      ]!;
    this.acceptOpeningActivityForState(
      key,
      state,
      textMessageEvents({
        namespace: 'receipt',
        sourceId: randomUUID(),
        role: 'assistant',
        content: label,
      }),
    );
  }

  private onActivity(event: TeammateActivityEvent): void {
    const found = this.stateFor(event);
    if (found === null) return;
    switch (event.activity.kind) {
      case 'context.compacted':
        this.acceptDisplayText(
          found.key,
          found.state,
          'assistant',
          event.activity.id,
          COT_CONTEXT_COMPACTED_LABEL,
          'compacted',
        );
        return;
      case 'turn.interrupted':
        this.acceptDisplayText(
          found.key,
          found.state,
          'assistant',
          event.activity.id,
          COT_TURN_INTERRUPTED_LABEL,
          'interrupted',
        );
        return;
      case 'assistant.message':
        this.acceptDisplayText(
          found.key,
          found.state,
          'assistant',
          event.activity.id,
          event.activity.text,
          'message',
        );
        return;
      case 'assistant.reasoning':
        this.acceptReasoningActivity(found.key, found.state, event.activity);
        return;
      case 'tool.call':
        this.acceptToolCallActivity(found.key, found.state, event.activity);
        return;
      case 'token.usage':
        this.acceptDisplayText(
          found.key,
          found.state,
          'assistant',
          event.activity.id,
          tokenUsageSummary(event.activity),
          'usage',
        );
        return;
      case 'turn.ended':
        this.finishCard(found.key, found.state, event.activity);
        return;
      default: {
        // Compile-time exhaustiveness: every projected activity kind needs a
        // dispatch arm, or its fact silently never reaches a card.
        const exhaustive: never = event.activity;
        void exhaustive;
        return;
      }
    }
  }

  /** One tool call, opening a row and later filling in its result. */
  private acceptToolCallActivity(
    key: string,
    state: CotState,
    event: CotToolCallActivity,
  ): void {
    if (state.anchor === null) return;
    if (event.status === 'started') {
      const events = toolCallStartEvents(event);
      if (events.length === 0) return;
      const accepted = this.acceptOpeningActivityForState(key, state, events);
      if (accepted) {
        state.rememberOpenCall(event.id, FEISHU_COT_OPEN_TOOL_CALLS_MAX);
      }
      return;
    }
    const opened = state.openCalls.get(event.id);
    if (opened === undefined) return;
    if (opened.generation !== state.generation) {
      state.openCalls.delete(event.id);
      return;
    }
    const presentation = state.active;
    if (
      presentation === null ||
      presentation.closed ||
      presentation.terminalIntent !== null
    ) {
      state.openCalls.delete(event.id);
      return;
    }
    const events = toolCallResultEvents(event);
    state.openCalls.delete(event.id);
    if (events.length === 0) return;
    if (
      this.writer.admit(state, presentation, events) &&
      presentation.phase === 'writing'
    ) {
      this.writer.schedule(key, state, presentation);
    }
  }

  /** One line of assistant- or user-attributed text, if this recipient can show anything at all. */
  private acceptDisplayText(
    key: string,
    state: CotState,
    role: 'user' | 'assistant',
    displayId: string,
    content: string,
    namespace: string,
  ): void {
    if (state.anchor === null) return;
    const events = textMessageEvents({
      namespace,
      sourceId: displayId,
      role,
      content,
    });
    if (events.length === 0) {
      this.opts.log.debug(
        {
          ...this.logScope(state),
          activity: role,
          reason: 'empty_after_projection',
        },
        'Feishu COT dropped activity with no safe display content',
      );
      return;
    }
    this.acceptOpeningActivityForState(key, state, events);
  }

  /**
   * One native reasoning increment, when the operator enabled reasoning.
   *
   * The projection decides what the increment adds against the parts this
   * card has open; its state is committed only after admission, so a dropped
   * increment never makes the next one believe the prefix was already shown.
   * See `./reasoning.js` for the block and section rules.
   */
  private acceptReasoningActivity(
    key: string,
    state: CotState,
    activity: CotReasoningActivity,
  ): void {
    if (!this.opts.cotReasoning) return;
    if (state.anchor === null) return;
    const projection = planReasoningActivity(
      activity,
      state.active?.reasoningParts,
    );
    if (projection === null) return;
    const accepted = this.acceptOpeningActivityForState(
      key,
      state,
      projection.events,
      projection.coalescible ? mergeAdjacentReasoningDelta : undefined,
    );
    const parts = state.active?.reasoningParts;
    if (accepted && parts !== undefined) {
      commitReasoningProjection(parts, projection);
    }
  }

  /**
   * The producer stopped, so the card it was writing is finished.
   *
   * This is the only terminal a card has. It names no logical turn — a provider
   * folded whatever it folded — so it closes whatever this recipient currently
   * has open, which is exactly the one card the operator is watching. A reason
   * is printed on that card before it closes, because an operator reading a
   * card that just stopped needs to know why. Printing is the only way it gets
   * there: the failure terminal's own message field is not rendered by the
   * client, so this text is load-bearing rather than a second copy.
   *
   * It is a terminal and never an opening activity: with no card open there is
   * nothing to finish, so the fact is ignored rather than turned into a card
   * that exists only to be closed. That also makes a repeated end harmless.
   */
  private finishCard(
    key: string,
    state: CotState,
    end: Extract<RuntimeActivity, { kind: 'turn.ended' }>,
  ): void {
    if (state.active === null) return;
    if (end.reason !== null) {
      this.acceptDisplayText(
        key,
        state,
        'assistant',
        randomUUID(),
        end.reason,
        'end',
      );
    }
    state.openCalls.clear();
    this.detach(key, state, end.status);
    this.reapState(key, state);
  }

  private onTeamState(event: TeamStateEvent): void {
    if (this.closed) return;
    this.leaderFence.onTeamState(event, this.states, (key, state) =>
      this.advanceAnchor(key, state, null),
    );
  }

  private onRouteReleasedUnguarded(input: {
    teamName: string;
    target: FeishuTarget;
  }): void {
    if (this.closed) return;
    this.leaderFence.onRouteReleased(input, this.states, (key, state) =>
      this.advanceAnchor(key, state, null),
    );
  }

  private onRouteClaimedUnguarded(input: {
    teamName: string;
    target: FeishuTarget;
  }): void {
    if (this.closed) return;
    this.leaderFence.onRouteClaimed(input);
  }

  private stateFor(event: {
    role: string;
    teamName: string | null;
    teammateName: string;
  }): { key: string; state: CotState } | null {
    if (this.closed) return null;
    const identity = cotRecipientOf(event);
    if (identity === null) return null;
    const key = cotRecipientKey(identity);
    const state = this.states.get(key);
    return state === undefined ? null : { key, state };
  }

  /**
   * Replace this recipient's anchor, closing whatever it currently shows.
   *
   * Whoever calls this has already earned the transition — the Channel is
   * submitting its own inbound, or a lifecycle fence is retiring it — so there
   * is nothing left to decide here.
   * A native turn still running keeps producing into the successor card,
   * because the operator's newest message is where they are now looking; a
   * `null` anchor is the fence retiring the recipient's presentation entirely.
   */
  private advanceAnchor(
    key: string,
    state: CotState,
    anchor: VisibleMessageAnchor | null,
  ): void {
    state.generation += 1;
    this.detach(key, state, anchor === null ? 'interrupted' : 'completed');
    state.anchor = anchor;
    if (anchor === null) {
      state.openCalls.clear();
    }
    this.reapState(key, state);
  }

  /**
   * Stop writing to this card and record how it ends. Anchor replacement
   * completes the old card; retirement and session closure interrupt it.
   */
  private detach(
    key: string,
    state: CotState,
    terminal: FeishuCotTerminal,
  ): void {
    const presentation = state.active;
    state.active = null;
    if (
      presentation === null ||
      presentation.terminalIntent !== null ||
      presentation.closed
    ) {
      return;
    }
    // A block still open when the card stops would otherwise leave the stream
    // without its message end; the close events are queued ahead of the
    // terminal, so the card ends in the order it was written.
    this.closeOpenReasoning(state, presentation);
    presentation.terminalIntent = terminal;
    if (presentation.phase === 'writing') {
      this.writer.schedule(key, state, presentation);
    }
  }

  private closeOpenReasoning(
    state: CotState,
    presentation: CotPresentation,
  ): void {
    const events = closeReasoningParts(presentation.reasoningParts);
    if (events.length > 0) this.writer.admit(state, presentation, events);
  }

  /**
   * Put displayable events on this recipient's card, opening one if needed.
   *
   * Opening is retried freely: the anchor is standing state and a card that
   * failed is gone, so the next activity simply tries again there. Repeated
   * failure costs one create attempt per activity, which is the price of not
   * letting a transient platform error silence a live conversation.
   */
  private acceptOpeningActivityForState(
    key: string,
    state: CotState,
    events: FeishuCotEventInput[],
    mergeAdjacent?: CotAdjacentMerge,
  ): boolean {
    const presentation = state.active;
    if (presentation === null) {
      const anchor = state.anchor;
      if (anchor === null) return false;
      const created: CotPresentation = {
        id: randomUUID(),
        chatId: anchor.chatId,
        originMessageId: anchor.messageId,
        phase: 'creating',
        cotId: null,
        messageId: null,
        outbox: new CotOutbox(),
        reasoningParts: new Map(),
        lastAppendStartedAt: null,
        terminalIntent: null,
        flushQueued: false,
        closed: false,
      };
      if (
        !this.writer.admit(state, created, [
          runStartedEvent(created.id),
          ...events,
        ])
      ) {
        return false;
      }
      state.active = created;
      this.writer.open(key, state, created);
      return true;
    }
    if (presentation.closed || presentation.terminalIntent !== null) {
      return false;
    }
    const accepted = this.writer.admit(
      state,
      presentation,
      events,
      mergeAdjacent,
    );
    if (accepted && presentation.phase === 'writing') {
      this.writer.schedule(key, state, presentation);
    }
    return accepted;
  }

  private reapState(key: string, state: CotState): void {
    if (state.isReapable(this.closed) && this.states.get(key) === state) {
      this.states.delete(key);
    }
  }

  private logScope(state: CotState | undefined): CotLogScope {
    return cotLogScope({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      recipient: state?.identity,
    });
  }
}
