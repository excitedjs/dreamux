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

import {
  bindChannelDef,
  leaderBindChannelDef,
  leaderUnbindChannelDef,
  listBindingsDef,
  unbindChannelDef,
} from '../src/tools/routing-tools.js';
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
