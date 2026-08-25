import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { observeKnownBot, trustIntroducedBots } from '../src/chat-bots-store.js';
import {
  FEISHU_TOOLS,
  buildToolCatalog,
  createFeishuChannelProvider,
  parseFeishuMcpToolInput,
} from '../src/index.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import {
  groupTarget,
  origin,
  settled,
  submitted,
  topicTarget,
  userMessage,
} from './helpers/cot-fixtures.js';
import { createFakeCoreEventSource } from './helpers/fake-core-events.js';
import { createFakeCotClient, settleCot } from './helpers/fake-cot-client.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dreamux-feishu-mcp-'));
  temporaryRoots.push(root);
  return root;
}

function logger(): DreamuxLogger {
  const noop = () => undefined;
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
}

async function startedCotSession(
  appId: string,
  log: DreamuxLogger = logger(),
) {
  const root = temporaryRoot();
  const bot = createFakeFeishuBot(appId);
  const cot = createFakeCotClient();
  Object.defineProperty(bot, 'cot', { value: cot });
  const events = createFakeCoreEventSource();
  const provider = createFeishuChannelProvider({ botFactory: () => bot });
  const session = provider.createSession({
    dispatcher_id: 'dispatcher-a',
    channel_id: 'primary',
    provider: 'builtin:feishu',
    config: { appId, appSecret: 'secret' },
    logger: log,
    state_root: root,
    cache_root: root,
  });
  await session.start({
    deliver: async () => ({ status: 'submitted' }),
    coreEvents: events.source,
  });
  if (session.handleTool === undefined) throw new Error('missing Feishu handleTool');
  return {
    bot,
    cot,
    events,
    session,
    handleTool: session.handleTool.bind(session),
  };
}

function teamLeaderContext() {
  return {
    dispatcher_id: 'dispatcher-a',
    channel_id: 'primary',
    caller: {
      kind: 'team_leader' as const,
      team_name: 'team-alpha',
      leader_name: 'leader',
    },
  };
}

