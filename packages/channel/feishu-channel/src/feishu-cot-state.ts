/** Session-owned COT state declarations plus pure identity and ledger helpers. */
import type {
  ChannelBindingEndpointSnapshot,
  ChannelBindingRouteEvent,
  ChannelOrigin,
  ChannelTeamStateEvent,
  ChannelTarget,
} from '@excitedjs/dreamux-types';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import type { FeishuCotRunStatus } from './feishu-cot-events.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';

const IDENTITY_KEY_SEPARATOR = '\0';

export const FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX = 512;
export const FEISHU_COT_DISPATCHER_TURNS_MAX = 512;
export const FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX = 64;
const FEISHU_COT_FENCED_LEADERS_MAX = 512;
const FEISHU_COT_FENCED_ROUTES_MAX = 512;

export interface VisibleMessageAnchor {
  readonly chatId: string;
  readonly messageId: string;
  readonly target: ChannelTarget;
  readonly binding: ChannelBindingEndpointSnapshot | null;
}

export type VisibleMessageReceipt = Omit<VisibleMessageAnchor, 'binding'>;

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

interface CotStateBase {
  generation: number;
  anchor: VisibleMessageAnchor | null;
  active: CotPresentation | null;
  disabledGeneration: number | null;
  readonly openCalls: Map<string, { readonly generation: number }>;
  readonly pendingTurns: Map<string, { readonly generation: number }>;
  tail: Promise<void>;
  inFlight: number;
}

export interface LeaderState extends CotStateBase {
  readonly kind: 'leader';
  readonly teamName: string;
  readonly leaderName: string;
  admittedTurnId: string | null;
  nextAnchor: VisibleMessageAnchor | null;
}

interface LeaderRouteFence {
  readonly leaderKey: string;
  readonly endpoint: ChannelBindingEndpointSnapshot;
}

export class LeaderLifecycleFence {
  private readonly leaders = new Set<string>();
  private readonly routes = new Map<string, LeaderRouteFence>();

  blocksAnchor(
    leaderKey: string,
    anchor: Pick<VisibleMessageAnchor, 'binding'>,
    channelId: string | undefined,
  ): boolean {
    if (this.leaders.has(leaderKey)) return true;
    for (const route of this.routes.values()) {
      if (
        route.leaderKey === leaderKey &&
        anchorMatchesEndpoint(anchor, route.endpoint, channelId)
      ) {
        return true;
      }
    }
    return false;
  }

  onTeamState(
    event: ChannelTeamStateEvent,
    leaders: Map<string, LeaderState>,
    interrupt: (key: string, state: LeaderState) => void,
  ): void {
    const eventKey = cotLeaderKey(event.team_name, event.leader_name);
    if (event.status !== 'closed') {
      this.leaders.delete(eventKey);
      this.clearRoutesForLeader(eventKey);
      return;
    }
    this.rememberLeader(eventKey);
    for (const [key, state] of leaders) {
      if (state.teamName !== event.team_name) continue;
      this.rememberLeader(key);
      interrupt(key, state);
    }
  }

  onBindingRoute(
    event: ChannelBindingRouteEvent,
    leaders: Map<string, LeaderState>,
    channelId: string | undefined,
    interrupt: (key: string, state: LeaderState) => void,
  ): void {
    if (!endpointBelongsToChannel(event.endpoint, channelId)) return;
    const previous = event.previous_team;
    if (previous !== null) {
      const key = cotLeaderKey(previous.team_name, previous.leader_name);
      this.rememberRoute(key, event.endpoint);
      const state = leaders.get(key);
      if (state !== undefined && [state.anchor, state.nextAnchor].some((anchor) =>
        anchor !== null && anchorMatchesEndpoint(anchor, event.endpoint, channelId))) {
        interrupt(key, state);
      }
    }
    if (event.action === 'bound') {
      this.clearRoute(cotLeaderKey(
        event.current_team.team_name,
        event.current_team.leader_name,
      ), event.endpoint);
    }
  }

  clear(): void {
    this.leaders.clear();
    this.routes.clear();
  }

  get leaderSize(): number {
    return this.leaders.size;
  }

  get routeSize(): number {
    return this.routes.size;
  }

  private rememberLeader(key: string): void {
    if (this.leaders.has(key)) return;
    if (this.leaders.size >= FEISHU_COT_FENCED_LEADERS_MAX) {
      const oldest = this.leaders.values().next().value as string | undefined;
      if (oldest !== undefined) this.leaders.delete(oldest);
    }
    this.leaders.add(key);
  }

  private rememberRoute(
    leaderKey: string,
    endpoint: ChannelBindingEndpointSnapshot,
  ): void {
    const key = routeFenceKey(leaderKey, endpoint);
    if (this.routes.has(key)) return;
    if (this.routes.size >= FEISHU_COT_FENCED_ROUTES_MAX) {
      const oldest = this.routes.keys().next().value as string | undefined;
      if (oldest !== undefined) this.routes.delete(oldest);
    }
    this.routes.set(key, { leaderKey, endpoint });
  }

