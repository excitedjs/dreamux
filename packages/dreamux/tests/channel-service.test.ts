/**
 * Coverage cell F: Core's side of the Channel seam.
 *
 * `ChannelService` is Core's whole relationship with its Channels — build,
 * hold, hand a caller the one object it needs, close. These tests prove:
 *   - `build()` hands each provider the exact create context Core owns
 *     (dispatcher/channel ids, provider ref, config, state/cache roots), and
 *     unwinds already-built sessions on partial failure without publishing a
 *     torn-down map as "built".
 *   - `sessionMcp()` answers from composition (`built`), not connectivity
 *     (`live`): a Channel's session-MCP capability is reachable before
 *     `adopt`, absent when the provider composed none, and gone after
 *     `clear`/`closeAll`.
 *   - `closeAll()` detaches its maps before awaiting provider shutdown so a
 *     concurrent observer never sees a half-closed live map, and logs
 *     per-channel close failures rather than losing them.
 *   - The external channel-provider loader proves registration works without
 *     provider-level `ref`/`descriptor` members, that the factory context is
 *     ref-only in the other direction too, and that a descriptor kind/ref
 *     conflict fails loud *before* the module is even imported.
 *   - `channelMcpDelegates` is the one place a caller-specific tool catalog is
 *     composed; it is reached only from the Dispatcher-agent and TeamLeader
 *     delegate assemblies, never from the ordinary TeamMate one.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ChannelMcpCall,
  ChannelMcpCallContext,
  ChannelMcpCaller,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { DispatcherChannelConfig, DreamuxConfig } from '../src/config/config.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import {
  loadChannelProviders,
  ExternalChannelProviderContractError,
} from '../src/channel/external-channel-provider.js';
import { channelMcpDelegates } from '../src/service/channel-service/mcp-delegates.js';
import { ChannelService } from '../src/service/channel-service/index.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { dispatcherCacheDir, dispatcherDir } from '../src/platform/paths.js';
import {
  createFakeChannelProvider,
  fakeChannelToolRegistration,
  type FakeChannelProviderResult,
} from './helpers/fake-channel-provider.js';

function silentLogger(): DreamuxLogger {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function channelConfig(id: string, provider: string): DispatcherChannelConfig {
  return { id, provider, config: { marker: id } };
}

/** A ChannelProviderCatalog resolving to whatever fixed providers a test hands it. */
function catalogWith(
  registrations: ReadonlyArray<{ ref: string; provider: unknown }>,
): ChannelProviderCatalog {
  const registry = new ProviderRegistry();
  for (const { ref, provider } of registrations) {
    const descriptor = { id: ref, kind: 'channel' as const, ref: parseProviderRef(ref) };
    registry.register(descriptor);
    registry.registerImplementation(descriptor.id, provider);
  }
  return new ChannelProviderCatalog({ registry });
}

function dreamuxConfigWith(
  dispatcherId: string,
  channels: DispatcherChannelConfig[],
): DreamuxConfig {
  return {
    agents: {},
    dispatchers: [
      {
        id: dispatcherId,
        cwd: null,
        enabled: true,
        workspace: { enabled: true },
        channels,
        agentRuntime: dispatcherId,
        runtime: { provider: 'builtin:codex', config: {} },
      },
    ],
  };
}

