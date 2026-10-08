import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { CoreCommands } from '../src/command/registry.js';
import { createServerHooks } from '../src/plugin/host.js';
import { parseProviderRef, ProviderRegistry } from '../src/registry/index.js';
import { Dispatchers } from '../src/service/dispatchers/index.js';
import { RestartIntentConsumer } from '../src/service/dispatcher-service/restart-intent.js';
import { McpLeaseRegistry } from '../src/service/mcp/leases.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import {
  capturingLogger,
  createUnstartedCommandServer,
  HARNESS_DISPATCHER_ID,
} from './helpers/command-harness.js';
import { dispatcherDir, teamCollectionDir } from '../src/platform/paths.js';

describe('Dispatcher hook ownership', () => {
  it('fires once per Dispatcher object with the cached service, configured cwd and frozen hooks', async () => {
    const f = await dispatcherFixture();
    const hooks = createServerHooks(f.log);
    const registry = new ProviderRegistry();
    registry.register(
      {
        id: 'controlled',
        kind: 'agentRuntime',
        ref: parseProviderRef('builtin:controlled'),
      },
      f.provider,
    );
    const dispatchers = new Dispatchers({
      config: { current: () => f.config },
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      channelProviders: new ChannelProviderCatalog({ registry }),
      mcpLeases: new McpLeaseRegistry(f.log),
      restartIntent: await RestartIntentConsumer.load({
        now: Date.now(),
        path: join(f.host.cwd, 'absent-restart.json'),
        log: f.log,
      }),
      commands: new CoreCommands([]),
      homePathPrefixes: [],
      adminSocketPath: join(f.host.cwd, 'hooks.sock'),
      channelLoggerFactory: () => f.log,
      dispatcherHook: hooks.dispatcher,
      log: f.log,
    });
    const observed: unknown[] = [];
    const reentrant: unknown[] = [];
    const reentrantErrors: unknown[] = [];
    hooks.dispatcher.tap('reentrant-observer', (dispatcher) => {
      observed.push(dispatcher);
      try {
        reentrant.push(dispatchers.get(dispatcher.id));
      } catch (error) {
        reentrantErrors.push(error);
      }
    });
    try {
      const first = dispatchers.get('test');
      expect(dispatchers.get('test')).toBe(first);
      expect(observed).toEqual([first]);
      expect(reentrantErrors).toEqual([]);
      expect(reentrant).toEqual([first]);
      expect(reentrant[0]).toBe(first);
      expect(first.cwd).toBe(f.host.cwd);
      expect(Object.isFrozen(first.hooks)).toBe(true);
      expect(f.provider.runtimes).toHaveLength(0);
    } finally {
      await dispatchers.shutdown();
    }
  });

  it('appends accepted launch drafts to both prompt channels and plugin skills after bundled skills only once per Agent', async () => {
    const f = await dispatcherFixture();
    const root = join(f.host.cwd, 'plugin-skills');
    await mkdir(join(root, 'extra-skill'), { recursive: true });
    const launch = vi.fn(
      async (draft: {
        instructions: string[];
        skillSources: Array<{ name: string; path: string; source: string }>;
      }) => {
        draft.instructions.push('from alpha');
        draft.skillSources.push({ name: 'alpha', path: root, source: 'alpha' });
      },
    );
    f.host.hooks.launch.tapPromise('alpha', launch);
    f.host.hooks.launch.tapPromise('broken', async (draft) => {
      draft.instructions.push('half written');
      throw new Error('read failed');
    });
    await f.host.start();
    const agent = f.host.dispatcherAgent.mustAgent();
    await agent.activate();
    const context = f.provider.runtimes[0]!.context;
    expect(context.systemPrompt?.replace?.endsWith('\n\nfrom alpha')).toBe(
      true,
    );
    expect(context.systemPrompt?.append?.slice(1)).toEqual(['from alpha']);
    expect(JSON.stringify(context.systemPrompt)).not.toContain('half written');
    expect(context.skillSources.map((source) => source.name)).toEqual([
      'dispatcher',
      'shared',
      'alpha',
    ]);
    await agent.stopForHost();
    await agent.activate();
    expect(f.provider.runtimes).toHaveLength(2);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('does not block Team creation when one dispatcher Team tap throws and still runs the surviving Team hooks', async () => {
    const f = await dispatcherFixture();
    f.host.hooks.team.tap('broken', () => {
      throw new Error('broken Team observer');
    });
    const successful = vi.fn();
    f.host.hooks.team.tap('successful', (team) => {
      successful();
      team.hooks.leaderLaunch.tapPromise('instructions', async (draft) => {
        draft.instructions.push('surviving Team hook');
      });
    });
    const created = await f.teams.createFromRequest(
      teamRequest('hook-tree', 'Start'),
    );
    expect(created.status).toBe('running');
    expect(successful).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(f.provider.runtimes[0]!.context.systemPrompt),
    ).toContain('surviving Team hook');
  });
});

describe('the whole hook tree through a real Server/DispatcherService', () => {
  it('fires host.dispatcher -> dispatcher.launch/team -> team.leaderLaunch in order, with frozen hook tables, real Team workspace and launch drafts reaching runtime', async () => {
    const order: string[] = [];
    const hooks = createServerHooks(capturingLogger([]));
    let dispatcherHooksFrozen = false;
    let teamHooksFrozen = false;
    let capturedWorkspace: string | null = null;
    hooks.dispatcher.tap('whole-tree', (dispatcher) => {
      order.push(`dispatcher:${dispatcher.id}`);
      dispatcherHooksFrozen = Object.isFrozen(dispatcher.hooks);
      dispatcher.hooks.launch.tapPromise('whole-tree', async (draft) => {
        order.push(`launch:${dispatcher.id}`);
        draft.instructions.push('from alpha dispatcher launch');
      });
      dispatcher.hooks.team.tap('whole-tree', (team, context) => {
        order.push(`team:${context.origin}:${team.name}`);
        teamHooksFrozen = Object.isFrozen(team.hooks);
        capturedWorkspace = team.workspace;
        team.hooks.leaderLaunch.tapPromise('whole-tree', async () => {
          order.push(`leaderLaunch:${team.name}`);
        });
      });
    });
    const fixture = await createUnstartedCommandServer({ hooks });
    await fixture.host.start();
    const dispatcher = fixture.host.dispatchers.get(HARNESS_DISPATCHER_ID);
    await expect(
      dispatcher.submitToAgent({
        source: 'channel',
        text: 'start dispatcher recipient',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
    const runtime = fixture.provider.runtimes[0]!;
    const created = await dispatcher.teams.createFromRequest(
      teamRequest('req-hook-tree'),
    );
    expect(order).toEqual([
      `dispatcher:${HARNESS_DISPATCHER_ID}`,
      `launch:${HARNESS_DISPATCHER_ID}`,
      `team:create:${created.team_name}`,
      `leaderLaunch:${created.team_name}`,
    ]);
    expect(dispatcherHooksFrozen).toBe(true);
    expect(teamHooksFrozen).toBe(true);
    expect(runtime.context.systemPrompt?.append).toContain(
      'from alpha dispatcher launch',
    );
    expect(
      runtime.context.systemPrompt?.replace?.endsWith(
        '\n\nfrom alpha dispatcher launch',
      ),
    ).toBe(true);
    const record = JSON.parse(
      await readFile(
        join(
          teamCollectionDir(dispatcherDir(HARNESS_DISPATCHER_ID)),
          created.team_name,
          'record.json',
        ),
        'utf8',
      ),
    ) as { runtime_cwd: string };
    expect(capturedWorkspace).toBe(record.runtime_cwd);
  });
});
