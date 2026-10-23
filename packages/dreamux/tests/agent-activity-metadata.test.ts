import { describe, expect, it, vi } from 'vitest';
import type { AgentActivityPage } from '@excitedjs/dreamux-types';
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
          arguments: { name: spawned.teammate.name },
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