describe('ChannelService', () => {
  let dreamuxRoot: string;
  const originalRoot = process.env['DREAMUX_ROOT'];

  beforeEach(async () => {
    dreamuxRoot = await mkdtemp(join(tmpdir(), 'dreamux-channel-service-'));
    process.env['DREAMUX_ROOT'] = dreamuxRoot;
  });

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env['DREAMUX_ROOT'];
    else process.env['DREAMUX_ROOT'] = originalRoot;
    await rm(dreamuxRoot, { recursive: true, force: true });
  });

  it('build() hands each provider the exact Core-owned create context', async () => {
    const fake = createFakeChannelProvider();
    const catalog = catalogWith([{ ref: 'npm:@example/chan#create', provider: fake.provider }]);
    const service = new ChannelService({
      dispatcherId: 'flow',
      config: dreamuxConfigWith('flow', [channelConfig('primary', 'npm:@example/chan#create')]),
      channelProviders: catalog,
      channelLoggerFactory: () => silentLogger(),
    });

    await service.build();

    const handle = fake.sessions.get('primary');
    expect(handle).toBeDefined();
    expect(handle?.createContext).toMatchObject({
      dispatcher_id: 'flow',
      channel_id: 'primary',
      provider: 'npm:@example/chan#create',
      config: { marker: 'primary' },
      state_root: dispatcherDir('flow'),
      cache_root: dispatcherCacheDir('flow'),
    });
    // build() only constructs; it must not have opened external input.
    expect(handle?.startCalled).toBe(false);
  });

  it('closes already-built sessions and never publishes a partial "built" map on failure', async () => {
    const good = createFakeChannelProvider();
    const failingCreate = {
      provider: {
        async createSession(): Promise<never> {
          throw new Error('boom: second channel cannot be created');
        },
      },
    };
    const catalog = catalogWith([
      { ref: 'npm:@example/good#create', provider: good.provider },
      { ref: 'npm:@example/bad#create', provider: failingCreate.provider },
    ]);
    const service = new ChannelService({
      dispatcherId: 'flow',
      config: dreamuxConfigWith('flow', [
        channelConfig('primary', 'npm:@example/good#create'),
        channelConfig('secondary', 'npm:@example/bad#create'),
      ]),
      channelProviders: catalog,
      channelLoggerFactory: () => silentLogger(),
    });

    await expect(service.build()).rejects.toThrow(/second channel cannot be created/);

    // The first channel's session was constructed, then closed on the way out.
    const handle = good.sessions.get('primary');
    expect(handle?.initializeCalled).toBe(false); // never got its Core port
    expect(handle?.closeCalled).toBe(true);
    // Nothing was published as "built": a session-MCP lookup answers null, not
    // a capability belonging to a torn-down instance.
    expect(service.sessionMcp('primary')).toBeNull();
  });

  it('sessionMcp() reads the built map, independent of adoption/liveness', async () => {
    const withTools = createFakeChannelProvider({
      mcp: {
        describe: () => [fakeChannelToolRegistration({ name: 'tool_a', target: 'session' })],
        sessionInvoke: async () => ({ ok: true, value: {} }),
      },
    });
    const withoutTools = createFakeChannelProvider();
    const catalog = catalogWith([
      { ref: 'npm:@example/tools#create', provider: withTools.provider },
      { ref: 'npm:@example/plain#create', provider: withoutTools.provider },
    ]);
    const service = new ChannelService({
      dispatcherId: 'flow',
      config: dreamuxConfigWith('flow', [
        channelConfig('primary', 'npm:@example/tools#create'),
        channelConfig('secondary', 'npm:@example/plain#create'),
      ]),
      channelProviders: catalog,
      channelLoggerFactory: () => silentLogger(),
    });

    const built = await service.build();
    // Available before adopt: composition, not connectivity.
    expect(service.sessionMcp('primary')).not.toBeNull();
    expect(service.sessionMcp('secondary')).toBeNull();

    service.adopt(built);
    expect(service.sessionMcp('primary')).not.toBeNull();

    service.clear();
    expect(service.sessionMcp('primary')).toBeNull();
  });

  it('closeAll() detaches its maps before awaiting shutdown, and logs per-channel failures', async () => {
    const errors: unknown[] = [];
    const log: DreamuxLogger = {
      ...silentLogger(),
      error: (obj: unknown) => {
        errors.push(obj);
      },
    };
    let releaseClose: (() => void) | null = null;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    // Indirected through a wrapper (matching `core-command-errors.test.ts`'s
    // `release: () => release?.()` idiom): calling the captured variable
    // directly at the use site defeats TS's control-flow narrowing across the
    // promise-executor closure and it types as `never`.
    const release = () => releaseClose?.();
    const slow = createFakeChannelProvider({ mutationTail: () => closeGate });
    const failing = createFakeChannelProvider({ failClose: () => new Error('close failed') });
    const catalog = catalogWith([
      { ref: 'npm:@example/slow#create', provider: slow.provider },
      { ref: 'npm:@example/fail#create', provider: failing.provider },
    ]);
    const service = new ChannelService({
      dispatcherId: 'flow',
      config: dreamuxConfigWith('flow', [
        channelConfig('primary', 'npm:@example/slow#create'),
        channelConfig('secondary', 'npm:@example/fail#create'),
      ]),
      channelProviders: catalog,
      channelLoggerFactory: () => silentLogger(),
    });
    const built = await service.build();
    service.adopt(built);

    const closing = service.closeAll(log);
    // The maps are detached synchronously, before the awaited close resolves:
    // a concurrent observer during shutdown sees no live channel, not a stale
    // half-closed one.
    expect(service.live().size).toBe(0);
    expect(service.sessionMcp('primary')).toBeNull();

    release();
    await closing;

    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { err?: { message?: string } }).err?.message ?? '')).toMatch(
      /close failed/,
    );

    // Idempotent: a second close on an already-cleared service is a no-op.
    await expect(service.closeAll(log)).resolves.toBeUndefined();
  });
});

