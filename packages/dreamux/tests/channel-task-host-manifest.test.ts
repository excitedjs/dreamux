import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import { TaskChannelHostCollection } from '../src/service/channel-task-host/index.js';
import {
  ensureTaskHostManifest,
  taskHostRootUnder,
} from '../src/service/channel-task-host/manifest.js';
import { canonicalTaskIdentity } from '../src/service/channel-task-host/identity.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';
import type { TaskTargetClaimInput } from '../src/service/channel-task-host/types.js';
import type { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { applyTestTaskManifest, testTaskContainer } from './helpers/task-host.js';

const PROVIDER = 'npm:@example/dreamux-task-channel';

describe('durable task host manifest discovery', () => {
  let root: string;
  let parent: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-host-manifest-'));
    parent = join(root, 'task-channel');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists a random stable stream identity and rejects provider replacement', async () => {
    const firstRoot = taskHostRootUnder(parent, 'remote-tasks');
    const first = await ensureTaskHostManifest({
      rootDir: firstRoot,
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: PROVIDER,
      now: () => 10,
    });
    const reopened = await ensureTaskHostManifest({
      rootDir: firstRoot,
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: PROVIDER,
      now: () => 20,
    });
    const second = await ensureTaskHostManifest({
      rootDir: taskHostRootUnder(parent, 'remote-tasks-2'),
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks-2',
      providerRef: PROVIDER,
    });

    expect(reopened).toEqual(first);
    expect(first.host_stream_id).toMatch(/^ths_/);
    expect(second.host_stream_id).not.toBe(first.host_stream_id);
    await expect(ensureTaskHostManifest({
      rootDir: firstRoot,
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: 'npm:@example/replacement-channel',
    })).rejects.toThrow(/provider does not match/);
  });

  it('fails startup when an active durable host loses its task capability', async () => {
    await activeStore();
    await expect(TaskChannelHostCollection.open(collectionOptions({
      configured: [{ id: 'remote-tasks', provider: PROVIDER }],
      supportsTaskHost: false,
    }))).rejects.toThrow(/active targets/);
  });

  it('rejects collaboration-space teardown while a task container is active', async () => {
    await activeStore();
    const collection = await TaskChannelHostCollection.open(collectionOptions({
      configured: [{ id: 'remote-tasks', provider: PROVIDER }],
      supportsTaskHost: true,
    }));

    expect(() => collection.assertSpaceCanDissolve({
      version: 1,
      dispatcher_id: 'dispatcher-a',
      space_name: 'space-a',
      channel_id: 'remote-tasks',
      provider: PROVIDER,
      container_type: 'task-space',
      container_key: 'space-a',
      display: null,
      canonical_url: null,
      current_binding: null,
      last_binding_generation: 1,
      status: 'unbound',
      created_at: 1,
      updated_at: 1,
      unbound_at: 1,
      unbound_note: null,
    })).toThrow(/owned by an active task attempt/);
    collection.close();
  });

  it('recovers terminal cleanup without opening a provider session', async () => {
    const store = await activeStore();
    const target = store.list()[0]!;
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    });
    const options = collectionOptions({ configured: [], supportsTaskHost: false });
    const collection = await TaskChannelHostCollection.open(options);
    await collection.recover();
    collection.close();

    const reopened = await TaskHostStore.open({
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: PROVIDER,
      rootDir: taskHostRootUnder(parent, 'remote-tasks'),
    });
    expect(reopened.get(target.target_id)).toMatchObject({
      phase: 'finalized',
      finalizer: { step: 'completed', cleanup_status: 'deleted' },
    });
    expect(options.channels.releaseResolvedTargetIfClaimed).toHaveBeenCalledOnce();
  });

  it('does not expose a cleanup-only host to a conversational session', async () => {
    const store = await activeStore();
    const target = store.list()[0]!;
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    });
    const collection = await TaskChannelHostCollection.open(collectionOptions({
      configured: [{ id: 'remote-tasks', provider: PROVIDER }],
      supportsTaskHost: false,
    }));

    expect(collection.beginSession('remote-tasks')).toBeUndefined();
    await collection.recover();
    collection.close();
  });

  it('fails closed on provider drift and corrupt discovery metadata', async () => {
    await activeStore();
    await expect(TaskChannelHostCollection.open(collectionOptions({
      configured: [{
        id: 'remote-tasks',
        provider: 'npm:@example/replacement-channel',
      }],
      supportsTaskHost: true,
    }))).rejects.toThrow(/provider does not match/);

    await rm(parent, { recursive: true, force: true });
    const corruptRoot = taskHostRootUnder(parent, 'remote-tasks');
    await mkdir(corruptRoot, { recursive: true });
    await writeFile(join(corruptRoot, 'manifest.json'), '{not-json', 'utf8');
    await expect(TaskChannelHostCollection.open(collectionOptions({
      configured: [],
      supportsTaskHost: false,
    }))).rejects.toThrow(/invalid task host manifest JSON/);
  });

  async function activeStore(): Promise<TaskHostStore> {
    const store = await TaskHostStore.open({
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: PROVIDER,
      rootDir: taskHostRootUnder(parent, 'remote-tasks'),
    });
    await applyTestTaskManifest(store, [testTaskContainer('space-a')]);
    await store.claim(taskClaim());
    return store;
  }

  function collectionOptions(input: {
    configured: Array<{ id: string; provider: string }>;
    supportsTaskHost: boolean;
  }) {
    const channels = {
      configuredChannels: () => input.configured,
      supportsTaskHost: () => input.supportsTaskHost,
      releaseResolvedTargetIfClaimed: vi.fn(async () => null),
    } as unknown as ChannelService & {
      releaseResolvedTargetIfClaimed: ReturnType<typeof vi.fn>;
    };
    const dispatcher = testDispatcherConfig({ id: 'dispatcher-a' });
    return {
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([dispatcher]),
      channels,
      collaborationSpaces: {} as CollaborationSpaceService,
      teams: {} as TeamCollection,
      agentRuntimeProviders: {} as AgentRuntimeProviderCatalog,
      log: noopLog(),
      isShuttingDown: () => false,
      taskHostParentDir: parent,
    };
  }
});

