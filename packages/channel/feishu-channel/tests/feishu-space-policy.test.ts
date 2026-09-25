/**
 * Collaboration Space policy snapshot semantics (COVERAGE CELL F; TeamLeader
 * failure ledger item 17): `generation` names a policy revision, not a
 * cancellation token.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FeishuRouting } from '../src/routing/index.js';
import { FeishuRoutingStore } from '../src/routing/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-space-policy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function makeRouting(): Promise<FeishuRouting> {
  const store = new FeishuRoutingStore({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    stateDir: dir,
  });
  await store.load();
  return new FeishuRouting({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    store,
  });
}

describe('bindSpace — generation advances only on creation-fact changes', () => {
  it('a display-only rename does not advance the generation', async () => {
    const routing = await makeRouting();
    const created = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    expect(created.generation).toBe(1);

    const renamed = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: 'New display',
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    expect(renamed.generation).toBe(1);
  });

  it('changing the leader_agent_runtime advances the generation', async () => {
    const routing = await makeRouting();
    await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    const rebound = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'claude-code',
      identity: null,
      repo: null,
    });
    expect(rebound.generation).toBe(2);
  });
});