describe('external channel provider loader (registration and fail-loud ordering)', () => {
  it('registers a loaded provider that has no ref/descriptor member of its own', async () => {
    const fake = createFakeChannelProvider();
    const registry = new ProviderRegistry();
    let receivedContext: { ref: string } | null = null;
    await loadChannelProviders({
      registry,
      refs: ['npm:@example/chan#create'],
      importModule: async () => ({
        create: (context: { ref: string }) => {
          receivedContext = context;
          // The provider echoes nothing about its own registration back.
          expect('ref' in (fake.provider as object)).toBe(false);
          expect('descriptor' in (fake.provider as object)).toBe(false);
          return fake.provider;
        },
      }),
    });

    expect(receivedContext).not.toBeNull();
    expect((receivedContext as unknown as { ref: string }).ref).toBe(
      'npm:@example/chan#create',
    );
    // Ref-only, in the direction Core controls: the factory context is exactly
    // the published `ProviderFactoryContext`, so Core's registration descriptor
    // never travels to the implementation side.
    expect(Object.keys(receivedContext as object)).toEqual(['ref']);
    const descriptor = registry.resolve('npm:@example/chan#create');
    expect(descriptor.kind).toBe('channel');
    expect(registry.getImplementation(descriptor.id)).toBe(fake.provider);
  });

  it('rejects a ref pre-registered under the wrong kind before the module is imported', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'npm:@example/chan#create',
      kind: 'agentRuntime',
      ref: parseProviderRef('npm:@example/chan#create'),
    });
    let importCalled = false;

    await expect(
      loadChannelProviders({
        registry,
        refs: ['npm:@example/chan#create'],
        importModule: async () => {
          importCalled = true;
          return { create: () => createFakeChannelProvider().provider };
        },
      }),
    ).rejects.toThrow(/registered as kind "agentRuntime", expected "channel"/);

    // Proof the kind/ref check ran before any implementation-level work.
    expect(importCalled).toBe(false);
    expect(registry.getImplementation('npm:@example/chan#create')).toBeUndefined();
  });

  it('rejects a contract failure (missing createSession) without a partial registration', async () => {
    const registry = new ProviderRegistry();

    // `ref` is included so this failure is isolated to the missing-createSession
    // defect rather than incidentally tripping the separate ref-member check
    // covered (and reported as a defect) by the test above.
    await expect(
      loadChannelProviders({
        registry,
        refs: ['npm:@example/broken#create'],
        importModule: async () => ({
          create: (ctx: { ref: string }) => ({ ref: ctx.ref, notASession: true }),
        }),
      }),
    ).rejects.toThrow(ExternalChannelProviderContractError);

    expect(registry.hasRef('npm:@example/broken#create')).toBe(false);
  });
});

