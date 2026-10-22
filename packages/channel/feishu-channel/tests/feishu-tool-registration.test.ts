import { describe, expect, it } from 'vitest';
import type { ChannelMcpCaller } from '@excitedjs/dreamux-types';
import { feishuToolRegistrations } from '../src/tools/registry.js';

const callers: ChannelMcpCaller[] = [
  { kind: 'dispatcher' },
  { kind: 'team_leader', team_name: 'team-a', leader_name: 'leader-a' },
];

describe('Feishu model-facing output schemas', () => {
  it.each(callers)(
    'leaves reminder-capable binding tools without schemas for $kind',
    (caller) => {
      const registrations = feishuToolRegistrations(caller);
      for (const name of ['bind_channel', 'unbind_channel']) {
        const registration = registrations.find(
          (entry) => entry.tool.name === name,
        );
        expect(registration).toBeDefined();
        expect(registration!.tool).not.toHaveProperty('outputSchema');
      }
      expect(
        registrations.find((entry) => entry.tool.name === 'reply')!.tool,
      ).toHaveProperty('outputSchema');
    },
  );

  it('keeps schemas for collaboration-space tools, including the full identity read', () => {
    const registrations = feishuToolRegistrations({ kind: 'dispatcher' });
    for (const name of [
      'bind_collaboration_space',
      'unbind_collaboration_space',
      'get_collaboration_space',
      'list_collaboration_spaces',
    ]) {
      expect(
        registrations.find((entry) => entry.tool.name === name)!.tool,
      ).toHaveProperty('outputSchema');
    }
    const get = registrations.find(
      (entry) => entry.tool.name === 'get_collaboration_space',
    )!;
    expect(get.tool.outputSchema).toMatchObject({
      properties: {
        space: {
          anyOf: [
            expect.objectContaining({
              properties: expect.objectContaining({
                identity: { type: ['string', 'null'] },
              }),
            }),
            { type: 'null' },
          ],
        },
      },
    });
  });
});
