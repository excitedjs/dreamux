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
 */
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import type { FeishuCotRunStatus } from './feishu-cot-events.js';
import { sameTarget, targetKey, type FeishuTarget } from './routing/target.js';

const IDENTITY_KEY_SEPARATOR = '\0';

const FEISHU_COT_FENCED_LEADERS_MAX = 512;
const FEISHU_COT_FENCED_TARGETS_MAX = 512;

/**
 * How many of this Channel's own inbound turns may hold a body-suppression mark.
 *
 * The mark is best effort. Core publishes the user message synchronously inside
 * `team.submit`, while the anchor moves only after that call reports admission,
 * so the message this Channel already made visible has usually gone past before
 * its mark exists and the mark is never consumed. The bound is what keeps those
 * unconsumed marks from accumulating.
 */
const FEISHU_COT_SUPPRESSED_TURNS_MAX = 64;

/**
 * The visible Feishu message a chain-of-thought card hangs under.
 *
 * The anchor is entirely the Channel's: it is captured from the inbound message
 * this session is about to submit, or from a message this session just sent,
 * and Core never carries it. `target` is kept beside the ids so a binding that
 * moves away can retire exactly the anchors that pointed at it.
 */
export interface VisibleMessageAnchor {
  readonly chatId: string;
  readonly messageId: string;
  readonly target: FeishuTarget;
}

export interface CotOutboxState {
  readonly events: FeishuCotEventInput[];
  bytes: number;
  droppedEvents: number;
}

export interface CotPresentation {
  readonly id: string;
  readonly generation: number;
  readonly chatId: string;
  readonly originMessageId: string;
  phase: 'creating' | 'writing';
  cotId: string | null;
  messageId: string | null;
  readonly outbox: CotOutboxState;
  terminalIntent: FeishuCotRunStatus | null;
  flushQueued: boolean;
  closed: boolean;
}

/**
 * Who a card belongs to.
 *
 * The two recipients differ only in identity and in the outer lifecycle policy
 * applied around them: a TeamLeader is additionally fenced by its Team's close
 * and by route removal, and the Dispatcher has no Team to be fenced by. Every
 * anchor, card open, append, interrupt, and close transition below is the same
 * for both.
 */
export type CotRecipientIdentity =
  | { readonly kind: 'leader'; readonly teamName: string; readonly leaderName: string }
  | { readonly kind: 'dispatcher'; readonly agentName: string };

/** One recipient's presentation state; the whole COT model is a map of these. */
export interface CotState {
  readonly identity: CotRecipientIdentity;
  generation: number;
  anchor: VisibleMessageAnchor | null;
  active: CotPresentation | null;
  readonly openCalls: Map<string, { readonly generation: number }>;
  /**
   * Turns whose user body this Channel itself put on screen.
   *
   * The one thing a card hides is a copy of the Feishu message already visible
   * at its own anchor. Everything else a recipient receives — a task, a
   * notification, a cron fire, a system or restart notice, an unknown future
   * source — is shown, so this is a set of proven-duplicate turns rather than a
   * source whitelist.
   */
  readonly suppressedUserTurns: Set<string>;
  tail: Promise<void>;
  inFlight: number;
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
    event: { team_name: string; leader_name: string; status: string },
    states: Map<string, CotState>,
    interrupt: (key: string, state: CotState) => void,
  ): void {
    const eventKey = cotRecipientKey({
      kind: 'leader',
      teamName: event.team_name,
      leaderName: event.leader_name,
    });
    if (event.status !== 'closed') {
      this.leaders.delete(eventKey);
      this.clearTargetsForLeader(eventKey);
      return;
    }
    this.rememberLeader(eventKey);
    for (const [key, state] of states) {
      if (!isTeamLeaderOf(state, event.team_name)) continue;
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
        sameTarget(state.anchor.target, input.target)
      ) {
        interrupt(key, state);
      }
    }
  }

  /** A binding this Channel just installed re-opens presentation for it. */
  onRouteClaimed(input: { teamName: string; target: FeishuTarget }): void {
    for (const [key, fenced] of this.targets) {
      if (
        fenced.leaderKey.startsWith(
          `leader${IDENTITY_KEY_SEPARATOR}${input.teamName}${IDENTITY_KEY_SEPARATOR}`,
        ) &&
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
  return state.identity.kind === 'leader' && state.identity.teamName === teamName;
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
  team_name: string | null;
  teammate_name: string;
}): CotRecipientIdentity | null {
  if (typeof event.teammate_name !== 'string' || event.teammate_name === '') {
    return null;
  }
  if (event.role === 'dispatcher' && event.team_name === null) {
    return { kind: 'dispatcher', agentName: event.teammate_name };
  }
  if (
    event.role === 'team_leader' &&
    typeof event.team_name === 'string' &&
    event.team_name !== ''
  ) {
    return {
      kind: 'leader',
      teamName: event.team_name,
      leaderName: event.teammate_name,
    };
  }
  return null;
}

export function cotRecipientKey(identity: CotRecipientIdentity): string {
  return identity.kind === 'leader'
    ? `leader${IDENTITY_KEY_SEPARATOR}${identity.teamName}` +
      `${IDENTITY_KEY_SEPARATOR}${identity.leaderName}`
    : `dispatcher${IDENTITY_KEY_SEPARATOR}${identity.agentName}`;
}

export function ensureCotState(
  states: Map<string, CotState>,
  identity: CotRecipientIdentity,
): CotState {
  const key = cotRecipientKey(identity);
  const existing = states.get(key);
  if (existing !== undefined) return existing;
  const created: CotState = {
    identity,
    generation: 0,
    anchor: null,
    active: null,
    openCalls: new Map(),
    suppressedUserTurns: new Set(),
    tail: Promise.resolve(),
    inFlight: 0,
  };
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
  };
}

/** Mark one turn as carrying a body this Channel already made visible. */
export function suppressChannelBody(state: CotState, turnId: string): void {
  if (typeof turnId !== 'string' || turnId === '') return;
  const marks = state.suppressedUserTurns;
  marks.delete(turnId);
  if (marks.size >= FEISHU_COT_SUPPRESSED_TURNS_MAX) {
    const oldest = marks.values().next();
    if (!oldest.done) marks.delete(oldest.value);
  }
  marks.add(turnId);
}

/** Consume the mark, if this turn carries one. Marks are one-shot. */
export function takeChannelBodySuppression(
  state: CotState,
  turnId: string,
): boolean {
  return state.suppressedUserTurns.delete(turnId);
}

export function cotStateHasAnchor(state: CotState): boolean {
  return state.anchor !== null;
}

export function reapCotState(
  closed: boolean,
  key: string,
  state: CotState,
  states: Map<string, CotState>,
): void {
  if (
    closed ||
    state.inFlight > 0 ||
    state.active !== null ||
    state.anchor !== null ||
    state.openCalls.size > 0
  ) {
    return;
  }
  if (states.get(key) === state) states.delete(key);
}

export function cotOpenCallKey(turnId: string, callId: string): string {
  return `${turnId}${IDENTITY_KEY_SEPARATOR}${callId}`;
}

export function rememberOpenToolCall(
  openCalls: Map<string, { readonly generation: number }>,
  generation: number,
  callKey: string,
  maximum: number,
): void {
  openCalls.delete(callKey);
  if (openCalls.size >= maximum) {
    const oldest = openCalls.keys().next();
    if (!oldest.done) openCalls.delete(oldest.value);
  }
  openCalls.set(callKey, { generation });
}