describe('channelMcpDelegates (Channel MCP injection)', () => {
  function mcpProviderWithCaller(): {
    result: FakeChannelProviderResult;
    seenCallers: ChannelMcpCaller[];
  } {
    const seenCallers: ChannelMcpCaller[] = [];
    const result = createFakeChannelProvider({
      mcp: {
        describe: (_config, context) => {
          seenCallers.push(context.caller);
          return [fakeChannelToolRegistration({ name: 'send', target: 'provider' })];
        },
        providerInvoke: async (call: ChannelMcpCall, context: ChannelMcpCallContext) => ({
          ok: true,
          value: { echoed: call.name, caller: context.caller },
        }),
      },
    });
    return { result, seenCallers };
  }

  it('composes a caller-specific catalog for a dispatcher caller', async () => {
    const { result, seenCallers } = mcpProviderWithCaller();
    const catalog = catalogWith([{ ref: 'npm:@example/chan#create', provider: result.provider }]);
    const delegates = channelMcpDelegates({
      dispatcherId: 'flow',
      channels: [channelConfig('primary', 'npm:@example/chan#create')],
      channelProviders: catalog,
      caller: { kind: 'dispatcher' },
      sessionMcp: () => null,
      dispatch: (task) => task(),
    });

    expect(delegates).toHaveLength(1);
    expect(seenCallers).toEqual([{ kind: 'dispatcher' }]);

    const outcome = await delegates[0]!.call({ name: 'send', arguments: {} });
    expect(outcome).toMatchObject({
      ok: true,
      structured: { echoed: 'send', caller: { kind: 'dispatcher' } },
    });
  });

  it('composes a distinct, Team-scoped catalog for a TeamLeader caller', () => {
    const { result, seenCallers } = mcpProviderWithCaller();
    const catalog = catalogWith([{ ref: 'npm:@example/chan#create', provider: result.provider }]);
    channelMcpDelegates({
      dispatcherId: 'flow',
      channels: [channelConfig('primary', 'npm:@example/chan#create')],
      channelProviders: catalog,
      caller: { kind: 'team_leader', team_name: 'alpha', leader_name: 'leader-alpha' },
      sessionMcp: () => null,
      dispatch: (task) => task(),
    });

    expect(seenCallers).toEqual([
      { kind: 'team_leader', team_name: 'alpha', leader_name: 'leader-alpha' },
    ]);
  });

  it('yields no delegate for a channel whose provider composes no MCP capability', () => {
    const plain = createFakeChannelProvider();
    const catalog = catalogWith([{ ref: 'npm:@example/plain#create', provider: plain.provider }]);
    const delegates = channelMcpDelegates({
      dispatcherId: 'flow',
      channels: [channelConfig('primary', 'npm:@example/plain#create')],
      channelProviders: catalog,
      caller: { kind: 'dispatcher' },
      sessionMcp: () => null,
      dispatch: (task) => task(),
    });
    expect(delegates).toHaveLength(0);
  });

  it('is reached only from the Dispatcher-agent and TeamLeader delegate assemblies, never the ordinary TeamMate one', async () => {
    // Architectural absence check: "ordinary TeamMates receive none" is proven
    // by there being no call site at all in the TeamMate delegate assembly,
    // not by a runtime flag a TeamMate-scoped call could theoretically flip.
    const dispatcherAssembly = await readFile(
      new URL('../src/service/dispatcher-service/mcp-delegates.ts', import.meta.url),
      'utf8',
    );
    const teammateAssembly = await readFile(
      new URL('../src/service/teammate-collection/mcp-delegate.ts', import.meta.url),
      'utf8',
    );
    expect(dispatcherAssembly).toMatch(/channelMcpDelegates\(/);
    expect(dispatcherAssembly).toMatch(/dispatcherAgentMcpDelegates/);
    expect(dispatcherAssembly).toMatch(/teamLeaderMcpDelegates/);
    expect(teammateAssembly).not.toMatch(/channelMcpDelegates/);
  });
});
