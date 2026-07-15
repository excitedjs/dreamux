import { describe, expect, it } from 'vitest';

import {
  ExternalChannelProviderContractError,
  ExternalChannelProviderLoadError,
  loadChannelProviders,
  type ExternalChannelProviderFactory,
} from '../src/channel/external-channel-provider.js';
import {
  BUILTIN_PROVIDER_PACKAGES,
  createBuiltinProviderRegistry,
  resolveBuiltinProviderPackage,
  UnknownBuiltinProviderPackageError,
} from '../src/registry/index.js';
import type {
  ChannelProvider,
  ChannelSession,
} from '@excitedjs/dreamux-types';
import { asChannelDescriptor } from './helpers/provider.js';

function fakeSession(channelId: string): ChannelSession {
  return {
    provider: 'builtin:feishu',
    channel_id: channelId,
    async start() {
      /* test sink */
    },
    async close() {
      /* test sink */
    },
    async resolveTarget() {
      return { target_type: 'group', target_key: 'k', bindable: true };
    },
  };
}

function channelFactory(options: {
  created?: string[];
} = {}): ExternalChannelProviderFactory {
  return ({ ref, descriptor }) => {
    const provider: ChannelProvider = {
      ref,
      descriptor: asChannelDescriptor(descriptor),
      readConfig(raw) {
        return raw;
      },
      createSession(context) {
        options.created?.push(context.channel_id);
        return fakeSession(context.channel_id);
      },
    };
    return provider;
  };
}

