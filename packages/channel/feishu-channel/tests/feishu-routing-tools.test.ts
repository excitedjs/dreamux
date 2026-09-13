/**
 * Authorization for `bind_channel`/`unbind_channel`/`list_bindings` is two
 * disjoint tool definitions per name, not one definition branching on caller
 * (COVERAGE CELL F, TeamLeader failure ledger item 21: a capability move must
 * not silently drop TeamLeader self-bind/self-release).
 *
 * The Dispatcher definitions accept an arbitrary `team_name` and reach every
 * route. The TeamLeader definitions have no `team_name` field in their input
 * schema at all — `leaseTeamName` derives the Team from the caller the MCP
 * lease already bound, and passes it as `requireOwner`, so the TeamLeader
 * handler can only ever act on routes that are free or already its own.
 */
import { describe, expect, it } from 'vitest';

import type { ChannelMcpCaller } from '@excitedjs/dreamux-types';

import type { FeishuChannelSession } from '../src/feishu-channel.js';
import { createFeishuSessionMcp } from '../src/feishu-session-mcp.js';

import {
  bindChannelDef,
  leaderBindChannelDef,
  leaderUnbindChannelDef,
  listBindingsDef,
  unbindChannelDef,
} from '../src/tools/routing-tools.js';
import type { FeishuBindingView } from '../src/routing/index.js';
import type {
  FeishuBindTargetSelector,
  FeishuToolContext,
  FeishuToolSession,
} from '../src/tools/types.js';

const teamLeader: ChannelMcpCaller = {
  kind: 'team_leader',
  team_name: 'my-team',
  leader_name: 'leader-1',
};
const dispatcher: ChannelMcpCaller = { kind: 'dispatcher' };

interface RecordedBind {
  target: FeishuBindTargetSelector;
  teamName: string;
  display: string | null;
  requireOwner?: string;
}
interface RecordedUnbind {
  target: FeishuBindTargetSelector;
  requireOwner?: string;
}

function fakeSession(): FeishuToolSession & {
  readonly binds: RecordedBind[];
  readonly unbinds: RecordedUnbind[];
} {
  const binds: RecordedBind[] = [];
  const unbinds: RecordedUnbind[] = [];
  return {
    askUserQuestion: async () => ({ request_id: 'ask-1' }),
    logger: {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    },
    channelId: 'chan-1',
    async sendText() {
      throw new Error('not used');
    },
    async react() {
      throw new Error('not used');
    },
    async listKnownChatBots() {
      throw new Error('not used');
    },
    async bindChannel(input) {
      binds.push(input);
      return { team_name: input.teamName, previous_team_name: null };
    },
    async unbindChannel(target, requireOwner) {
      unbinds.push({ target, requireOwner });
      return { team_name: 'released-team' };
    },
    listBindings() {
      return [];
    },
    async bindSpace() {
      throw new Error('not used');
    },
    async unbindSpace() {
      return null;
    },
    getSpace() {
      return undefined;
    },
    listSpaces() {
      return [];
    },
    binds,
    unbinds,
  };
}

function ctx(caller: ChannelMcpCaller, session: FeishuToolSession): FeishuToolContext {
  return { caller, session };
}

describe('bind_channel — Dispatcher vs TeamLeader are disjoint definitions', () => {
  it('the TeamLeader input schema has no team_name property at all', () => {
    const props = (leaderBindChannelDef.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.hasOwn(props, 'team_name')).toBe(false);
    // The Dispatcher schema does require one.
    const dispatcherProps = (
      bindChannelDef.inputSchema as { properties: Record<string, unknown>; required: string[] }
    );
    expect(dispatcherProps.required).toContain('team_name');
  });

  it('the TeamLeader definition derives the Team from the caller and passes it as requireOwner', async () => {
    const session = fakeSession();
    const input = leaderBindChannelDef.parse({ chat_id: 'oc_own' });
    await leaderBindChannelDef.handle(ctx(teamLeader, session), input);

    expect(session.binds).toEqual([
      {
        target: { chatId: 'oc_own' },
        teamName: 'my-team',
        display: null,
        requireOwner: 'my-team',
      },
    ]);
  });

  it('the Dispatcher definition passes whatever team_name the caller supplied, with no requireOwner', async () => {
    const session = fakeSession();
    const input = bindChannelDef.parse({
      chat_id: 'oc_any',
      team_name: 'arbitrary-team',
    });
    await bindChannelDef.handle(ctx(dispatcher, session), input);

    expect(session.binds).toEqual([
      {
        target: { chatId: 'oc_any' },
        teamName: 'arbitrary-team',
        display: null,
      },
    ]);
  });

  it('only the Dispatcher catalog advertises bind_channel/unbind_channel/list_bindings', () => {
    expect(bindChannelDef.callers).toEqual(['dispatcher']);
    expect(unbindChannelDef.callers).toEqual(['dispatcher']);
    expect(listBindingsDef.callers).toEqual(['dispatcher']);
    expect(leaderBindChannelDef.callers).toEqual(['team_leader']);
    expect(leaderUnbindChannelDef.callers).toEqual(['team_leader']);
  });
});

