/**
 * Session-owned COT state, keyed by the recipient it presents.
 *
 * One recipient — a TeamLeader, or the Dispatcher Agent — owns exactly one
 * standing anchor and at most one open card, whichever Feishu chat, DM, group,
 * or topic supplied that anchor. A target is a property of the anchor and
 * nothing else: it is not a presentation identity, not a state key, and not a
 * partition, so a conversation that moves between chats moves its one card
 * rather than growing a second.
 *
 * Nothing here is durable. Restarting the session loses every anchor and every
 * open-card reference by design; there is no restore, replay, or backfill.
 *
 * A presentation's outbox is this recipient's own queue: `CotOutbox` owns the
 * bounded buffer and the append-batch split, calling into `./bytes.js` for
 * every fitting check, but the queue itself and its drop bookkeeping are this
 * module's, not a bag passed to free functions.
 */
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import { appendBatchFits, cotEventBytes, outboxAdmits } from './bytes.js';
import type { FeishuCotTerminal } from './card.js';
import { sameTarget, targetKey, type FeishuTarget } from '../routing/target.js';

const IDENTITY_KEY_SEPARATOR = '\0';

const FEISHU_COT_FENCED_LEADERS_MAX = 512;
const FEISHU_COT_FENCED_TARGETS_MAX = 512;

/**
 * The visible Feishu message a chain-of-thought card hangs under.
 *
 * The anchor is entirely the Channel's: it is captured from the inbound message
 * this session is about to submit, or from the binding card this session just
 * sent for a Team, and Core never carries it. `target` is kept beside the ids
 * so a binding that moves away can retire exactly the anchors that pointed at
 * it.
 */
export interface VisibleMessageAnchor {
  readonly chatId: string;
  readonly messageId: string;
  readonly target: FeishuTarget;
  readonly servingTarget: FeishuTarget | null;
}

export type CotOutboxAdmission =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly firstDrop: boolean;
      readonly bufferedEvents: number;
      readonly bufferedBytes: number;
    };

/** Bounded buffering and append-batch selection for one COT presentation. */
export class CotOutbox {
  private readonly queue: FeishuCotEventInput[] = [];
  private byteTotal = 0;
  droppedEvents = 0;

  admit(events: readonly FeishuCotEventInput[]): CotOutboxAdmission {
    const check = outboxAdmits(this.queue.length, this.byteTotal, events);
    if (!check.fits) {
      const firstDrop = this.droppedEvents === 0;
      this.droppedEvents += events.length;
      return {
        accepted: false,
        firstDrop,
        bufferedEvents: this.queue.length,
        bufferedBytes: this.byteTotal,
      };
    }
    this.queue.push(...events);
    this.byteTotal += check.incomingBytes;
    return { accepted: true };
  }

  hasEvents(): boolean {
    return this.queue.length > 0;
  }

  clear(): void {
    this.queue.length = 0;
    this.byteTotal = 0;
  }

  /** Pull as many queued events as one append call to `cotId`/`messageId` can carry. */
  takeAppendBatch(cotId: string, messageId: string): FeishuCotEventInput[] {
    const batch: FeishuCotEventInput[] = [];
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next === undefined) break;
      if (!appendBatchFits(cotId, messageId, [...batch, next])) break;
      this.queue.shift();
      this.byteTotal -= cotEventBytes(next);
      batch.push(next);
    }
    return batch;
  }
}

export interface CotPresentation {
  readonly id: string;
  readonly generation: number;
  readonly chatId: string;
  readonly originMessageId: string;
  phase: 'creating' | 'writing';
  cotId: string | null;
  messageId: string | null;
  readonly outbox: CotOutbox;
  terminalIntent: FeishuCotTerminal | null;
  flushQueued: boolean;
  closed: boolean;
}

