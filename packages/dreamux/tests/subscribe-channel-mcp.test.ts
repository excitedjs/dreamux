import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeMcpServer,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import { codexMcpServerArgs } from '@excitedjs/agent-runtime-codex';
import { claudeCodeMcpConfig } from '@excitedjs/agent-runtime-claude-code';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { createAdminSocketServer } from '../src/admin/socket.js';
import { runSubscribeChannelMcp } from '../src/mcp/subscribe-channel-mcp.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import {
  parseProviderRef,
  ProviderRegistry,
} from '../src/registry/index.js';
import { Server } from '../src/server.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import {
  fakeSubscribeChannelCatalog,
  SUBSCRIBE_PROVIDER_REF,
} from './helpers/fake-subscribe-channel.js';

const RUNTIME_PROVIDER_REF = 'builtin:test-runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class CapturingRuntime implements AgentRuntime {
  readonly providerRef = RUNTIME_PROVIDER_REF;
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
  private status: AgentRuntimeStatus = 'declared';

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async channelInput(_input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'submitted', turnId: 'turn-channel' };
  }

  async completionInput(
    input: AgentRuntimeTextInput,
  ): Promise<AgentRuntimeTurnResult> {
    this.textSubmitted.push(input);
    return { status: 'submitted', turnId: 'turn-text' };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return null;
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: null };
  }

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

function fakeRuntimeCatalog(input: {
  contexts: AgentRuntimeCreateContext[];
  runtimes: CapturingRuntime[];
}): AgentRuntimeProviderCatalog {
  const registry = new ProviderRegistry();
  const descriptor = {
    id: 'test-runtime',
    kind: 'agentRuntime' as const,
    ref: parseProviderRef(RUNTIME_PROVIDER_REF),
  };
  const provider: AgentRuntimeProvider = {
    ref: RUNTIME_PROVIDER_REF,
    descriptor,
    getCapabilities: () => CAPABILITIES,
    createRuntime(context) {
      input.contexts.push(context);
      const runtime = new CapturingRuntime();
      input.runtimes.push(runtime);
      return runtime;
    },
  };
  registry.register(descriptor);
  registry.registerImplementation(descriptor.id, provider);
  return new AgentRuntimeProviderCatalog({ registry });
}

function emptyChannelCatalog(): ChannelProviderCatalog {
  return {
    list: () => [],
    resolve(ref: string) {
      throw new Error(`unexpected channel provider ${JSON.stringify(ref)}`);
    },
  } as unknown as ChannelProviderCatalog;
}

function noopLog(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

function subscriptionConfig(workspace: string) {
  return {
    ...testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [],
        agentRuntime: 'agent-a',
        runtimeProvider: RUNTIME_PROVIDER_REF,
      }),
    ]),
    subscriptions: [
      {
        id: 'issues',
        dispatcher_id: 'dispatcher-a',
        provider: SUBSCRIBE_PROVIDER_REF,
        config: { repo: 'example/repo' },
      },
    ],
  };
}

function twoSubscriptionConfig(workspace: string) {
  return {
    ...subscriptionConfig(workspace),
    subscriptions: [
      {
        id: 'issues',
        dispatcher_id: 'dispatcher-a',
        provider: SUBSCRIBE_PROVIDER_REF,
        config: { repo: 'example/repo', stream: 'issues' },
      },
      {
        id: 'pull_requests',
        dispatcher_id: 'dispatcher-a',
        provider: SUBSCRIBE_PROVIDER_REF,
        config: { repo: 'example/repo', stream: 'pulls' },
      },
    ],
  };
}

