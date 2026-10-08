/** Core channel ownership, provider registration, and caller-scoped MCP behavior. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelMcpCaller,
  ChannelProvider,
  DreamuxLogger,
  ProviderFactoryContext,
} from '@excitedjs/dreamux-types';
import type { DispatcherChannelConfig } from '../src/config/config.js';
import { resolveConfig } from '../src/config/load.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import {
  loadChannelProviders,
  ExternalChannelProviderContractError,
} from '../src/channel/external-channel-provider.js';
import { ChannelService } from '../src/service/channel-service/index.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { mcpDelegateIdentity } from '../src/service/mcp/identity-version.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { WorkFence } from '../src/platform/work-fence.js';
import { dispatcherCacheDir, dispatcherDir } from '../src/platform/paths.js';
import {
  createFakeChannelProvider,
  fakeChannelToolRegistration,
} from './helpers/fake-channel-provider.js';
import { ControlledRuntimeProvider } from './helpers/controlled-runtime-provider.js';

const external = vi.hoisted(() => ({
  factory: (_context: unknown): unknown => {
    throw new Error('unconfigured external fixture');
  },
}));
vi.mock('@excitedjs/feishu-channel', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@excitedjs/feishu-channel')>();
  return {
    ...actual,
    createTestChannel: (context: unknown) => external.factory(context),
  };
});

const log: DreamuxLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child: () => log,
};
const caller: ChannelMcpCaller = { kind: 'dispatcher' };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-channel-service-'));
  vi.stubEnv('DREAMUX_ROOT', root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function channelConfig(id: string, provider: string): DispatcherChannelConfig {
  return { id, provider, config: { marker: id } };
}
function catalogWith(
  registrations: ReadonlyArray<{
    ref: string;
    id?: string;
    provider: ChannelProvider<unknown>;
  }>,
): ChannelProviderCatalog {
  const registry = new ProviderRegistry();
  for (const { ref, id, provider } of registrations) {
    registry.register(
      { id: id ?? ref, kind: 'channel', ref: parseProviderRef(ref) },
      provider,
    );
  }
  return new ChannelProviderCatalog({ registry });
}
function owner(
  channels: DispatcherChannelConfig[],
  catalog: ChannelProviderCatalog,
  logger: DreamuxLogger = log,
) {
  const coreEvents = new DispatcherCoreEventBus({
    dispatcherId: 'flow',
    log: logger,
  });
  const commands = { invoke: vi.fn(async () => ({})) };
  const service = new ChannelService({
    dispatcherId: 'flow',
    dispatcher: {
      id: 'flow',
      cwd: root,
      enabled: true,
      workspace: { enabled: true },
      channels,
      agentRuntime: 'test',
    },
    channelProviders: catalog,
    channelLoggerFactory: () => logger,
    coreEvents,
    commands,
    log: logger,
  });
  return { service, coreEvents, commands, fence: new WorkFence('flow') };
}
function sessionTools() {
  return createFakeChannelProvider({
    mcp: {
      describe: () => [
        fakeChannelToolRegistration({ name: 'tool_a', target: 'session' }),
      ],
      sessionInvoke: async () => ({ ok: true, value: { served: true } }),
    },
  });
}

describe('ChannelService', () => {
  it('build() hands each provider the exact Core-owned create context', async () => {
    const fake = createFakeChannelProvider();
    const ref = 'npm:@example/chan#create';
    const { service } = owner(
      [channelConfig('primary', ref)],
      catalogWith([{ ref, provider: fake.provider }]),
    );
    await service.build();
    const handle = fake.sessions.get('primary');
    expect(handle?.createContext).toMatchObject({
      dispatcher_id: 'flow',
      channel_id: 'primary',
      provider: ref,
      config: { marker: 'primary' },
      state_root: dispatcherDir('flow'),
      cache_root: dispatcherCacheDir('flow'),
    });
    expect(handle?.initializeCalled).toBe(false);
    expect(handle?.startCalled).toBe(false);
    await service.closeAll();
  });

  it('closes already-built sessions and never publishes a partial built map on failure', async () => {
    const good = sessionTools();
    const bad: ChannelProvider<unknown> = {
      createSession: async () => {
        throw new Error('second channel cannot be created');
      },
    };
    const { service, fence } = owner(
      [
        channelConfig('primary', 'builtin:good'),
        channelConfig('secondary', 'builtin:bad'),
      ],
      catalogWith([
        { ref: 'builtin:good', id: 'good', provider: good.provider },
        { ref: 'builtin:bad', id: 'bad', provider: bad },
      ]),
    );
    await expect(service.build()).rejects.toThrow(
      'second channel cannot be created',
    );
    expect(good.sessions.get('primary')?.initializeCalled).toBe(false);
    expect(good.sessions.get('primary')?.closeCalled).toBe(true);
    expect(service.mcpDelegates(caller, fence)[0]?.describe().tools).toEqual(
      [],
    );
    expect(service.list().every((entry) => !entry.live)).toBe(true);
  });

  it('session MCP composition exists before start and disappears after its instance closes', async () => {
    const tools = sessionTools();
    const plain = createFakeChannelProvider();
    const { service, fence } = owner(
      [
        channelConfig('primary', 'builtin:tools'),
        channelConfig('secondary', 'builtin:plain'),
      ],
      catalogWith([
        { ref: 'builtin:tools', id: 'tools', provider: tools.provider },
        { ref: 'builtin:plain', id: 'plain', provider: plain.provider },
      ]),
    );
    await service.build();
    const before = service.mcpDelegates(caller, fence);
    expect(before).toHaveLength(1);
    expect(before[0]?.describe().tools).toHaveLength(1);
    await expect(
      before[0]!.call({ name: 'tool_a', arguments: {} }),
    ).resolves.toMatchObject({ ok: true, structured: { served: true } });
    expect(service.list().map((entry) => entry.live)).toEqual([false, false]);
    await service.initialize(fence);
    await service.start(fence);
    expect(service.list().map((entry) => entry.live)).toEqual([true, true]);
    await service.closeAll();
    expect(service.mcpDelegates(caller, fence)[0]?.describe().tools).toEqual(
      [],
    );
    expect(service.list().map((entry) => entry.live)).toEqual([false, false]);
  });

  it('closeAll fences admission, reports failures, and retains a failed instance for retry', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createFakeChannelProvider({ mutationTail: () => held });
    const failed = sessionTools();
    const errors: unknown[] = [];
    const logger: DreamuxLogger = {
      ...log,
      error: (fields) => {
        errors.push(fields);
      },
    };
    const { service, coreEvents, commands, fence } = owner(
      [
        channelConfig('primary', 'builtin:slow'),
        channelConfig('secondary', 'builtin:failed'),
      ],
      catalogWith([
        { ref: 'builtin:slow', id: 'slow', provider: slow.provider },
        { ref: 'builtin:failed', id: 'failed', provider: failed.provider },
      ]),
      logger,
    );
    const built = await service.build();
    await service.initialize(fence);
    await service.start(fence);
    const close = vi.spyOn(built.get('secondary')!.session, 'close');
    close.mockRejectedValueOnce(new Error('close failed'));
    const closing = service.closeAll();
    const rejected = expect(closing).rejects.toThrow('close failed');
    expect(coreEvents.hasSources()).toBe(false);
    await expect(
      slow.sessions.get('primary')!.port!.invoke.invoke('team.list', {}),
    ).rejects.toThrow();
    expect(commands.invoke).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(errors).toHaveLength(1);
    expect(service.list().map((entry) => entry.live)).toEqual([false, true]);
    expect(
      service.mcpDelegates(caller, fence)[0]?.describe().tools,
    ).toHaveLength(1);
    await service.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
    expect(service.list().every((entry) => !entry.live)).toBe(true);
    expect(service.mcpDelegates(caller, fence)[0]?.describe().tools).toEqual(
      [],
    );
    await service.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('external channel provider registration and config rejection', () => {
  it('registers a loaded provider that has no ref or descriptor member of its own', async () => {
    const fake = createFakeChannelProvider();
    const registry = new ProviderRegistry();
    const contexts: ProviderFactoryContext[] = [];
    const ref = 'npm:@excitedjs/feishu-channel#createTestChannel';
    external.factory = (context) => {
      contexts.push(context as ProviderFactoryContext);
      return fake.provider;
    };
    await loadChannelProviders({ registry, refs: [ref] });
    expect(contexts).toEqual([{ ref }]);
    expect('ref' in fake.provider).toBe(false);
    expect('descriptor' in fake.provider).toBe(false);
    const descriptor = registry.resolve(ref);
    expect(descriptor.kind).toBe('channel');
    expect(registry.getImplementation(descriptor.id)).toBe(fake.provider);
  });

  it('rejects a configured channel ref registered under the wrong kind before any runtime or session starts', async () => {
    for (const ref of [
      'npm:@excitedjs/feishu-channel#createTestChannel',
      'npm:@example/not-installed-channel#create',
    ]) {
      const registry = new ProviderRegistry();
      const provider = new ControlledRuntimeProvider();
      registry.register(
        { id: ref, kind: 'agentRuntime', ref: parseProviderRef(ref) },
        provider,
      );
      const factory = vi.fn(() => {
        throw new Error('a registered provider must not be reloaded');
      });
      external.factory = factory;
      await expect(
        resolveConfig(
          {
            agents: [{ id: 'test', provider: ref, config: {} }],
            dispatchers: [
              {
                id: 'flow',
                cwd: root,
                agentRuntime: 'test',
                channels: [{ id: 'primary', provider: ref, config: {} }],
              },
            ],
          },
          join(root, 'config.json'),
          registry,
        ),
      ).rejects.toThrow(/is a agentRuntime provider, expected channel/);
      expect(factory).not.toHaveBeenCalled();
      expect(provider.runtimes).toEqual([]);
    }
  });

  it('rejects a contract failure without a partial registration', async () => {
    const registry = new ProviderRegistry();
    const ref = 'npm:@excitedjs/feishu-channel#createTestChannel';
    external.factory = () => ({ notASession: true });
    await expect(
      loadChannelProviders({ registry, refs: [ref] }),
    ).rejects.toThrow(ExternalChannelProviderContractError);
    expect(registry.hasRef(ref)).toBe(false);
    expect(registry.getImplementation(ref)).toBeUndefined();
  });
});

describe('ChannelService MCP delegate composition', () => {
  function providerWithCaller() {
    const seenCallers: ChannelMcpCaller[] = [];
    const result = createFakeChannelProvider({
      mcp: {
        describe: (_config, context) => {
          seenCallers.push(context.caller);
          return [
            fakeChannelToolRegistration({ name: 'send', target: 'provider' }),
          ];
        },
        providerInvoke: async (call, context) => ({
          ok: true,
          value: { echoed: call.name, caller: context.caller },
        }),
      },
    });
    const own = owner(
      [channelConfig('primary', 'builtin:fixture')],
      catalogWith([
        { ref: 'builtin:fixture', id: 'fixture', provider: result.provider },
      ]),
    );
    return { ...own, seenCallers };
  }
  it('names each server after the resolved provider, not the configured channel id', () => {
    const h = providerWithCaller();
    const delegates = h.service.mcpDelegates(caller, h.fence);
    expect(delegates.map((delegate) => delegate.name)).toEqual([
      'channel-fixture',
    ]);
    expect(mcpDelegateIdentity(delegates[0]!.name).name).toBe(
      'dreamux-channel-fixture',
    );
  });
  it('composes a caller-specific catalog for a dispatcher caller', async () => {
    const h = providerWithCaller();
    const delegates = h.service.mcpDelegates(caller, h.fence);
    expect(delegates).toHaveLength(1);
    expect(h.seenCallers).toEqual([caller]);
    await expect(
      delegates[0]!.call({ name: 'send', arguments: {} }),
    ).resolves.toMatchObject({
      ok: true,
      structured: { echoed: 'send', caller },
    });
  });
  it('composes a distinct Team-scoped catalog for a TeamLeader caller', () => {
    const h = providerWithCaller();
    const leader: ChannelMcpCaller = {
      kind: 'team_leader',
      team_name: 'alpha',
      leader_name: 'leader-alpha',
    };
    h.service.mcpDelegates(leader, h.fence);
    expect(h.seenCallers).toEqual([leader]);
  });
  it('yields no delegate for a channel whose provider composes no MCP capability', () => {
    const fake = createFakeChannelProvider();
    const h = owner(
      [channelConfig('primary', 'builtin:plain')],
      catalogWith([
        { ref: 'builtin:plain', id: 'plain', provider: fake.provider },
      ]),
    );
    expect(h.service.mcpDelegates(caller, h.fence)).toEqual([]);
  });
});

describe('ChannelService.assertRunnable through real provider catalogs', () => {
  it('accepts a single channel whose provider resolves', () => {
    const fake = createFakeChannelProvider();
    const { service } = owner(
      [channelConfig('primary', 'builtin:fixture')],
      catalogWith([
        { ref: 'builtin:fixture', id: 'fixture', provider: fake.provider },
      ]),
    );
    expect(() => service.assertRunnable()).not.toThrow();
    expect(fake.sessions.size).toBe(0);
  });

  it('accepts more than one channel when each provider resolves (any provider, not just feishu)', () => {
    const one = createFakeChannelProvider();
    const two = createFakeChannelProvider();
    const { service } = owner(
      [
        channelConfig('primary', 'builtin:fixture'),
        channelConfig('secondary', 'npm:@example/other#channel'),
      ],
      catalogWith([
        { ref: 'builtin:fixture', id: 'fixture', provider: one.provider },
        { ref: 'npm:@example/other#channel', provider: two.provider },
      ]),
    );
    expect(() => service.assertRunnable()).not.toThrow();
    expect(one.sessions.size + two.sessions.size).toBe(0);
  });

  it('rejects a channel whose provider has no loaded implementation', () => {
    const { service } = owner(
      [
        channelConfig('primary', 'builtin:fixture'),
        channelConfig('secondary', 'npm:@example/other#channel'),
      ],
      catalogWith([
        {
          ref: 'builtin:fixture',
          id: 'fixture',
          provider: createFakeChannelProvider().provider,
        },
      ]),
    );
    expect(() => service.assertRunnable()).toThrow(
      /channel "npm:@example\/other#channel" is not runnable/,
    );
    expect(service.list().every((entry) => !entry.live)).toBe(true);
  });

  it("propagates the real catalog's wrong-kind reason through the guard message", () => {
    const registry = new ProviderRegistry();
    const ref = 'npm:@example/wrong-kind#create';
    registry.register(
      { id: ref, kind: 'agentRuntime', ref: parseProviderRef(ref) },
      new ControlledRuntimeProvider(),
    );
    const { service } = owner(
      [channelConfig('primary', ref)],
      new ChannelProviderCatalog({ registry }),
    );
    expect(() => service.assertRunnable()).toThrow(
      /is a agentRuntime provider, expected channel/,
    );
  });

  it('accepts a channel resolved through the real catalog once its implementation is registered', () => {
    const registry = new ProviderRegistry();
    const ref = 'npm:@example/real#create';
    registry.register(
      { id: ref, kind: 'channel', ref: parseProviderRef(ref) },
      createFakeChannelProvider().provider,
    );
    const { service } = owner(
      [channelConfig('primary', ref)],
      new ChannelProviderCatalog({ registry }),
    );
    expect(() => service.assertRunnable()).not.toThrow();
  });
});
