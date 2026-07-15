import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  ChannelRoutes,
  ChannelSession,
  ChannelTaskHost,
  ChannelTaskHostEventBatch,
  ChannelTaskSubmitInput,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { canonicalTaskIdentity } from '../src/service/channel-task-host/identity.js';
import { TaskChannelHostService } from '../src/service/channel-task-host/service.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';
import { startChannelSessions } from '../src/service/dispatcher-service/channel-session-start.js';
import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import type { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TaskChannelHostCollection } from '../src/service/channel-task-host/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

describe('Task Channel Host public boundary', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-host-contract-'));
    repo = join(root, 'repository');
    await execa('git', ['init', repo]);
    await writeFile(join(repo, 'README.md'), 'fixture\n');
    await execa('git', ['-C', repo, 'add', 'README.md']);
    await execa('git', [
      '-C', repo,
      '-c', 'user.name=Dreamux Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'fixture',
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('derives unique canonical targets without exposing remote keys', () => {
    const common = {
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      containerKey: 'remote-space-key',
      attempt: { task_key: 'remote-task-key', attempt_key: 'attempt-1' },
    };
    const first = canonicalTaskIdentity({ ...common, containerType: 'space' });
    const second = canonicalTaskIdentity({ ...common, containerType: 'project' });
    const retry = canonicalTaskIdentity({ ...common, containerType: 'space' });

    expect(retry).toEqual(first);
    expect(second.targetId).not.toBe(first.targetId);
    expect(JSON.stringify(first)).not.toContain('remote-task-key');
    expect(JSON.stringify(first)).not.toContain('remote-space-key');
  });

  it('exposes Core-derived capabilities and fails closed during negotiation', async () => {
    const { service } = await openService({ root, repo, durableRuntime: false });
    await service.recover();
    const host = service.beginSession();

    expect(host.scope).toMatchObject({
      schema_versions: [1],
      required_capabilities: [
        'durable_task_submission_v1',
        'host_event_stream_v1',
      ],
      stream_generation: 1,
      host_status: 'ready',
    });
    expect(host.scope.host_stream_id).toMatch(/^ths_/);
    expect(host.scope.session_fence).not.toBe('');
    await expect(host.negotiate({
      supported_schema_versions: [1],
      supported_capabilities: ['host_event_stream_v1'],
    })).rejects.toThrow(/durable_task_submission_v1/);

    const negotiated = await negotiate(host);
    expect(negotiated).toMatchObject({
      capabilities: [
        'durable_task_submission_v1',
        'host_event_stream_v1',
      ],
      resume: 'snapshot_required',
      session_fence: host.scope.session_fence,
    });
    const rejected = await host.submit(validSubmission());
    expect(rejected).toMatchObject({
      status: 'rejected',
      code: 'TASK_HOST_CAPABILITY_UNAVAILABLE',
      retryable: false,
    });
    const snapshot = await host.snapshot();
    expect(snapshot.status).toBe('page');
    if (snapshot.status !== 'page') throw new Error('snapshot unavailable');
    expect(snapshot.page.total_items).toBe(0);
  });

  it('requires logical repository capability only for channel-resolved bindings', async () => {
    const { service } = await openService({
      root,
      repo,
      durableRuntime: true,
      repositorySource: 'channel',
    });
    await service.recover();
    const host = service.beginSession();
    expect(host.scope.required_capabilities).toEqual([
      'durable_task_submission_v1',
      'host_event_stream_v1',
      'logical_repository_binding_v1',
    ]);
    await expect(host.negotiate({
      supported_schema_versions: [1],
      supported_capabilities: [
        'durable_task_submission_v1',
        'host_event_stream_v1',
      ],
    })).rejects.toThrow(/logical_repository_binding_v1/);
  });

  it('revokes superseded and detached scoped session handles', async () => {
    const { service } = await openService({ root, repo, durableRuntime: false });
    await service.recover();
    const first = service.beginSession();
    const second = service.beginSession();

    expect(first.scope.session_fence).not.toBe(second.scope.session_fence);
    await expect(negotiate(first)).rejects.toThrow(/revoked/);
    await negotiate(second);
    service.detachEventSink();
    await expect(second.snapshot()).rejects.toThrow(/revoked/);
  });

  it('requires negotiation before attaching the automatic event sink', async () => {
    const { service } = await openService({ root, repo, durableRuntime: false });
    await service.recover();
    const host = service.beginSession();

    expect(() => service.attachEventSink(host.scope.session_fence, {
      acceptHostEvents: async () => ({ acknowledged_through: 0 }),
    })).toThrow(/not negotiated/);
    await negotiate(host);
    expect(() => service.attachEventSink(host.scope.session_fence, {
      acceptHostEvents: async () => ({ acknowledged_through: 0 }),
    })).toThrow(/snapshot must complete/);
  });

  it('detaches the prior event sink when a session handle is superseded', async () => {
    const { service, store } = await openService({ root, repo, durableRuntime: false });
    await service.recover();
    const received: ChannelTaskHostEventBatch[] = [];
    const first = service.beginSession();
    await negotiate(first);
    await first.snapshot();
    service.attachEventSink(first.scope.session_fence, {
      async acceptHostEvents(batch) {
        received.push(structuredClone(batch));
        return { acknowledged_through: store.acknowledgedThrough };
      },
    });
    await waitFor(() => received.length === 1);

    service.beginSession();
    await store.appendHostStatus('degraded');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
  });

  it('requires snapshot for a fresh session and replays an acknowledged cursor', async () => {
    const { service } = await openService({ root, repo, durableRuntime: false });
    await service.recover();
    let host = service.beginSession();
    const fresh = await negotiate(host);
    expect(fresh.resume).toBe('snapshot_required');
    await expect(host.replay({
      host_stream_id: fresh.host_stream_id,
      stream_generation: fresh.stream_generation,
      after_sequence: Math.max(0, fresh.watermark - 1),
    })).resolves.toMatchObject({ status: 'snapshot_required' });
    await expect(host.acknowledgeHostEvents({
      host_stream_id: fresh.host_stream_id,
      stream_generation: fresh.stream_generation,
      acknowledged_through: fresh.watermark,
    })).rejects.toThrow(/exceeds the offered prefix/);
    const snapshot = await host.snapshot();
    expect(snapshot).toMatchObject({
      status: 'page',
      page: {
        complete: true,
        next_cursor: null,
        watermark: fresh.watermark,
        host_status: 'ready',
      },
    });
    const acknowledged = await host.acknowledgeHostEvents({
      host_stream_id: fresh.host_stream_id,
      stream_generation: fresh.stream_generation,
      acknowledged_through: fresh.watermark,
    });
    expect(acknowledged.acknowledged_through).toBe(fresh.watermark);

    host = service.beginSession();
    const resumed = await host.negotiate({
      supported_schema_versions: [1],
      supported_capabilities: host.scope.required_capabilities,
      resume: {
        host_stream_id: fresh.host_stream_id,
        stream_generation: fresh.stream_generation,
        acknowledged_through: acknowledged.acknowledged_through,
      },
    });
    expect(resumed.resume).toBe('replay');
    await expect(host.replay({
      host_stream_id: resumed.host_stream_id,
      stream_generation: resumed.stream_generation + 1,
      after_sequence: acknowledged.acknowledged_through,
    })).resolves.toMatchObject({ status: 'snapshot_required' });
  });

  it('accepts a provider cursor persisted ahead of the Core ACK after restart', async () => {
    const { service, store } = await openService({ root, repo, durableRuntime: false });
    await service.recover();
    const first = service.beginSession();
    const negotiated = await negotiate(first);
    const snapshot = await first.snapshot();
    if (snapshot.status !== 'page' || !snapshot.page.complete) {
      throw new Error('expected a complete snapshot');
    }
    expect(store.acknowledgedThrough).toBeLessThan(snapshot.page.watermark);

    const resumed = service.beginSession();
    const resume = await resumed.negotiate({
      supported_schema_versions: [1],
      supported_capabilities: resumed.scope.required_capabilities,
      resume: {
        host_stream_id: negotiated.host_stream_id,
        stream_generation: negotiated.stream_generation,
        acknowledged_through: snapshot.page.watermark,
      },
    });
    expect(resume.resume).toBe('replay');
    expect(resume.acknowledged_through).toBe(store.acknowledgedThrough);
    await expect(resumed.replay({
      host_stream_id: resume.host_stream_id,
      stream_generation: resume.stream_generation,
      after_sequence: snapshot.page.watermark,
    })).resolves.toMatchObject({
      status: 'events',
      batch: { events: [] },
    });
    await expect(resumed.acknowledgeHostEvents({
      host_stream_id: resume.host_stream_id,
      stream_generation: resume.stream_generation,
      acknowledged_through: snapshot.page.watermark,
    })).resolves.toEqual({ acknowledged_through: snapshot.page.watermark });
  });

  it('automatically drains host events through the provider sink and durable ACK', async () => {
    const { service, store } = await openService({
      root,
      repo,
      durableRuntime: false,
    });
    await service.recover();
    const received: ChannelTaskHostEventBatch[] = [];
    const host = service.beginSession();
    await negotiate(host);
    await host.snapshot();
    service.attachEventSink(host.scope.session_fence, {
      async acceptHostEvents(batch) {
        received.push(structuredClone(batch));
        return { acknowledged_through: batch.last_sequence ?? 0 };
      },
    });
    await waitFor(() => store.acknowledgedThrough === store.watermark);
    expect(received.flatMap((batch) => batch.events).map((event) => event.payload))
      .toEqual([
        { kind: 'host.lifecycle', status: 'recovering' },
        { kind: 'host.lifecycle', status: 'ready' },
      ]);
    expect(store.acknowledgedThrough).toBe(store.watermark);
  });

  it('rejects oversized remote DTOs before repository or runtime side effects', async () => {
    const { service, store, channels, collaborationSpaces } = await openService({
      root,
      repo,
      durableRuntime: true,
    });
    await service.recover();
    const host = service.beginSession();
    await negotiate(host);
    const invalid = validSubmission();
    invalid.turn.text = 'x'.repeat(256 * 1024 + 1);

    await expect(host.submit(invalid)).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_INPUT_INVALID',
    });
    const invalidSource = validSubmission();
    invalidSource.turn.source = { provider: 'remote' } as never;
    await expect(host.submit(invalidSource)).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_INPUT_INVALID',
    });
    const oversizedSource = validSubmission();
    oversizedSource.turn.source = 'x'.repeat(513);
    await expect(host.submit(oversizedSource)).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_INPUT_INVALID',
    });
    expect(store.list()).toEqual([]);
    expect(channels.resolveRepositoryBinding).not.toHaveBeenCalled();
    expect(collaborationSpaces.inspectTaskBinding).not.toHaveBeenCalled();
  });

  it('rejects unknown fields and host-local attachment paths at the DTO boundary', async () => {
    const { service, store, channels } = await openService({
      root,
      repo,
      durableRuntime: true,
    });
    await service.recover();
    const host = service.beginSession();
    await negotiate(host);
    const unknown = validSubmission() as ReturnType<typeof validSubmission> & {
      transport_command?: string;
    };
    unknown.transport_command = 'provider-owned';
    await expect(host.submit(unknown)).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_INPUT_INVALID',
    });
    const localPath = validSubmission();
    localPath.turn.attachments = [{
      kind: 'file',
      name: 'input.txt',
      localPath: '/tmp/provider-supplied-path',
    } as never];
    await expect(host.submit(localPath)).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_INPUT_INVALID',
    });
    await expect(host.cancel({
      attempt: localPath.attempt,
      container: { ...localPath.container, meta: { unexpected: true } },
    } as never)).resolves.toEqual({
      status: 'rejected',
      code: 'TASK_INPUT_INVALID',
    });
    expect(store.list()).toEqual([]);
    expect(channels.resolveRepositoryBinding).not.toHaveBeenCalled();
  });

  it('keeps strict task delivery separate from conversational deliver', async () => {
    const deliver = vi.fn(async () => ({
      status: 'submitted' as const,
      turnId: 'dispatcher-turn',
    }));
    const taskSubmit = vi.fn(async () => ({
      status: 'rejected' as const,
      code: 'TASK_HOST_SHUTTING_DOWN' as const,
      message: 'stopped',
      retryable: true,
    }));
    const taskHost = fakeTaskHost(taskSubmit);
    const session: ChannelSession = {
      provider: 'npm:@example/dreamux-task-channel',
      channel_id: 'remote-tasks',
      async start(routes: ChannelRoutes) {
        expect(routes.taskHost).toBe(taskHost);
        await routes.taskHost!.submit(validSubmission());
      },
      async close() {},
      async resolveTarget() {
        return { target_type: 'task', target_key: 'unused', bindable: false };
      },
    };
    const taskHosts = {
      beginSession: () => taskHost,
      attachEventSink: vi.fn(),
    } as unknown as TaskChannelHostCollection;

    await startChannelSessions({
      sessions: new Map([['remote-tasks', session]]),
      taskHosts,
      deliver,
      targetLifecycle: vi.fn(async () => {}),
      assertReady: () => {},
      adopt: () => {},
    });
    expect(taskSubmit).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
  });
});