/**
 * Who a card belongs to.
 *
 * The two recipients differ only in identity and in the outer lifecycle policy
 * applied around them: a TeamLeader is additionally fenced by its Team's close
 * and by route removal, and the Dispatcher has no Team to be fenced by. Every
 * anchor, card open, append, interrupt, and close transition is the same for
 * both.
 */
export type CotRecipientIdentity =
  | { readonly kind: 'leader'; readonly teamName: string }
  | { readonly kind: 'dispatcher' };

/** One recipient's presentation state; the whole COT model is a map of these. */
export class CotState {
  generation = 0;
  anchor: VisibleMessageAnchor | null = null;
  active: CotPresentation | null = null;
  readonly openCalls = new Map<string, { readonly generation: number }>();
  tail: Promise<void> = Promise.resolve();
  inFlight = 0;

  constructor(readonly identity: CotRecipientIdentity) {}

  /** Keyed on the runtime's own call id: a provider folds any number of
   * submissions into one native turn, so there is no turn half to add. */
  rememberOpenCall(callKey: string, maximum: number): void {
    this.openCalls.delete(callKey);
    if (this.openCalls.size >= maximum) {
      const oldest = this.openCalls.keys().next();
      if (!oldest.done) this.openCalls.delete(oldest.value);
    }
    this.openCalls.set(callKey, { generation: this.generation });
  }

  /** Idle and anchorless, and not part of a session still closing down. */
  isReapable(sessionClosed: boolean): boolean {
    return (
      !sessionClosed &&
      this.inFlight === 0 &&
      this.active === null &&
      this.anchor === null &&
      this.openCalls.size === 0
    );
  }
}

interface LeaderTargetFence {
  readonly leaderKey: string;
  readonly target: FeishuTarget;
}

/**
 * What a leader may no longer present into.
 *
 * Two facts fence a card: the Team closed, and the route that produced the
 * anchor was taken away. Both are local — one arrives as `team.state`, the
 * other is this Channel's own unbind — so the fence needs no Core event. It is
 * the whole of the TeamLeader's extra lifecycle policy; the Dispatcher, having
 * no Team, is never fenced.
 */
export class LeaderLifecycleFence {
  private readonly leaders = new Set<string>();
  private readonly targets = new Map<string, LeaderTargetFence>();

  blocksAnchor(leaderKey: string, anchor: VisibleMessageAnchor): boolean {
    if (this.leaders.has(leaderKey)) return true;
    for (const fenced of this.targets.values()) {
      if (
        fenced.leaderKey === leaderKey &&
        sameTarget(fenced.target, anchor.target)
      ) {
        return true;
      }
    }
    return false;
  }

  onTeamState(
    event: { teamName: string; leaderName: string; status: string },
    states: Map<string, CotState>,
    interrupt: (key: string, state: CotState) => void,
  ): void {
    const eventKey = cotRecipientKey({
      kind: 'leader',
      teamName: event.teamName,
    });
    if (event.status !== 'closed') {
      this.leaders.delete(eventKey);
      this.clearTargetsForLeader(eventKey);
      return;
    }
    this.rememberLeader(eventKey);
    for (const [key, state] of states) {
      if (!isTeamLeaderOf(state, event.teamName)) continue;
      this.rememberLeader(key);
      interrupt(key, state);
    }
  }

  /** A binding this Channel just removed or moved to another Team. */
  onRouteReleased(
    input: { teamName: string; target: FeishuTarget },
    states: Map<string, CotState>,
    interrupt: (key: string, state: CotState) => void,
  ): void {
    for (const [key, state] of states) {
      if (!isTeamLeaderOf(state, input.teamName)) continue;
      this.rememberTarget(key, input.target);
      if (
        state.anchor !== null &&
        (sameTarget(state.anchor.target, input.target) ||
          (state.anchor.servingTarget !== null &&
            sameTarget(state.anchor.servingTarget, input.target)))
      ) {
        interrupt(key, state);
      }
    }
  }

