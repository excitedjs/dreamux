import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ChannelCorePort,
  ChannelEventSubscription,
  DreamuxLogger,
  JsonValue,
} from '@excitedjs/dreamux-types';
import type { Mention } from '@excitedjs/feishu-transport';

import { FeishuChannelSession } from '../src/feishu-channel.js';
import {
  detectFeishuSlashCommand,
  dispatchFeishuSlashCommand,
} from '../src/feishu-slash-commands.js';
import { trustIntroducedBots } from '../src/chat-bots-store.js';
import { defaultDispatcherAccessState, saveDispatcherAccess } from '../src/feishu-gate.js';
import { chatTarget } from '../src/routing/target.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import { createFakeCotClient } from './helpers/fake-feishu-cot.js';

const mention: Mention = {
  key: '@_user_10',
  name: 'Dreamux',
  id: { open_id: 'ou_bot' },
};

function detect(input: {
  text: string;
  messageType?: string;
  chatType?: 'p2p' | 'group';
  botMentioned?: boolean;
  senderKind?: 'human' | 'bot';
  mentions?: Mention[];
}) {
  return detectFeishuSlashCommand({
    messageType: input.messageType ?? 'text',
    rawContent: JSON.stringify({ text: input.text }),
    mentions: input.mentions ?? [],
    chatType: input.chatType ?? 'p2p',
    botMentioned: input.botMentioned ?? false,
    senderKind: input.senderKind ?? 'human',
  });
}

describe('Feishu slash command recognition', () => {
  it('recognizes a mention-prefixed command longest-key-first', () => {
    expect(detect({
      text: '@_user_10 /stop',
      chatType: 'group',
      botMentioned: true,
      mentions: [{ ...mention, key: '@_user_1' }, mention],
    })).toBe('stop');
  });

  it('ignores trailing text and matches case-insensitively', () => {
    expect(detect({ text: '/STOP now please' })).toBe('stop');
  });

  it('does not recognize a command in the middle of a message', () => {
    expect(detect({ text: 'I already sent /stop' })).toBeNull();
  });

  it('does not recognize non-text content', () => {
    expect(detect({ text: '/teams', messageType: 'post' })).toBeNull();
  });

  it('requires a bot mention in groups even when ordinary delivery does not', () => {
    expect(detect({ text: '/teams', chatType: 'group' })).toBeNull();
  });

  it('recognizes a direct-message command without a mention', () => {
    expect(detect({ text: '/dissolve' })).toBe('dissolve');
  });

  it('leaves a trusted bot command-shaped message on ordinary delivery', () => {
    expect(detect({
      text: '@_user_10 /dissolve',
      chatType: 'group',
      botMentioned: true,
      senderKind: 'bot',
      mentions: [mention],
    })).toBeNull();
  });
});