describe('channel provider loader', () => {
  it('resolves the built-in channel ref to its package', () => {
    expect(resolveBuiltinProviderPackage('feishu')).toBe(
      '@excitedjs/feishu-channel',
    );
    expect(BUILTIN_PROVIDER_PACKAGES['feishu']).toBe('@excitedjs/feishu-channel');
  });

  it('maps the built-in agent-runtime refs to their extraction packages', () => {
    // Forward-looking for slice 3: the same alias map carries the runtime
    // packages, so builtin:codex / builtin:claude-code resolve through the
    // identical loader path once those packages exist.
    expect(resolveBuiltinProviderPackage('codex')).toBe(
      '@excitedjs/agent-runtime-codex',
    );
    expect(resolveBuiltinProviderPackage('claude-code')).toBe(
      '@excitedjs/agent-runtime-claude-code',
    );
  });

  it('loads builtin:feishu through the same package-loader path', async () => {
    const registry = createBuiltinProviderRegistry();
    const imported: string[] = [];
    await loadChannelProviders({
      registry,
      refs: ['builtin:feishu'],
      importModule: async (packageName) => {
        imported.push(packageName);
        return { default: channelFactory() };
      },
    });

    expect(imported).toEqual(['@excitedjs/feishu-channel']);
    const descriptors = registry.listByKind('channel');
    expect(descriptors.map((d) => d.id)).toEqual(['feishu']);
    expect(registry.resolve('builtin:feishu').kind).toBe('channel');
  });

  it('loads external npm channel providers and registers the implementation', async () => {
    const registry = createBuiltinProviderRegistry();
    const created: string[] = [];
    await loadChannelProviders({
      registry,
      refs: ['npm:@example/dreamux-channel#provider'],
      importModule: async (packageName) => {
        expect(packageName).toBe('@example/dreamux-channel');
        return { provider: channelFactory({ created }) };
      },
    });

    const descriptor = registry.resolve('npm:@example/dreamux-channel#provider');
    expect(descriptor.kind).toBe('channel');
    const impl = registry.getImplementation(descriptor.id) as ChannelProvider;
    expect(impl.ref).toBe('npm:@example/dreamux-channel#provider');
    const session = impl.createSession({
      dispatcher_id: 'flow',
      channel_id: 'github',
      provider: descriptor.ref.raw,
      config: {},
    });
    expect(session.channel_id).toBe('github');
    expect(created).toEqual(['github']);
  });

  it('accepts a frozen task-capable provider without mutating it', async () => {
    const registry = createBuiltinProviderRegistry();
    let frozen: ChannelProvider | null = null;
    await loadChannelProviders({
      registry,
      refs: ['npm:@example/dreamux-task-channel'],
      importModule: async () => ({
        default: async (context: Parameters<ExternalChannelProviderFactory>[0]) => {
          const base = await channelFactory()(context);
          frozen = Object.freeze({
            ...base,
            taskChannel: {
              protocol: 'task_channel_host_v1' as const,
              schema_versions: [1],
              capabilities: [
                'durable_task_submission_v1' as const,
                'host_event_stream_v1' as const,
              ],
            },
            resolveRepositoryBinding: async () => null,
          });
          return frozen;
        },
      }),
    });

    expect(frozen).not.toBeNull();
    expect(registry.getImplementation(frozen!.descriptor.id)).toBe(frozen);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('skips refs already registered in the channel registry', async () => {
    const registry = createBuiltinProviderRegistry();
    let importCount = 0;
    const importModule = async () => {
      importCount += 1;
      return { default: channelFactory() };
    };
    await loadChannelProviders({
      registry,
      refs: ['builtin:feishu', 'builtin:feishu'],
      importModule,
    });
    expect(importCount).toBe(1);
  });

  it('fails loud for unmapped builtin channel refs', async () => {
    expect(() => resolveBuiltinProviderPackage('does-not-exist')).toThrow(
      UnknownBuiltinProviderPackageError,
    );
    await expect(
      loadChannelProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['builtin:does-not-exist'],
        importModule: async () => ({ default: channelFactory() }),
      }),
    ).rejects.toThrow(ExternalChannelProviderLoadError);
    await expect(
      loadChannelProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['builtin:does-not-exist'],
        importModule: async () => ({ default: channelFactory() }),
      }),
    ).rejects.toThrow(/builtin:does-not-exist/);
  });

  it('reports package import failures with the channel provider ref', async () => {
    await expect(
      loadChannelProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/missing-channel'],
        importModule: async () => {
          throw new Error('package not found');
        },
      }),
    ).rejects.toThrow(ExternalChannelProviderLoadError);
    await expect(
      loadChannelProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/missing-channel'],
        importModule: async () => {
          throw new Error('package not found');
        },
      }),
    ).rejects.toThrow(/npm:@example\/missing-channel/);
  });

  it('rejects modules that do not export a channel provider factory', async () => {
    await expect(
      loadChannelProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/dreamux-channel#missing'],
        importModule: async () => ({ default: channelFactory() }),
      }),
    ).rejects.toThrow(ExternalChannelProviderContractError);
  });

  it('rejects channel providers missing createSession', async () => {
    await expect(
      loadChannelProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/dreamux-channel'],
        importModule: async () => ({
          default: ({ ref, descriptor }: { ref: string; descriptor: unknown }) => ({
            ref,
            descriptor,
          }),
        }),
      }),
    ).rejects.toThrow(/provider\.createSession must be a function/);
  });

  it('rejects channel providers whose descriptor kind is wrong', async () => {
    await expect(
      loadChannelProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/dreamux-channel'],
        importModule: async () => ({
          default: ({ ref }: { ref: string }) => ({
            ref,
            descriptor: {
              id: ref,
              kind: 'agentRuntime',
              ref: { source: 'npm', package: '@example/dreamux-channel', export: null, raw: ref },
            },
            createSession: () => fakeSession('x'),
          }),
        }),
      }),
    ).rejects.toThrow(/provider\.descriptor\.kind must be "channel"/);
  });

  it('rejects malformed task capabilities and repository resolvers', async () => {
    await expect(loadChannelProviders({
      registry: createBuiltinProviderRegistry(),
      refs: ['npm:@example/dreamux-task-channel'],
      importModule: async () => ({
        default: ({ ref, descriptor }: Parameters<ExternalChannelProviderFactory>[0]) => ({
          ...channelFactory()({ ref, descriptor }),
          taskChannel: { protocol: 'unknown' },
        }),
      }),
    })).rejects.toThrow(/provider\.taskChannel/);

    await expect(loadChannelProviders({
      registry: createBuiltinProviderRegistry(),
      refs: ['npm:@example/dreamux-task-channel'],
      importModule: async () => ({
        default: ({ ref, descriptor }: Parameters<ExternalChannelProviderFactory>[0]) => ({
          ...channelFactory()({ ref, descriptor }),
          resolveRepositoryBinding: true,
        }),
      }),
    })).rejects.toThrow(/provider\.resolveRepositoryBinding/);

    await expect(loadChannelProviders({
      registry: createBuiltinProviderRegistry(),
      refs: ['npm:@example/dreamux-task-channel'],
      importModule: async () => ({
        default: ({ ref, descriptor }: Parameters<ExternalChannelProviderFactory>[0]) => ({
          ...channelFactory()({ ref, descriptor }),
          taskChannel: {
            protocol: 'task_channel_host_v1' as const,
            schema_versions: [1],
            capabilities: [
              'durable_task_submission_v1' as const,
              'host_event_stream_v1' as const,
              'logical_repository_binding_v1' as const,
            ],
          },
        }),
      }),
    })).rejects.toThrow(/resolveRepositoryBinding is required/);
  });
});