async function openService(input: {
  root: string;
  repo: string;
  durableRuntime: boolean;
  repositorySource?: 'static' | 'channel';
}) {
  const repositorySource = input.repositorySource ?? 'static';
  const channelConfig = {
    id: 'remote-tasks',
    provider: 'npm:@example/dreamux-task-channel',
    collaborationSpace: {
      defaultBinding: {
        enabled: true,
        repositorySource,
        repo: repositorySource === 'static'
          ? { cwd: input.repo, baseRef: null }
          : null,
        identity: null,
      },
    },
    config: {},
    identity: 'remote-task-platform',
  };
  const dispatcher = testDispatcherConfig({
    id: 'dispatcher-a',
    agentRuntime: 'leader-runtime',
    runtimeProvider: 'npm:@example/durable-runtime',
    channels: [channelConfig],
  });
  const config = testDreamuxConfig([dispatcher]);
  const store = await TaskHostStore.open({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    providerRef: 'npm:@example/dreamux-task-channel',
    rootDir: join(input.root, 'host'),
  });
  const channels = {
    collaborationSpaceConfig: vi.fn(() => channelConfig.collaborationSpace),
    resolveRepositoryBinding: vi.fn(async () => ({
      cwd: input.repo,
      binding_revision: 'revision-1',
    })),
  } as unknown as ChannelService;
  const collaborationSpaces = {
    inspectTaskBinding: vi.fn(async () => null),
  } as unknown as CollaborationSpaceService;
  const teams = {} as TeamCollection;
  const agentRuntimeProviders = {
    resolve: () => ({
      getCapabilities: () => ({
        resume: { supported: false },
        ...(input.durableRuntime
          ? {
              durableTaskSubmission: {
                supported: true as const,
                protocol: 'durable_task_submission_v1' as const,
              },
              durableTaskToolInvocation: {
                supported: true as const,
                protocol: 'durable_task_mcp_invocation_v1' as const,
              },
            }
          : {}),
      }),
    }),
  } as unknown as AgentRuntimeProviderCatalog;
  const service = await TaskChannelHostService.open({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    provider: channelConfig.provider,
    config,
    channels,
    collaborationSpaces,
    teams,
    agentRuntimeProviders,
    log: noopLog(),
    isShuttingDown: () => false,
    store,
  });
  return { service, store, channels, collaborationSpaces };
}

