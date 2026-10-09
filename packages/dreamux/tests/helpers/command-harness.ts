/** Real command composition and transport fixtures, using controlled provider seams. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { afterEach, vi } from 'vitest';
import type {
  ChannelEventSource,
  JsonValue,
  TeamSummary,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { CoreCommandContext } from '../../src/command/types.js';
import { createCoreCommandRegistry } from '../../src/server/command-catalog.js';
import { CoreCommandPort } from '../../src/command/port.js';
import type {
  CoreCommands,
  AnyCoreCommand,
} from '../../src/command/registry.js';
import {
  createAdminSocketServer,
  type AdminSocketServer,
} from '../../src/admin/socket.js';
import type { AdminResponse } from '../../src/admin/protocol.js';
import { createChannelCorePort } from '../../src/service/channel-service/core-port.js';
import { McpLeaseRegistry } from '../../src/service/mcp/leases.js';
import type {
  McpDelegateCall,
  McpDelegateResult,
  McpServerDelegate,
} from '../../src/service/mcp/types.js';
import type { TeamListRow } from '../../src/service/team/types.js';
import type { DispatcherService } from '../../src/service/dispatcher-service/index.js';
import type {
  DispatcherSummary,
  DispatcherRuntimeStatus,
} from '../../src/service/dispatcher-service/types.js';
import { ConfigService } from '../../src/config/service.js';
import {
  globalConfigFile,
  type DispatcherConfig,
  type DispatcherChannelConfig,
} from '../../src/config/config.js';
import {
  ProviderRegistry,
  parseProviderRef,
} from '../../src/registry/index.js';
import { Server } from '../../src/server.js';
import { ControlledRuntimeProvider } from './controlled-runtime-provider.js';
import { createFakeChannelProvider } from './fake-channel-provider.js';

// Observe definitions supplied to the real constructor; production needs no
// catalog reflection capability merely to satisfy a test.
const observed = vi.hoisted(
  () => new WeakMap<object, readonly AnyCoreCommand[]>(),
);
vi.mock('../../src/command/registry.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/command/registry.js')>();
  return {
    ...real,
    CoreCommands: class extends real.CoreCommands {
      constructor(definitions: readonly AnyCoreCommand[]) {
        super(definitions);
        observed.set(this, definitions);
      }
    },
  };
});
export function registryNames(registry: CoreCommands): string[] {
  const definitions = observed.get(registry);
  if (!definitions) throw new Error('registry construction was not observed');
  return definitions.map((definition) => definition.name);
}
export const HARNESS_DISPATCHER_ID = 'harness-d1';
export const HARNESS_CHANNEL_ID = 'harness-channel';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
export interface FakeDispatcherOverrides {
  createTeam?: unknown;
  submitToTeamLeader?: unknown;
  submitToAgent?: unknown;
  interruptAgent?: unknown;
  interruptTeamLeader?: unknown;
  listTeams?: unknown;
  listChannels?: unknown;
  getTeamStatus?: unknown;
  getTeamHistory?: unknown;
  dissolveTeam?: unknown;
  teamScheduler?: unknown;
  teammates?: Record<string, unknown>;
  workflows?: Record<string, unknown>;
  scheduler?: Record<string, unknown>;
}
export interface HarnessOptions {
  dispatcherOverrides?: FakeDispatcherOverrides;
  dispatcherRow?: DispatcherConfig | null;
  summarize?: () => Promise<DispatcherSummary[]>;
  dispatcherRuntimeStatus?: () => Promise<DispatcherRuntimeStatus>;
  enabled?: boolean;
  channels?: DispatcherChannelConfig[];
}
export interface CommandHarness {
  readonly host: Server;
  readonly registry: CoreCommands;
  readonly port: CoreCommandPort;
  readonly dispatcher: DispatcherService;
  readonly mcpLeases: McpLeaseRegistry;
  readonly dispatcherLookups: string[];
  readonly provider: ControlledRuntimeProvider;
  readonly fake: ReturnType<typeof createFakeChannelProvider>;
  readonly root: string;
}
export function harnessDispatcherRow(
  overrides: Partial<DispatcherConfig> = {},
): DispatcherConfig {
  return {
    id: HARNESS_DISPATCHER_ID,
    cwd: '/tmp',
    enabled: true,
    workspace: { enabled: false },
    channels: [],
    agentRuntime: 'controlled',
    ...overrides,
  };
}
function stub(target: object, key: string, implementation: unknown): void {
  if (implementation !== undefined)
    vi.spyOn(target as never, key as never).mockImplementation(
      implementation as never,
    );
}
/** Config is file-backed; external runtime and channel providers are controlled. */
export async function createUnstartedCommandServer(
  options: Pick<HarnessOptions, 'enabled' | 'channels'> & {
    hooks?: ConstructorParameters<typeof Server>[0]['hooks'];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-command-'));
  vi.stubEnv('DREAMUX_ROOT', join(root, 'state'));
  const registry = new ProviderRegistry();
  const provider = new ControlledRuntimeProvider();
  const fake = createFakeChannelProvider();
  registry.register(
    {
      id: 'controlled',
      kind: 'agentRuntime',
      ref: parseProviderRef('builtin:controlled'),
    },
    provider,
  );
  const channels = options.channels ?? [
    { id: HARNESS_CHANNEL_ID, provider: 'builtin:fixture-channel', config: {} },
  ];
  for (const channel of channels) {
    const ref = parseProviderRef(channel.provider);
    registry.register(
      {
        id: ref.source === 'builtin' ? ref.id : ref.package,
        kind: 'channel',
        ref,
      },
      {
        ...fake.provider,
        identity: {
          get: (config: Record<string, unknown>) =>
            typeof config['identity'] === 'string' ? config['identity'] : '',
        },
      },
    );
  }
  const raw = {
    agents: [{ id: 'controlled', provider: 'builtin:controlled', config: {} }],
    dispatchers: [
      {
        id: HARNESS_DISPATCHER_ID,
        cwd: root,
        enabled: options.enabled ?? true,
        workspace: { enabled: false },
        channels,
        agentRuntime: 'controlled',
      },
    ],
  };
  const file = globalConfigFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(raw), { mode: 0o600 });
  const config = await ConfigService.open({ providerRegistry: registry });
  const log = capturingLogger([]);
  const host = new Server({
    config,
    providerRegistry: registry,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    adminSocketPath: join(root, 'owner.sock'),
    logger: log,
    channelLoggerFactory: () => log,
    workflowLoggerFactory: () => log,
  });
  cleanups.push(async () => {
    try {
      await host.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return { host, config, provider, fake, root };
}
/** Fault injection spies sit on actual owners, never a fake command host. */
export async function createCommandHarness(
  options: HarnessOptions = {},
): Promise<CommandHarness> {
  const fixture = await createUnstartedCommandServer(options);
  const { host, config } = fixture;
  await host.start();
  const dispatcher = host.dispatchers.get(HARNESS_DISPATCHER_ID);
  const dispatcherLookups: string[] = [];
  const get = host.dispatchers.get.bind(host.dispatchers);
  vi.spyOn(host.dispatchers, 'get').mockImplementation((id) => {
    dispatcherLookups.push(id);
    return get(id);
  });
  stub(host.dispatchers, 'summarize', options.summarize);
  stub(host.dispatchers, 'status', options.dispatcherRuntimeStatus);
  const overrides = options.dispatcherOverrides ?? {};
  for (const [input, target, key] of [
    ['submitToAgent', dispatcher, 'submitToAgent'],
    ['interruptAgent', dispatcher, 'interruptAgent'],
    ['listChannels', dispatcher.channels, 'list'],
    ['createTeam', dispatcher.teams, 'createFromRequest'],
    ['submitToTeamLeader', dispatcher.teams, 'submitToLeader'],
    ['interruptTeamLeader', dispatcher.teams, 'interruptLeader'],
    ['listTeams', dispatcher.teams, 'list'],
    ['getTeamStatus', dispatcher.teams, 'summary'],
    ['getTeamHistory', dispatcher.teams, 'history'],
    ['dissolveTeam', dispatcher.teams, 'dissolve'],
    ['teamScheduler', dispatcher.teams, 'scheduler'],
  ] as const)
    stub(target, key, overrides[input]);
  for (const key of ['teammates', 'workflows', 'scheduler'] as const) {
    for (const [method, implementation] of Object.entries(overrides[key] ?? {}))
      stub(dispatcher[key], method, implementation);
  }
  if (options.dispatcherRow === null) {
    const current = config.current();
    vi.spyOn(config, 'current').mockReturnValue({
      ...current,
      dispatchers: [],
    });
  }
  const commands = createCoreCommandRegistry(host);
  const port = new CoreCommandPort(commands);
  return {
    ...fixture,
    registry: commands,
    port,
    dispatcher,
    mcpLeases: host.mcpLeases,
    dispatcherLookups,
  };
}

export function harnessTeamListRow(
  overrides: Partial<TeamListRow> = {},
): TeamListRow {
  return {
    team_name: 'harness-team',
    status: 'running',
    intent: 'test Team',
    source_repo: null,
    leader_name: 'harness-leader',
    leader_agent_runtime: 'fake-runtime',
    leader_state: 'running',
    member_count: 0,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    worktree_cleanup: 'not-managed',
    ...overrides,
  };
}

export function harnessTeamSummary(
  overrides: Partial<TeamSummary> = {},
): TeamSummary {
  return {
    team_name: 'harness-team',
    status: 'running',
    intent: 'test Team',
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    close_note: null,
    leader_name: 'harness-leader',
    leader_agent_runtime: 'fake-runtime',
    runtime_cwd: '/tmp/harness-workspace',
    leader_state: 'running',
    leader_session_id: null,
    leader_runtime_status: null,
    leader_intent: 'lead test Team',
    leader_last_error: null,
    leader_closed_at: null,
    leader_close_note: null,
    member_count: 0,
    source_repo: null,
    worktree_mode: 'reuse-cwd',
    worktree_cleanup_mode: 'keep',
    worktree_cleanup: 'not-managed',
    ...overrides,
  };
}

/** A caller context as the admin socket adapter would build it. */
export function adminContext(dispatcherId?: string): CoreCommandContext {
  return {
    source: 'admin_socket',
    ...(dispatcherId !== undefined ? { dispatcher_id: dispatcherId } : {}),
  };
}

/** A caller context as the in-process Channel adapter would build it. */
export function channelContext(
  dispatcherId: string = HARNESS_DISPATCHER_ID,
  channelId: string = HARNESS_CHANNEL_ID,
): CoreCommandContext {
  return {
    source: 'channel',
    dispatcher_id: dispatcherId,
    channel_id: channelId,
  };
}

/** A no-op `ChannelEventSource`: the Command half of the port is under test, never the event half. */
export function fakeChannelEventSource(): ChannelEventSource {
  return {
    subscribe: () => ({ unsubscribe: () => {} }),
  };
}

/** Build the in-process Channel invoke adapter over a harness's admitted port. */
export function createHarnessChannelInvoker(
  harness: CommandHarness,
  dispatcherId: string = HARNESS_DISPATCHER_ID,
  channelId: string = HARNESS_CHANNEL_ID,
  logs: CapturedLog[] = [],
) {
  return createChannelCorePort({
    registry: harness.port,
    dispatcherId,
    channelId,
    events: fakeChannelEventSource(),
    log: capturingLogger(logs),
  });
}

/** One log line an adapter recorded rather than said out loud. */
export interface CapturedLog {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

/** A logger that keeps what it was told, for asserting what stayed private. */
export function capturingLogger(sink: CapturedLog[]): DreamuxLogger {
  const record = (
    fields: Record<string, unknown> | string,
    message?: string,
  ): void => {
    sink.push({
      fields: typeof fields === 'string' ? {} : fields,
      message: typeof fields === 'string' ? fields : (message ?? ''),
    });
  };
  const log: DreamuxLogger = {
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    child: () => log,
  };
  return log;
}

export interface HarnessAdminSocket {
  readonly socketPath: string;
  readonly server: AdminSocketServer;
  /** Everything the socket adapter logged instead of putting on the wire. */
  readonly logs: CapturedLog[];
  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<AdminResponse>;
  /** Send a raw line, bypassing JSON construction — for framing-failure tests. */
  sendRaw(line: string): Promise<AdminResponse>;
  close(): Promise<void>;
}

/**
 * Start a real `admin.sock` NDJSON server over a harness's admitted port, and
 * a matching raw socket client. `createAdminSocketServer` only ever reaches
 * `server.commands.invoke`, so a structural fake stands in for the concrete
 * `Server` class without instantiating it.
 */
export async function startHarnessAdminSocket(
  harness: CommandHarness,
): Promise<HarnessAdminSocket> {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-command-harness-'));
  const socketPath = join(dir, 'admin.sock');
  const logs: CapturedLog[] = [];
  const fakeServer = {
    commands: harness.port,
    logger: capturingLogger(logs),
  };
  const server = createAdminSocketServer(fakeServer, socketPath);
  await server.start();

  let seq = 0;
  async function sendRaw(line: string): Promise<AdminResponse> {
    return new Promise<AdminResponse>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(`${line}\n`);
      });
      socket.on('data', (chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const raw = buf.slice(0, idx);
        socket.end();
        try {
          resolve(JSON.parse(raw) as AdminResponse);
        } catch (err) {
          reject(err);
        }
      });
      socket.on('error', reject);
    });
  }

  async function send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<AdminResponse> {
    seq += 1;
    const id = `req-${seq}`;
    return sendRaw(
      JSON.stringify({
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    );
  }

  return {
    socketPath,
    server,
    logs,
    send,
    sendRaw,
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Mint a Channel-reachable MCP token for a single-tool fake delegate. */
export function mintFakeMcpServer(
  mcpLeases: McpLeaseRegistry,
  options: {
    name?: string;
    toolName?: string;
    call?: (call: McpDelegateCall) => Promise<McpDelegateResult>;
    isCurrent?: () => boolean;
  } = {},
): { token: string } {
  const toolName = options.toolName ?? 'harness_tool';
  const delegate: McpServerDelegate = {
    name: options.name ?? 'harness-mcp-server',
    describe: () => ({
      tools: [{ name: toolName, inputSchema: { type: 'object' } }],
    }),
    call:
      options.call ??
      (async (call) => ({ ok: true, structured: { echoed: call.arguments } })),
  };
  const lease = {
    isCurrent: options.isCurrent ?? (() => true),
    state: { publish: async () => {} },
  };
  const minted = mcpLeases.mint(lease, delegate);
  if (minted === null) {
    throw new Error(
      'harness MCP delegate advertised no tools; mint returned null',
    );
  }
  return { token: minted.token };
}

export interface RawStubSocket {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * A bare Unix-socket listener for the admin CLIENT's own transport-failure
 * paths (`src/admin/client.ts`) — connection accepted, then handed unparsed
 * to `onConnection`. No NDJSON framing, no Command port: it exists so a test
 * can make the real client observe "connected but no valid answer ever came"
 * without a real `CoreCommandPort` in the loop at all.
 */
export async function startRawStubSocket(
  onConnection: (socket: Socket) => void,
): Promise<RawStubSocket> {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-command-harness-stub-'));
  const socketPath = join(dir, 'admin.sock');
  // A test that deliberately never answers (the client-timeout case) leaves
  // its accepted connection open on purpose: `server.close()` alone waits for
  // every open connection to end, which a socket the test intentionally never
  // closes would hang forever. Tracking and destroying accepted sockets here
  // is what makes that case a fast, deterministic test rather than a leaked
  // handle the harness happens not to notice.
  const openSockets = new Set<Socket>();
  const server = createServer((socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A JSON payload deep enough to violate `COMMAND_PAYLOAD_BOUNDS.maxDepth`, built without ever crossing `JSON.parse`. */
export function hostileDeepPayload(depth: number): JsonValue {
  let value: JsonValue = 'bottom';
  for (let i = 0; i < depth; i++) {
    value = { nested: value };
  }
  return value as JsonValue;
}

export type { AdminResponse };
