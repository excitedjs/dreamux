/**
 * Shared test scaffolding for the Core Command registry and its two adapters
 * (node: core-command-registry).
 *
 * Nothing here replaces production wiring: it builds the exact same objects
 * `Server` composes — `createCoreCommandRegistry`, `CoreCommandPort`,
 * `createAdminSocketServer`, `createChannelCorePort`, a real
 * `McpLeaseRegistry` — around a hand-built `CoreCommandHost` and a hand-built
 * `DispatcherService`-shaped fake. Using the real registry/port/adapters is
 * what makes "both adapters resolve the same definition" a fact the tests
 * observe rather than an assumption they encode.
 *
 * The fake dispatcher only implements the methods the registered Commands
 * actually call (verified by reading every `service/*\/commands.ts` module),
 * each returning the minimal value that satisfies that Command's own declared
 * output schema. A test overrides one method to inject a business failure or
 * to observe whether a handler ran.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';

import type {
  ChannelEventSource,
  CoreCommandContext,
  JsonValue,
} from '@excitedjs/dreamux-types';

import { createCoreCommandRegistry } from '../../src/command/catalog.js';
import type { CoreCommandHost } from '../../src/command/host.js';
import { CoreCommandPort } from '../../src/command/port.js';
import { CoreCommands } from '../../src/command/registry.js';
import { createAdminSocketServer, type AdminSocketServer } from '../../src/admin/socket.js';
import type { AdminResponse } from '../../src/admin/protocol.js';
import { createChannelCorePort } from '../../src/channel/core-port.js';
import { McpLeaseRegistry } from '../../src/service/mcp/leases.js';
import type {
  McpDelegateCall,
  McpDelegateResult,
  McpServerDelegate,
} from '../../src/service/mcp/types.js';
import type { DispatcherService } from '../../src/service/dispatcher-service/index.js';
import type { DispatcherRow } from '../../src/state/dispatcher-store.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherSummary,
} from '../../src/service/dispatcher-service/types.js';
import type { Server } from '../../src/server.js';

/** The one dispatcher id every harness configures by default. */
export const HARNESS_DISPATCHER_ID = 'harness-d1';
export const HARNESS_CHANNEL_ID = 'harness-channel';

