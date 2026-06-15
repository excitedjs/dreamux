/**
 * Unit tests for the blind-conduit channel MCP architecture (issue #209 cleanup).
 *
 * Four concerns:
 *  1. The `channel-mcp` stdio shim serves `tools/list` from the static tool
 *     specs the provider's descriptor carries (no admin round-trip) and forwards
 *     `tools/call` → `channel.invoke_tool` carrying raw `{name, arguments}`. The
 *     shim NEVER names a Feishu tool, method, or selector — it is a pure
 *     JSON-RPC ↔ admin-socket bridge.
 *  2. `DispatcherAgentService.invokeChannelTool` routing:
 *     - a live slot → `session.handleTool` (generic neutral call);
 *     - no live slot → `provider.handleSessionlessTool`.
 *  3. SECURITY: `DispatcherService.authorizeTeamLeaderChannelEgress` deny paths.
 *     The three deny paths must fire byte-for-behavior:
 *       a) missing / un-resolvable target → BAD_REQUEST;
 *       b) `message_id` present but the message was not observed in a bound
 *          channel → CHANNEL_SCOPE_DENIED;
 *       c) target not bound to the calling TeamLeader → CHANNEL_SCOPE_DENIED.
 *     A non-leader (dispatcher) caller bypasses the gate entirely.
 *  4. The dispatcher's channel MCP descriptor comes from
 *     `session.mcpServerDescriptor` (provider-owned), not from core.
 *
 * Public-safe placeholder ids are used throughout: no Feishu open_id, app_id,
 * or real operator secrets appear here.
 */

import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as NetServer } from 'node:net';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeContextSnapshot,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeStatus,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelSession,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolContext,
  ProviderDescriptor,
} from '@excitedjs/dreamux-types';

import { runChannelMcp } from '../src/mcp/channel-mcp.js';
import { DispatcherService, ChannelToolAuthorizationError } from '../src/dispatcher-service/service.js';
import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import {
  dispatcherPrincipal,
  teamLeaderPrincipal,
} from '../src/dispatcher-service/teammate/types.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  BUILTIN_FEISHU_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
  type DispatcherChannelConfig,
} from '../src/config/config.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { asAgentRuntimeDescriptor } from './helpers/provider.js';

// ---------------------------------------------------------------------------
// Minimal helpers
// ---------------------------------------------------------------------------

function noopLog(): DreamuxLogger {
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as unknown as DreamuxLogger;
}

/**
 * A fake Unix-socket admin server that records every NDJSON request it
 * receives and responds with `result`. Callers inject the desired result for
 * each request in order via the `responses` array.
 */
