import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelCorePort,
  ChannelCoreEvent,
  ChannelEventSubscription,
  DreamuxLogger,
  JsonValue,
} from '@excitedjs/dreamux-types';
import type { Mention } from '@excitedjs/feishu-transport';

import { FeishuChannelSession } from '../src/feishu-channel.js';
import {
  detectFeishuSlashCommand,
  dispatchFeishuSlashCommand,
  type FeishuSlashCommandName,
} from '../src/feishu-slash-commands.js';
import { trustIntroducedBots } from '../src/chat-bots-store.js';
import { defaultDispatcherAccessState, saveDispatcherAccess } from '../src/feishu-gate.js';
import { chatTarget, topicTarget, type FeishuTarget } from '../src/routing/target.js';
import { bindChannelDef } from '../src/tools/routing-tools.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import { createFakeCotClient } from './helpers/fake-feishu-cot.js';
import { teamSummary } from './helpers/team-status.js';

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

/**
 * Names the parser would rewrite if `parse-positional-numbers` were left on,
 * and each one is a legal Team id. Both the recognition test and the
 * end-to-end bind test read this list, so neither can drift from the other.
 */
const NUMERIC_LOOKING_TEAM_NAMES = [
  'MyTeam', '123', '1e5', '0x1f', '2.50', '10.00', '1.', '12.', '0.0',
];

