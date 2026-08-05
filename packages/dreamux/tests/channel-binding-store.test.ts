/**
 * Channel binding store v3 invariants (issue #209 binding store v3). The store
 * keys active bindings by `(channel_id, target_key)`; `target_key` is the
 * provider-owned routing key (Feishu: the chat id) and provider selectors live
 * in `meta`. v3 also requires `claim_id` route provenance. These pin:
 * bind/resolve/transfer-back by key, non-bindable (P2P) rejection, the
 * one-active-row-per-target reassignment rule, and the persisted v3 shape.
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

describe('ChannelBindingStore v3', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-binding-v3-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('binds, resolves, and transfers back by (channel_id, target_key)', async () => {
    const store = new ChannelBindingStore();
    const { binding: bound } = await store.bind({
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

    // The persisted file is v3, keeps chat_id out of the top-level columns, and
    // records explicit-bind provenance as claim_id: null.
    const onDisk = JSON.parse(
      readFileSync(dispatcherChannelBindingsPath(DISPATCHER), 'utf8'),
    );
    expect(onDisk.version).toBe(3);
    expect(onDisk.bindings[0]).not.toHaveProperty('chat_id');
    expect(onDisk.bindings[0].meta.chat_id).toBe('chat-a');
    expect(onDisk.bindings[0].claim_id).toBeNull();

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
    expect(back.binding?.active).toBe(false);
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
    const { binding: first } = await store.bind({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    });
    const { binding: second } = await store.bind({
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

  it('keeps the available owner while refreshing provider metadata idempotently', async () => {
    const store = new ChannelBindingStore();
    const input = {
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-available'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    };
    const { binding: first } = await store.bindIfAvailableToOwner(input);
    const second = await store.bindIfAvailableToOwner({
      ...input,
      target: {
        ...input.target,
        display: 'changed provider display',
        meta: { chat_id: 'chat-available', message_id: 'latest-message' },
      },
    });

    expect(second).toMatchObject({
      transition: 'unchanged',
      binding: {
        display: 'changed provider display',
        meta: { message_id: 'latest-message' },
        team_name: first.team_name,
        leader_name: first.leader_name,
        created_at: first.created_at,
      },
    });
    expect(second.binding.claim_id).toBeNull();
    expect(await store.list(DISPATCHER)).toHaveLength(1);
  });

  it('refuses another owner and every active managed claim without mutation', async () => {
    const store = new ChannelBindingStore();
    const explicitInput = {
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-explicit'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    };
    await store.bind(explicitInput);
    await expect(store.bindIfAvailableToOwner({
      ...explicitInput,
      teamName: 'beta',
      leaderName: 'beta-leader',
    })).rejects.toThrow(/already bound to another owner/);
    await expect(store.resolve({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-explicit',
    })).resolves.toMatchObject({
      team_name: 'alpha',
      leader_name: 'alpha-leader',
      claim_id: null,
    });

    const managedInput = {
      ...explicitInput,
      target: groupTarget('chat-managed'),
    };
    await store.claim({ ...managedInput, claimId: 'managed-claim' });
    await expect(
      store.bindIfAvailableToOwner(managedInput),
    ).rejects.toThrow(/active collaboration route/);
    await expect(store.resolve({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-managed',
    })).resolves.toMatchObject({
      team_name: 'alpha',
      leader_name: 'alpha-leader',
      claim_id: 'managed-claim',
    });
  });

  it('atomically lets only one of two Team owners claim an available target', async () => {
    const store = new ChannelBindingStore();
    const base = {
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-race'),
    };
    const results = await Promise.allSettled([
      store.bindIfAvailableToOwner({
        ...base,
        teamName: 'alpha',
        leaderName: 'alpha-leader',
      }),
      store.bindIfAvailableToOwner({
        ...base,
        teamName: 'beta',
        leaderName: 'beta-leader',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = await store.resolve({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-race',
    });
    expect(['alpha', 'beta']).toContain(active?.team_name);
    expect(await store.list(DISPATCHER)).toHaveLength(1);
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
        claimId: 'claim-beta',
      }),
    ).rejects.toThrow(/already bound to Team "alpha"/);
    await expect(
      store.resolve({ dispatcherId: DISPATCHER, channelId: 'primary', targetKey: 'chat-a' }),
    ).resolves.toMatchObject({ team_name: 'alpha', active: true });
  });

  it('does not release an explicit same-owner rebind with an older claim id', async () => {
    const store = new ChannelBindingStore();
    const input = {
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    };
    await store.claim({ ...input, claimId: 'collaboration-claim' });
    await store.bind(input);

    await expect(store.transferBackIfClaimed({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-a',
      claimId: 'collaboration-claim',
    })).resolves.toMatchObject({ transition: 'unchanged', binding: null });
    await expect(store.resolve({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-a',
    })).resolves.toMatchObject({
      team_name: 'alpha',
      claim_id: null,
      active: true,
    });
  });

  it('reports route transition taxonomy inside the store write lock', async () => {
    const store = new ChannelBindingStore();
    const input = {
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      provider: 'builtin:feishu',
      target: groupTarget('chat-a'),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
    };

    await expect(store.bind(input)).resolves.toMatchObject({
      transition: 'bound',
      previous: null,
      binding: { team_name: 'alpha', claim_id: null, active: true },
    });
    await expect(store.bind({
      ...input,
      target: {
        ...groupTarget('chat-a'),
        display: 'Renamed group',
        meta: { chat_id: 'chat-a', chat_type: 'group', refreshed: true },
      },
    })).resolves.toMatchObject({
      transition: 'unchanged',
      previous: { team_name: 'alpha', claim_id: null, active: true },
      binding: {
        display: 'Renamed group',
        meta: { refreshed: true },
      },
    });
    await expect(store.claim({
      ...input,
      claimId: 'managed-claim',
    })).rejects.toThrow(/different active route claim/);
    await store.transferBack({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-a',
    });
    await expect(store.claim({
      ...input,
      claimId: 'managed-claim',
    })).resolves.toMatchObject({
      transition: 'bound',
      previous: { active: false },
      binding: { claim_id: 'managed-claim', active: true },
    });
    await expect(store.bind(input)).resolves.toMatchObject({
      transition: 'replaced',
      previous: { claim_id: 'managed-claim' },
      binding: { claim_id: null },
    });
    await expect(store.transferBack({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-a',
    })).resolves.toMatchObject({
      transition: 'unbound',
      previous: { active: true },
      binding: { active: false },
    });
    await expect(store.transferBack({
      dispatcherId: DISPATCHER,
      channelId: 'primary',
      targetKey: 'chat-a',
    })).resolves.toEqual({
      transition: 'unchanged',
      previous: null,
      binding: null,
    });
    await expect(store.bind(input)).resolves.toMatchObject({
      transition: 'bound',
      previous: { active: false },
      binding: { active: true },
    });
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
    ).resolves.toMatchObject({ transition: 'unchanged', binding: null });
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