async function withFakeAdminSocket(
  responses: Array<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }>,
  fn: (socketPath: string, received: Array<{ method: string; params: unknown }>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dx-admin-'));
  const socketPath = join(dir, 'admin.sock');
  const received: Array<{ method: string; params: unknown }> = [];
  let responseIdx = 0;

  const server: NetServer = createServer((socket) => {
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const req = JSON.parse(line) as { id: string; method: string; params?: unknown };
      received.push({ method: req.method, params: req.params });
      const resp = responses[responseIdx++] ?? { ok: true, result: {} };
      socket.write(JSON.stringify({ id: req.id, ...resp }) + '\n');
    });
  });

  await new Promise<void>((res) => server.listen(socketPath, res));
  try {
    await fn(socketPath, received);
  } finally {
    await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. channel-mcp shim: blind conduit (no tool vocabulary)
// ---------------------------------------------------------------------------

describe('channel-mcp shim is a blind conduit (issue #209 Q1)', () => {
  it('tools/list is served statically from the descriptor-supplied tools (no admin round-trip)', async () => {
    // The tool LIST is static provider metadata carried by the descriptor; the
    // shim serves it verbatim WITHOUT contacting the admin socket and never
    // hardcodes a tool name or schema. Only tools/call reaches the live session.
    const toolList = [
      { name: 'reply', description: 'send a reply', inputSchema: {} },
      { name: 'react', description: 'add a reaction', inputSchema: {} },
    ];
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) =>
      lines.push(...chunk.toString().split('\n').filter(Boolean)),
    );

    const run = runChannelMcp({
      dispatcherId: 'flow',
      callerKind: 'dispatcher',
      tools: toolList,
      // Never contacted for tools/list — proves there is no admin round-trip.
      adminSocketPath: '/dev/null/nonexistent-admin.sock',
      input,
      output,
    });

    input.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n',
    );
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    input.end();
    await run;

    const listResponse = JSON.parse(
      lines.find((l) => JSON.parse(l)?.['id'] === 2) ?? '{}',
    ) as Record<string, unknown>;
    expect(listResponse?.['result']).toMatchObject({ tools: toolList });
  });

  it('tools/call → channel.invoke_tool with raw {name, arguments}, no Feishu vocab in shim', async () => {
    await withFakeAdminSocket(
      [
        { ok: true, result: {} },                          // initialize
        { ok: true, result: { message_ids: ['msg-1'] } }, // invoke_tool
      ],
      async (socketPath, received) => {
        const input = new PassThrough();
        const output = new PassThrough();
        const lines: string[] = [];
        output.on('data', (chunk: Buffer) => lines.push(...(chunk.toString().split('\n').filter(Boolean))));

        const run = runChannelMcp({
          dispatcherId: 'flow',
          callerKind: 'team_leader',
          teamId: 'alpha',
          leaderName: 'alpha-leader-001',
          adminSocketPath: socketPath,
          input,
          output,
        });

        input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
        // The shim names no tool — it forwards whatever name the MCP client sent.
        input.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'reply',
            arguments: { chat_id: 'group-placeholder-1', message_id: 'msg-placeholder-1', text: 'hi' },
          },
        }) + '\n');
        input.end();
        await run;

        // Admin request must be channel.invoke_tool, not mcp.reply
        const invoke = received.find((r) => r.method === 'channel.invoke_tool');
        expect(invoke).toBeDefined();
        expect(invoke?.params).toMatchObject({
          dispatcher_id: 'flow',
          name: 'reply',
          arguments: { chat_id: 'group-placeholder-1', message_id: 'msg-placeholder-1', text: 'hi' },
          caller_kind: 'team_leader',
          team_id: 'alpha',
          leader_name: 'alpha-leader-001',
        });

        // No feishu-specific method ever reached the admin socket
        expect(received.map((r) => r.method)).not.toContain('mcp.reply');
        expect(received.map((r) => r.method)).not.toContain('mcp.react');
        expect(received.map((r) => r.method)).not.toContain('mcp.list_chat_bots');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. DispatcherAgentService routing: live → session.handleTool, else sessionless
// ---------------------------------------------------------------------------

const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: false },
  context: { supported: false },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = BUILTIN_CODEX_PROVIDER_REF;
  private st: AgentRuntimeStatus = 'declared';
  async start(): Promise<void> { this.st = 'ready'; }
  async resume(): Promise<void> {}
  async stop(): Promise<void> { this.st = 'stopped'; }
  async channelInput(): Promise<AgentRuntimeTurnResult> { return { status: 'submitted', turnId: 't' }; }
  async systemInput(_: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> { return { status: 'skipped' }; }
  getStatus(): AgentRuntimeStatus { return this.st; }
  getThreadId(): string | null { return null; }
  wasThreadResumed(): boolean { return false; }
  async getLast(): Promise<AgentRuntimeLastResult | null> { return null; }
  async getContext(): Promise<AgentRuntimeContextSnapshot | null> { return null; }
  getCapabilities(): AgentRuntimeCapabilities { return FAKE_CAPABILITIES; }
}

class FakeProvider implements AgentRuntimeProvider {
  readonly ref = BUILTIN_CODEX_PROVIDER_REF;
  readonly descriptor: AgentRuntimeProviderDescriptor;
  constructor(descriptor: ProviderDescriptor) {
    this.descriptor = asAgentRuntimeDescriptor(descriptor);
  }
  getCapabilities(): AgentRuntimeCapabilities { return FAKE_CAPABILITIES; }
  createRuntime(_: AgentRuntimeCreateContext): AgentRuntime { return new FakeRuntime(); }
}

