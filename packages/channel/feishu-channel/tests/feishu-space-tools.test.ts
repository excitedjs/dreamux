/**
 * The four Collaboration Space MCP tools are Channel-owned and Dispatcher-only
 * (COVERAGE CELL F). They read and write nothing but this Channel's own
 * `FeishuSpaceRecord` policy rows through `FeishuToolSession`; no Core
 * Collaboration Space state, Command, event, or type is referenced anywhere
 * in this module — the whole capability is a plain read/write over a Feishu
 * record projected into a stable wire shape.
 */
import { describe, expect, it } from 'vitest';

import type { ChannelMcpCaller } from '@excitedjs/dreamux-types';

import {
  bindSpaceDef,
  getSpaceDef,
  listSpacesDef,
  unbindSpaceDef,
} from '../src/tools/space-tools.js';
import type { FeishuSpaceRecord } from '../src/routing/document.js';
import type { FeishuToolContext, FeishuToolSession } from '../src/tools/types.js';

const dispatcher: ChannelMcpCaller = { kind: 'dispatcher' };
const teamLeader: ChannelMcpCaller = {
  kind: 'team_leader',
  team_name: 'team-a',
  leader_name: 'leader-a',
};

function space(overrides: Partial<FeishuSpaceRecord> = {}): FeishuSpaceRecord {
  return {
    space_id: 'space-id-1',
    space_name: 'space-a',
    container_chat_id: 'oc_container',
    display: null,
    generation: 1,
    leader_agent_runtime: 'codex',
    identity: null,
    repo: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function fakeSession(
  overrides: Partial<FeishuToolSession> = {},
): FeishuToolSession {
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
    async bindChannel() {
      throw new Error('not used');
    },
    async unbindChannel() {
      throw new Error('not used');
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
    ...overrides,
  };
}

function ctx(caller: ChannelMcpCaller, session: FeishuToolSession): FeishuToolContext {
  return { caller, session };
}

describe('Collaboration Space tools — Dispatcher-only catalog', () => {
  it('none of the four tools are ever offered to a TeamLeader', () => {
    for (const def of [bindSpaceDef, unbindSpaceDef, getSpaceDef, listSpacesDef]) {
      expect(def.callers).toEqual(['dispatcher']);
      expect(def.callers).not.toContain('team_leader');
    }
  });
});

describe('bind_collaboration_space', () => {
  it('parses input and projects the returned FeishuSpaceRecord to the wire shape', async () => {
    let received: unknown;
    const session = fakeSession({
      async bindSpace(input) {
        received = input;
        return space({ leader_agent_runtime: input.leaderAgentRuntime, display: input.display });
      },
    });
    const input = bindSpaceDef.parse({
      space_name: 'space-a',
      chat_id: 'oc_container',
      display: 'Nice label',
      leader_agent_runtime: 'claude-code',
      repo: { path: '/repo', base_ref: 'main' },
    });
    const result = await bindSpaceDef.handle(ctx(dispatcher, session), input);

    expect(received).toEqual({
      spaceName: 'space-a',
      chatId: 'oc_container',
      display: 'Nice label',
      leaderAgentRuntime: 'claude-code',
      identity: null,
      repo: { path: '/repo', base_ref: 'main' },
    });
    expect(result['space']).toMatchObject({
      space_name: 'space-a',
      leader_agent_runtime: 'claude-code',
      display: 'Nice label',
    });
  });
});

describe('unbind_collaboration_space', () => {
  it('reports unbound: true when a policy was actually removed', async () => {
    const session = fakeSession({
      async unbindSpace(spaceName) {
        expect(spaceName).toBe('space-a');
        return space();
      },
    });
    const result = await unbindSpaceDef.handle(
      ctx(dispatcher, session),
      unbindSpaceDef.parse({ space_name: 'space-a' }),
    );
    expect(result).toEqual({ space_name: 'space-a', unbound: true });
  });

  it('reports unbound: false when there was nothing to remove', async () => {
    const session = fakeSession({ async unbindSpace() { return null; } });
    const result = await unbindSpaceDef.handle(
      ctx(dispatcher, session),
      unbindSpaceDef.parse({ space_name: 'never-bound' }),
    );
    expect(result).toEqual({ space_name: 'never-bound', unbound: false });
  });
});

describe('get_collaboration_space', () => {
  it('joins the space policy with only the bindings that carry its own space_name', async () => {
    const record = space();
    const session = fakeSession({
      getSpace: () => record,
      listBindings: () => [
        {
          target_kind: 'topic',
          chat_id: 'oc_container',
          thread_id: 'thread_1',
          display: null,
          team_name: 'team-x',
          origin: 'space',
          space_name: 'space-a',
          created_at: 1,
          updated_at: 1,
        },
        {
          target_kind: 'group',
          chat_id: 'oc_unrelated',
          thread_id: null,
          display: null,
          team_name: 'team-y',
          origin: 'manual',
          space_name: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    const result = await getSpaceDef.handle(
      ctx(dispatcher, session),
      getSpaceDef.parse({ space_name: 'space-a' }),
    );
    expect(result['targets']).toEqual([
      { chat_id: 'oc_container', thread_id: 'thread_1', display: null, team_name: 'team-x' },
    ]);
  });

  it('answers a null space and empty targets for an unregistered name', async () => {
    const session = fakeSession({ getSpace: () => undefined, listBindings: () => [] });
    const result = await getSpaceDef.handle(
      ctx(dispatcher, session),
      getSpaceDef.parse({ space_name: 'nope' }),
    );
    expect(result).toEqual({ space: null, targets: [] });
  });
});

describe('list_collaboration_spaces', () => {
  it('lists every registered space, projected to the wire shape', async () => {
    const session = fakeSession({ listSpaces: () => [space(), space({ space_name: 'space-b' })] });
    const result = await listSpacesDef.handle(ctx(dispatcher, session));
    expect((result['spaces'] as unknown[]).map((s) => (s as { space_name: string }).space_name)).toEqual([
      'space-a',
      'space-b',
    ]);
  });
});

// A TeamLeader caller is exercised only to prove no handler secretly reads
// `ctx.caller.team_name` to scope Space policy — Collaboration Space is an
// operator-level concept with no Team-scoped reading at all.
describe('Collaboration Space tools ignore caller identity beyond authorization', () => {
  it('get_collaboration_space answers the same regardless of caller identity, when called directly', async () => {
    const record = space();
    const session = fakeSession({ getSpace: () => record, listBindings: () => [] });
    const asDispatcher = await getSpaceDef.handle(
      ctx(dispatcher, session),
      getSpaceDef.parse({ space_name: 'space-a' }),
    );
    const asTeamLeaderCtx: FeishuToolContext = { caller: teamLeader, session };
    const asTeamLeader = await getSpaceDef.handle(
      asTeamLeaderCtx,
      getSpaceDef.parse({ space_name: 'space-a' }),
    );
    expect(asDispatcher).toEqual(asTeamLeader);
  });
});