function dispatcherContext() {
  return {
    dispatcher_id: 'dispatcher-a',
    channel_id: 'primary',
    caller: { kind: 'dispatcher' as const },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Feishu MCP tool surface', () => {
  it('publishes complete canonical metadata and closed schemas', () => {
    const catalog = buildToolCatalog();

    expect(catalog).toEqual([
      expect.objectContaining({
        name: 'reply',
        title: 'Reply in Feishu',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      }),
      expect.objectContaining({
        name: 'react',
        title: 'React in Feishu',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      }),
      expect.objectContaining({
        name: 'list_chat_bots',
        title: 'List Feishu chat bots',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }),
    ]);

    for (const tool of catalog) {
      expect(tool.description).toEqual(expect.any(String));
      expect(tool.inputSchema).toEqual(
        expect.objectContaining({
          type: 'object',
          additionalProperties: false,
          properties: expect.any(Object),
          required: expect.any(Array),
        }),
      );
      expect(tool.outputSchema).toEqual(
        expect.objectContaining({
          type: 'object',
          additionalProperties: false,
          properties: expect.any(Object),
          required: expect.any(Array),
        }),
      );
    }

    expect(catalog.map((tool) => tool.outputSchema)).toEqual([
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
        },
        required: ['message_ids'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: { reaction_id: { type: 'string', minLength: 1 } },
        required: ['reaction_id'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat_id: { type: 'string', minLength: 1 },
          known: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                open_id: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1 },
              },
              required: ['open_id'],
            },
          },
          trusted: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                open_id: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1 },
              },
              required: ['open_id'],
            },
          },
        },
        required: ['chat_id', 'known', 'trusted'],
      },
    ]);
  });

  it('returns direct canonical reply and reaction results from the live session', async () => {
    const root = temporaryRoot();
    const bot = createFakeFeishuBot('mcp-results');
    const provider = createFeishuChannelProvider({ botFactory: () => bot });
    const session = provider.createSession({
      dispatcher_id: 'dispatcher-a',
      channel_id: 'primary',
      provider: 'builtin:feishu',
      config: { appId: 'mcp-results', appSecret: 'secret' },
      logger: logger(),
      state_root: root,
      cache_root: root,
    });
    if (session.handleTool === undefined) throw new Error('missing Feishu handleTool');

    await expect(
      session.handleTool(
        {
          name: 'reply',
          arguments: {
            chat_id: 'chat-a',
            message_id: 'message-source',
            text: 'hello',
          },
        },
        {
          dispatcher_id: 'dispatcher-a',
          channel_id: 'primary',
          caller: { kind: 'dispatcher' },
        },
      ),
    ).resolves.toEqual({ message_ids: ['message-fake-1'] });
    await expect(
      session.handleTool(
        {
          name: 'react',
          arguments: {
            chat_id: 'chat-a',
            message_id: 'message-source',
            emoji: 'THUMBSUP',
          },
        },
        {
          dispatcher_id: 'dispatcher-a',
          channel_id: 'primary',
          caller: { kind: 'dispatcher' },
        },
      ),
    ).resolves.toEqual({ reaction_id: 'reaction-fake-1' });

    expect(bot.sentMessages).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        text: 'hello',
        messageIds: ['message-fake-1'],
      }),
    ]);
    expect(bot.reactions).toEqual([
      {
        messageId: 'message-source',
        emoji: 'THUMBSUP',
        reactionId: 'reaction-fake-1',
      },
    ]);
    await session.close();
  });

  it('anchors the next leader COT card to the visible Reply message', async () => {
    const { cot, events, session, handleTool } = await startedCotSession(
      'mcp-cot-lifecycle',
    );
    events.emit(submitted({
      channel_origin: origin({ target: groupTarget() }),
    }));
    await settleCot();
    expect(cot.createRequests()).toHaveLength(1);
    expect(cot.createRequests()[0]?.data?.['origin_message_id']).toBe('om-source-1');

    await handleTool(
      {
        name: 'reply',
        arguments: {
          chat_id: 'oc-group-1',
          text: 'visible reply',
        },
      },
      teamLeaderContext(),
    );
    expect(cot.createRequests()).toHaveLength(1);

    events.emit(settled());
    await settleCot();
    expect(cot.eventsFor('cot-1')).toContainEqual(expect.objectContaining({
      eventType: 'RUN_FINISHED',
      content: expect.objectContaining({ status: 'done' }),
    }));
    events.emit(submitted({
      turn_id: 'turn-2',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    events.emit(userMessage({
      event_id: 'turn-2-message',
      turn_id: 'turn-2',
    }));
    await settleCot();
    expect(cot.createRequests()).toHaveLength(2);
    expect(cot.createRequests()[1]?.data?.['origin_message_id'])
      .toBe('message-fake-1');
    await session.close();
  });

  it('keeps Reply successful when its receipt observer and logger throw', async () => {
    const baseLog = logger();
    const throwingLog: DreamuxLogger = {
      ...baseLog,
      warn: () => {
        throw new Error('logger failed');
      },
    };
    const { bot, session, handleTool } = await startedCotSession(
      'mcp-cot-fail-open',
      throwingLog,
    );
    const internals = session as unknown as {
      session: {
        cot: {
          adapter?: { refreshNextAnchor(): void };
          refreshReplyNextAnchor(): void;
        };
      };
    };
    const cotSeam = internals.session.cot;
    if (cotSeam.adapter === undefined) throw new Error('missing Feishu COT adapter');
    cotSeam.adapter.refreshNextAnchor = () => {
      throw new Error('adapter observer failed');
    };

    await expect(handleTool(
      {
        name: 'reply',
        arguments: { chat_id: 'oc-group-1', text: 'first reply' },
      },
      teamLeaderContext(),
    )).resolves.toEqual({ message_ids: ['message-fake-1'] });

    cotSeam.refreshReplyNextAnchor = () => {
      throw new Error('receipt observer failed');
    };
    await expect(handleTool(
      {
        name: 'reply',
        arguments: { chat_id: 'oc-group-1', text: 'second reply' },
      },
      teamLeaderContext(),
    )).resolves.toEqual({ message_ids: ['message-fake-2'] });
    expect(bot.sentMessages).toHaveLength(2);
    await session.close();
  });

  it('does not update leader COT anchors for dispatcher Replies', async () => {
    const { cot, events, session, handleTool } = await startedCotSession(
      'mcp-cot-dispatcher-reply',
    );
    events.emit(submitted());
    await settleCot();

    await handleTool(
      {
        name: 'reply',
        arguments: { chat_id: 'oc-group-1', text: 'dispatcher reply' },
      },
      dispatcherContext(),
    );
    events.emit(settled());
    events.emit(submitted({
      turn_id: 'turn-2',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    events.emit(userMessage({
      event_id: 'turn-2-message',
      turn_id: 'turn-2',
    }));
    await settleCot();

    expect(cot.createRequests().map((request) =>
      request.data?.['origin_message_id']))
      .toEqual(['om-source-1', 'om-source-1']);
    await session.close();
  });

  it('drops a late leader Reply receipt after the conversation moves chats', async () => {
    const { bot, cot, events, session, handleTool } = await startedCotSession(
      'mcp-cot-stale-receipt',
    );
    events.emit(submitted({
      channel_origin: origin({ target: groupTarget() }),
    }));
    await settleCot();
    const receipt = deferred();
    bot.setSendReceiptDelay(receipt.promise);

    const reply = handleTool(
      {
        name: 'reply',
        arguments: {
          chat_id: 'oc-group-1',
          text: 'late reply',
        },
      },
      teamLeaderContext(),
    );
    await vi.waitFor(() => {
      expect(bot.sentMessages).toHaveLength(1);
    });
    events.emit(submitted({
      turn_id: 'turn-2',
      channel_origin: origin({
        message_id: 'om-source-2',
        target: topicTarget('oc-group-2', 'omt-thread-2'),
      }),
    }));
    await settleCot();
    receipt.resolve();
    await reply;

    events.emit(settled({ turn_id: 'turn-2' }));
    events.emit(submitted({
      turn_id: 'turn-3',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    events.emit(userMessage({
      event_id: 'turn-3-message',
      turn_id: 'turn-3',
    }));
    await settleCot();

    expect(cot.createRequests().map((request) =>
      request.data?.['origin_message_id']))
      .toEqual(['om-source-1', 'om-source-2', 'om-source-2']);
    await session.close();
  });

  it('returns byte-identical live and sessionless list_chat_bots results', async () => {
    const root = temporaryRoot();
    await observeKnownBot(root, 'chat-a', { openId: 'bot-known', name: 'Known' });
    await trustIntroducedBots(root, 'chat-a', [
      { openId: 'bot-trusted', name: 'Trusted' },
    ]);

    const provider = createFeishuChannelProvider({
      botFactory: () => createFakeFeishuBot('mcp-list'),
    });
    const session = provider.createSession({
      dispatcher_id: 'dispatcher-a',
      channel_id: 'primary',
      provider: 'builtin:feishu',
      config: { appId: 'mcp-list', appSecret: 'secret' },
      logger: logger(),
      state_root: root,
      cache_root: root,
    });
    if (session.handleTool === undefined) throw new Error('missing Feishu handleTool');
    if (provider.handleSessionlessTool === undefined) {
      throw new Error('missing Feishu handleSessionlessTool');
    }

    const live = await session.handleTool(
      { name: 'list_chat_bots', arguments: { chat_id: 'chat-a' } },
      {
        dispatcher_id: 'dispatcher-a',
        channel_id: 'primary',
        caller: { kind: 'dispatcher' },
      },
    );
    const sessionless = await provider.handleSessionlessTool(
      'list_chat_bots',
      { chat_id: 'chat-a' },
      {
        dispatcher_id: 'dispatcher-a',
        channel_id: 'primary',
        state_root: root,
      },
    );

    expect(live).toEqual({
      chat_id: 'chat-a',
      known: [
        { open_id: 'bot-known', name: 'Known' },
        { open_id: 'bot-trusted', name: 'Trusted' },
      ],
      trusted: [{ open_id: 'bot-trusted', name: 'Trusted' }],
    });
    expect(JSON.stringify(sessionless)).toBe(JSON.stringify(live));
    await session.close();
  });

  it('does not expose pairing approval as an access MCP tool', () => {
    expect(FEISHU_TOOLS.map((tool) => tool.name)).toEqual([
      'reply',
      'react',
      'list_chat_bots',
    ]);
    expect(buildToolCatalog().map((tool) => tool.name)).not.toContain('access');
    expect(() =>
      parseFeishuMcpToolInput('access', { code: '<PAIRING_TOKEN_HEX>' }),
    ).toThrow(/unknown Feishu tool 'access'/);
  });
});