describe('Feishu slash command recognition', () => {
  it.each(NUMERIC_LOOKING_TEAM_NAMES)(
    'preserves the exact bind argument %s', (name) => {
      expect(detect({ text: `/BIND ${name}` })).toEqual({ name: 'bind', args: [name] });
    },
  );

  it.each(['--foo', '-abc', '--', '---', '--a=b', '-', '\\'])(
    'parses %s without throwing outside command dispatch', (argument) => {
      expect(() => detect({ text: `/bind ${argument}` })).not.toThrow();
      expect(detect({ text: `/bind ${argument}` })?.name).toBe('bind');
    },
  );

  it('matches whole command tokens only', () => {
    expect(detect({ text: '/binding alpha' })).toBeNull();
    expect(detect({ text: '/helpful' })).toBeNull();
  });

  it('recognizes a mention-prefixed command longest-key-first', () => {
    expect(detect({
      text: '@_user_10 /stop',
      chatType: 'group',
      botMentioned: true,
      mentions: [{ ...mention, key: '@_user_1' }, mention],
    })).toEqual({ name: 'stop', args: [] });
  });

  it('parses trailing text and matches the command name case-insensitively', () => {
    expect(detect({ text: '/STOP now please' })).toEqual({
      name: 'stop', args: ['now', 'please'],
    });
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
    expect(detect({ text: '/dissolve' })).toEqual({ name: 'dissolve', args: [] });
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

/**
 * Dispatch with the parts a command may not use filled in. Every command is
 * handed the same context, so a test that only exercises `/stop` still has to
 * supply what `/teams` reads.
 */
type DispatchContext = Parameters<typeof dispatchFeishuSlashCommand>[1];
function dispatch(
  command: FeishuSlashCommandName,
  context: Pick<DispatchContext, 'plan' | 'invoke' | 'bindings'> & Partial<DispatchContext>,
  trailing = 'now please',
) {
  const invocation = detect({ text: `/${command} ${trailing}` });
  if (invocation === null) throw new Error(`unrecognized command /${command}`);
  return dispatchFeishuSlashCommand(invocation, {
    target: chatTarget('oc_command', 'group'),
    bindChannel: async () => { throw new Error('unexpected bind'); },
    resolveChatName: async () => undefined,
    ...context,
  });
}

describe('Feishu slash command dispatch', () => {
  it('shows its own usage for a bind with no argument and does not bind', async () => {
    const bindChannel = vi.fn<DispatchContext['bindChannel']>();
    const reply = await dispatch('bind', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [], invoke: async () => ({}), bindChannel,
    }, '');
    expect(reply).toEqual({ kind: 'text', text: 'Usage: /bind <team_name>' });
    expect(bindChannel).not.toHaveBeenCalled();
  });

  it('lists every command with its English usage and summary', async () => {
    const reply = await dispatch('help', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [], invoke: async () => { throw new Error('help must not call Core'); },
    });
    const expected: Record<FeishuSlashCommandName, string> = {
      bind: '- `/bind <team_name>` — Route this group to a Team.',
      dissolve: '- `/dissolve` — Dissolve this conversation\'s bound Team.',
      help: '- `/help` — Show this list.',
      stop: '- `/stop` — Interrupt the current turn in this conversation.',
      teams: '- `/teams` — List running Teams.',
    };
    expect(reply).toEqual({
      kind: 'text', text: ['**Dreamux commands**', ...Object.values(expected)].join('\n'),
    });
    for (const name of Object.keys(expected)) {
      expect(detect({ text: `/${name}` })?.name).toBe(name);
    }
  });

  it('targets a bound Team for stop and renders idle distinctly', async () => {
    const calls: Array<{ command: string; payload: JsonValue }> = [];
    const reply = await dispatch('stop', {
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
    await dispatch('stop', {
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
      await expect(dispatch(command, {
        plan,
        bindings: [],
        invoke: async () => { throw new Error('Core unavailable'); },
      // Every command reports a failure the same way, including `/dissolve`:
      // a Core it never reached did not refuse anything.
      })).resolves.toEqual({
        kind: 'text',
        text: `Command /${command} failed: Core unavailable`,
      });
    }
  });

  it('answers an accepted dissolve with nothing, and every other outcome with words', async () => {
    await expect(dispatch('dissolve', {
      plan: { kind: 'dispatcher', reason: 'not_bindable' },
      bindings: [],
      invoke: async () => ({}),
    })).resolves.toEqual({
      kind: 'text',
      text: 'This conversation has no bound Team.',
    });
    await expect(dispatch('dissolve', {
      plan: { kind: 'bound', teamName: 'alpha', matched: chatTarget('oc_a', 'group') },
      bindings: [],
      invoke: async () => ({
        accepted: true,
        team_name: 'alpha',
        status: 'submitted',
      }),
    // The Team's close reaches this Channel as a `team.state` closed event,
    // which removes the routes and announces that to the conversation. A
    // receipt here would be a second message about the one event.
    })).resolves.toEqual({ kind: 'silent' });
    await expect(dispatch('dissolve', {
      plan: { kind: 'bound', teamName: 'alpha', matched: chatTarget('oc_a', 'group') },
      bindings: [],
      invoke: async () => { throw new Error('worktree is dirty'); },
    })).resolves.toEqual({
      kind: 'text',
      text: 'Command /dissolve failed: worktree is dirty',
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
    const first = await dispatch('teams', input);
    const second = await dispatch('teams', input);
    expect(first).toEqual(second);
    const rendered = JSON.stringify(first);
    expect(rendered).toContain('alpha');
    expect(rendered).toContain('Current chat name');
    expect(rendered).not.toContain('closed');
  });

  it('falls back to the chat id when one current-name lookup fails', async () => {
    const reply = await dispatch('teams', {
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
    const reply = await dispatch('teams', {
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
    // panel → grid → left column → the Team tile, whose runtime tag and intent
    // are separate elements so the two columns can size them independently.
    const card = reply.card as {
      body: {
        elements: Array<{
          header: { title: { content: string } };
          elements: Array<{
            columns: Array<{ elements: Array<{ elements: Array<{ content: string }> }> }>;
          }>;
        }>;
      };
    };
    const panel = card.body.elements[0]!;
    const tile = panel.elements[0]!.columns[0]!.elements[0]!;

    expect(tile.elements[0]!.content).toContain('codex\\</text\\_tag\\>\\_\\*');
    expect(tile.elements[1]!.content).toContain('\\</text\\_tag\\>\\*intent\\*\\_');
    expect(tile.elements[1]!.content).not.toContain('</text_tag>*intent*_');
    expect(panel.header.title.content).toContain('\\<unsafe\\>');
  });

  it('links a topic binding to its topic and a group binding to its chat', async () => {
    const binding = {
      chat_id: 'oc_group',
      display: null,
      team_name: 'alpha',
      origin: 'space' as const,
      space_name: 'space',
      created_at: 1,
      updated_at: 1,
    };
    const reply = await dispatch('teams', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [
        { ...binding, target_kind: 'group', thread_id: null },
        { ...binding, target_kind: 'topic', thread_id: 'omt_topic' },
      ],
      resolveChatName: async () => 'Topic group',
      invoke: async () => ({
        teams: [{
          team_name: 'alpha', status: 'running', intent: null,
          source_repo: null, leader_agent_runtime: 'codex',
        }],
      }),
    });
    if (reply.kind !== 'card') throw new Error('expected card reply');
    const card = reply.card as {
      body: {
        elements: Array<{
          elements: Array<{
            columns: Array<{ elements: Array<{ elements: Array<{ content: string }> }> }>;
          }>;
        }>;
      };
    };
    const tile = card.body.elements[0]!.elements[0]!.columns[0]!.elements[0]!;

    expect(tile.elements[2]!.content.split('  \n')).toEqual([
      '[📍 Topic group](https://applink.feishu.cn/client/chat/open?openChatId=oc_group)',
      '[📍 Topic group](https://applink.feishu.cn/client/thread/open' +
        '?open_chat_id=oc_group&open_thread_id=omt_topic' +
        '&openchatid=oc_group&openthreadid=omt_topic&thread_position=-1)' +
        ' <font color=\'grey\'>· omt\\_topic</font>',
    ]);
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

describe('Feishu slash command routing side effects', () => {
  it.each([
    { command: 'stop' as const, code: 'TEAM_NOT_FOUND' },
    { command: 'dissolve' as const, code: 'TEAM_CLOSED' },
  ])('answers /$command for $code and leaves the binding to the paths that own it', async ({ command, code }) => {
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
      command: { name: command, args: [] },
      target,
      containerChatId: null,
    });

    expect(reply).toMatchObject({ kind: 'text', text: expect.stringContaining('Team unavailable') });
    // A rejected command proves nothing durable: TEAM_CLOSED is also raised for
    // a dissolve that is still pending and may yet fail. The binding survives
    // for the final team.state event or the next rejected delivery to remove,
    // so whichever of them empties the rows still has its announcement to make.
    expect(session.routing.bindingFor(target)).toMatchObject({ team_name: 'alpha' });
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
      command: { name: 'teams', args: [] },
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
      text: '@_user_1 /teams',
      resources: [],
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
      text: '@_user_1 /stop',
      resources: [],
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
      text: '@_user_1 /dissolve',
      resources: [],
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

/** Exercise recognition, inbound gates, real binding storage, and outbound placement together. */
async function bindHarness(target = chatTarget('oc_bind', 'group')) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-bind-state-'));
  const attachmentCacheDir = mkdtempSync(join(tmpdir(), 'dreamux-bind-cache-'));
  tempDirs.push(stateDir, attachmentCacheDir);
  const bot = createFakeFeishuBot('bind');
  if (target.kind === 'topic') bot.setChatMode(target.chatId, 'topic');
  const cot = createFakeCotClient();
  bot.setCot(cot);
  await saveDispatcherAccess(stateDir, {
    ...defaultDispatcherAccessState(),
    allow_users: ['ou_human'],
    group: { policy: 'allowlist', allow_chats: [target.chatId], require_mention: true },
  });
  const calls: Array<{ command: string; payload: JsonValue }> = [];
  let status: 'running' | 'closed' | 'missing' = 'running';
  const listeners: Array<(event: ChannelCoreEvent) => void | Promise<void>> = [];
  const session = new FeishuChannelSession({
    dispatcherId: 'disp', channelId: 'channel', appId: 'app', appSecret: '',
    stateDir, attachmentCacheDir, log: silentLog, botFactory: () => bot,
  });
  await session.initialize({
    invoke: {
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'team.list') return { teams: [] };
        if (command !== 'team.status') throw new Error(`unexpected ${command}`);
        const teamName = (payload as { team_name: string }).team_name;
        if (status === 'missing') {
          throw Object.assign(new Error(`Team ${JSON.stringify(teamName)} does not exist`), {
            code: 'TEAM_NOT_FOUND',
          });
        }
        return JSON.parse(JSON.stringify(teamSummary(teamName, status))) as JsonValue;
      },
    },
    events: {
      subscribe(listener) {
        listeners.push(listener);
        return { unsubscribe: () => undefined };
      },
    },
  });
  await session.start();
  const command = vi.spyOn(session, 'command');
  let ordinal = 0;
  return {
    session, bot, cot, calls, command,
    setStatus(value: typeof status) { status = value; },
    async seed(bound: FeishuTarget, teamName: string) {
      await session.routing.bind({ target: bound, teamName, display: null, origin: 'manual', spaceId: null });
    },
    async inject(text: string) {
      const messageId = `om_bind_${++ordinal}`;
      await bot.inject({
        messageId, chatId: target.chatId,
        chatType: target.kind === 'p2p' ? 'p2p' : 'group',
        ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
        senderId: 'ou_human', senderType: 'user', senderName: 'Human',
        messageType: 'text', rawContent: JSON.stringify({ text: `@_user_1 ${text}` }),
        text: `@_user_1 ${text}`, resources: [],
        mentions: [{ key: '@_user_1', name: 'Dreamux', id: { open_id: bot.botOpenId } }],
        createTime: String(ordinal), raw: {},
      });
      return messageId;
    },
    async speak(teamName: string) {
      // A fake send is recorded before its result reaches notification bookkeeping.
      const messageId = bot.sentCards.at(-1)!.messageIds[0]!;
      await vi.waitFor(() => expect(session.handle.targetRouter.targetForMessage(messageId)).toBeDefined());
      for (const listener of listeners) await listener({
        schema_version: 1, kind: 'teammate.activity', occurred_at: 1,
        role: 'team_leader', team_name: teamName, teammate_name: `${teamName}-leader`,
        activity: { kind: 'assistant.message', event_id: `event-${teamName}`, content: 'Hello', redacted: false },
      });
    },
  };
}

describe('/bind through ordinary Feishu inbound', () => {
  it('binds the group and sends exactly the existing binding card, with a silent command result', async () => {
    const h = await bindHarness();
    await h.inject('/bind alpha');
    await vi.waitFor(() => expect(h.bot.sentCards).toHaveLength(1));
    expect(h.session.routing.listBindings()).toMatchObject([{
      target_kind: 'group', chat_id: 'oc_bind', thread_id: null, team_name: 'alpha',
    }]);
    expect(h.bot.sentCards[0]!.target).toEqual({ chatId: 'oc_bind' });
    expect(h.bot.sentMessages).toEqual([]);
    expect(await h.command.mock.results[0]!.value).toEqual({ kind: 'silent' });
    expect(h.calls).toEqual([{ command: 'team.status', payload: { team_name: 'alpha' } }]);
    await h.session.close();
  });

  it.each(NUMERIC_LOOKING_TEAM_NAMES)(
    'binds the exact Team name %s', async (name) => {
      const h = await bindHarness();
      await h.inject(`/bind ${name}`);
      expect(h.session.routing.listBindings()[0]?.team_name).toBe(name);
      expect(h.calls).toEqual([{ command: 'team.status', payload: { team_name: name } }]);
      await h.session.close();
    },
  );

  it.each([false, true])('binds the whole chat and announces in the requesting topic (topic already bound: %s)', async (bound) => {
    const topic = topicTarget('oc_topic_group', 'omt_topic');
    const group = chatTarget(topic.chatId, 'group');
    const h = await bindHarness(topic);
    if (bound) await h.seed(topic, 'team-a');
    const messageId = await h.inject('/bind team-b');
    await vi.waitFor(() => expect(h.bot.sentCards).toHaveLength(1));
    expect(h.session.routing.bindingFor(group)?.team_name).toBe('team-b');
    expect(h.session.routing.bindingFor(topic)?.team_name).toBe(bound ? 'team-a' : undefined);
    expect(h.bot.sentCards[0]!.target).toEqual({ chatId: topic.chatId, replyToMessageId: messageId });
    expect(h.bot.sentMessages).toEqual([]);
    expect(await h.command.mock.results[0]!.value).toEqual({ kind: 'silent' });
    await h.speak('team-b');
    expect(h.session.handle.targetRouter.targetForMessage(h.bot.sentCards[0]!.messageIds[0]!)).toEqual(topic);
    await h.session.close();
    expect(h.cot.cards).toEqual([]);
  });

  // `/bind` binds the containing chat from either place, so both invocations
  // reach `FeishuRouting.bind` with the same group target and are refused by
  // the routing document rather than by this command. The Team is live, so a
  // green assertion here cannot be the closed/missing-Team refusal wearing
  // the Space refusal's name.
  it.each(['group', 'topic'] as const)('refuses a registered Collaboration Space from a %s target without changing routing', async (kind) => {
    const target = kind === 'topic' ? topicTarget('oc_space_bind', 'omt_topic') : chatTarget('oc_space_bind', 'group');
    const h = await bindHarness(target);
    await h.session.routing.bindSpace({
      spaceName: 'space', containerChatId: target.chatId, display: null,
      leaderAgentRuntime: 'codex', identity: null, repo: null,
    });
    // A topic inside the Space, which is what provisioning installs and the
    // one thing binding the chat itself would have taken over. Seeding the
    // container group is no longer possible — that is the rule under test.
    await h.seed(topicTarget(target.chatId, 'omt_provisioned'), 'team-a');
    const before = h.session.routing.listBindings();
    await h.inject('/bind team-b');
    expect(h.bot.sentMessages[0]?.text).toBe(
      'Command /bind failed: This Feishu chat is a Collaboration Space, ' +
      'which gives each of its topics its own Team. Binding the chat itself ' +
      'would take over every topic in it and stop new ones from getting a ' +
      'Team. Bind a chat that is not a Collaboration Space.',
    );
    expect(h.session.routing.listBindings()).toEqual(before);
    expect(h.calls).toEqual([{ command: 'team.status', payload: { team_name: 'team-b' } }]);
    expect(h.bot.sentCards).toEqual([]);
    await h.session.close();
  });

  it('rebinds directly and names the displaced Team on the sole notification', async () => {
    const h = await bindHarness();
    await h.seed(chatTarget('oc_bind', 'group'), 'team-a');
    await h.inject('/bind team-b');
    await vi.waitFor(() => expect(h.bot.sentCards).toHaveLength(1));
    expect(h.session.routing.listBindings()[0]?.team_name).toBe('team-b');
    expect(JSON.stringify(h.bot.sentCards[0]!.card)).toContain('Previous Team: team-a');
    expect(h.bot.sentMessages).toEqual([]);
    await h.session.close();
  });

  it.each([
    ['missing', 'Team "unavailable" does not exist'],
    ['closed', 'Team "unavailable" is closed and can no longer answer here. Bind an open Team instead.'],
  ] as const)('reports the owning layer\'s %s error and preserves routing', async (status, message) => {
    const h = await bindHarness();
    await h.seed(chatTarget('oc_bind', 'group'), 'team-a');
    const before = h.session.routing.listBindings();
    h.setStatus(status);
    await h.inject('/bind unavailable');
    expect(h.bot.sentMessages[0]?.text).toBe(`Command /bind failed: ${message}`);
    expect(h.session.routing.listBindings()).toEqual(before);
    expect(h.bot.sentCards).toEqual([]);
    await h.session.close();
  });

  it('refuses a direct message without writing a row or calling Core', async () => {
    const h = await bindHarness(chatTarget('oc_dm', 'p2p'));
    await h.inject('/bind alpha');
    expect(h.session.routing.listBindings()).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.bot.sentCards).toEqual([]);
    expect(h.bot.sentMessages[0]?.text).toBe(
      'Command /bind failed: A Feishu direct message chat cannot be bound to a Team. ' +
      'Bind a group, or a topic inside one.',
    );
    await h.session.close();
  });

  it('keeps MCP notifications in the bound target and supplies a fallback anchor there', async () => {
    const topic = topicTarget('oc_mcp_group', 'omt_topic');
    const h = await bindHarness(topic);
    // Give the topic a message this session has seen and answered in, so the
    // bound group is not the only place the card and the anchor could land.
    await h.inject('/help');
    const group = chatTarget(topic.chatId, 'group');
    await h.seed(group, 'team-a');
    const caller = { kind: 'dispatcher' } as const;
    const result = await bindChannelDef.handle({ caller, session: h.session.toolSession(caller) },
      bindChannelDef.parse({ chat_id: group.chatId, team_name: 'team-b' }));
    await vi.waitFor(() => expect(h.bot.sentCards).toHaveLength(1));
    expect(result['previous_team_name']).toBe('team-a');
    expect(h.bot.sentCards[0]!.target).toEqual({ chatId: group.chatId });
    expect(JSON.stringify(h.bot.sentCards[0]!.card)).toContain('Previous Team: team-a');
    await h.speak('team-b');
    await vi.waitFor(() => expect(h.cot.cards).toHaveLength(1));
    expect(h.cot.cards[0]!.originMessageId).toBe(h.bot.sentCards[0]!.messageIds[0]);
    await h.session.close();
  });
});