describe('unbind_channel — TeamLeader self-release', () => {
  it('the TeamLeader input schema has no team_name property', () => {
    const props = (leaderUnbindChannelDef.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.hasOwn(props, 'team_name')).toBe(false);
  });

  it('the TeamLeader definition releases only its own Team\'s routes', async () => {
    const session = fakeSession();
    const input = leaderUnbindChannelDef.parse({ chat_id: 'oc_mine' });
    await leaderUnbindChannelDef.handle(ctx(teamLeader, session), input);

    expect(session.unbinds).toEqual([
      { target: { chatId: 'oc_mine' }, requireOwner: 'my-team' },
    ]);
  });

  it('the Dispatcher definition releases without a requireOwner restriction', async () => {
    const session = fakeSession();
    const input = unbindChannelDef.parse({ chat_id: 'oc_anyones' });
    await unbindChannelDef.handle(ctx(dispatcher, session), input);

    expect(session.unbinds).toEqual([
      { target: { chatId: 'oc_anyones' }, requireOwner: undefined },
    ]);
  });
});

describe('list_bindings — query parameters narrow one table read', () => {
  function row(
    input: Pick<
      FeishuBindingView,
      'target_kind' | 'chat_id' | 'thread_id' | 'team_name'
    >,
  ): FeishuBindingView {
    return {
      ...input,
      display: null,
      origin: 'manual',
      space_name: null,
      created_at: 1,
      updated_at: 1,
    };
  }

  const rows: readonly FeishuBindingView[] = [
    row({ target_kind: 'group', chat_id: 'oc_space', thread_id: null, team_name: 'alpha' }),
    row({ target_kind: 'topic', chat_id: 'oc_space', thread_id: 'omt_one', team_name: 'beta' }),
    row({ target_kind: 'topic', chat_id: 'oc_space', thread_id: 'omt_two', team_name: 'alpha' }),
    row({ target_kind: 'group', chat_id: 'oc_other', thread_id: null, team_name: 'beta' }),
  ];

  /** Each matched row as `chat_id#thread_id`, in table order. */
  async function matched(args: unknown): Promise<string[]> {
    const session: FeishuToolSession = { ...fakeSession(), listBindings: () => rows };
    const result = await listBindingsDef.handle(
      ctx(dispatcher, session),
      listBindingsDef.parse(args),
    );
    const bindings = result['bindings'] as unknown as FeishuBindingView[];
    return bindings.map((item) => `${item.chat_id}#${item.thread_id ?? ''}`);
  }

  it('returns the whole table when no filter is supplied', async () => {
    expect(await matched({})).toEqual([
      'oc_space#',
      'oc_space#omt_one',
      'oc_space#omt_two',
      'oc_other#',
    ]);
    // The tool is still reachable with no arguments at all.
    expect(await matched(undefined)).toHaveLength(4);
  });

  it('team_name returns that Team\'s routes, and an empty answer for a Team with none', async () => {
    expect(await matched({ team_name: 'alpha' })).toEqual([
      'oc_space#',
      'oc_space#omt_two',
    ]);
    expect(await matched({ team_name: 'no-such-team' })).toEqual([]);
  });

  it('chat_id returns the chat\'s own row together with every topic under it', async () => {
    expect(await matched({ chat_id: 'oc_space' })).toEqual([
      'oc_space#',
      'oc_space#omt_one',
      'oc_space#omt_two',
    ]);
  });

  it('thread_id pinpoints one topic', async () => {
    expect(await matched({ thread_id: 'omt_one' })).toEqual(['oc_space#omt_one']);
  });

  it('target_kind is the only way to ask for whole-chat rows alone', async () => {
    expect(await matched({ target_kind: 'group' })).toEqual([
      'oc_space#',
      'oc_other#',
    ]);
    expect(await matched({ target_kind: 'topic' })).toEqual([
      'oc_space#omt_one',
      'oc_space#omt_two',
    ]);
  });

  it('several filters narrow together, and matching nothing is an answer', async () => {
    expect(await matched({ chat_id: 'oc_space', team_name: 'alpha' })).toEqual([
      'oc_space#',
      'oc_space#omt_two',
    ]);
    expect(await matched({ chat_id: 'oc_other', team_name: 'alpha' })).toEqual([]);
  });

  it('rejects a target_kind no binding can be installed with, naming what is accepted', () => {
    expect(() => listBindingsDef.parse({ target_kind: 'p2p' }))
      .toThrow(/target_kind must be one of: group, topic/);
  });

  it('advertises the four filters as optional', () => {
    const schema = listBindingsDef.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      'team_name',
      'chat_id',
      'thread_id',
      'target_kind',
    ]);
    expect(schema.required).toEqual([]);
  });

  it('narrows through the registered Dispatcher catalog, not only in the definition', async () => {
    // The registry advertises `def.inputSchema` and resolves the same object to
    // serve the call, so this is what proves the schema a Dispatcher reads is
    // the one its arguments are parsed against.
    const session: FeishuToolSession = { ...fakeSession(), listBindings: () => rows };

    const result = await mcpFor(session).invoke({
      name: 'list_bindings',
      arguments: { team_name: 'alpha', target_kind: 'topic' },
    }, { dispatcher_id: 'd1', channel_id: 'chan-1', caller: dispatcher });

    expect(result).toMatchObject({
      ok: true,
      value: {
        bindings: [expect.objectContaining({ chat_id: 'oc_space', thread_id: 'omt_two' })],
      },
    });
  });

  it('refuses a bad filter through the registered catalog without claiming success', async () => {
    const result = await mcpFor(fakeSession()).invoke({
      name: 'list_bindings',
      arguments: { target_kind: 'p2p' },
    }, { dispatcher_id: 'd1', channel_id: 'chan-1', caller: dispatcher });

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('target_kind must be one of: group, topic'),
    });
  });
});

