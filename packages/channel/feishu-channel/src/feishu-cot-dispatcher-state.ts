/**
 * The Dispatcher Agent's side of the COT display, and only that.
 *
 * A Dispatcher conversation is shaped differently from a TeamLeader's, which
 * is why it has its own store. A leader owns one standing anchor that later
 * turns keep writing under; the Dispatcher answers whatever conversation the
 * message arrived in, so its unit is one turn under one visible message, and a
 * turn ends when it settles. Nothing here is durable — it is a session-local
 * correlation ledger for cards that are already on screen.
 */
import type {
  CotStateBase,
  VisibleMessageAnchor,
} from './feishu-cot-state.js';

const IDENTITY_KEY_SEPARATOR = '\0';

export const FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX = 512;
export const FEISHU_COT_DISPATCHER_TURNS_MAX = 512;
export const FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX = 64;

export interface DispatcherTurnState extends CotStateBase {
  readonly kind: 'dispatcher';
  readonly conversationKey: string;
  readonly agentName: string;
  readonly chatId: string;
  readonly turnId: string;
  settled: boolean;
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

export function cotDispatcherConversationKey(
  agentName: string,
  chatId: string,
): string {
  return `${agentName}${IDENTITY_KEY_SEPARATOR}${chatId}`;
}

export function cotDispatcherTurnKey(
  agentName: string,
  turnId: string,
): string {
  return `${agentName}${IDENTITY_KEY_SEPARATOR}${turnId}`;
}