  /** A binding this Channel just installed re-opens presentation for it. */
  onRouteClaimed(input: { teamName: string; target: FeishuTarget }): void {
    for (const [key, fenced] of this.targets) {
      if (
        fenced.leaderKey ===
          `leader${IDENTITY_KEY_SEPARATOR}${input.teamName}` &&
        sameTarget(fenced.target, input.target)
      ) {
        this.targets.delete(key);
      }
    }
  }

  clear(): void {
    this.leaders.clear();
    this.targets.clear();
  }

  private rememberLeader(key: string): void {
    if (this.leaders.has(key)) return;
    if (this.leaders.size >= FEISHU_COT_FENCED_LEADERS_MAX) {
      const oldest = this.leaders.values().next().value as string | undefined;
      if (oldest !== undefined) this.leaders.delete(oldest);
    }
    this.leaders.add(key);
  }

  private rememberTarget(leaderKey: string, target: FeishuTarget): void {
    const key = `${leaderKey}${IDENTITY_KEY_SEPARATOR}${targetKey(target)}`;
    if (this.targets.has(key)) return;
    if (this.targets.size >= FEISHU_COT_FENCED_TARGETS_MAX) {
      const oldest = this.targets.keys().next().value as string | undefined;
      if (oldest !== undefined) this.targets.delete(oldest);
    }
    this.targets.set(key, { leaderKey, target });
  }

  private clearTargetsForLeader(leaderKey: string): void {
    for (const [key, fenced] of this.targets) {
      if (fenced.leaderKey === leaderKey) this.targets.delete(key);
    }
  }
}

function isTeamLeaderOf(state: CotState, teamName: string): boolean {
  return (
    state.identity.kind === 'leader' && state.identity.teamName === teamName
  );
}

/**
 * The recipient an event or a routing decision names.
 *
 * Returns `null` for anything that is not one of the two presented recipients —
 * a Team member, a Dispatcher-scoped TeamMate — so the caller never has to
 * repeat the role test.
 */
export function cotRecipientOf(event: {
  role: string;
  teamName: string | null;
  teammateName: string;
}): CotRecipientIdentity | null {
  if (typeof event.teammateName !== 'string' || event.teammateName === '') {
    return null;
  }
  if (event.role === 'dispatcher' && event.teamName === null) {
    return { kind: 'dispatcher' };
  }
  if (
    event.role === 'team_leader' &&
    typeof event.teamName === 'string' &&
    event.teamName !== ''
  ) {
    return {
      kind: 'leader',
      teamName: event.teamName,
    };
  }
  return null;
}

/** The recipient an optimistic inbound submission names, before Core answers. */
export function inboundRecipient(
  teamName: string | null,
): CotRecipientIdentity | null {
  if (teamName === null) return { kind: 'dispatcher' };
  return typeof teamName === 'string' && teamName !== ''
    ? { kind: 'leader', teamName }
    : null;
}

export function cotRecipientKey(identity: CotRecipientIdentity): string {
  return identity.kind === 'leader'
    ? `leader${IDENTITY_KEY_SEPARATOR}${identity.teamName}`
    : 'dispatcher';
}

export function ensureCotState(
  states: Map<string, CotState>,
  identity: CotRecipientIdentity,
): CotState {
  const key = cotRecipientKey(identity);
  const existing = states.get(key);
  if (existing !== undefined) return existing;
  const created = new CotState(identity);
  states.set(key, created);
  return created;
}

export function prepareVisibleAnchor(
  anchor: VisibleMessageAnchor,
): VisibleMessageAnchor | null {
  if (
    typeof anchor.chatId !== 'string' ||
    anchor.chatId === '' ||
    typeof anchor.messageId !== 'string' ||
    anchor.messageId === '' ||
    anchor.target.chatId !== anchor.chatId
  ) {
    return null;
  }
  return {
    chatId: anchor.chatId,
    messageId: anchor.messageId,
    target: { ...anchor.target },
    servingTarget:
      anchor.servingTarget === null ? null : { ...anchor.servingTarget },
  };
}
