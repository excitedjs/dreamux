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
import { submitted, userMessage } from './helpers/cot-fixtures.js';
import {
  createFakeCotClient,
  settleCot,
} from './helpers/fake-cot-client.js';

function logger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
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
    await vi.waitFor(() => {
      expect(bot.sentCards).toHaveLength(1);
    });
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

  it('feeds a successful route notification back as the leader COT fallback', async () => {
    const cot = createFakeCotClient();
    const bot = Object.assign(createFakeFeishuBot('app-with-cot'), { cot });
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });

    source.emit(routeEvent());
    await vi.waitFor(() => {
      expect(bot.sentCards).toHaveLength(1);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event_kind: 'binding.route' }),
        'Feishu binding notification sent',
      );
    });
    source.emit(submitted({
      team_name: 'alpha',
      agent_name: 'leader-alpha',
      turn_id: 'completion-after-binding',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    source.emit(userMessage({
      team_name: 'alpha',
      agent_name: 'leader-alpha',
      event_id: 'completion-after-binding-message',
      turn_id: 'completion-after-binding',
    }));
    await settleCot();
    await s.close();

    expect(cot.createRequests()).toHaveLength(1);
    expect(cot.createRequests()[0]?.data).toMatchObject({
      receive_id: 'chat-a',
      origin_message_id: 'message-fake-1',
    });
  });

  it('drops a binding fallback when the route changes before send completion', async () => {
    const cot = createFakeCotClient();
    const bot = Object.assign(createFakeFeishuBot('app-stale-binding'), { cot });
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });
    const firstSend = deferred();
    bot.setSendCardDelay(firstSend.promise);

    source.emit(routeEvent());
    await vi.waitFor(() => {
      expect(bot.sentCards).toHaveLength(1);
    });
    bot.setSendCardDelay(null);
    const replacement: ChannelBindingRouteEvent = {
      ...routeEvent(),
      transition: 'replaced',
      previous_team: {
        team_name: 'alpha',
        leader_name: 'leader-alpha',
      },
      current_team: {
        team_name: 'beta',
        leader_name: 'leader-beta',
        leader_agent_runtime: 'test:runtime',
        runtime_cwd: '/tmp/dreamux/work-beta',
      },
    };
    source.emit(replacement);
    await vi.waitFor(() => {
      expect(bot.sentCards).toHaveLength(2);
      expect(log.info).toHaveBeenCalledTimes(1);
    });
    firstSend.resolve();
    await vi.waitFor(() => {
      expect(log.info).toHaveBeenCalledTimes(2);
    });

    source.emit(submitted({
      team_name: 'alpha',
      agent_name: 'leader-alpha',
      turn_id: 'completion-after-replaced-binding',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    source.emit(userMessage({
      team_name: 'alpha',
      agent_name: 'leader-alpha',
      event_id: 'completion-after-replaced-binding-message',
      turn_id: 'completion-after-replaced-binding',
    }));
    await settleCot();
    await s.close();

    expect(cot.createRequests()).toEqual([]);
  });

  it('does not feed collaboration-space notifications into leader COT', async () => {
    const cot = createFakeCotClient();
    const bot = Object.assign(createFakeFeishuBot('app-space-with-cot'), { cot });
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });

    source.emit(spaceEvent());
    await vi.waitFor(() => {
      expect(bot.sentCards).toHaveLength(1);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event_kind: 'binding.collaboration_space' }),
        'Feishu binding notification sent',
      );
    });
    source.emit(submitted({
      team_name: 'alpha',
      agent_name: 'leader-alpha',
      turn_id: 'completion-after-space-binding',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    source.emit(userMessage({
      team_name: 'alpha',
      agent_name: 'leader-alpha',
      event_id: 'completion-after-space-binding-message',
      turn_id: 'completion-after-space-binding',
    }));
    await settleCot();
    await s.close();

    expect(cot.createRequests()).toEqual([]);
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
    await vi.waitFor(() => {
      expect(bot.sentCards).toHaveLength(1);
    });
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
    await vi.waitFor(() => {
      expect(bot.sentCards).toHaveLength(1);
    });
    await s.close();

    expect(bot.sentCards).toHaveLength(1);
    expect(bot.sentCards[0]?.target).toMatchObject({ chatId: 'chat-topic' });
    expect(bot.sentCards[0]?.target.replyToMessageId).toBeUndefined();
  });

  it('retries one failed send in place and contains a final failure', async () => {
    const bot = createFakeFeishuBot('app');
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });
    const sendCard = bot.sendCard.bind(bot);
    let attempts = 0;
    bot.sendCard = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient send failure');
      return sendCard(...args);
    };

    source.emit(routeEvent({ meta: { chat_id: 'chat-retry' } }));
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(bot.sentCards).toHaveLength(1);
    });
    await s.close();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, event_kind: 'binding.route' }),
      'Feishu binding notification failed; retrying once',
    );

    const failingBot = createFakeFeishuBot('app-failing');
    let failedAttempts = 0;
    failingBot.sendCard = async () => {
      failedAttempts += 1;
      throw new Error('send failed');
    };
    const failingSource = eventSource();
    const failing = session({ stateDir, bot: failingBot, log });
    await start({ session: failing, source: failingSource });
    failingSource.emit(routeEvent({ meta: { chat_id: 'chat-fail' } }));
    await vi.waitFor(() => {
      expect(failedAttempts).toBe(2);
    });
    await expect(failing.close()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, event_kind: 'binding.route' }),
      'Feishu binding notification failed after retry',
    );
  });

  it('aborts a timed-out attempt and immediately retries once', async () => {
    vi.useFakeTimers();
    const bot = createFakeFeishuBot('app-timeout-retry');
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });
    const signals: AbortSignal[] = [];
    let attempts = 0;
    bot.sendCard = async (_target, _card, options) => {
      attempts += 1;
      const signal = options?.signal;
      if (signal === undefined) throw new Error('expected a send signal');
      signals.push(signal);
      if (attempts === 2) return { messageIds: ['message-retry-success'] };
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    };

    source.emit(routeEvent({ meta: { chat_id: 'chat-timeout-retry' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(20_001);
    expect(attempts).toBe(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, event_kind: 'binding.route' }),
      'Feishu binding notification failed; retrying once',
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 2,
        message_ids: ['message-retry-success'],
      }),
      'Feishu binding notification sent',
    );
    await expect(s.close()).resolves.toBeUndefined();
  });

  it('stops after two timed-out attempts', async () => {
    vi.useFakeTimers();
    const bot = createFakeFeishuBot('app-timeout-final');
    const log = logger();
    const source = eventSource();
    const s = session({ stateDir, bot, log });
    await start({ session: s, source });
    const signals: AbortSignal[] = [];
    let attempts = 0;
    bot.sendCard = async (_target, _card, options) => {
      attempts += 1;
      const signal = options?.signal;
      if (signal === undefined) throw new Error('expected a send signal');
      signals.push(signal);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    };

    source.emit(routeEvent({ meta: { chat_id: 'chat-timeout-final' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(20_001);
    expect(attempts).toBe(2);
    expect(signals[0]?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(20_001);
    expect(attempts).toBe(2);
    expect(signals[1]?.aborted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, event_kind: 'binding.route' }),
      'Feishu binding notification failed after retry',
    );
    await expect(s.close()).resolves.toBeUndefined();
  });

  it('cancels a hung notification when the session closes', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    await expect(closing).resolves.toBeUndefined();
  });
});