function taskClaim(): TaskTargetClaimInput {
  const attempt = { task_key: 'task-a', attempt_key: 'attempt-1' };
  const identity = canonicalTaskIdentity({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    containerType: 'task-space',
    containerKey: 'space-a',
    attempt,
  });
  return {
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    provider: PROVIDER,
    targetId: identity.targetId,
    canonicalTargetKey: identity.targetKey,
    attempt,
    container: { container_type: 'task-space', container_key: 'space-a' },
    manifestRevision: 1,
    containerGeneration: 1,
    logicalRepository: { repository_key: 'repository-a' },
    resolvedRepository: {
      source: 'channel',
      logical_key: 'repository-a',
      binding_revision: 'revision-1',
      fingerprint: 'fingerprint-1',
      repo_cwd: '/tmp/example-repository',
      base_ref: null,
      base_commit: '0'.repeat(40),
    },
    requestFingerprint: 'request-fingerprint',
    receipt: {
      receipt_id: identity.receiptId,
      target_id: identity.targetId,
      attempt,
      revision: 1,
      accepted_at: 1,
      manifest_revision: 1,
      container_generation: 1,
    },
    title: 'Task A',
    turn: { sourceId: 'delivery-a', text: 'Execute task A' },
    teamName: identity.teamName,
    worktreeSlug: identity.worktreeSlug,
    routeClaimId: identity.routeClaimId,
  };
}

function noopLog(): DreamuxLogger {
  const sink = () => {};
  return { error: sink, warn: sink, info: sink, debug: sink, trace: sink };
}
