/**
 * Channel binding store v2 invariants (issue #209 binding store v2). The store
 * keys active bindings by `(channel_id, target_key)`; `target_key` is the
 * provider-owned routing key (Feishu: the chat id) and provider selectors live
 * in `meta`. These pin: bind/resolve/transfer-back by key, non-bindable (P2P)
 * rejection, the one-active-row-per-target reassignment rule, and the persisted
 * v2 shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChannelTarget } from '@excitedjs/dreamux-types';

import { ChannelBindingStore } from '../src/service/channel-binding/store.js';
import {
  dispatcherChannelBindingsPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';

const DISPATCHER = 'flow';

function groupTarget(chatId: string): ChannelTarget {
  return {
    target_type: 'group',
    target_key: chatId,
    bindable: true,
    meta: { chat_id: chatId, chat_type: 'group' },
  };
}

function p2pTarget(chatId: string): ChannelTarget {
  return {
    target_type: 'p2p',
    target_key: chatId,
    bindable: false,
    meta: { chat_id: chatId, chat_type: 'p2p' },
  };
}

describe('ChannelBindingStore v2', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-binding-v2-'));
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

  it('binds, resolves, and transfers back by (channel_id, target_key)', async () => {
    const store = new ChannelBindingStore();
    const bound = await store.bind({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    });
    expect(bound).toMatchObject({
      channel_id: 'primary',
      target_type: 'group',
      target_key: 'chat-a',
      meta: { chat_id: 'chat-a', chat_type: 'group' },
      team_name: 'alpha',
      leader_name: 'alpha-leader',
      active: true,
    });

    // The persisted file is v2 and keeps chat_id out of the top-level columns.
    const onDisk = JSON.parse(
      readFileSync(dispatcherChannelBindingsPath(DISPATCHER), 'utf8'),
    );
    expect(onDisk.version).toBe(2);
    expect(onDisk.bindings[0]).not.toHaveProperty('chat_id');
    expect(onDisk.bindings[0].meta.chat_id).toBe('chat-a');

    await expect(
      store.resolve({ dispatcherId: DISPATCHER, channelId: 'primary', targetKey: 'chat-a' }),
    ).resolves.toMatchObject({ team_name: 'alpha' });
    // A different channel id never resolves the same target_key.
    await expect(
      store.resolve({ dispatcherId: DISPATCHER, channelId: 'other', targetKey: 'chat-a' }),
    ).resolves.toBeNull();

    const back = await store.transferBack({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-a',
    });
    expect(back?.active).toBe(false);
    await expect(
      store.resolve({ dispatcherId: DISPATCHER, channelId: 'primary', targetKey: 'chat-a' }),
    ).resolves.toBeNull();
  });

  it('rejects binding a non-bindable (P2P) target fail-loud', async () => {
    const store = new ChannelBindingStore();
    await expect(
      store.bind({
        dispatcherId: DISPATCHER,
        channelId: 'primary',
        provider: 'builtin:feishu',
        target: p2pTarget('chat-dm'),
        teamName: 'alpha',
        leaderName: 'alpha-leader',
      }),
    ).rejects.toThrow(/not bindable/);
  });

  it('reassigns an active target to a new Team (one active row per key, created_at preserved)', async () => {
    const store = new ChannelBindingStore();
    const first = await store.bind({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    });
    const second = await store.bind({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'beta',
      leaderName: 'beta-leader',
    });
    expect(second.team_name).toBe('beta');
    expect(second.created_at).toBe(first.created_at);

    // Exactly one row for (channel_id, target_key), now active for beta only.
    const all = await store.list(DISPATCHER);
    expect(all).toHaveLength(1);
    await expect(
      store.resolve({ dispatcherId: DISPATCHER, channelId: 'primary', targetKey: 'chat-a' }),
    ).resolves.toMatchObject({ team_name: 'beta' });
  });

  it('claim rejects an active target owned by another Team', async () => {
    const store = new ChannelBindingStore();
    await store.bind({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    });

    await expect(
      store.claim({
        dispatcherId: DISPATCHER,
        channelId: 'primary',
        provider: 'builtin:feishu',
        target: groupTarget('chat-a'),
        teamName: 'beta',
        leaderName: 'beta-leader',
      }),
    ).rejects.toThrow(/already bound to Team "alpha"/);
    await expect(
      store.resolve({ dispatcherId: DISPATCHER, channelId: 'primary', targetKey: 'chat-a' }),
    ).resolves.toMatchObject({ team_name: 'alpha', active: true });
  });

  it('transferBackIfOwned ignores owner mismatches without deactivating the new owner', async () => {
    const store = new ChannelBindingStore();
    await store.bind({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'beta',
      leaderName: 'beta-leader',
    });

    await expect(
      store.transferBackIfOwned({
        dispatcherId: DISPATCHER,
        channelId: 'primary',
        targetKey: 'chat-a',
        owner: { teamName: 'alpha', leaderName: 'alpha-leader' },
      }),
    ).resolves.toBeNull();
    await expect(
      store.resolve({ dispatcherId: DISPATCHER, channelId: 'primary', targetKey: 'chat-a' }),
    ).resolves.toMatchObject({ team_name: 'beta', active: true });

    await expect(
      store.transferBack({
        dispatcherId: DISPATCHER,
        channelId: 'primary',
        targetKey: 'chat-a',
        expectedOwner: { teamName: 'alpha', leaderName: 'alpha-leader' },
      }),
    ).rejects.toThrow(/not Team "alpha"/);
  });

  it('preserves concurrent binds for different targets in the same file', async () => {
    const store = new ChannelBindingStore();
    const mutableStore = store as unknown as {
      write: (dispatcherId: string, file: unknown) => Promise<void>;
    };
    const write = mutableStore.write.bind(store);
    mutableStore.write = async (dispatcherId, file) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await write(dispatcherId, file);
    };

    await Promise.all(
      Array.from({ length: 12 }, (_, idx) =>
        store.bind({
          dispatcherId: DISPATCHER,
          channelId: 'primary',
          provider: 'builtin:feishu',
          target: groupTarget(`chat-${idx}`),
          teamName: `team-${idx}`,
          leaderName: `team-${idx}-leader`,
        }),
      ),
    );

    const all = await store.list(DISPATCHER);
    expect(all).toHaveLength(12);
    expect(all.map((binding) => binding.target_key).sort()).toEqual(
      Array.from({ length: 12 }, (_, idx) => `chat-${idx}`).sort(),
    );
  });
});
