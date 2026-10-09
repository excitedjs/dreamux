import { createFakeChannelProvider } from './fake-channel-provider.js';
import { teamCreatePayloadHash } from '../../src/service/team/create-request.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { TeamCreateCommand } from '@excitedjs/dreamux-types';
import { AgentRuntimeProviderCatalog } from '../../src/agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../../src/channel/catalog.js';
import { CoreCommands } from '../../src/command/registry.js';
import type { DreamuxConfig } from '../../src/config/config.js';
import { createLogger } from '../../src/platform/logger.js';
import { dispatcherDir, teamCollectionDir } from '../../src/platform/paths.js';
import { parseProviderRef } from '../../src/registry/provider-ref.js';
import { ProviderRegistry } from '../../src/registry/registry.js';
import { DispatcherService } from '../../src/service/dispatcher-service/index.js';
import {
  notifyResumedRestart,
  RestartIntentConsumer,
} from '../../src/service/dispatcher-service/restart-intent.js';
import { McpLeaseRegistry } from '../../src/service/mcp/leases.js';
import { TeamCollection } from '../../src/service/team/index.js';
import { ControlledRuntimeProvider } from './controlled-runtime-provider.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});
export function teamRequest(id = 'request-one', prompt?: string) {
  const command: TeamCreateCommand = {
    request_id: id,
    name_prefix: 'review',
    intent: 'Review the implementation',
    leader: {
      agent_runtime: 'controlled',
      ...(prompt === undefined ? {} : { prompt }),
    },
  };
  return {
    requestId: id,
    payloadHash: teamCreatePayloadHash(command),
    command,
    deliverCompletionToDispatcher: false,
  };
}
export async function dispatcherFixture(
  options: {
    channel?: boolean;
    restartNotice?: string;
    channelOptions?: Parameters<typeof createFakeChannelProvider>[0];
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), 'dreamux-teams-'));
  const cwd = join(base, 'workspace');
  await mkdir(cwd);
  vi.stubEnv('DREAMUX_ROOT', join(base, 'state'));
  const log = createLogger({ destination: { write() {} } });
  const provider = new ControlledRuntimeProvider();
  const registry = new ProviderRegistry();
  registry.register(
    {
      id: 'controlled',
      kind: 'agentRuntime',
      ref: parseProviderRef('builtin:controlled'),
    },
    provider,
  );
  const channel = createFakeChannelProvider(options.channelOptions);
  if (options.channel)
    registry.register(
      {
        id: 'fixture-channel',
        kind: 'channel',
        ref: parseProviderRef('builtin:fixture-channel'),
      },
      channel.provider,
    );
  const dispatcher = {
    id: 'test',
    cwd,
    enabled: true,
    workspace: { enabled: false },
    channels: options.channel
      ? [
          {
            id: 'fixture-channel',
            provider: 'builtin:fixture-channel',
            config: {},
          },
        ]
      : [],
    agentRuntime: 'controlled',
  };
  const config: DreamuxConfig = {
    agents: { controlled: { provider: 'builtin:controlled', config: {} } },
    dispatchers: [dispatcher],
  };
  if (options.restartNotice !== undefined)
    await notifyResumedRestart({
      targets: ['test'],
      announce: options.restartNotice,
      now: Date.now(),
      path: join(base, 'restart.json'),
      runControl: async () => undefined,
    });
  const restartIntent = await RestartIntentConsumer.load({
    now: Date.now(),
    path: join(base, 'restart.json'),
    log,
  });
  const hosts: DispatcherService[] = [];
  const releases: Array<() => void> = [];
  const build = () => {
    const host = new DispatcherService({
      id: dispatcher.id,
      dispatcher,
      config: { current: () => config },
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      channelProviders: new ChannelProviderCatalog({ registry }),
      mcpLeases: new McpLeaseRegistry(log),
      restartIntent,
      commands: new CoreCommands([]),
      homePathPrefixes: [],
      adminSocketPath: join(base, 'admin.sock'),
      channelLoggerFactory: () => log,
      workflowLog: log,
      log,
    });
    hosts.push(host);
    const teams = host.teams;
    if (!(teams instanceof TeamCollection))
      throw new Error('expected real Team collection');
    return { host, teams };
  };
  const initial = build();
  cleanups.push(async () => {
    for (const release of releases) release();
    try {
      for (const host of hosts) await host.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  return {
    ...initial,
    log,
    provider,
    channel,
    build,
    releases,
    config,
    teamRoot: teamCollectionDir(dispatcherDir(dispatcher.id)),
  };
}