describe('subscription channel MCP core ownership', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-subscribe-mcp-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('injects core-rendered subscription descriptors into dispatcher runtime launch metadata', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const contexts: AgentRuntimeCreateContext[] = [];
    const runtimes: CapturingRuntime[] = [];
    const subscription = fakeSubscribeChannelCatalog();
    const config = subscriptionConfig(workspace);
    const server = new Server({
      config,
      agentRuntimeProviderCatalog: fakeRuntimeCatalog({ contexts, runtimes }),
      channelProviderCatalog: emptyChannelCatalog(),
      subscribeChannelProviderCatalog: subscription.catalog,
      adminSocketPath: join(root, 'admin.sock'),
      logger: noopLog(),
      channelLoggerFactory: () => noopLog(),
    });

    const dispatcher = server.getDispatcher('dispatcher-a');
    await dispatcher.start();
    const job = await dispatcher.scheduler.create({
      cron: '* * * * *',
      prompt: 'wake dispatcher',
      tz: 'UTC',
    });
    await dispatcher.scheduler.runNow(job.id);

    const dispatcherContext = contexts.find(
      (context) => context.identity.runtime_id === 'dispatcher-a',
    );
    expect(dispatcherContext?.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-aXNzdWVz',
          command: expect.any(String),
          args: expect.arrayContaining([
            'subscribe-channel-mcp',
            '--provider',
            SUBSCRIBE_PROVIDER_REF,
            '--subscription-id',
            'issues',
            '--dispatcher',
            'dispatcher-a',
            '--admin-socket',
            join(root, 'admin.sock'),
          ]),
        }),
      ]),
    );
    expect(subscription.configReads).toEqual([{ repo: 'example/repo' }]);
    expect(subscription.starts).toBe(0);

    await dispatcher.stop();
  });

  it('keeps same-provider subscription descriptors distinct in runtime MCP config renderers', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const contexts: AgentRuntimeCreateContext[] = [];
    const runtimes: CapturingRuntime[] = [];
    const subscription = fakeSubscribeChannelCatalog();
    const server = new Server({
      config: twoSubscriptionConfig(workspace),
      agentRuntimeProviderCatalog: fakeRuntimeCatalog({ contexts, runtimes }),
      channelProviderCatalog: emptyChannelCatalog(),
      subscribeChannelProviderCatalog: subscription.catalog,
      adminSocketPath: join(root, 'admin.sock'),
      logger: noopLog(),
      channelLoggerFactory: () => noopLog(),
    });

    const dispatcher = server.getDispatcher('dispatcher-a');
    await dispatcher.start();
    const job = await dispatcher.scheduler.create({
      cron: '* * * * *',
      prompt: 'wake dispatcher',
      tz: 'UTC',
    });
    await dispatcher.scheduler.runNow(job.id);

    const servers =
      contexts.find((context) => context.identity.runtime_id === 'dispatcher-a')
        ?.mcpServers ?? [];
    const subscriptionServers = servers.filter((server) =>
      server.args.includes('subscribe-channel-mcp'),
    );
    assertTwoSubscriptionServers(subscriptionServers);
    const codexArgs = codexMcpServerArgs(subscriptionServers);
    expect(codexArgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'mcp_servers.subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-aXNzdWVz.command=',
        ),
        expect.stringContaining(
          'mcp_servers.subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-cHVsbF9yZXF1ZXN0cw.command=',
        ),
      ]),
    );
    const claudeConfig = claudeCodeMcpConfig(subscriptionServers);
    expect(Object.keys(claudeConfig.mcpServers).sort()).toEqual([
      'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-aXNzdWVz',
      'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-cHVsbF9yZXF1ZXN0cw',
    ]);

    await dispatcher.stop();
  });

  it('serves static tools/list and forwards tools/call through admin without starting a subscription session', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const subscription = fakeSubscribeChannelCatalog();
    const socketPath = join(root, 'admin.sock');
    const server = new Server({
      config: subscriptionConfig(workspace),
      agentRuntimeProviderCatalog: fakeRuntimeCatalog({
        contexts: [],
        runtimes: [],
      }),
      channelProviderCatalog: emptyChannelCatalog(),
      subscribeChannelProviderCatalog: subscription.catalog,
      adminSocketPath: socketPath,
      logger: noopLog(),
      channelLoggerFactory: () => noopLog(),
    });
    const admin = createAdminSocketServer(server, socketPath);
    await admin.start();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: unknown[] = [];
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') lines.push(JSON.parse(line));
      }
    });

    const run = runSubscribeChannelMcp({
      dispatcherId: 'dispatcher-a',
      providerRef: SUBSCRIBE_PROVIDER_REF,
      subscriptionId: 'issues',
      tools: [{ name: 'ack_issue' }],
      adminSocketPath: socketPath,
      input,
      output,
      log: () => undefined,
    });
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'ack_issue',
          arguments: { issue: 42 },
        },
      })}\n`,
    );
    input.end();
    await run;
    await admin.close();

    expect(lines).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'ack_issue' }] },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [
            {
              type: 'text',
              text: 'ack_issue forwarded to dreamux serve',
            },
          ],
          structuredContent: {
            ok: true,
            received: { issue: 42 },
          },
        },
      },
    ]);
    expect(subscription.handled).toEqual([
      {
        call: { name: 'ack_issue', arguments: { issue: 42 } },
        context: expect.objectContaining({
          dispatcher_id: 'dispatcher-a',
          subscription_id: 'issues',
        }),
      },
    ]);
    expect(subscription.starts).toBe(0);
  });

  it('routes subscription tool admin calls to the static provider catalog without materializing dispatchers or sessions', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const subscription = fakeSubscribeChannelCatalog();
    const server = new Server({
      config: subscriptionConfig(workspace),
      agentRuntimeProviderCatalog: fakeRuntimeCatalog({
        contexts: [],
        runtimes: [],
      }),
      channelProviderCatalog: emptyChannelCatalog(),
      subscribeChannelProviderCatalog: subscription.catalog,
      adminSocketPath: join(root, 'admin.sock'),
      logger: noopLog(),
      channelLoggerFactory: () => noopLog(),
    });

    await expect(
      server.invokeSubscribeChannelTool({
        dispatcherId: 'dispatcher-a',
        providerRef: SUBSCRIBE_PROVIDER_REF,
        subscriptionId: 'issues',
        name: 'ack_issue',
        arguments: { issue: 7 },
      }),
    ).resolves.toEqual({ ok: true, received: { issue: 7 } });
    expect(subscription.handled).toEqual([
      {
        call: { name: 'ack_issue', arguments: { issue: 7 } },
        context: expect.objectContaining({
          dispatcher_id: 'dispatcher-a',
          subscription_id: 'issues',
        }),
      },
    ]);
    expect(subscription.starts).toBe(0);
    expect(server.repos.dispatchers).toBeInstanceOf(DispatcherStore);
  });
});

function assertTwoSubscriptionServers(
  servers: readonly AgentRuntimeMcpServer[],
): void {
  expect(servers.map((server) => server.name).sort()).toEqual([
    'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-aXNzdWVz',
    'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-cHVsbF9yZXF1ZXN0cw',
  ]);
  expect(new Set(servers.map((server) => server.name)).size).toBe(2);
  expect(servers.map((server) => server.args)).toEqual(
    expect.arrayContaining([
      expect.arrayContaining(['--subscription-id', 'issues']),
      expect.arrayContaining(['--subscription-id', 'pull_requests']),
    ]),
  );
}
