import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@excitedjs/dreamux-types';
import type { Mention } from '@excitedjs/feishu-transport';

import {
  detectFeishuSlashCommand,
  dispatchFeishuSlashCommand,
  type FeishuSlashCommandName,
} from '../src/feishu-slash-commands.js';
import { chatTarget } from '../src/routing/target.js';

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
 * and each one is a legal Team id.
 */
const NUMERIC_LOOKING_TEAM_NAMES = [
  'MyTeam',
  '123',
  '1e5',
  '0x1f',
  '2.50',
  '10.00',
  '1.',
  '12.',
  '0.0',
];

describe('Feishu slash command recognition', () => {
  it.each(NUMERIC_LOOKING_TEAM_NAMES)(
    'preserves the exact bind argument %s',
    (name) => {
      expect(detect({ text: `/BIND ${name}` })).toEqual({
        name: 'bind',
        args: [name],
      });
    },
  );

  it.each(['--foo', '-abc', '--', '---', '--a=b', '-', '\\'])(
    'parses %s without throwing outside command dispatch',
    (argument) => {
      expect(() => detect({ text: `/bind ${argument}` })).not.toThrow();
      expect(detect({ text: `/bind ${argument}` })?.name).toBe('bind');
    },
  );

  it('matches whole command tokens only', () => {
    expect(detect({ text: '/binding alpha' })).toBeNull();
    expect(detect({ text: '/helpful' })).toBeNull();
  });

  it('recognizes a mention-prefixed command longest-key-first', () => {
    expect(
      detect({
        text: '@_user_10 /stop',
        chatType: 'group',
        botMentioned: true,
        mentions: [{ ...mention, key: '@_user_1' }, mention],
      }),
    ).toEqual({ name: 'stop', args: [] });
  });

  it('parses trailing text and matches the command name case-insensitively', () => {
    expect(detect({ text: '/STOP now please' })).toEqual({
      name: 'stop',
      args: ['now', 'please'],
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
    expect(detect({ text: '/dissolve' })).toEqual({
      name: 'dissolve',
      args: [],
    });
  });

  it('leaves a trusted bot command-shaped message on ordinary delivery', () => {
    expect(
      detect({
        text: '@_user_10 /dissolve',
        chatType: 'group',
        botMentioned: true,
        senderKind: 'bot',
        mentions: [mention],
      }),
    ).toBeNull();
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
  context: Pick<DispatchContext, 'plan' | 'invoke' | 'bindings'> &
    Partial<DispatchContext>,
  trailing = 'now please',
) {
  const invocation = detect({ text: `/${command} ${trailing}` });
  if (invocation === null) throw new Error(`unrecognized command /${command}`);
  return dispatchFeishuSlashCommand(invocation, {
    target: chatTarget('oc_command', 'group'),
    bindChannel: async () => {
      throw new Error('unexpected bind');
    },
    resolveChatName: async () => undefined,
    ...context,
  });
}

describe('Feishu slash command dispatch', () => {
  it('shows its own usage for a bind with no argument and does not bind', async () => {
    const bindChannel = vi.fn<DispatchContext['bindChannel']>();
    const reply = await dispatch(
      'bind',
      {
        plan: { kind: 'dispatcher', reason: 'no_binding' },
        bindings: [],
        invoke: async () => ({}),
        bindChannel,
      },
      '',
    );
    expect(reply).toEqual({ kind: 'text', text: 'Usage: /bind <team_name>' });
    expect(bindChannel).not.toHaveBeenCalled();
  });

  it('lists every command with its English usage and summary', async () => {
    const reply = await dispatch('help', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [],
      invoke: async () => {
        throw new Error('help must not call Core');
      },
    });
    const expected: Record<FeishuSlashCommandName, string> = {
      bind: '- `/bind <team_name>` — Route this group to a Team.',
      dissolve: "- `/dissolve` — Dissolve this conversation's bound Team.",
      help: '- `/help` — Show this list.',
      stop: '- `/stop` — Interrupt the current turn in this conversation.',
      teams: '- `/teams` — List running Teams.',
    };
    expect(reply).toEqual({
      kind: 'text',
      text: ['**Dreamux commands**', ...Object.values(expected)].join('\n'),
    });
    for (const name of Object.keys(expected)) {
      expect(detect({ text: `/${name}` })?.name).toBe(name);
    }
  });

  it('targets a bound Team for stop and renders idle distinctly', async () => {
    const calls: Array<{ command: string; payload: JsonValue }> = [];
    const reply = await dispatch('stop', {
      plan: {
        kind: 'bound',
        teamName: 'alpha',
        matched: chatTarget('oc_a', 'group'),
      },
      bindings: [],
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        return { status: 'idle' };
      },
    });
    expect(calls).toEqual([
      {
        command: 'team.interrupt',
        payload: { team_name: 'alpha' },
      },
    ]);
    expect(reply).toEqual({ kind: 'text', text: 'No turn is running.' });
  });

  it('addresses the Dispatcher Agent for an unbound stop', async () => {
    const calls: Array<{ command: string; payload: JsonValue }> = [];
    await dispatch('stop', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [],
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        return { status: 'interrupted' };
      },
    });
    expect(calls).toEqual([{ command: 'dispatcher.interrupt', payload: {} }]);
  });

  it('answers every Core command failure with one line', async () => {
    for (const command of ['stop', 'teams', 'dissolve'] as const) {
      const plan =
        command === 'dissolve'
          ? {
              kind: 'bound' as const,
              teamName: 'alpha',
              matched: chatTarget('oc_a', 'group'),
            }
          : { kind: 'dispatcher' as const, reason: 'no_binding' as const };
      await expect(
        dispatch(command, {
          plan,
          bindings: [],
          invoke: async () => {
            throw new Error('Core unavailable');
          },
          // Every command reports a failure the same way, including `/dissolve`:
          // a Core it never reached did not refuse anything.
        }),
      ).resolves.toEqual({
        kind: 'text',
        text: `Command /${command} failed: Core unavailable`,
      });
    }
  });

  it('answers an accepted dissolve with nothing, and every other outcome with words', async () => {
    await expect(
      dispatch('dissolve', {
        plan: { kind: 'dispatcher', reason: 'not_bindable' },
        bindings: [],
        invoke: async () => ({}),
      }),
    ).resolves.toEqual({
      kind: 'text',
      text: 'This conversation has no bound Team.',
    });
    await expect(
      dispatch('dissolve', {
        plan: {
          kind: 'bound',
          teamName: 'alpha',
          matched: chatTarget('oc_a', 'group'),
        },
        bindings: [],
        invoke: async () => ({
          accepted: true,
          team_name: 'alpha',
          status: 'submitted',
        }),
        // The Team's close reaches this Channel as a `team.state` closed event,
        // which removes the routes and announces that to the conversation. A
        // receipt here would be a second message about the one event.
      }),
    ).resolves.toEqual({ kind: 'silent' });
    await expect(
      dispatch('dissolve', {
        plan: {
          kind: 'bound',
          teamName: 'alpha',
          matched: chatTarget('oc_a', 'group'),
        },
        bindings: [],
        invoke: async () => {
          throw new Error('worktree is dirty');
        },
      }),
    ).resolves.toEqual({
      kind: 'text',
      text: 'Command /dissolve failed: worktree is dirty',
    });
  });

  it('filters running Teams and renders stable colors with current chat names', async () => {
    const input = {
      plan: { kind: 'dispatcher', reason: 'not_bindable' } as const,
      bindings: [
        {
          target_kind: 'group' as const,
          chat_id: 'oc_a',
          thread_id: null,
          display: null,
          team_name: 'alpha',
          origin: 'space' as const,
          space_name: 'space',
          created_at: 1,
          updated_at: 1,
        },
      ],
      resolveChatName: async () => 'Current chat name',
      invoke: async () => ({
        teams: [
          {
            team_name: 'alpha',
            status: 'running',
            intent: 'Ship it',
            source_repo: '/repos/example',
            leader_agent_runtime: 'codex',
          },
          {
            team_name: 'closed',
            status: 'closed',
            intent: null,
            source_repo: null,
            leader_agent_runtime: 'claude-code',
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
      bindings: [
        {
          target_kind: 'group',
          chat_id: 'oc_fallback',
          thread_id: null,
          display: null,
          team_name: 'alpha',
          origin: 'space',
          space_name: 'space',
          created_at: 1,
          updated_at: 1,
        },
      ],
      resolveChatName: async () => {
        throw new Error('lookup unavailable');
      },
      invoke: async () => ({
        teams: [
          {
            team_name: 'alpha',
            status: 'running',
            intent: null,
            source_repo: null,
            leader_agent_runtime: 'codex',
          },
        ],
      }),
    });
    expect(JSON.stringify(reply)).toContain('oc_fallback');
  });

  it('escapes operator text that would otherwise break card markdown tags', async () => {
    const reply = await dispatch('teams', {
      plan: { kind: 'dispatcher', reason: 'no_binding' },
      bindings: [],
      invoke: async () => ({
        teams: [
          {
            team_name: 'alpha_*',
            status: 'running',
            intent: '</text_tag>*intent*_',
            source_repo: '/repos/<unsafe>',
            leader_agent_runtime: 'codex</text_tag>_*',
          },
        ],
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
            columns: Array<{
              elements: Array<{ elements: Array<{ content: string }> }>;
            }>;
          }>;
        }>;
      };
    };
    const panel = card.body.elements[0]!;
    const tile = panel.elements[0]!.columns[0]!.elements[0]!;

    expect(tile.elements[0]!.content).toContain('codex\\</text\\_tag\\>\\_\\*');
    expect(tile.elements[1]!.content).toContain(
      '\\</text\\_tag\\>\\*intent\\*\\_',
    );
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
        teams: [
          {
            team_name: 'alpha',
            status: 'running',
            intent: null,
            source_repo: null,
            leader_agent_runtime: 'codex',
          },
        ],
      }),
    });
    if (reply.kind !== 'card') throw new Error('expected card reply');
    const card = reply.card as {
      body: {
        elements: Array<{
          elements: Array<{
            columns: Array<{
              elements: Array<{ elements: Array<{ content: string }> }>;
            }>;
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
        " <font color='grey'>· omt\\_topic</font>",
    ]);
  });
});