  private clearRoute(
    leaderKey: string,
    endpoint: ChannelBindingEndpointSnapshot,
  ): void {
    this.routes.delete(routeFenceKey(leaderKey, endpoint));
  }

  private clearRoutesForLeader(leaderKey: string): void {
    for (const [key, route] of this.routes) {
      if (route.leaderKey === leaderKey) this.routes.delete(key);
    }
  }
}

function routeFenceKey(
  leaderKey: string,
  endpoint: ChannelBindingEndpointSnapshot,
): string {
  return [
    leaderKey,
    endpoint.provider,
    endpoint.channel_id,
    endpoint.endpoint_type,
    endpoint.endpoint_key,
  ].join(IDENTITY_KEY_SEPARATOR);
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
  const update = prepareLeaderAnchorUpdate(
    leaders,
    teamName,
    leaderName,
    anchor,
  );
  if (update === null || update.state.anchor !== null) return;
  update.state.anchor = update.anchor;
}

export function refreshLeaderNextAnchor(
  leaders: Map<string, LeaderState>,
  teamName: string,
  leaderName: string,
  anchor: VisibleMessageReceipt,
): void {
  if (!validLeaderIdentity(teamName, leaderName)) return;
  const state = leaders.get(cotLeaderKey(teamName, leaderName));
  if (state === undefined) return;
  const current = state.anchor ?? state.nextAnchor;
  if (current === null) return;
  const prepared = prepareVisibleAnchor({
    ...anchor,
    binding: current.binding,
  });
  if (prepared === null) return;
  if (
    !sameConversationTarget(current.target, prepared.target)
  ) {
    return;
  }
  state.nextAnchor = prepared;
}

function prepareLeaderAnchorUpdate(
  leaders: Map<string, LeaderState>,
  teamName: string,
  leaderName: string,
  anchor: VisibleMessageAnchor,
): { state: LeaderState; anchor: VisibleMessageAnchor } | null {
  if (!validLeaderIdentity(teamName, leaderName)) return null;
  const prepared = prepareVisibleAnchor(anchor);
  if (prepared === null) return null;
  return {
    state: ensureLeaderState(leaders, teamName, leaderName),
    anchor: prepared,
  };
}

function validLeaderIdentity(teamName: string, leaderName: string): boolean {
  return typeof teamName === 'string' && teamName !== '' &&
    typeof leaderName === 'string' && leaderName !== '';
}

function prepareVisibleAnchor(
  anchor: VisibleMessageAnchor,
): VisibleMessageAnchor | null {
  let target: ChannelTarget;
  try {
    if (
      typeof anchor.chatId !== 'string' ||
      anchor.chatId === '' ||
      typeof anchor.messageId !== 'string' ||
      anchor.messageId === '' ||
      targetChatId(anchor.target) !== anchor.chatId
    ) {
      return null;
    }
    target = cloneTarget(anchor.target);
  } catch {
    return null;
  }
  return {
    ...anchor,
    target,
    binding: anchor.binding === null ? null : structuredClone(anchor.binding),
  };
}

function sameConversationTarget(
  left: ChannelTarget,
  right: ChannelTarget,
): boolean {
  const leftChatId = targetChatId(left);
  return leftChatId !== null &&
    leftChatId === targetChatId(right) &&
    left.target_type === right.target_type &&
    left.target_key === right.target_key;
}

export interface DispatcherTurnState extends CotStateBase {
  readonly kind: 'dispatcher';
  readonly conversationKey: string;
  readonly agentName: string;
  readonly chatId: string;
  readonly turnId: string;
  settled: boolean;
}

export type CotState = LeaderState | DispatcherTurnState;

