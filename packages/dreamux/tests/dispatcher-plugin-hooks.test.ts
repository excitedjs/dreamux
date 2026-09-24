/**
 * The Dispatcher-level plugin hooks: `host.hooks.dispatcher` fires once per
 * constructed DispatcherService, and `beforeLaunch` drafts reach the launched
 * runtime on both prompt channels and after the bundled skill roots.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  Dispatcher,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import { AsyncSeriesHook } from 'tapable';

import {
  AgentRuntimeProviderCatalog,
  type AgentRuntimeProviderCatalog as Catalog,
} from '../src/agent-runtime/index.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { createConversationProjection } from '../src/channel/conversation-projection.js';
import type { DreamuxConfig, ResolvedAgentConfig } from '../src/config/config.js';
import { getRuntimeConfig, setRuntimeConfig } from '../src/platform/paths.js';
import { launchDraftTaps } from '../src/plugin/hooks.js';
import { createServerHooks } from '../src/plugin/host.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { Server } from '../src/server.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { createDispatcherAgent } from '../src/service/dispatcher-service/agent.js';
import { ensureDispatcherRootIdentity } from '../src/service/dispatcher-service/identity.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import type { TeammateAgentMcp } from '../src/service/teammate-service/types.js';
import { createFakeChannelProvider } from './helpers/fake-channel-provider.js';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as DreamuxLogger;

const roots: string[] = [];
const previousRoot = process.env['DREAMUX_ROOT'];

afterEach(async () => {
  if (previousRoot === undefined) delete process.env['DREAMUX_ROOT'];
  else process.env['DREAMUX_ROOT'] = previousRoot;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

describe('host.hooks.dispatcher', () => {
  it('fires once per Dispatcher object, with the cached service and its configured cwd', async () => {
    const root = await tempRoot('dreamux-dispatcher-hook-');
    process.env['DREAMUX_ROOT'] = root;
    const previousConfig = getRuntimeConfig();
    const registry = new ProviderRegistry();
    const channelRef = 'npm:@example/channel';
    registry.register({ id: channelRef, kind: 'channel', ref: parseProviderRef(channelRef) });
    registry.registerImplementation(channelRef, createFakeChannelProvider().provider);
    const runtime = { provider: 'npm:@example/runtime', config: {} };
    const config: DreamuxConfig = {
      agents: { example: runtime },
      dispatchers: [{
        id: 'stopped',
        cwd: root,
        enabled: false,
        workspace: { enabled: false },
        channels: [{ id: 'primary', provider: channelRef, config: {} }],
        agentRuntime: 'example',
        runtime,
      }],
    };
    const hooks = createServerHooks(silentLog);
    const announced: Dispatcher[] = [];
    hooks.dispatcher.tap('alpha', (dispatcher) => {
      announced.push(dispatcher);
    });
    const server = new Server({
      config,
      providerRegistry: registry,
      agentRuntimeProviderCatalog: new AgentRuntimeProviderCatalog({ registry }),
      channelProviderCatalog: new ChannelProviderCatalog({ registry }),
      adminSocketPath: join(root, 'admin.sock'),
      logger: silentLog,
      hooks,
    });
    try {
      await server.start();
      const first = server.getDispatcher('stopped');
      const second = server.getDispatcher('stopped');

      expect(second).toBe(first);
      expect(announced).toEqual([first]);
      expect(announced[0]?.id).toBe('stopped');
      expect(announced[0]?.cwd).toBe(root);
    } finally {
      await server.shutdown();
      setRuntimeConfig(previousConfig);
    }
  });
});

describe('dispatcher.hooks.beforeLaunch', () => {
  it('appends accepted draft instructions to both prompt channels and plugin skill roots after the bundled ones', async () => {
    const cwd = await tempRoot('dreamux-dispatcher-launch-');
    process.env['DREAMUX_ROOT'] = cwd;
    const pluginSkills = join(cwd, 'plugin-skills');
    await mkdir(join(pluginSkills, 'alpha-skill'), { recursive: true });

    const identities = new AgentIdentityStore({
      dir: join(cwd, 'identity'),
      dispatcherId: 'flow',
      expectedName: null,
      log: silentLog,
    });
    const identity = await ensureDispatcherRootIdentity({
      identities,
      dispatcherId: 'flow',
      agentRuntime: 'fake-runtime',
      cwd,
    });

    const launches: AgentRuntimeCreateContext<unknown>[] = [];
    const provider = {
      getCapabilities: () => ({ tags: [], publicConfig: null }),
      readRecentActivity: async () => ({ records: [], truncated: false }),
      async createRuntime(context: AgentRuntimeCreateContext<unknown>) {
        launches.push(context);
        return {
          async start() {
            return { continuity: 'fresh' as const };
          },
          async stop() {},
        };
      },
    } as unknown as AgentRuntimeProvider<unknown>;

    const beforeLaunch = launchDraftTaps(
      new AsyncSeriesHook<[LaunchDraft]>(['draft'], 'beforeLaunch'),
      silentLog,
    );
    beforeLaunch.tapPromise('alpha', async (draft) => {
      draft.instructions.push('from alpha');
      draft.skillSources.push({ name: 'alpha', path: pluginSkills, source: 'alpha' });
    });
    beforeLaunch.tapPromise('broken', async (draft) => {
      draft.instructions.push('half written');
      throw new Error('read failed');
    });

    const agent = await createDispatcherAgent({
      id: 'flow',
      config: {
        agents: {
          'fake-runtime': { provider: 'fake', config: {} } as unknown as ResolvedAgentConfig,
        },
        dispatchers: [],
      },
      agentRuntimeProviders: {
        resolve: () => ({ implementation: provider }),
      } as unknown as Catalog,
      log: silentLog,
      mcp: { leases: {}, delegates: [], adminSocketPath: '' } as unknown as TeammateAgentMcp,
      identity,
      identities,
      admissions: new AdmissionLedger(),
      conversationProjection: createConversationProjection({
        coreEvents: new DispatcherCoreEventBus({ dispatcherId: 'flow', log: silentLog, maxSources: 1 })
          .publisher,
        log: silentLog,
        homePathPrefixes: [],
      }),
      beforeLaunch,
    });
    await agent.activate();

    expect(launches).toHaveLength(1);
    const launched = launches[0]!;
    expect(launched.systemPrompt?.replace?.endsWith('\n\nfrom alpha')).toBe(true);
    expect(launched.systemPrompt?.append?.slice(1)).toEqual(['from alpha']);
    expect(JSON.stringify(launched.systemPrompt)).not.toContain('half written');
    expect(launched.skillSources.map((source) => source.name)).toEqual([
      'dispatcher',
      'shared',
      'alpha',
    ]);
    await agent.stopForHost();
  });
});
