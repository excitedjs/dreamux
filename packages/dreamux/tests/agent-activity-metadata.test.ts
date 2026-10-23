import { describe, expect, it, vi } from 'vitest';
import type {
  AgentActivityPage,
  AgentRuntimeProvider,
} from '@excitedjs/dreamux-types';
import { createTeamMateMcpDelegate } from '../src/service/agent/mcp.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';

describe('provider-owned activity metadata', () => {
  it.each([true, false])(
    'passes only provider-supplied path and turn IDs (available=%s)',
    async (available) => {
      const f = await dispatcherFixture();
      await f.host.start();
      const spawned = await f.host.teammates.spawn({
        name: 'reader',
        prompt: 'work',
        intent: 'Observe activity',
      });
      await f.provider.runtimes[0]!.context.state.publish({
        kind: 'session',
        sessionId: 'native-session',
      });
      const nativeTurn = available ? { turnId: 'native-turn' } : {};
      const page: AgentActivityPage = {
        records: [
          { kind: 'assistant_message', text: 'working', ...nativeTurn },
          {
            kind: 'tool',
            name: 'Read',
            status: 'started',
            occurredAt: '2026-01-01T00:00:00Z',
            ...nativeTurn,
          },
        ],
        nextCursor: 'native-cursor',
        truncated: true,
        ...(available ? { transcriptPath: '/native/session.jsonl.zst' } : {}),
      };
      vi.spyOn(f.provider, 'readRecentActivity').mockResolvedValue(page);
      const delegate = createTeamMateMcpDelegate({
        kind: 'dispatcher',
        dispatcher: f.host,
      });
      const records = [
        {
          kind: 'assistant_message',
          text: 'working',
          occurred_at: null,
          ...(available ? { turn_id: 'native-turn' } : {}),
        },
        {
          kind: 'tool',
          name: 'Read',
          status: 'started',
          occurred_at: '2026-01-01T00:00:00Z',
          ...(available ? { turn_id: 'native-turn' } : {}),
        },
      ];
      const expected = {
        records,
        next_cursor: 'native-cursor',
        truncated: true,
        transcript_path: available ? '/native/session.jsonl.zst' : null,
      };
      expect(
        await delegate.call({
          name: 'last',
          arguments: { name: spawned.teammate.name, include_tools: true },
        }),
      ).toMatchObject({ ok: true, structured: expected });
      await f.host.teammates.close({
        name: spawned.teammate.name,
        note: 'Pause',
      });
      const count = f.provider.runtimes.length;
      const closed = await f.host.teammates.last(spawned.teammate.name);
      expect(closed).toMatchObject({
        ...expected,
        teammate: { status: 'closed' },
      });
      expect(closed.records).toEqual(records);
      expect(f.provider.runtimes).toHaveLength(count);
    },
  );
});

describe('MCP last tool selection', () => {
  it.each(['dispatcher', 'team_leader'] as const)(
    '%s defaults to assistant messages and preserves explicit tool selection',
    async (scope) => {
      const f = await dispatcherFixture();
      await f.host.start();
      const spawned = await f.host.teammates.spawn({
        name: 'reader',
        prompt: 'work',
        intent: 'Observe activity',
      });
      await f.provider.runtimes[0]!.context.state.publish({
        kind: 'session',
        sessionId: 'native-session',
      });
      const message = { kind: 'assistant_message', text: 'working' } as const;
      const tool = { kind: 'tool', name: 'Read', status: 'completed' } as const;
      const provider: AgentRuntimeProvider<unknown> = f.provider;
      const read = vi
        .spyOn(provider, 'readRecentActivity')
        .mockImplementation(async (query) => ({
          records: query.includeTools ? [message, tool] : [message],
          truncated: false,
        }));
      const delegate = createTeamMateMcpDelegate(
        scope === 'dispatcher'
          ? { kind: 'dispatcher', dispatcher: f.host }
          : {
              kind: 'team_leader',
              team: {
                teammates: f.host.teammates,
                workflows: f.host.workflows,
                admitLeaderTools: async <T>(operation: () => Promise<T>) =>
                  operation(),
              },
            },
      );
      for (const includeTools of [undefined, false, true]) {
        const result = await delegate.call({
          name: 'last',
          arguments: {
            name: spawned.teammate.name,
            ...(includeTools === undefined
              ? {}
              : { include_tools: includeTools }),
          },
        });
        expect(read).toHaveBeenLastCalledWith(
          {
            sessionId: 'native-session',
            limit: 20,
            includeTools: includeTools ?? false,
          },
          expect.anything(),
        );
        expect(result).toMatchObject({
          ok: true,
          structured: {
            records: (includeTools ? [message, tool] : [message]).map(
              (record) => ({ ...record, occurred_at: null }),
            ),
          },
        });
      }
      const direct = await f.host.teammates.last(spawned.teammate.name);
      expect(direct.records).toEqual([
        { ...message, occurred_at: null },
        { ...tool, occurred_at: null },
      ]);
      expect(read).toHaveBeenLastCalledWith(
        { sessionId: 'native-session', limit: 20, includeTools: true },
        expect.anything(),
      );
    },
  );
});