/** A minimal, always-valid `DispatcherRow` for the harness dispatcher. */
export function harnessDispatcherRow(
  overrides: Partial<DispatcherRow> = {},
): DispatcherRow {
  return {
    dispatcher_id: HARNESS_DISPATCHER_ID,
    channel_identity: 'harness-identity',
    status: 'running',
    enabled: 1,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as DispatcherRow;
}

/**
 * Every method a registered Command reaches on `host.dispatcher(id)`,
 * pre-wired to return the minimal value each caller's declared output schema
 * accepts. Override any subset per test.
 */
export interface FakeDispatcherOverrides {
  start?: () => Promise<void>;
  runtimeStatus?: () => { status: string | null };
  workspace?: () => Promise<string>;
  createTeam?: (input: unknown) => Promise<unknown>;
  submitToTeamLeader?: (input: unknown) => Promise<unknown>;
  submitToAgent?: (input: unknown) => Promise<unknown>;
  listTeams?: () => Promise<unknown[]>;
  getTeamStatus?: (teamId: string) => Promise<unknown>;
  getTeamHistory?: (query: unknown) => Promise<unknown>;
  dissolveTeam?: (input: unknown) => Promise<unknown>;
  teamScheduler?: (teamId: string) => Promise<unknown>;
  teammates?: Partial<{
    spawn: (input: unknown) => Promise<unknown>;
    send: (input: unknown) => Promise<unknown>;
    close: (input: unknown) => Promise<unknown>;
    list: () => Promise<unknown[]>;
    status: (name: string) => Promise<unknown>;
    history: (query: unknown) => Promise<unknown>;
    last: (name: string, query?: unknown) => Promise<unknown>;
    getCapabilities: () => unknown;
  }>;
  workflows?: Partial<{
    run: (input: unknown) => Promise<unknown>;
    status: (input: unknown) => Promise<unknown>;
    stop: (input: unknown) => Promise<unknown>;
    list: () => Promise<unknown>;
  }>;
  scheduler?: Partial<{
    list: () => Promise<unknown>;
    create: (input: unknown) => Promise<unknown>;
    update: (input: unknown) => Promise<unknown>;
    delete: (id: string) => Promise<unknown>;
  }>;
}

/**
 * A `DispatcherService`-shaped fake. Cast at the boundary rather than typed
 * structurally: every registered Command reaches it only through the narrow
 * `CoreCommandHost` port, exactly as production does, so nothing here needs to
 * be a *real* `DispatcherService` — only to answer the same calls the same way.
 */
export function createFakeDispatcher(
  overrides: FakeDispatcherOverrides = {},
): DispatcherService {
  const fake = {
    start: overrides.start ?? (async () => {}),
    runtimeStatus: overrides.runtimeStatus ?? (() => ({ status: 'running' })),
    workspace: overrides.workspace ?? (async () => '/tmp/harness-workspace'),
    createTeam:
      overrides.createTeam ??
      (async () => ({
        status: 'created',
        team_name: 'harness-team',
        leader_name: 'harness-leader',
      })),
    submitToTeamLeader:
      overrides.submitToTeamLeader ??
      (async () => ({ status: 'submitted', turn: { id: 'harness-turn-1' } })),
    submitToAgent:
      overrides.submitToAgent ??
      (async () => ({ status: 'submitted', turn: { id: 'harness-turn-1' } })),
    listTeams: overrides.listTeams ?? (async () => []),
    getTeamStatus:
      overrides.getTeamStatus ??
      (async () => ({ team: {}, leader: null, member_count: 0 })),
    getTeamHistory:
      overrides.getTeamHistory ?? (async () => ({ items: [], next_cursor: null })),
    dissolveTeam:
      overrides.dissolveTeam ??
      (async () => ({
        accepted: true,
        team_name: 'harness-team',
        status: 'dissolving',
      })),
    teamScheduler:
      overrides.teamScheduler ??
      (async () => fakeSchedulerCommands(overrides.scheduler)),
    teammates: {
      spawn:
        overrides.teammates?.spawn ??
        (async () => ({ teammate: {}, status: 'submitted' })),
      send:
        overrides.teammates?.send ??
        (async () => ({ teammate: {}, status: 'submitted' })),
      close: overrides.teammates?.close ?? (async () => ({ teammate: {} })),
      list: overrides.teammates?.list ?? (async () => []),
      status: overrides.teammates?.status ?? (async () => ({})),
      history:
        overrides.teammates?.history ?? (async () => ({ items: [], next_cursor: null })),
      last:
        overrides.teammates?.last ??
        (async () => ({
          teammate: {},
          requested_records: 0,
          returned_records: 0,
          records: [],
          next_cursor: null,
          truncated: false,
        })),
      getCapabilities:
        overrides.teammates?.getCapabilities ?? (() => ({ verbs: [], agent_runtimes: [] })),
    },
    workflows: {
      run: overrides.workflows?.run ?? (async () => ({ run_id: 'harness-run-1' })),
      status: overrides.workflows?.status ?? (async () => ({})),
      stop: overrides.workflows?.stop ?? (async () => ({})),
      list: overrides.workflows?.list ?? (async () => ({})),
    },
    get scheduler() {
      return fakeSchedulerCommands(overrides.scheduler);
    },
  };
  return fake as unknown as DispatcherService;
}

function fakeSchedulerCommands(overrides: FakeDispatcherOverrides['scheduler']) {
  return {
    list: overrides?.list ?? (async () => ({ jobs: [] })),
    create: overrides?.create ?? (async () => ({})),
    update: overrides?.update ?? (async () => ({})),
    delete: overrides?.delete ?? (async (id: string) => ({ id, deleted: true })),
  };
}

export interface HarnessOptions {
  dispatcherOverrides?: FakeDispatcherOverrides;
  dispatcherRow?: DispatcherRow | null;
  /** Override `host.summarize()`, used by `server.status` and `dispatcher.list`. */
  summarize?: () => Promise<DispatcherSummary[]>;
  dispatcherRuntimeStatus?: () => Promise<DispatcherRuntimeStatus>;
}

export interface CommandHarness {
  readonly host: CoreCommandHost;
  readonly registry: CoreCommands;
  readonly port: CoreCommandPort;
  readonly dispatcher: DispatcherService;
  readonly mcpLeases: McpLeaseRegistry;
  /** Every call `host.dispatcher(id)` made, for tests that assert a call count. */
  readonly dispatcherLookups: string[];
}

/** Build one full harness: host, registry, and the admitted port, wired together exactly as `Server` wires them. */
export function createCommandHarness(options: HarnessOptions = {}): CommandHarness {
  const dispatcher = createFakeDispatcher(options.dispatcherOverrides);
  const dispatcherLookups: string[] = [];
  const mcpLeases = new McpLeaseRegistry();
  const row =
    options.dispatcherRow === undefined ? harnessDispatcherRow() : options.dispatcherRow;
  const host: CoreCommandHost = {
    summarize: options.summarize ?? (async () => []),
    dispatcherRow: (id: string) => (id === row?.dispatcher_id ? row : null),
    dispatcherRuntimeStatus:
      options.dispatcherRuntimeStatus ??
      (async () => ({ status: 'running', threadId: null, lastError: null })),
    dispatcher: (id: string) => {
      dispatcherLookups.push(id);
      return dispatcher;
    },
    mcpLeases,
  };
  const registry = createCoreCommandRegistry(host);
  const port = new CoreCommandPort(registry);
  return { host, registry, port, dispatcher, mcpLeases, dispatcherLookups };
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
  return { source: 'channel', dispatcher_id: dispatcherId, channel_id: channelId };
}

/** A no-op `ChannelEventSource`: the Command half of the port is under test, never the event half. */
export function fakeChannelEventSource(): ChannelEventSource {
  return {
    subscribe: () => ({ unsubscribe: () => {} }),
  } as unknown as ChannelEventSource;
}

/** Build the in-process Channel invoke adapter over a harness's admitted port. */
export function createHarnessChannelInvoker(
  harness: CommandHarness,
  dispatcherId: string = HARNESS_DISPATCHER_ID,
  channelId: string = HARNESS_CHANNEL_ID,
) {
  return createChannelCorePort({
    registry: harness.port,
    dispatcherId,
    channelId,
    events: fakeChannelEventSource(),
  });
}

export interface HarnessAdminSocket {
  readonly socketPath: string;
  readonly server: AdminSocketServer;
  send(method: string, params?: Record<string, unknown>): Promise<AdminResponse>;
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
  const fakeServer = { commands: harness.port } as unknown as Server;
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
    return sendRaw(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
  }

  return {
    socketPath,
    server,
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
      identity: { name: options.name ?? 'harness-mcp-server', version: '1.0.0' },
      tools: [{ name: toolName, inputSchema: { type: 'object' } }],
    }),
    call:
      options.call ??
      (async (call) => ({ ok: true, structured: { echoed: call.arguments } })),
  };
  const lease = { isCurrent: options.isCurrent ?? (() => true) } as unknown as Parameters<
    McpLeaseRegistry['mint']
  >[0];
  const minted = mcpLeases.mint(lease, delegate);
  if (minted === null) {
    throw new Error('harness MCP delegate advertised no tools; mint returned null');
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
