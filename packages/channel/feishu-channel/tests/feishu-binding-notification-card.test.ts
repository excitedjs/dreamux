import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChannelBindingCollaborationSpaceEvent,
  ChannelBindingRouteEvent,
  ChannelCoreEvent,
  ChannelCoreEventKind,
  ChannelCoreEventListener,
  ChannelCoreEventSource,
  ChannelCoreEventSubscription,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from '../src/index.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
} from './helpers/fake-feishu-bot.js';

function logger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

function eventSource(): ChannelCoreEventSource & {
  emit(event: ChannelCoreEvent): void;
} {
  const listeners = new Map<ChannelCoreEventKind, Set<(event: ChannelCoreEvent) => void>>();
  return {
    on<K extends ChannelCoreEventKind>(
      kind: K,
      listener: ChannelCoreEventListener<K>,
    ): ChannelCoreEventSubscription {
      const set = listeners.get(kind) ?? new Set();
      set.add(listener as (event: ChannelCoreEvent) => void);
      listeners.set(kind, set);
      return {
        unsubscribe() {
          set.delete(listener as (event: ChannelCoreEvent) => void);
        },
      };
    },
    emit(event: ChannelCoreEvent): void {
      for (const listener of listeners.get(event.kind) ?? []) listener(event);
    },
  };
}

function session(input: {
  stateDir: string;
  bot: FakeFeishuBot;
  log?: ReturnType<typeof logger>;
}): FeishuChannelSession {
  return new FeishuChannelSession({
    dispatcherId: 'flow',
    appId: 'app',
    appSecret: 'secret',
    stateDir: input.stateDir,
    attachmentCacheDir: join(input.stateDir, 'attachments'),
    log: input.log ?? logger(),
    botFactory: () => input.bot,
  });
}

async function start(input: {
  session: FeishuChannelSession;
  source: ChannelCoreEventSource;
}): Promise<void> {
  await input.session.start(
    { submitTurn: async () => ({ status: 'submitted' }) },
    input.source,
  );
}

function routeEvent(input: {
  endpointType?: string;
  provider?: string;
  meta?: Record<string, unknown>;
  action?: 'bound' | 'unbound';
} = {}): ChannelBindingRouteEvent {
  const action = input.action ?? 'bound';
  const endpoint = {
    provider: input.provider ?? 'builtin:feishu',
    channel_id: 'primary',
    endpoint_type: input.endpointType ?? 'group',
    endpoint_key: input.endpointType === 'topic' ? 'topic-a' : 'chat-a',
    display: 'Target <unsafe>',
    canonical_url: null,
    meta: input.meta ?? { chat_id: 'chat-a', chat_type: 'group' },
  };
  if (action === 'unbound') {
    return {
      schema_version: 1,
      kind: 'binding.route',
      occurred_at: 42,
      action,
      transition: 'unbound',
      endpoint,
      previous_team: {
        team_name: 'alpha',
        leader_name: 'leader-alpha',
      },
      current_team: null,
    };
  }
  return {
    schema_version: 1,
    kind: 'binding.route',
    occurred_at: 42,
    action,
    transition: 'bound',
    endpoint,
    previous_team: null,
    current_team: {
      team_name: 'alpha',
      leader_name: 'leader-alpha',
      leader_agent_runtime: 'test:runtime',
      runtime_cwd: '/tmp/dreamux/work',
    },
  };
}

function spaceEvent(input: {
  provider?: string;
  action?: 'bound' | 'unbound';
} = {}): ChannelBindingCollaborationSpaceEvent {
  const action = input.action ?? 'bound';
  const container = {
    provider: input.provider ?? 'builtin:feishu',
    channel_id: 'primary',
    endpoint_type: 'topic_group',
    endpoint_key: 'chat-topic',
    display: 'Topic Group',
    canonical_url: null,
    meta: { chat_id: 'chat-topic', chat_mode: 'topic' },
  };
  if (action === 'unbound') {
    return {
      schema_version: 1,
      kind: 'binding.collaboration_space',
      occurred_at: 43,
      action,
      transition: 'unbound',
      container,
      space_name: 'space-alpha',
      current_binding: null,
    };
  }
  return {
    schema_version: 1,
    kind: 'binding.collaboration_space',
    occurred_at: 43,
    action,
    transition: 'bound',
    container,
    space_name: 'space-alpha',
    current_binding: {
      leader_agent_runtime: 'test:runtime',
      repo_cwd: '/tmp/repo',
      worktree: {
        mode: 'managed',
        base_ref: 'main',
        cleanup: 'delete-on-close',
      },
    },
  };
}