function validSubmission(): ChannelTaskSubmitInput {
  return {
    attempt: { task_key: 'task-a', attempt_key: 'attempt-1' },
    container: { container_type: 'task-space', container_key: 'space-a' },
    turn: { sourceId: 'delivery-a', text: 'Execute task A' },
    title: 'Task A',
  };
}

function negotiate(host: ChannelTaskHost) {
  return host.negotiate({
    supported_schema_versions: [1],
    supported_capabilities: host.scope.required_capabilities,
  });
}

function fakeTaskHost(
  submit: ChannelTaskHost['submit'],
): ChannelTaskHost {
  return {
    scope: {
      schema_versions: [1],
      required_capabilities: [],
      optional_capabilities: [],
      host_stream_id: 'stream-a',
      stream_generation: 1,
      host_status: 'ready',
      session_fence: 'fence-a',
    },
    negotiate: async () => ({
      schema_version: 1,
      capabilities: [],
      host_stream_id: 'stream-a',
      stream_generation: 1,
      watermark: 0,
      acknowledged_through: 0,
      host_status: 'ready',
      session_fence: 'fence-a',
      resume: 'snapshot_required',
    }),
    submit,
    lookupSubmission: async () => null,
    cancel: async () => ({ status: 'not_found' }),
    snapshot: async () => ({
      status: 'page',
      page: {
        schema_version: 1,
        snapshot_id: 'snapshot-a',
        session_fence: 'fence-a',
        host_stream_id: 'stream-a',
        stream_generation: 1,
        watermark: 0,
        acknowledged_through: 0,
        host_status: 'ready',
        item_offset: 0,
        item_count: 0,
        total_items: 0,
        complete: true,
        items: [],
        next_cursor: null,
      },
    }),
    replay: async () => ({
      status: 'events',
      batch: {
        schema_version: 1,
        host_stream_id: 'stream-a',
        stream_generation: 1,
        first_sequence: null,
        last_sequence: null,
        events: [],
        has_more: false,
      },
    }),
    acknowledgeHostEvents: async ({ acknowledged_through }) => ({
      acknowledged_through,
    }),
  };
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

function noopLog(): DreamuxLogger {
  const sink = () => {};
  return { trace: sink, debug: sink, info: sink, warn: sink, error: sink };
}