export function cotStateAdmitsTurn(state: CotState, turnId: string): boolean {
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

interface DispatcherConversationState {
  readonly agentName: string;
  readonly chatId: string;
  readonly turns: Map<string, DispatcherTurnState>;
}

export interface KeyedDispatcherTurn {
  readonly key: string;
  readonly state: DispatcherTurnState;
}

export type DispatcherTurnBeginResult =
  | ({ readonly status: 'started' } & KeyedDispatcherTurn)
  | { readonly status: 'duplicate' }
  | {
      readonly status: 'full';
      readonly reason: 'conversations' | 'session_turns' | 'chat_turns';
      readonly maximum: number;
    };

/** Session-local correlation owner for dispatcher conversations and turns. */
export class DispatcherCotStateStore {
  private readonly conversations =
    new Map<string, DispatcherConversationState>();
  private readonly turns = new Map<string, DispatcherTurnState>();

  begin(
    agentName: string,
    turnId: string,
    anchor: VisibleMessageAnchor,
  ): DispatcherTurnBeginResult {
    const key = cotDispatcherTurnKey(agentName, turnId);
    if (this.turns.has(key)) return { status: 'duplicate' };
    const conversationKey = cotDispatcherConversationKey(
      agentName,
      anchor.chatId,
    );
    let conversation = this.conversations.get(conversationKey);
    if (this.turns.size >= FEISHU_COT_DISPATCHER_TURNS_MAX) {
      return {
        status: 'full',
        reason: 'session_turns',
        maximum: FEISHU_COT_DISPATCHER_TURNS_MAX,
      };
    }
    if (
      conversation === undefined &&
      this.conversations.size >= FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX
    ) {
      return {
        status: 'full',
        reason: 'conversations',
        maximum: FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX,
      };
    }
    if (
      conversation !== undefined &&
      conversation.turns.size >= FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX
    ) {
      return {
        status: 'full',
        reason: 'chat_turns',
        maximum: FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX,
      };
    }
    if (conversation === undefined) {
      conversation = { agentName, chatId: anchor.chatId, turns: new Map() };
      this.conversations.set(conversationKey, conversation);
    }
    const state: DispatcherTurnState = {
      kind: 'dispatcher',
      conversationKey,
      agentName,
      chatId: anchor.chatId,
      turnId,
      settled: false,
      generation: 1,
      anchor,
      active: null,
      disabledGeneration: null,
      openCalls: new Map(),
      pendingTurns: new Map(),
      tail: Promise.resolve(),
      inFlight: 0,
    };
    conversation.turns.set(turnId, state);
    this.turns.set(key, state);
    return { status: 'started', key, state };
  }

  find(agentName: string, turnId: string): KeyedDispatcherTurn | null {
    const key = cotDispatcherTurnKey(agentName, turnId);
    const state = this.turns.get(key);
    return state === undefined || state.settled ? null : { key, state };
  }

  settle(agentName: string, turnId: string): KeyedDispatcherTurn | null {
    const key = cotDispatcherTurnKey(agentName, turnId);
    const state = this.turns.get(key);
    if (state === undefined || state.settled) return null;
    state.settled = true;
    return { key, state };
  }

  *all(): IterableIterator<KeyedDispatcherTurn> {
    for (const conversation of this.conversations.values()) {
      for (const state of conversation.turns.values()) {
        yield {
          key: cotDispatcherTurnKey(state.agentName, state.turnId),
          state,
        };
      }
    }
  }

  reap(key: string, state: DispatcherTurnState): void {
    const conversation = this.conversations.get(state.conversationKey);
    if (conversation?.turns.get(state.turnId) !== state) return;
    conversation.turns.delete(state.turnId);
    if (this.turns.get(key) === state) this.turns.delete(key);
    if (conversation.turns.size === 0) {
      this.conversations.delete(state.conversationKey);
    }
  }

  clear(): void {
    this.conversations.clear();
    this.turns.clear();
  }
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

export function cotDispatcherConversationKey(
  agentName: string,
  chatId: string,
): string {
  return `${agentName}${IDENTITY_KEY_SEPARATOR}${chatId}`;
}

export function cotDispatcherTurnKey(agentName: string, turnId: string): string {
  return `${agentName}${IDENTITY_KEY_SEPARATOR}${turnId}`;
}

export function cotOpenCallKey(turnId: string, callId: string): string {
  return `${turnId}${IDENTITY_KEY_SEPARATOR}${callId}`;
}

export function targetChatId(target: ChannelTarget): string | null {
  const chatId = target.meta?.['chat_id'];
  return typeof chatId === 'string' && chatId !== '' ? chatId : null;
}

export function cloneTarget(target: ChannelTarget): ChannelTarget {
  return structuredClone(target);
}

export function visibleAnchorFromOrigin(
  origin: ChannelOrigin,
  channelId: string | undefined,
): VisibleMessageAnchor | null {
  const chatId = targetChatId(origin.target);
  if (
    channelId === undefined ||
    origin.provider !== BUILTIN_FEISHU_PROVIDER_REF ||
    origin.channel_id !== channelId ||
    typeof origin.message_id !== 'string' ||
    origin.message_id === '' ||
    chatId === null
  ) {
    return null;
  }
  return {
    chatId,
    messageId: origin.message_id,
    target: cloneTarget(origin.target),
    binding: origin.binding === null ? null : structuredClone(origin.binding),
  };
}

export function anchorMatchesEndpoint(
  anchor: Pick<VisibleMessageAnchor, 'binding'>,
  endpoint: ChannelBindingEndpointSnapshot,
  channelId: string | undefined,
): boolean {
  const binding = anchor.binding;
  return binding !== null && binding !== undefined &&
    endpointBelongsToChannel(binding, channelId) &&
    endpointBelongsToChannel(endpoint, channelId) &&
    binding.provider === endpoint.provider &&
    binding.channel_id === endpoint.channel_id &&
    binding.endpoint_type === endpoint.endpoint_type &&
    binding.endpoint_key === endpoint.endpoint_key;
}

function endpointBelongsToChannel(
  endpoint: ChannelBindingEndpointSnapshot,
  channelId: string | undefined,
): boolean {
  return channelId !== undefined &&
    endpoint.provider === BUILTIN_FEISHU_PROVIDER_REF &&
    endpoint.channel_id === channelId;
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