describe('Feishu slash command dispatch', () => {
  it('targets a bound Team for stop and renders idle distinctly', async () => {
    const calls: Array<{ command: string; payload: JsonValue }> = [];
    const reply = await dispatchFeishuSlashCommand('stop', {
      plan: { kind: 'bound', teamName: 'alpha', matched: chatTarget('oc_a', 'group') },
      bindings: [],
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        return { status: 'idle' };
      },
    });
    expect(calls).toEqual([{
      command: 'team.interrupt',
      payload: { team_name: 'alpha' },
    }]);
    expect(reply).toEqual({ kind: 'text', text: 'No turn is running.' });
  });

  it('omits the Team name for an unbound stop', async () => {
    const calls: JsonValue[] = [];
    await dispatchFeishuSlashCommand('stop', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [],
      invoke: async (_command, payload) => {
        calls.push(payload);
        return { status: 'interrupted' };
      },
    });
    expect(calls).toEqual([{}]);
  });

  it('answers every Core command failure with one line', async () => {
    for (const command of ['stop', 'teams', 'dissolve'] as const) {
      const plan = command === 'dissolve'
        ? { kind: 'bound' as const, teamName: 'alpha', matched: chatTarget('oc_a', 'group') }
        : { kind: 'dispatcher' as const, reason: 'no_binding' as const };
      await expect(dispatchFeishuSlashCommand(command, {
        plan,
        bindings: [],
        invoke: async () => { throw new Error('Core unavailable'); },
      })).resolves.toEqual({
        kind: 'text',
        text: command === 'dissolve'
          ? 'Team dissolve refused: Core unavailable'
          : `Command /${command} failed: Core unavailable`,
      });
    }
  });

  it('renders no-bound and Core-refused dissolve outcomes distinctly', async () => {
    await expect(dispatchFeishuSlashCommand('dissolve', {
      plan: { kind: 'dispatcher', reason: 'not_bindable' },
      bindings: [],
      invoke: async () => ({}),
    })).resolves.toEqual({
      kind: 'text',
      text: 'This conversation has no bound Team.',
    });
    await expect(dispatchFeishuSlashCommand('dissolve', {
      plan: { kind: 'bound', teamName: 'alpha', matched: chatTarget('oc_a', 'group') },
      bindings: [],
      invoke: async () => ({
        accepted: true,
        team_name: 'alpha',
        status: 'submitted',
      }),
    })).resolves.toEqual({
      kind: 'text',
      text: 'Dissolving Team "alpha".',
    });
    await expect(dispatchFeishuSlashCommand('dissolve', {
      plan: { kind: 'bound', teamName: 'alpha', matched: chatTarget('oc_a', 'group') },
      bindings: [],
      invoke: async () => { throw new Error('worktree is dirty'); },
    })).resolves.toEqual({
      kind: 'text',
      text: 'Team dissolve refused: worktree is dirty',
    });
  });

  it('filters running Teams and renders stable colors with current chat names', async () => {
    const input = {
      plan: { kind: 'dispatcher', reason: 'not_bindable' } as const,
      bindings: [{
        target_kind: 'group' as const,
        chat_id: 'oc_a',
        thread_id: null,
        display: null,
        team_name: 'alpha',
        origin: 'space' as const,
        space_name: 'space',
        created_at: 1,
        updated_at: 1,
      }],
      resolveChatName: async () => 'Current chat name',
      invoke: async () => ({
        teams: [
          {
            team_name: 'alpha', status: 'running', intent: 'Ship it',
            source_repo: '/repos/example', leader_agent_runtime: 'codex',
          },
          {
            team_name: 'closed', status: 'closed', intent: null,
            source_repo: null, leader_agent_runtime: 'claude-code',
          },
        ],
      }),
    };
    const first = await dispatchFeishuSlashCommand('teams', input);
    const second = await dispatchFeishuSlashCommand('teams', input);
    expect(first).toEqual(second);
    const rendered = JSON.stringify(first);
    expect(rendered).toContain('alpha');
    expect(rendered).toContain('Current chat name');
    expect(rendered).not.toContain('closed');
  });

  it('falls back to the chat id when one current-name lookup fails', async () => {
    const reply = await dispatchFeishuSlashCommand('teams', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [{
        target_kind: 'group',
        chat_id: 'oc_fallback',
        thread_id: null,
        display: null,
        team_name: 'alpha',
        origin: 'space',
        space_name: 'space',
        created_at: 1,
        updated_at: 1,
      }],
      resolveChatName: async () => { throw new Error('lookup unavailable'); },
      invoke: async () => ({
        teams: [{
          team_name: 'alpha', status: 'running', intent: null,
          source_repo: null, leader_agent_runtime: 'codex',
        }],
      }),
    });
    expect(JSON.stringify(reply)).toContain('oc_fallback');
  });

  it('escapes operator text that would otherwise break card markdown tags', async () => {
    const reply = await dispatchFeishuSlashCommand('teams', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [],
      invoke: async () => ({
        teams: [{
          team_name: 'alpha_*', status: 'running', intent: '</text_tag>*intent*_',
          source_repo: '/repos/<unsafe>', leader_agent_runtime: 'codex</text_tag>_*',
        }],
      }),
    });
    if (reply.kind !== 'card') throw new Error('expected card reply');
    const card = reply.card as {
      body: {
        elements: Array<{
          header: { title: { content: string } };
          elements: Array<{ elements: Array<{ content: string }> }>;
        }>;
      };
    };
    const panel = card.body.elements[0]!;
    const content = panel.elements[0]!.elements[0]!.content;

    expect(content).toContain('codex\\</text\\_tag\\>\\_\\*');
    expect(content).toContain('\\</text\\_tag\\>\\*intent\\*\\_');
    expect(content).not.toContain('</text_tag>*intent*_');
    expect(panel.header.title.content).toContain('\\<unsafe\\>');
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

describe('Feishu slash command stale-route reconciliation', () => {
  it.each([
    { command: 'stop' as const, code: 'TEAM_NOT_FOUND' },
    { command: 'dissolve' as const, code: 'TEAM_CLOSED' },
  ])('forgets a bound Team after /$command receives $code', async ({ command, code }) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-command-state-'));
    const attachmentCacheDir = mkdtempSync(join(tmpdir(), 'dreamux-command-cache-'));
    tempDirs.push(stateDir, attachmentCacheDir);
    const bot = createFakeFeishuBot('commands');
    const session = new FeishuChannelSession({
      dispatcherId: 'disp',
      channelId: 'channel',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir,
      log: silentLog,
      botFactory: () => bot,
    });
    await session.initialize({
      invoke: {
        invoke: async () => {
          throw Object.assign(new Error('Team unavailable'), { code });
        },
      },
      events: {
        subscribe(): ChannelEventSubscription {
          return { unsubscribe: () => undefined };
        },
      },
    });
    const target = chatTarget('oc_bound', 'group');
    await session.routing.bind({
      target,
      teamName: 'alpha',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const reply = await session.command({
      command,
      target,
      containerChatId: null,
    });

    expect(reply).toMatchObject({ kind: 'text', text: expect.stringContaining('Team unavailable') });
    expect(session.routing.bindingFor(target)).toBeUndefined();
    await session.close();
  });

  it('calls a class-style bot chat-name resolver with the bot as this', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-command-state-'));
    const attachmentCacheDir = mkdtempSync(join(tmpdir(), 'dreamux-command-cache-'));
    tempDirs.push(stateDir, attachmentCacheDir);
    const bot = createFakeFeishuBot('commands');
    bot.resolveChatName = async function (chatId): Promise<string> {
      if (this !== bot) throw new Error('lost bot receiver');
      return `Bound ${chatId}`;
    };
    const session = new FeishuChannelSession({
      dispatcherId: 'disp',
      channelId: 'channel',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir,
      log: silentLog,
      botFactory: () => bot,
    });
    await session.initialize({
      invoke: {
        invoke: async () => ({
          teams: [{
            team_name: 'alpha', status: 'running', intent: null,
            source_repo: null, leader_agent_runtime: 'codex',
          }],
        }),
      },
      events: {
        subscribe(): ChannelEventSubscription {
          return { unsubscribe: () => undefined };
        },
      },
    });
    const target = chatTarget('oc_bound', 'group');
    await session.routing.bind({
      target,
      teamName: 'alpha',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const reply = await session.command({
      command: 'teams',
      target,
      containerChatId: null,
    });

    expect(JSON.stringify(reply)).toContain('Bound oc\\\\_bound');
    await session.close();
  });
});

describe('Feishu slash command inbound placement', () => {
  it('does not provision or open a COT anchor in a collaboration-space topic', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-command-state-'));
    const attachmentCacheDir = mkdtempSync(join(tmpdir(), 'dreamux-command-cache-'));
    tempDirs.push(stateDir, attachmentCacheDir);
    const bot = createFakeFeishuBot('commands');
    bot.setChatMode('oc_space', 'topic');
    const cot = createFakeCotClient();
    bot.setCot(cot);
    const calls: Array<{ command: string; payload: JsonValue }> = [];
    const port: ChannelCorePort = {
      invoke: {
        invoke: async (command, payload) => {
          calls.push({ command, payload });
          if (command === 'team.list') return { teams: [] };
          throw new Error(`unexpected ${command}`);
        },
      },
      events: {
        subscribe(): ChannelEventSubscription {
          return { unsubscribe: () => undefined };
        },
      },
    };
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      allow_users: ['ou_human'],
      group: {
        policy: 'allowlist',
        allow_chats: ['oc_space'],
        require_mention: false,
      },
    });
    const session = new FeishuChannelSession({
      dispatcherId: 'disp',
      channelId: 'channel',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir,
      log: silentLog,
      botFactory: () => bot,
    });
    await session.initialize(port);
    await session.routing.bindSpace({
      spaceName: 'space',
      containerChatId: 'oc_space',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    await session.start();
    await bot.inject({
      messageId: 'om_command',
      chatId: 'oc_space',
      chatType: 'group',
      threadId: 'omt_topic',
      senderId: 'ou_human',
      senderType: 'user',
      senderName: 'Human',
      messageType: 'text',
      rawContent: JSON.stringify({ text: '@_user_1 /teams' }),
      parsedText: '@Dreamux /teams',
      mentions: [{
        key: '@_user_1',
        name: 'Dreamux',
        id: { open_id: bot.botOpenId },
      }],
      createTime: '1',
      raw: {},
    });

    expect(calls).toEqual([{ command: 'team.list', payload: {} }]);
    expect(cot.cards).toHaveLength(0);
    expect(bot.sentCards).toHaveLength(1);

    await bot.inject({
      messageId: 'om_stop_before_provision',
      chatId: 'oc_space',
      chatType: 'group',
      threadId: 'omt_fresh_topic',
      senderId: 'ou_human',
      senderType: 'user',
      senderName: 'Human',
      messageType: 'text',
      rawContent: JSON.stringify({ text: '@_user_1 /stop' }),
      parsedText: '@Dreamux /stop',
      mentions: [{
        key: '@_user_1',
        name: 'Dreamux',
        id: { open_id: bot.botOpenId },
      }],
      createTime: '2',
      raw: {},
    });

    expect(calls).toEqual([{ command: 'team.list', payload: {} }]);
    expect(bot.sentMessages.at(-1)?.text).toBe(
      'This conversation has no bound Team.',
    );
    expect(cot.cards).toHaveLength(0);
    await session.close();
  });

  it('delivers a trusted bot command-shaped message as ordinary inbound', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-command-state-'));
    const attachmentCacheDir = mkdtempSync(join(tmpdir(), 'dreamux-command-cache-'));
    tempDirs.push(stateDir, attachmentCacheDir);
    const bot = createFakeFeishuBot('commands');
    const calls: Array<{ command: string; payload: JsonValue }> = [];
    const session = new FeishuChannelSession({
      dispatcherId: 'disp',
      channelId: 'channel',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir,
      log: silentLog,
      botFactory: () => bot,
    });
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      group: {
        policy: 'allowlist',
        allow_chats: ['oc_bots'],
        require_mention: true,
      },
    });
    await trustIntroducedBots(stateDir, 'oc_bots', [{ openId: 'ou_peer' }]);
    await session.initialize({
      invoke: {
        invoke: async (command, payload) => {
          calls.push({ command, payload });
          return { status: 'submitted', turn_id: 'turn-bot-message' };
        },
      },
      events: {
        subscribe(): ChannelEventSubscription {
          return { unsubscribe: () => undefined };
        },
      },
    });
    await session.start();

    await bot.inject({
      messageId: 'om_peer_command',
      chatId: 'oc_bots',
      chatType: 'group',
      senderId: 'ou_peer',
      senderType: 'bot',
      senderName: 'Peer bot',
      messageType: 'text',
      rawContent: JSON.stringify({ text: '@_user_1 /dissolve' }),
      parsedText: '@Dreamux /dissolve',
      mentions: [{
        key: '@_user_1',
        name: 'Dreamux',
        id: { open_id: bot.botOpenId },
      }],
      createTime: '1',
      raw: {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('team.submit');
    expect(calls[0]!.payload).not.toHaveProperty('team_name');
    await session.close();
  });
});
