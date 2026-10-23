/**
 * The four Collaboration Space MCP tools are Channel-owned and Dispatcher-only
 * (COVERAGE CELL F). They read and write nothing but this Channel's own
 * `FeishuSpaceRecord` policy rows through `FeishuToolSession`; no Core
 * Collaboration Space state, Command, event, or type is referenced anywhere
 * in this module — the whole capability is a plain read/write over a Feishu
 * record projected into a stable wire shape.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeToolSession,
  type ToolOverrides,
} from './helpers/feishu-tool-session.js';

import type { ChannelMcpCaller } from '@excitedjs/dreamux-types';

import {
  bindSpaceDef,
  getSpaceDef,
  listSpacesDef,
  unbindSpaceDef,
} from '../src/tools/space-tools.js';
import type { FeishuSpaceRecord } from '../src/routing/document.js';
import { FeishuRouting } from '../src/routing/index.js';
import type {
  FeishuToolContext,
  FeishuToolSession,
} from '../src/tools/types.js';

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
    leader_agent_runtime: 'codex',
    identity: null,
    repo: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function fakeSession(
  overrides: Partial<ToolOverrides> = {},
): FeishuToolSession {
  return makeToolSession(overrides);
}

function ctx(
  caller: ChannelMcpCaller,
  session: FeishuToolSession,
): FeishuToolContext {
  return { caller, session };
}

describe('Collaboration Space tools — Dispatcher-only catalog', () => {
  it('none of the four tools are ever offered to a TeamLeader', () => {
    for (const def of [
      bindSpaceDef,
      unbindSpaceDef,
      getSpaceDef,
      listSpacesDef,
    ]) {
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
        return space({
          leader_agent_runtime: input.leaderAgentRuntime,
          display: input.display,
        });
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
    expect(result).toEqual({
      space_name: 'space-a',
      chat_id: 'oc_container',
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
    expect(result).toEqual({ unbound: true });
  });

  it('reports unbound: false when there was nothing to remove', async () => {
    const session = fakeSession({
      async unbindSpace() {
        return null;
      },
    });
    const result = await unbindSpaceDef.handle(
      ctx(dispatcher, session),
      unbindSpaceDef.parse({ space_name: 'never-bound' }),
    );
    expect(result).toEqual({ unbound: false });
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
    expect(result['space']).toEqual({
      space_name: 'space-a',
      chat_id: 'oc_container',
      display: null,
      leader_agent_runtime: 'codex',
      identity: null,
      repo_path: null,
      repo_base_ref: null,
      created_at: 1,
      updated_at: 1,
    });
    expect(result['targets']).toEqual([
      {
        chat_id: 'oc_container',
        thread_id: 'thread_1',
        display: null,
        team_name: 'team-x',
      },
    ]);
  });

  it('answers a null space and empty targets for an unregistered name', async () => {
    const session = fakeSession({
      getSpace: () => undefined,
      listBindings: () => [],
    });
    const result = await getSpaceDef.handle(
      ctx(dispatcher, session),
      getSpaceDef.parse({ space_name: 'nope' }),
    );
    expect(result).toEqual({ space: null, targets: [] });
  });

  it.each([
    null,
    'Review architecture.\n\nPreserve **all** identity guidance.',
  ])(
    'reads the saved identity verbatim after reopening the routing store: %s',
    async (identity) => {
      const dir = await mkdtemp(join(tmpdir(), 'feishu-space-identity-'));
      const options = {
        dispatcherId: 'fixture',
        channelId: 'channel',
        stateDir: dir,
      };
      const routing = new FeishuRouting(options);
      const reopened = new FeishuRouting(options);
      try {
        await routing.initialize();
        const session = fakeSession({
          bindSpace: (input) =>
            routing.bindSpace({
              spaceName: input.spaceName,
              containerChatId: input.chatId,
              display: input.display,
              leaderAgentRuntime: input.leaderAgentRuntime,
              identity: input.identity,
              repo: input.repo,
            }),
          getSpace: (name) => reopened.spaceByName(name),
        });
        expect(
          await bindSpaceDef.handle(
            ctx(dispatcher, session),
            bindSpaceDef.parse({
              space_name: 'space-a',
              chat_id: 'oc_container',
              leader_agent_runtime: 'codex',
              ...(identity === null ? {} : { identity }),
              repo: { path: '/repo', base_ref: 'main' },
            }),
          ),
        ).toEqual({ space_name: 'space-a', chat_id: 'oc_container' });
        await routing.close();
        await reopened.initialize();
        const result = await getSpaceDef.handle(
          ctx(dispatcher, session),
          getSpaceDef.parse({ space_name: 'space-a' }),
        );
        expect(result['space']).toEqual({
          space_name: 'space-a',
          chat_id: 'oc_container',
          display: null,
          leader_agent_runtime: 'codex',
          identity,
          repo_path: '/repo',
          repo_base_ref: 'main',
          created_at: expect.any(Number),
          updated_at: expect.any(Number),
        });
      } finally {
        await routing.close();
        await reopened.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('list_collaboration_spaces', () => {
  it('lists every registered space, projected to the wire shape', async () => {
    const session = fakeSession({
      listSpaces: () => [
        space(),
        space({
          space_name: 'space-b',
          identity: 'Long guidance belongs in get, not in the list.',
          repo: { path: '/repo', base_ref: 'main' },
        }),
      ],
    });
    const result = await listSpacesDef.handle(ctx(dispatcher, session), {});
    expect(result).toEqual({
      spaces: [
        {
          space_name: 'space-a',
          chat_id: 'oc_container',
          display: null,
          leader_agent_runtime: 'codex',
          repo_path: null,
        },
        {
          space_name: 'space-b',
          chat_id: 'oc_container',
          display: null,
          leader_agent_runtime: 'codex',
          repo_path: '/repo',
        },
      ],
    });
  });
});

// A TeamLeader caller is exercised only to prove no handler secretly reads
// `ctx.caller.team_name` to scope Space policy — Collaboration Space is an
// operator-level concept with no Team-scoped reading at all.
describe('Collaboration Space tools ignore caller identity beyond authorization', () => {
  it('get_collaboration_space answers the same regardless of caller identity, when called directly', async () => {
    const record = space();
    const session = fakeSession({
      getSpace: () => record,
      listBindings: () => [],
    });
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
