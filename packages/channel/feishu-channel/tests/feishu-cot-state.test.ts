import { describe, expect, it } from 'vitest';

import {
  DispatcherCotStateStore,
  FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX,
  FEISHU_COT_DISPATCHER_TURNS_MAX,
  FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX,
  type DispatcherTurnState,
  type VisibleMessageAnchor,
} from '../src/feishu-cot-state.js';

function anchor(chatId: string): VisibleMessageAnchor {
  return {
    chatId,
    messageId: `message-${chatId}`,
    target: {
      target_type: 'group',
      target_key: chatId,
      bindable: true,
      meta: { chat_id: chatId },
    },
    binding: null,
  };
}

function sizes(store: DispatcherCotStateStore): {
  conversations: number;
  turns: number;
} {
  const internals = store as unknown as {
    conversations: Map<string, unknown>;
    turns: Map<string, unknown>;
  };
  return {
    conversations: internals.conversations.size,
    turns: internals.turns.size,
  };
}

describe('DispatcherCotStateStore caps', () => {
  it('pins the reviewed session and per-chat limits', () => {
    expect(FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX).toBe(512);
    expect(FEISHU_COT_DISPATCHER_TURNS_MAX).toBe(512);
    expect(FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX).toBe(64);
  });

  it('refuses a 65th chat turn without indexing partial state', () => {
    const store = new DispatcherCotStateStore();
    for (let index = 0; index < FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX; index += 1) {
      expect(store.begin('dispatcher', `turn-${index}`, anchor('chat-a')).status)
        .toBe('started');
    }
    const before = sizes(store);

    expect(store.begin('dispatcher', 'turn-refused', anchor('chat-a'))).toEqual({
      status: 'full',
      reason: 'chat_turns',
      maximum: FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX,
    });
    expect(sizes(store)).toEqual(before);
    expect(store.find('dispatcher', 'turn-refused')).toBeNull();
  });

  it('refuses a 513th session turn without creating its conversation', () => {
    const store = new DispatcherCotStateStore();
    for (let index = 0; index < FEISHU_COT_DISPATCHER_TURNS_MAX; index += 1) {
      expect(store.begin(
        'dispatcher',
        `turn-${index}`,
        anchor(`chat-${index}`),
      ).status).toBe('started');
    }
    const before = sizes(store);

    expect(store.begin(
      'dispatcher',
      'turn-refused',
      anchor('chat-refused'),
    )).toEqual({
      status: 'full',
      reason: 'session_turns',
      maximum: FEISHU_COT_DISPATCHER_TURNS_MAX,
    });
    expect(sizes(store)).toEqual(before);
    expect(store.find('dispatcher', 'turn-refused')).toBeNull();
  });

  it('refuses a new conversation at its cap with no turn-index residue', () => {
    const store = new DispatcherCotStateStore();
    const internals = store as unknown as {
      conversations: Map<string, {
        agentName: string;
        chatId: string;
        turns: Map<string, DispatcherTurnState>;
      }>;
      turns: Map<string, DispatcherTurnState>;
    };
    for (let index = 0; index < FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX; index += 1) {
      internals.conversations.set(`seed-${index}`, {
        agentName: 'dispatcher',
        chatId: `seed-chat-${index}`,
        turns: new Map(),
      });
    }

    expect(store.begin('dispatcher', 'turn-refused', anchor('chat-new'))).toEqual({
      status: 'full',
      reason: 'conversations',
      maximum: FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX,
    });
    expect(sizes(store)).toEqual({
      conversations: FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX,
      turns: 0,
    });
    expect(store.find('dispatcher', 'turn-refused')).toBeNull();
  });
});