describe('Feishu binding notification cards', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-binding-card-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('sends group route cards and ignores other providers', async () => {
    const bot = createFakeFeishuBot('app');
    const source = eventSource();
    const s = session({ stateDir, bot });
    await start({ session: s, source });

    source.emit(routeEvent({ provider: 'builtin:other' }));
    source.emit(routeEvent());
    await s.close();

    expect(bot.sentCards).toHaveLength(1);
    expect(bot.sentCards[0]?.target).toMatchObject({ chatId: 'chat-a' });
    expect(bot.sentCards[0]?.target.replyToMessageId).toBeUndefined();
    const cardJson = JSON.stringify(bot.sentCards[0]?.card);
    expect(cardJson).toContain('Runtime cwd: /tmp/dreamux/work');
    expect(cardJson).toContain('"plain_text"');
    expect(cardJson).not.toContain('chat_type');
    expect(cardJson).not.toContain('claim_id');
    expect(cardJson).not.toContain('prompt');
  });

  it('sends topic route cards as replies to the persisted trigger message', async () => {
    const bot = createFakeFeishuBot('app');
    const source = eventSource();
    const s = session({ stateDir, bot });
    await start({ session: s, source });

    source.emit(routeEvent({
      endpointType: 'topic',
      meta: {
        chat_id: 'chat-topic',
        chat_type: 'group',
        chat_mode: 'topic',
        thread_id: 'topic-a',
        message_id: 'msg-trigger',
      },
    }));
    await s.close();

    expect(bot.sentCards).toHaveLength(1);
    expect(bot.sentCards[0]?.target).toMatchObject({
      chatId: 'chat-topic',
      replyToMessageId: 'msg-trigger',
    });
  });

  it('skips malformed legacy topic metadata with a warning', async () => {
    const bot = createFakeFeishuBot('app');
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });

    source.emit(routeEvent({
      endpointType: 'topic',
      meta: {
        chat_id: 'chat-topic',
        chat_mode: 'topic',
        thread_id: 'topic-a',
      },
    }));
    await s.close();

    expect(bot.sentCards).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_kind: 'binding.route' }),
      'skipped Feishu binding notification with incomplete provider metadata',
    );
  });

  it('sends collaboration-space bind as a fresh group-level card', async () => {
    const bot = createFakeFeishuBot('app');
    const source = eventSource();
    const s = session({ stateDir, bot });
    await start({ session: s, source });

    source.emit(spaceEvent());
    await s.close();

    expect(bot.sentCards).toHaveLength(1);
    expect(bot.sentCards[0]?.target).toMatchObject({ chatId: 'chat-topic' });
    expect(bot.sentCards[0]?.target.replyToMessageId).toBeUndefined();
  });

  it('serializes attempts, preserves order, and contains send failures', async () => {
    const bot = createFakeFeishuBot('app');
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });

    source.emit(routeEvent({ meta: { chat_id: 'chat-1' } }));
    source.emit(routeEvent({ meta: { chat_id: 'chat-2' }, action: 'unbound' }));
    await s.close();
    expect(bot.sentCards.map((card) => card.chatId)).toEqual(['chat-1', 'chat-2']);

    const failingBot = createFakeFeishuBot('app-failing');
    failingBot.setSendError(new Error('send failed'));
    const failingSource = eventSource();
    const failing = session({ stateDir, bot: failingBot, log });
    await start({ session: failing, source: failingSource });
    failingSource.emit(routeEvent({ meta: { chat_id: 'chat-fail' } }));
    await expect(failing.close()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_kind: 'binding.route' }),
      'Feishu binding notification failed',
    );
  });

  it('bounds close when a binding notification send never settles', async () => {
    vi.useFakeTimers();
    const bot = createFakeFeishuBot('app-hung');
    bot.setSendCardDelay(new Promise(() => undefined));
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });

    source.emit(routeEvent({ meta: { chat_id: 'chat-hung' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.sentCards).toHaveLength(1);

    const closing = s.close();
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(closing).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dispatcher_id: 'flow' }),
      'Feishu binding notification drain reached its close deadline',
    );
  });

  it('times out one local send without muting later notifications', async () => {
    vi.useFakeTimers();
    let releaseSend!: () => void;
    const delayedSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const bot = createFakeFeishuBot('app-late');
    bot.setSendCardDelay(delayedSend);
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });

    source.emit(routeEvent({ meta: { chat_id: 'chat-a' } }));
    source.emit(routeEvent({ meta: { chat_id: 'chat-b' }, action: 'unbound' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.sentCards.map((card) => card.chatId)).toEqual(['chat-a']);

    await vi.advanceTimersByTimeAsync(20_001);
    expect(bot.sentCards.map((card) => card.chatId)).toEqual(['chat-a', 'chat-b']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_kind: 'binding.route' }),
      'Feishu binding notification timed out; remote delivery is unknown',
    );

    releaseSend();
    await vi.advanceTimersByTimeAsync(0);
    bot.setSendCardDelay(null);
    source.emit(routeEvent({ meta: { chat_id: 'chat-c' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.sentCards.map((card) => card.chatId)).toEqual([
      'chat-a',
      'chat-b',
      'chat-c',
    ]);
    await expect(s.close()).resolves.toBeUndefined();
    expect(bot.deliveredCards.map((card) => card.chatId)).toEqual([
      'chat-a',
      'chat-b',
      'chat-c',
    ]);
  });
});