function mcpFor(session: FeishuToolSession) {
  return createFeishuSessionMcp(
    { toolSession: () => session } as unknown as FeishuChannelSession,
    session.logger,
  );
}

describe.each([dispatcher, teamLeader])('$kind binding receipts', (caller) => {
  const context = { dispatcher_id: 'd1', channel_id: 'chan-1', caller };

  it('adds notification guidance alongside the successful binding value', async () => {
    const result = await mcpFor(fakeSession()).invoke({
      name: 'bind_channel',
      arguments: {
        chat_id: 'oc_target',
        ...(caller.kind === 'dispatcher' ? { team_name: 'my-team' } : {}),
      },
    }, context);

    expect(result).toEqual({
      ok: true,
      value: {
        chat_id: 'oc_target',
        thread_id: null,
        team_name: 'my-team',
        previous_team_name: null,
      },
      text: expect.stringMatching(/^Binding succeeded\..*automatically.*notification card/),
    });
    expect(result).toMatchObject({
      text: expect.stringContaining('no additional user notification is needed'),
    });
  });

  it.each(['my-team', null])('adds unbinding guidance only for a removed route (%s)', async (teamName) => {
    const session = fakeSession();
    session.unbindChannel = async () => ({ team_name: teamName });
    const result = await mcpFor(session).invoke({
      name: 'unbind_channel',
      arguments: { chat_id: 'oc_target' },
    }, context);

    expect(result).toMatchObject({
      ok: true,
      value: {
        chat_id: 'oc_target',
        thread_id: null,
        unbound: teamName !== null,
        team_name: teamName,
      },
    });
    if (teamName === null) {
      expect(result).not.toHaveProperty('text');
    } else {
      expect(result).toMatchObject({
        text: expect.stringMatching(/^Unbinding succeeded\..*automatically.*notification card/),
      });
      expect(result).toMatchObject({
        text: expect.stringContaining('no additional user notification is needed'),
      });
    }
  });

  it.each(['bind_channel', 'unbind_channel'])('does not claim success for a refused %s call', async (name) => {
    const result = await mcpFor(fakeSession()).invoke({ name, arguments: {} }, context);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('chat_id') });
    expect(result).not.toHaveProperty('text');
  });

  it('does not attach binding guidance to other tools', async () => {
    const result = await mcpFor(fakeSession()).invoke({
      name: 'ask_user_question',
      arguments: {
        chat_id: 'oc_target',
        questions: [{
          header: 'Choice',
          question: 'Which option?',
          options: [
            { label: 'First', description: 'The first option' },
            { label: 'Second', description: 'The second option' },
          ],
        }],
      },
    }, context);
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('text');
  });
});