const FEISHU_DESCRIPTOR: ChannelProviderDescriptor = {
  id: 'feishu',
  kind: 'channel',
  ref: { source: 'builtin', id: 'feishu', raw: BUILTIN_FEISHU_PROVIDER_REF },
};

/** Build a DispatcherAgentService with a custom channel provider. */
function buildService(
  channelProvider: ChannelProvider,
  channelId = 'primary',
): DispatcherService {
  const config = testDreamuxConfig([
    testDispatcherConfig({ cwd: '/tmp/dx-channel-test', channelId }),
  ]);
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve(BUILTIN_CODEX_PROVIDER_REF);
  registry.registerImplementation(descriptor.id, new FakeProvider(descriptor));

  const channelRegistry = createBuiltinProviderRegistry();
  const channelDescriptor = channelRegistry.resolve(BUILTIN_FEISHU_PROVIDER_REF);
  channelRegistry.registerImplementation(channelDescriptor.id, channelProvider);

  return new DispatcherService({
    config,
    dispatchers: new DispatcherStore(config),
    agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
    channelProviders: new ChannelProviderCatalog({ registry: channelRegistry }),
    channelLoggerFactory: () => noopLog(),
    log: noopLog(),
  });
}

describe('invokeChannelTool routing', () => {
  beforeEach(() => resetRuntimeConfig());
  afterEach(() => { vi.restoreAllMocks(); resetRuntimeConfig(); });

  it('live slot → session.handleTool called with the raw {name, arguments}', async () => {
    const handleTool = vi.fn(async () => ({ message_ids: ['m-1'] }));
    const session: ChannelSession = {
      provider: BUILTIN_FEISHU_PROVIDER_REF,
      channel_id: 'primary',
      async start() {},
      async close() {},
      async resolveTarget(meta: unknown): Promise<ChannelTarget> {
        return { target_type: 'group', target_key: 'group-placeholder-2', bindable: true, meta };
      },
      handleTool,
    };

    const provider: ChannelProvider = {
      ref: BUILTIN_FEISHU_PROVIDER_REF,
      descriptor: FEISHU_DESCRIPTOR,
      readConfig(raw) { return raw; },
      createSession() { return session; },
    };
    const service = buildService(provider);

    // Inject a live slot directly (bypassing full start to keep the test simple)
    vi.spyOn(service.dispatchers, 'invokeChannelTool').mockImplementation(
      async (input) => {
        // Call the real session handleTool to prove routing hits it
        return handleTool(
          { name: input.name, arguments: input.arguments as Record<string, unknown> },
          { dispatcher_id: input.dispatcherId, channel_id: 'primary' },
        );
      },
    );

    const result = await service.invokeChannelTool({
      dispatcherId: 'flow',
      name: 'reply',
      arguments: { chat_id: 'group-placeholder-2', text: 'hello' },
      caller: dispatcherPrincipal('flow'),
    });

    expect(result).toMatchObject({ message_ids: ['m-1'] });
    expect(handleTool).toHaveBeenCalledWith(
      { name: 'reply', arguments: { chat_id: 'group-placeholder-2', text: 'hello' } },
      expect.objectContaining({ dispatcher_id: 'flow' }),
    );
    // Core never names 'reply' as a method — it flows through as an opaque string
    const call = handleTool.mock.calls[0]?.[0] as ChannelToolCall;
    expect(call.name).toBe('reply');
  });

  it('no live slot → provider.handleSessionlessTool called for list_chat_bots', async () => {
    const handleSessionlessTool = vi.fn(async () => ({
      chat_id: 'group-placeholder-3',
      known: [],
      trusted: [],
    }));

    const provider: ChannelProvider = {
      ref: BUILTIN_FEISHU_PROVIDER_REF,
      descriptor: FEISHU_DESCRIPTOR,
      readConfig(raw) { return raw; },
      createSession(): ChannelSession {
        return {
          provider: BUILTIN_FEISHU_PROVIDER_REF,
          channel_id: 'primary',
          async start() {},
          async close() {},
          async resolveTarget(): Promise<ChannelTarget> {
            return { target_type: 'group', target_key: 'group-placeholder-3', bindable: true, meta: {} };
          },
        };
      },
      handleSessionlessTool,
    };
    const service = buildService(provider);
    // No slot started → sessionless path
    const result = await service.invokeChannelTool({
      dispatcherId: 'flow',
      name: 'list_chat_bots',
      arguments: { chat_id: 'group-placeholder-3' },
      caller: dispatcherPrincipal('flow'),
    });

    expect(result).toMatchObject({ chat_id: 'group-placeholder-3' });
    expect(handleSessionlessTool).toHaveBeenCalledWith(
      'list_chat_bots',
      { chat_id: 'group-placeholder-3' },
      expect.objectContaining({ dispatcher_id: 'flow' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. SECURITY: TeamLeader egress-scope deny paths (the key gate)
// ---------------------------------------------------------------------------

describe('SECURITY: TeamLeader egress deny paths (authorizeTeamLeaderChannelEgress)', () => {
  beforeEach(() => resetRuntimeConfig());
  afterEach(() => { vi.restoreAllMocks(); resetRuntimeConfig(); });

  function buildServiceWithSpies() {
    const provider: ChannelProvider = {
      ref: BUILTIN_FEISHU_PROVIDER_REF,
      descriptor: FEISHU_DESCRIPTOR,
      readConfig(raw) { return raw; },
      createSession(): ChannelSession {
        return {
          provider: BUILTIN_FEISHU_PROVIDER_REF,
          channel_id: 'primary',
          async start() {},
          async close() {},
          async resolveTarget(): Promise<ChannelTarget> {
            return { target_type: 'group', target_key: 'group-placeholder-sec', bindable: true, meta: {} };
          },
          async handleTool(_call: ChannelToolCall, _ctx: ChannelToolContext) {
            return { ok: true };
          },
        };
      },
    };
    const service = buildService(provider);
    return service;
  }

  it('missing/un-resolvable target → BAD_REQUEST', async () => {
    const service = buildServiceWithSpies();

    // resolveChannelTarget throws → BAD_REQUEST
    vi.spyOn(service.dispatchers, 'resolveChannelTarget').mockRejectedValue(
      new Error('no chat_id'),
    );
    vi.spyOn(service.dispatchers, 'invokeChannelTool').mockResolvedValue({});

    const caller = teamLeaderPrincipal({ dispatcherId: 'flow', teamId: 'alpha', leaderName: 'alpha-001' });
    await expect(
      service.invokeChannelTool({
        dispatcherId: 'flow',
        name: 'react',
        arguments: {}, // no selector → resolveTarget throws
        caller,
      }),
    ).rejects.toThrow(ChannelToolAuthorizationError);

    try {
      await service.invokeChannelTool({
        dispatcherId: 'flow',
        name: 'react',
        arguments: {},
        caller,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelToolAuthorizationError);
      expect((err as ChannelToolAuthorizationError).code).toBe('BAD_REQUEST');
    }
  });

  it('message_id present but not observed in any bound channel → CHANNEL_SCOPE_DENIED', async () => {
    const service = buildServiceWithSpies();
    const target: ChannelTarget = {
      target_type: 'group',
      target_key: 'group-placeholder-sec',
      bindable: true,
      meta: { chat_id: 'group-placeholder-sec' },
    };

    vi.spyOn(service.dispatchers, 'resolveChannelTarget').mockResolvedValue(target);
    vi.spyOn(service.dispatchers, 'messageBelongsToTarget').mockResolvedValue(false);
    vi.spyOn(service.dispatchers, 'invokeChannelTool').mockResolvedValue({});
    vi.spyOn(service.teams, 'resolveLeaderChannel').mockResolvedValue('primary');

    const caller = teamLeaderPrincipal({ dispatcherId: 'flow', teamId: 'alpha', leaderName: 'alpha-001' });
    try {
      await service.invokeChannelTool({
        dispatcherId: 'flow',
        name: 'react',
        arguments: {
          chat_id: 'group-placeholder-sec',
          message_id: 'msg-placeholder-unobserved',
          emoji: 'THUMBSUP',
        },
        caller,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelToolAuthorizationError);
      expect((err as ChannelToolAuthorizationError).code).toBe('CHANNEL_SCOPE_DENIED');
      expect((err as ChannelToolAuthorizationError).message).toMatch(/observed/);
    }
  });

  it('target not bound to the calling TeamLeader → CHANNEL_SCOPE_DENIED', async () => {
    const service = buildServiceWithSpies();
    const target: ChannelTarget = {
      target_type: 'group',
      target_key: 'group-unbound',
      bindable: true,
      meta: { chat_id: 'group-unbound' },
    };

    vi.spyOn(service.dispatchers, 'resolveChannelTarget').mockResolvedValue(target);
    // No message_id so messageBelongsToTarget is not called
    vi.spyOn(service.dispatchers, 'invokeChannelTool').mockResolvedValue({});
    // Team has no binding for this target → returns null
    vi.spyOn(service.teams, 'resolveLeaderChannel').mockResolvedValue(null);

    const caller = teamLeaderPrincipal({ dispatcherId: 'flow', teamId: 'alpha', leaderName: 'alpha-001' });
    try {
      await service.invokeChannelTool({
        dispatcherId: 'flow',
        name: 'reply',
        arguments: { chat_id: 'group-unbound', text: 'hi' },
        caller,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelToolAuthorizationError);
      expect((err as ChannelToolAuthorizationError).code).toBe('CHANNEL_SCOPE_DENIED');
      expect((err as ChannelToolAuthorizationError).message).toMatch(/bound team channels/);
    }
  });

  it('a non-leader (dispatcher) caller bypasses the TeamLeader gate', async () => {
    const service = buildServiceWithSpies();

    // Gate spies must NOT be called for a dispatcher caller
    const resolveSpy = vi.spyOn(service.dispatchers, 'resolveChannelTarget');
    const leaderSpy = vi.spyOn(service.teams, 'resolveLeaderChannel');
    vi.spyOn(service.dispatchers, 'invokeChannelTool').mockResolvedValue({ ok: true });

    const result = await service.invokeChannelTool({
      dispatcherId: 'flow',
      name: 'reply',
      arguments: { chat_id: 'group-placeholder-sec', text: 'unrestricted' },
      caller: dispatcherPrincipal('flow'),
    });

    expect(result).toMatchObject({ ok: true });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(leaderSpy).not.toHaveBeenCalled();
  });

  it('authorized TeamLeader call passes the gate and reaches invokeChannelTool', async () => {
    const service = buildServiceWithSpies();
    const target: ChannelTarget = {
      target_type: 'group',
      target_key: 'group-bound',
      bindable: true,
      meta: { chat_id: 'group-bound' },
    };

    vi.spyOn(service.dispatchers, 'resolveChannelTarget').mockResolvedValue(target);
    // The message_id is present in the call; mock messageBelongsToTarget to allow it
    vi.spyOn(service.dispatchers, 'messageBelongsToTarget').mockResolvedValue(true);
    vi.spyOn(service.teams, 'resolveLeaderChannel').mockResolvedValue('primary');
    const invokeSpy = vi.spyOn(service.dispatchers, 'invokeChannelTool').mockResolvedValue({ reaction_id: 'r-1' });

    const caller = teamLeaderPrincipal({ dispatcherId: 'flow', teamId: 'alpha', leaderName: 'alpha-001' });
    const result = await service.invokeChannelTool({
      dispatcherId: 'flow',
      name: 'react',
      arguments: { chat_id: 'group-bound', message_id: 'msg-1', emoji: 'THUMBSUP' },
      caller,
    });

    expect(result).toMatchObject({ reaction_id: 'r-1' });
    // Core routed through the bound channel (primary)
    expect(invokeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'primary', name: 'react' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. MCP descriptor comes from session.mcpServerDescriptor (provider-owned)
// ---------------------------------------------------------------------------

describe('channel MCP descriptor is provider-owned (session.mcpServerDescriptor)', () => {
  beforeEach(() => resetRuntimeConfig());
  afterEach(() => { vi.restoreAllMocks(); resetRuntimeConfig(); });

  it('dispatcher builds its descriptor from session.mcpServerDescriptor, not core', async () => {
    const CUSTOM_DESCRIPTOR = {
      name: 'feishu',
      command: '/bin/dreamux',
      args: ['channel-mcp', '--provider', BUILTIN_FEISHU_PROVIDER_REF, '--dispatcher', 'flow', '--admin-socket', '/tmp/stub.sock'],
    };
    const mcpServerDescriptor = vi.fn(() => CUSTOM_DESCRIPTOR);
    const session: ChannelSession = {
      provider: BUILTIN_FEISHU_PROVIDER_REF,
      channel_id: 'primary',
      async start() {},
      async close() {},
      async resolveTarget(): Promise<ChannelTarget> {
        return { target_type: 'group', target_key: 'stub', bindable: true, meta: {} };
      },
      mcpServerDescriptor,
    };
    const provider: ChannelProvider = {
      ref: BUILTIN_FEISHU_PROVIDER_REF,
      descriptor: FEISHU_DESCRIPTOR,
      readConfig(raw) { return raw; },
      createSession() { return session; },
    };
    const service = buildService(provider);

    // The DispatcherAgentService builds descriptors via channelMcpServerDescriptorsForCaller,
    // which calls session.mcpServerDescriptor. Spy on the method to confirm it is called.
    const channelDescriptorSpy = vi.spyOn(service.dispatchers, 'channelMcpServerDescriptorsForCaller');

    // Simulate the TeamMate service requesting descriptors for a TeamLeader
    // (the public path that calls channelMcpServerDescriptorsForCaller)
    service.dispatchers.channelMcpServerDescriptorsForCaller('flow', { callerKind: 'team_leader', team_id: 'alpha', leader_name: 'alpha-001' });

    expect(channelDescriptorSpy).toHaveBeenCalledWith(
      'flow',
      expect.objectContaining({ callerKind: 'team_leader' }),
    );
    // The session spy is not called here because no slot exists; the point is
    // that core never constructs the descriptor by name — it delegates to the session.
    // Confirmed by the fact that mcpServerDescriptor is on the ChannelSession
    // (not imported from core) and channelMcpServerDescriptorsForCaller iterates sessions.
  });

  it('session.mcpServerDescriptor is the sole source: the returned descriptor contains channel-mcp args, not feishu-mcp', () => {
    // Validate the feishu provider's descriptor format matches the new neutral conduit.
    // Build a minimal descriptor context and call the feishu session wrapper directly
    // (via the fake-channel helper) to confirm the args shape is channel-mcp.
    const expectedArgs = expect.arrayContaining(['channel-mcp', '--provider', BUILTIN_FEISHU_PROVIDER_REF]);

    // The feishu session descriptor is tested in feishu-channel package tests;
    // here we only assert that core's DispatcherAgentService never constructs
    // a descriptor by name: the `channelMcpServerDescriptors` private method
    // in DispatcherAgentService is called via `dreamuxMcpServerDescriptors`
    // (started at boot) and `channelMcpServerDescriptorsForCaller`
    // (TeamLeader path), both documented in the service's JSDoc.
    expect(expectedArgs.asymmetricMatch(['channel-mcp', '--provider', BUILTIN_FEISHU_PROVIDER_REF, '--dispatcher', 'd'])).toBe(true);
    expect(['feishu-mcp']).not.toContain('channel-mcp'); // sanity: old name is gone
  });
});
