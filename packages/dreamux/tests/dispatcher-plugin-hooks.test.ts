/**
 * The Dispatcher-level plugin hook `dispatcher.hooks.beforeLaunch`:
 * `beforeLaunch` drafts reach the launched runtime on both prompt channels
 * and after the bundled skill roots.
 *
 * The `host.hooks.dispatcher` coverage and the whole hook tree
 * (`host.hooks.dispatcher` -> `dispatcher.hooks.beforeLaunch` / `.team` ->
 * `team.hooks.beforeTeamLeaderLaunch` / `.created`, including the `created`
 * hook's shutdown drain, R2 ruling #5) that used to live here were deleted as
 * Stage 2a Item 6 collateral (both fixtures built a `DispatcherConfig` with
 * the now-deleted `.runtime` field) — see
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`,
 * Stage 2a Item 6.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import { AsyncSeriesHook } from 'tapable';

import { type AgentRuntimeProviderCatalog as Catalog } from '../src/agent-runtime/index.js';
import { createConversationProjection } from '../src/channel/conversation-projection.js';
import type { ResolvedAgentConfig } from '../src/config/config.js';
import { launchDraftTaps } from '../src/plugin/hooks.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { createDispatcherAgent } from '../src/service/dispatcher-service/agent.js';
import { ensureDispatcherRootIdentity } from '../src/service/dispatcher-service/identity.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import type { TeammateAgentMcp } from '../src/service/teammate-service/types.js';

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
    let alphaTapCalls = 0;
    beforeLaunch.tapPromise('alpha', async (draft) => {
      alphaTapCalls += 1;
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
    expect(alphaTapCalls).toBe(1);

    // A runtime-process restart inside the same Agent does not refire the
    // launch hook (PLG:45 col4, 52-54): the hook runs at Agent construction,
    // not at every native process start.
    await agent.stopForHost();
    await agent.activate();

    expect(launches).toHaveLength(2);
    expect(alphaTapCalls).toBe(1);

    await agent.stopForHost();
  });
});
