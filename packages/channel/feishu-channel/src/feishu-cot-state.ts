/** Session-owned COT state plus its pure identity and ledger helpers. */
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import type {
  DispatcherCotStateStore,
  DispatcherTurnState,
} from './feishu-cot-dispatcher-state.js';
import type { FeishuCotRunStatus } from './feishu-cot-events.js';
import { sameTarget, targetKey, type FeishuTarget } from './routing/target.js';

const IDENTITY_KEY_SEPARATOR = '\0';

const FEISHU_COT_FENCED_LEADERS_MAX = 512;
const FEISHU_COT_FENCED_TARGETS_MAX = 512;

/**
 * The visible Feishu message a chain-of-thought card hangs under.
 *
 * The anchor is now entirely the Channel's: it is captured from the inbound
 * message this session is about to submit, or from a message this session just
 * sent, and Core never carries it. `target` is kept beside the ids so a binding
 * that moves away can retire exactly the anchors that pointed at it.
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
  readonly turnId: string;
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
 * What every presented conversation has, whoever is answering it.
 *
 * The presentation machinery — outbox, generation fencing, open tool calls,
 * the serialized platform tail — is identical for a Dispatcher turn and a
 * TeamLeader's card. Only the correlation around it differs, so only that is
 * stated separately below.
 */
export interface CotStateBase {
  generation: number;
  anchor: VisibleMessageAnchor | null;
  active: CotPresentation | null;
  disabledGeneration: number | null;
  readonly openCalls: Map<string, { readonly generation: number }>;
  readonly pendingTurns: Map<string, { readonly generation: number }>;
  tail: Promise<void>;
  inFlight: number;
}

/**
 * One TeamLeader's presentation state.
 *
 * A leader keeps a standing anchor: later turns of the same conversation — a
 * completion reported back, a cron fire — write under the message the operator
 * is already watching. A Dispatcher turn does not, which is why it has its own
 * state in `feishu-cot-dispatcher-state.ts`.
 */
export interface LeaderState extends CotStateBase {
  readonly kind: 'leader';
  readonly teamName: string;
  readonly leaderName: string;
  admittedTurnId: string | null;
  nextAnchor: VisibleMessageAnchor | null;
}

/** The state a presentation helper operates on, whichever it is. */
export type CotState = LeaderState | DispatcherTurnState;

interface LeaderTargetFence {
  readonly leaderKey: string;
  readonly target: FeishuTarget;
}

/**
 * What a leader may no longer present into.
 *
 * Two facts fence a card: the Team closed, and the route that produced the
 * anchor was taken away. Both are now local — one arrives as `team.state`, the
 * other is this Channel's own unbind — so the fence needs no Core event.
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
    leaders: Map<string, LeaderState>,
    interrupt: (key: string, state: LeaderState) => void,
  ): void {
    const eventKey = cotLeaderKey(event.team_name, event.leader_name);
    if (event.status !== 'closed') {
      this.leaders.delete(eventKey);
      this.clearTargetsForLeader(eventKey);
      return;
    }
    this.rememberLeader(eventKey);
    for (const [key, state] of leaders) {
      if (state.teamName !== event.team_name) continue;
      this.rememberLeader(key);
      interrupt(key, state);
    }
  }

  /** A binding this Channel just removed or moved to another Team. */
  onRouteReleased(
    input: { teamName: string; target: FeishuTarget },
    leaders: Map<string, LeaderState>,
    interrupt: (key: string, state: LeaderState) => void,
  ): void {
    for (const [key, state] of leaders) {
      if (state.teamName !== input.teamName) continue;
      this.rememberTarget(key, input.target);
      const anchored = [state.anchor, state.nextAnchor].some(
        (anchor) => anchor !== null && sameTarget(anchor.target, input.target),
      );
      if (anchored) interrupt(key, state);
    }
  }

  /** A binding this Channel just installed re-opens presentation for it. */
  onRouteClaimed(input: { teamName: string; target: FeishuTarget }): void {
    for (const [key, fenced] of this.targets) {
      if (
        fenced.leaderKey.startsWith(
          `${input.teamName}${IDENTITY_KEY_SEPARATOR}`,
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

export function ensureLeaderState(
  leaders: Map<string, LeaderState>,
  teamName: string,
  leaderName: string,
): LeaderState {
  const key = cotLeaderKey(teamName, leaderName);
  const existing = leaders.get(key);
  if (existing !== undefined) return existing;
  const created: LeaderState = {
    kind: 'leader',
    teamName,
    leaderName,
    admittedTurnId: null,
    generation: 0,
    anchor: null,
    nextAnchor: null,
    active: null,
    disabledGeneration: null,
    openCalls: new Map(),
    pendingTurns: new Map(),
    tail: Promise.resolve(),
    inFlight: 0,
  };
  leaders.set(key, created);
  return created;
}

export function setLeaderFallbackAnchorIfAbsent(
  leaders: Map<string, LeaderState>,
  teamName: string,
  leaderName: string,
  anchor: VisibleMessageAnchor,
): void {
  if (!validLeaderIdentity(teamName, leaderName)) return;
  const prepared = prepareVisibleAnchor(anchor);
  if (prepared === null) return;
  const state = ensureLeaderState(leaders, teamName, leaderName);
  if (state.anchor !== null) return;
  state.anchor = prepared;
}

export function refreshLeaderNextAnchor(
  leaders: Map<string, LeaderState>,
  teamName: string,
  leaderName: string,
  anchor: VisibleMessageAnchor,
): void {
  if (!validLeaderIdentity(teamName, leaderName)) return;
  const state = leaders.get(cotLeaderKey(teamName, leaderName));
  if (state === undefined) return;
  const current = state.anchor ?? state.nextAnchor;
  if (current === null) return;
  const prepared = prepareVisibleAnchor(anchor);
  if (prepared === null) return;
  // A reply only migrates the anchor inside the same conversation. Replying
  // somewhere else is an ordinary outbound message, not a new place for this
  // leader's next card.
  if (!sameTarget(current.target, prepared.target)) return;
  state.nextAnchor = prepared;
}

function validLeaderIdentity(teamName: string, leaderName: string): boolean {
  return typeof teamName === 'string' && teamName !== '' &&
    typeof leaderName === 'string' && leaderName !== '';
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

export function cotStateAdmitsTurn(state: CotState, turnId: string): boolean {
  // A dispatcher state *is* one turn, so reaching it is already the proof.
  return state.kind === 'dispatcher' || state.admittedTurnId === turnId;
}

export function releaseLeaderTurn(state: LeaderState, turnId: string): void {
  if (state.admittedTurnId !== turnId) return;
  state.admittedTurnId = null;
  state.pendingTurns.delete(turnId);
}

export function cotStateHasAnchor(state: CotState): boolean {
  return state.anchor !== null ||
    (state.kind === 'leader' && state.nextAnchor !== null);
}

export function reapCotState(
  closed: boolean,
  key: string,
  state: CotState,
  leaders: Map<string, LeaderState>,
  dispatcher: DispatcherCotStateStore,
): void {
  if (closed || state.inFlight > 0 || state.active !== null ||
      state.openCalls.size > 0 || state.pendingTurns.size > 0) return;
  if (state.kind === 'leader') {
    if (!cotStateHasAnchor(state) && leaders.get(key) === state) {
      leaders.delete(key);
    }
    return;
  }
  dispatcher.reap(key, state);
}

export function cotLeaderKey(teamName: string, leaderName: string): string {
  return `${teamName}${IDENTITY_KEY_SEPARATOR}${leaderName}`;
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
