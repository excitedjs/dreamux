/**
 * Coverage cell F: Core's side of the Channel seam.
 *
 * The `ChannelService` describe block that used to live here — `build()`
 * handing each provider the exact create context Core owns, unwinding
 * already-built sessions on partial failure, `sessionMcp()` answering from
 * composition rather than connectivity, and `closeAll()` detaching its maps
 * before awaiting provider shutdown while logging per-channel close
 * failures — was deleted as Stage 2a Item 6 collateral (its `dreamuxConfigWith()`
 * fixture built a `DispatcherConfig` with the now-deleted `.runtime` field)
 * — see
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`,
 * Stage 2a Item 6. These tests still prove:
 *   - The external channel-provider loader proves registration works without
 *     provider-level `ref`/`descriptor` members, that the factory context is
 *     ref-only in the other direction too, and that a descriptor kind/ref
 *     conflict fails loud *before* the module is even imported.
 *   - `channelMcpDelegates` is the one place a caller-specific tool catalog is
 *     composed; it names each server after the provider it resolved, and it is
 *     reached only from the Dispatcher-agent and TeamLeader delegate
 *     assemblies, never from the ordinary TeamMate one.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type {
  ChannelMcpCall,
  ChannelMcpCallContext,
  ChannelMcpCaller,
  ProviderFactoryContext,
} from '@excitedjs/dreamux-types';

import type { DispatcherChannelConfig } from '../src/config/config.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import {
  loadChannelProviders,
  ExternalChannelProviderContractError,
} from '../src/channel/external-channel-provider.js';
import { channelMcpDelegates } from '../src/service/channel-service/mcp-delegates.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import {
  createFakeChannelProvider,
  fakeChannelToolRegistration,
  type FakeChannelProviderResult,
} from './helpers/fake-channel-provider.js';

function channelConfig(id: string, provider: string): DispatcherChannelConfig {
  return { id, provider, config: { marker: id } };
}

/**
 * A ChannelProviderCatalog resolving to whatever fixed providers a test hands
 * it. `id` defaults to the ref, which is what the loader seeds for an `npm:`
 * provider; a builtin registers the bare id its descriptor carries.
 */
function catalogWith(
  registrations: ReadonlyArray<{ ref: string; id?: string; provider: unknown }>,
): ChannelProviderCatalog {
  const registry = new ProviderRegistry();
  for (const { ref, id, provider } of registrations) {
    const descriptor = { id: id ?? ref, kind: 'channel' as const, ref: parseProviderRef(ref) };
    registry.register(descriptor);
    registry.registerImplementation(descriptor.id, provider);
  }
  return new ChannelProviderCatalog({ registry });
}

describe('external channel provider loader (registration and fail-loud ordering)', () => {
  it('registers a loaded provider that has no ref/descriptor member of its own', async () => {
    const fake = createFakeChannelProvider();
    const registry = new ProviderRegistry();
    // Collected rather than held in a nullable: the factory runs inside the
    // loader, so a `let x: T | null = null` stays narrowed to `null` for the
    // typechecker and every read needs a cast that hides what is asserted.
    const receivedContexts: ProviderFactoryContext[] = [];
    await loadChannelProviders({
      registry,
      refs: ['npm:@example/chan#create'],
      importModule: async () => ({
        create: (context: ProviderFactoryContext) => {
          receivedContexts.push(context);
          // The provider echoes nothing about its own registration back.
          expect('ref' in (fake.provider as object)).toBe(false);
          expect('descriptor' in (fake.provider as object)).toBe(false);
          return fake.provider;
        },
      }),
    });

    expect(receivedContexts).toHaveLength(1);
    expect(receivedContexts[0].ref).toBe('npm:@example/chan#create');
    // Ref-only, in the direction Core controls: the factory context is exactly
    // the published `ProviderFactoryContext`, so Core's registration descriptor
    // never travels to the implementation side.
    expect(Object.keys(receivedContexts[0])).toEqual(['ref']);
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

  it('names each server after the resolved provider, not the configured channel id', () => {
    const { result } = mcpProviderWithCaller();
    const catalog = catalogWith([
      { ref: 'builtin:feishu', id: 'feishu', provider: result.provider },
    ]);
    const delegates = channelMcpDelegates({
      dispatcherId: 'flow',
      channels: [channelConfig('primary', 'builtin:feishu')],
      channelProviders: catalog,
      caller: { kind: 'dispatcher' },
      sessionMcp: () => null,
      dispatch: (task) => task(),
    });

    // `primary` is the operator's own string, which the model has nowhere to
    // look up; the provider is what it can associate these tools with. Both
    // model-visible names are the provider's.
    expect(delegates.map((delegate) => delegate.name)).toEqual(['channel-feishu']);
    expect(delegates[0]!.describe().identity.name).toBe('dreamux-channel-feishu');
  });

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
