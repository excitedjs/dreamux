import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { observeKnownBot, trustIntroducedBots } from '../src/chat-bots-store.js';
import {
  FEISHU_TOOLS,
  buildToolCatalog,
  createFeishuChannelProvider,
  parseFeishuMcpToolInput,
} from '../src/index.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

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
        { dispatcher_id: 'dispatcher-a', channel_id: 'primary' },
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
        { dispatcher_id: 'dispatcher-a', channel_id: 'primary' },
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
      { dispatcher_id: 'dispatcher-a', channel_id: 'primary' },
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
