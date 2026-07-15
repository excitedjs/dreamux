import { describe, expect, it } from 'vitest';

import type {
  ChannelProvider,
  ChannelProviderFactory,
  ChannelSession,
} from '@excitedjs/dreamux-types';

import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { loadChannelProviders } from '../src/channel/external-channel-provider.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { ChannelService } from '../src/service/channel-service/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const PROVIDER_REF = 'npm:@example/dreamux-task-channel';

describe('external task Channel provider seam', () => {
  it('builds a frozen provider and frozen session without rewriting either', async () => {
    let providerObject: ChannelProvider | null = null;
    let sessionObject: ChannelSession | null = null;
    const catalog = await taskCatalog((context) => {
      sessionObject = Object.freeze(validTaskSession(context.channel_id));
      return sessionObject;
    }, (provider) => {
      providerObject = Object.freeze(provider);
      return providerObject;
    });
    const service = channelService(catalog);

    const sessions = await service.build();
    expect(sessions.get('remote-tasks')).toBe(sessionObject);
    expect(Object.isFrozen(providerObject)).toBe(true);
    expect(Object.isFrozen(sessionObject)).toBe(true);
  });

  it('rejects malformed task event sinks at the session boundary', async () => {
    const catalog = await taskCatalog((context) => ({
      ...validTaskSession(context.channel_id),
      taskHostEvents: {},
    } as unknown as ChannelSession));

    await expect(channelService(catalog).build()).rejects.toThrow(
      /session\.taskHostEvents must expose acceptHostEvents/,
    );
  });

  it('requires an automatic event sink for every task-capable session', async () => {
    const catalog = await taskCatalog((context) => validSession(context.channel_id));

    await expect(channelService(catalog).build()).rejects.toThrow(
      /task-capable session must expose taskHostEvents/,
    );
  });

  it('rejects invalid resolver DTOs before repository policy processing', async () => {
    const catalog = await taskCatalog(
      (context) => validTaskSession(context.channel_id),
      (provider) => ({
        ...provider,
        resolveRepositoryBinding: async () => ({
          cwd: '',
          binding_revision: 'revision-1',
        }),
      }),
    );

    await expect(channelService(catalog).resolveRepositoryBinding(
      'remote-tasks',
      { repository_key: 'repository-a' },
    )).rejects.toThrow(/invalid repository binding/);
  });

  it('keeps conversational providers compatible and task capability absent', async () => {
    const registry = createBuiltinProviderRegistry();
    await loadChannelProviders({
      registry,
      refs: ['npm:@example/dreamux-conversational-channel'],
      importModule: async () => ({
        default: ((context) => ({
          ref: context.ref,
          descriptor: context.descriptor,
          createSession: (sessionContext) => validSession(
            sessionContext.channel_id,
            context.ref,
          ),
        })) satisfies ChannelProviderFactory,
      }),
    });
    const catalog = new ChannelProviderCatalog({ registry });
    const service = channelService(
      catalog,
      'npm:@example/dreamux-conversational-channel',
    );

    expect(service.supportsTaskHost('remote-tasks')).toBe(false);
    await expect(service.build()).resolves.toHaveProperty('size', 1);
  });

  it('fails startup configuration when a channel repository resolver is absent', async () => {
    const registry = createBuiltinProviderRegistry();
    await loadChannelProviders({
      registry,
      refs: [PROVIDER_REF],
      importModule: async () => ({
        default: ((context) => ({
          ref: context.ref,
          descriptor: context.descriptor,
          taskChannel: {
            protocol: 'task_channel_host_v1',
            schema_versions: [1],
            capabilities: [
              'durable_task_submission_v1',
              'host_event_stream_v1',
            ],
          },
          createSession: (sessionContext) => validTaskSession(sessionContext.channel_id),
        })) satisfies ChannelProviderFactory,
      }),
    });
    const service = channelService(
      new ChannelProviderCatalog({ registry }),
      PROVIDER_REF,
      'channel',
    );

    expect(() => service.supportsTaskHost('remote-tasks')).toThrow(
      /does not expose logical_repository_binding_v1 with a resolver/,
    );
  });
});

async function taskCatalog(
  createSession: ChannelProvider['createSession'],
  wrap: (provider: ChannelProvider) => ChannelProvider = (provider) => provider,
): Promise<ChannelProviderCatalog> {
  const registry = createBuiltinProviderRegistry();
  await loadChannelProviders({
    registry,
    refs: [PROVIDER_REF],
    importModule: async () => ({
      default: ((context) => wrap({
        ref: context.ref,
        descriptor: context.descriptor,
        taskChannel: {
          protocol: 'task_channel_host_v1',
          schema_versions: [1],
          capabilities: [
            'durable_task_submission_v1',
            'host_event_stream_v1',
            'logical_repository_binding_v1',
          ],
        },
        createSession,
        resolveRepositoryBinding: async () => null,
      })) satisfies ChannelProviderFactory,
    }),
  });
  return new ChannelProviderCatalog({ registry });
}

function channelService(
  channelProviders: ChannelProviderCatalog,
  provider = PROVIDER_REF,
  repositorySource: 'static' | 'channel' = 'static',
): ChannelService {
  const dispatcher = testDispatcherConfig({
    id: 'dispatcher-a',
    channels: [{
      id: 'remote-tasks',
      provider,
      collaborationSpace: {
        defaultBinding: {
          enabled: false,
          repositorySource,
          repo: null,
          identity: null,
        },
      },
      config: {},
      identity: 'remote-task-platform',
    }],
  });
  return new ChannelService({
    dispatcherId: 'dispatcher-a',
    config: testDreamuxConfig([dispatcher]),
    channelProviders,
    channelLoggerFactory: () => ({}) as never,
  });
}

function validSession(channelId: string, provider = PROVIDER_REF): ChannelSession {
  return {
    provider,
    channel_id: channelId,
    async start() {},
    async close() {},
    async resolveTarget() {
      return { target_type: 'task', target_key: 'unused', bindable: false };
    },
  };
}

function validTaskSession(channelId: string): ChannelSession {
  return {
    ...validSession(channelId),
    taskHostEvents: {
      async acceptHostEvents(batch) {
        return { acknowledged_through: batch.last_sequence ?? 0 };
      },
    },
  };
}
