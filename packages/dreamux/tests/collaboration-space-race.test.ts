import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import { CollaborationSpaceStore } from '../src/service/collaboration-space/store.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import {
  fakeChannels,
  fakeConfig,
  fakeTeams,
  log,
  type CreatedTeam,
} from './helpers/collaboration-space.js';

class SecondFindUnboundStore extends CollaborationSpaceStore {
  calls = 0;
  flipAfterFirstFind = false;

  override async findSpaceByContainer(
    input: Parameters<CollaborationSpaceStore['findSpaceByContainer']>[0],
  ) {
    const space = await super.findSpaceByContainer(input);
    if (!this.flipAfterFirstFind || space === null) return space;
    this.calls += 1;
    if (this.calls === 1) return space;
    return { ...space, current_binding: null, status: 'unbound' as const };
  }
}

describe('CollaborationSpaceService race regressions', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-collab-race-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('provisions with the accepted generation instead of re-reading bound state', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const store = new SecondFindUnboundStore();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      store,
      log: log as never,
      isShuttingDown: () => false,
    });

    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    store.flipAfterFirstFind = true;

    const provisioned = await service.acceptAndProvisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-claim-race',
        bindable: true,
      },
    });

    expect(store.calls).toBe(1);
    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });
    expect(created).toHaveLength(1);
  });

  it('serializes container uniqueness across concurrent bind calls', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => false,
    });

    const container = {
      container_type: 'topic_group',
      container_key: 'container-shared',
    };
    const results = await Promise.allSettled([
      service.bind({
        spaceName: 'space-a',
        container,
        leaderAgentRuntime: 'agent-a',
      }),
      service.bind({
        spaceName: 'space-b',
        container,
        leaderAgentRuntime: 'agent-a',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/already registered as collaboration space/),
      }),
    });
    await expect(service.list()).resolves.toMatchObject({
      spaces: [{ container_key: 'container-shared' }],
    });
  });
});
