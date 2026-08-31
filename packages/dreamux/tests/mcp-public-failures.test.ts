/**
 * What a caller reads when a tool call does not succeed (node: core-command-registry).
 *
 * The contract under test has one rule with two halves. A failure whose own
 * author wrote both its reason and its next step — a {@link StatedFailure} — is
 * repeated verbatim, code first. Every other thrown value keeps the code it
 * already had, or `INTERNAL` when it had none, and the message it already had:
 * Core does not own those words and does not replace them, so the most specific
 * fact anybody has survives to the caller while the stack stays in the log.
 * Nothing is suppressed: there is no failure a caller is simply not told about,
 * and no list anywhere of which failures may be shown.
 *
 * Everything here is behavioral. Tools are driven through the real admission
 * boundary — and, where what a model actually reads is the point, through the
 * real stdio shim over a real `admin.sock`. The tables below are test fixtures
 * naming which call to make; production keeps no such table.
 */
import { describe, expect, it } from 'vitest';

import type { CoreCommandContext, DreamuxLogger } from '@excitedjs/dreamux-types';

import { runDreamuxMcp } from '../src/mcp/shim.js';
import { McpLeaseRegistry } from '../src/service/mcp/leases.js';
import type {
  McpDelegateResult,
  McpServerDelegate,
} from '../src/service/mcp/types.js';
import { StatedFailure, ValidationError } from '../src/platform/errors.js';
import { createTeamMcpDelegate } from '../src/service/team-collection/mcp-delegate.js';
import { createTeamMateMcpDelegate } from '../src/service/teammate-collection/mcp-delegate.js';
import { createCronMcpDelegate } from '../src/service/scheduler/mcp-delegate.js';
import {
  TeamClosedError,
  TeamNotFoundError,
} from '../src/service/team-collection/errors.js';
import { TeamMateNotFoundError } from '../src/service/teammate-collection/errors.js';
import { CronJobNotFoundError } from '../src/service/scheduler/errors.js';
import { WorkflowRunNotFoundError } from '../src/service/workflow-service/errors.js';
import { DispatcherNotFoundError } from '../src/service/dispatchers/errors.js';
import { callTool, connectMcpClient } from './helpers/mcp-client.js';
import {
  HARNESS_DISPATCHER_ID,
  capturingLogger,
  createCommandHarness,
  createFakeDispatcher,
  createHarnessChannelInvoker,
  startHarnessAdminSocket,
  type CapturedLog,
  type CommandHarness,
  type FakeDispatcherOverrides,
} from './helpers/command-harness.js';
import { teamSubmitResult } from '../src/service/team-service/types.js';
import { toSubmissionResult } from '../src/service/teammate-service/turn-recording.js';
import { AgentActivityReadError } from '../src/service/agent-entity/activity-reader.js';
import { ACTIVITY_PUBLIC_ERRORS } from '../src/service/agent-entity/activity-errors.js';

/**
 * An `AgentRuntimeGenerationLease`-shaped fake: every registry path used here
 * reads only `isCurrent()` (same narrow shape as mcp-lease-shim.test.ts).
 */
function fakeLease() {
  return { isCurrent: () => true } as unknown as Parameters<
    McpLeaseRegistry['mint']
  >[0];
}

function adminContext(): CoreCommandContext {
  return { source: 'admin_socket', dispatcher_id: HARNESS_DISPATCHER_ID };
}

/** The text a model actually read back from one tool call. */
function toolText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { text?: string }[];
  return content.map((entry) => entry.text ?? '').join('');
}

/** Run one tool through the real shim over a real admin socket. */
async function throughTheShim(
  harness: CommandHarness,
  delegate: McpServerDelegate,
  call: { name: string; arguments: Record<string, unknown> },
): Promise<{ text: string; isError: boolean; structured: unknown }> {
  const admin = await startHarnessAdminSocket(harness);
  try {
    const minted = harness.mcpLeases.mint(fakeLease(), delegate);
    if (minted === null) throw new Error('the delegate advertised no tools');
    const connection = await connectMcpClient((transport) =>
      runDreamuxMcp({
        lease: minted.token,
        adminSocketPath: admin.socketPath,
        transport,
        log: () => {},
      }),
    );
    try {
      const result = await callTool(connection.client, call.name, call.arguments);
      return {
        text: toolText(result),
        isError: result.isError === true,
        structured: result.structuredContent,
      };
    } finally {
      await connection.close();
    }
  } finally {
    await admin.close();
  }
}

/**
 * Reach one delegate the only way anything reaches a delegate: through the
 * lease registry, which is also where a failure becomes an answer.
 */
async function throughTheRegistry(
  delegate: McpServerDelegate,
  name: string,
  args: Record<string, unknown> = {},
  log?: DreamuxLogger,
): Promise<McpDelegateResult> {
  const registry = new McpLeaseRegistry(log);
  const minted = registry.mint(fakeLease(), delegate);
  if (minted === null) throw new Error('the delegate advertised no tools');
  return registry.invoke(minted.token, { name, arguments: args });
}

function teamDelegate(overrides: FakeDispatcherOverrides): McpServerDelegate {
  return createTeamMcpDelegate({
    dispatcher: createFakeDispatcher(overrides),
    caller: { kind: 'dispatcher' },
  });
}

function teammateDelegate(overrides: FakeDispatcherOverrides): McpServerDelegate {
  return createTeamMateMcpDelegate({
    kind: 'dispatcher',
    dispatcher: createFakeDispatcher(overrides),
  });
}

function cronDelegate(overrides: FakeDispatcherOverrides): McpServerDelegate {
  const dispatcher = createFakeDispatcher(overrides);
  return createCronMcpDelegate({
    scheduler: async () => dispatcher.scheduler,
  });
}

/** One value as its wire carries it. */
function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

function refusalMessage(result: McpDelegateResult): string {
  expect(result.ok, 'expected a settled failure, got a success').toBe(false);
  return result.ok ? '' : result.message;
}

/** The one shape a failure Core does not own takes: its code, then its words. */
const UNCLASSIFIED = /^INTERNAL: /;

// ---------------------------------------------------------------------------
// A failure that stated itself: read verbatim, all the way to the model.
// ---------------------------------------------------------------------------

describe('a failure that stated itself reaches the model as its code, its reason, and its next step', () => {
  it('team.status on a Team that does not exist: the model reads the fact and the way out', async () => {
    const raised = 'Team "ghost-a1b2" does not exist';
    const harness = createCommandHarness();
    const result = await throughTheShim(
      harness,
      teamDelegate({
        getTeamStatus: async () => {
          throw new TeamNotFoundError(raised);
        },
      }),
      { name: 'status', arguments: { team_name: 'ghost-a1b2' } },
    );

    expect(result.isError).toBe(true);
    // Three promises to a model, in one sentence: the stable code, the concrete
    // reason, and something to do next.
    expect(result.text.startsWith('TEAM_NOT_FOUND: ')).toBe(true);
    expect(result.text).toContain(raised);
    expect(result.text).toContain(new TeamNotFoundError(raised).action);
    // Nothing about the server, and no invitation to go read a log.
    expect(result.text).not.toContain('server logs');
    expect(result.text).not.toMatch(UNCLASSIFIED);
  });

  it('the reason and the action come from the failure itself, not from the renderer', async () => {
    const raised = new TeamClosedError('Team "blue-1a2b" is closed');
    const result = await throughTheRegistry(
      teamDelegate({
        submitToTeamLeader: async () => {
          throw raised;
        },
      }),
      'send',
      { team_name: 'blue-1a2b', prompt: 'go' },
    );
    const message = refusalMessage(result);
    expect(message).toBe(`${raised.code}: ${raised.message}. ${raised.action}`);
  });

  it('every stated failure a domain raises carries both halves it promises', () => {
    const stated: StatedFailure[] = [
      new TeamNotFoundError('gone'),
      new TeamClosedError('over'),
      new TeamMateNotFoundError('gone'),
      new CronJobNotFoundError('gone'),
      new WorkflowRunNotFoundError('gone'),
      new DispatcherNotFoundError('d-9'),
      new ValidationError("param 'name' must be a non-empty string"),
    ];
    for (const failure of stated) {
      expect(failure.code, `${failure.name} has no code`).toBeTruthy();
      expect(failure.message, `${failure.name} has no reason`).toBeTruthy();
      expect(failure.action, `${failure.name} has no action`).toBeTruthy();
      // An action tells a caller what to do; it is never a restatement of the
      // reason, and never a pointer at the server's log.
      expect(failure.action).not.toBe(failure.message);
      expect(failure.action.toLowerCase()).not.toContain('server log');
    }
  });
});

// ---------------------------------------------------------------------------
// A failure Core does not own: answered with the words it already had.
// ---------------------------------------------------------------------------

describe('a failure Core does not own reaches the caller with its own message', () => {
  const NATIVE_MESSAGE =
    'ENOENT: no such file or directory, open /Users/ops/.dreamux/state/team/blue/record.json';

  const native = () => {
    const error = new Error(NATIVE_MESSAGE);
    error.stack = `${error.message}\n    at TeamStore.read (/Users/ops/dreamux/src/store.ts:12:9)`;
    return error;
  };

  it('reports it as INTERNAL carrying the message the failure already had', async () => {
    const result = await throughTheRegistry(
      teamDelegate({
        getTeamStatus: async () => {
          throw native();
        },
      }),
      'status',
      { team_name: 'blue-1a2b' },
    );
    expect(refusalMessage(result)).toBe(`INTERNAL: ${NATIVE_MESSAGE}`);
  });

  it('does not re-author the message, and states no next step it did not know', async () => {
    const message = refusalMessage(
      await throughTheRegistry(
        teammateDelegate({
          teammates: {
            spawn: async () => {
              throw native();
            },
          },
        }),
        'spawn',
        { name_prefix: 'mate', prompt: 'go', intent: 'do the thing' },
      ),
    );
    // The native fact survives whole: Core owns neither the reason nor a
    // recovery it would have to invent to say anything more.
    expect(message).toContain('ENOENT');
    expect(message).toContain('/Users/ops/.dreamux/state/team/blue/record.json');
    expect(message).not.toContain('Whether this call took effect is unknown');
    expect(message).not.toMatch(/failure id/i);
  });

  it('keeps the stack out of the answer and in the log', async () => {
    const logs: CapturedLog[] = [];
    const result = await throughTheRegistry(
      teamDelegate({
        getTeamStatus: async () => {
          throw native();
        },
      }),
      'status',
      { team_name: 'blue-1a2b' },
      capturingLogger(logs),
    );
    expect(refusalMessage(result)).not.toContain('at TeamStore.read');
    expect(logs).toHaveLength(1);
    const record = logs[0]!;
    expect(record.fields['server']).toBe('team');
    expect(record.fields['tool']).toBe('status');
    expect(record.fields).not.toHaveProperty('failure_id');
    const err = record.fields['err'] as { message: string; stack?: string };
    expect(err.message).toBe(NATIVE_MESSAGE);
    expect(err.stack).toContain('at TeamStore.read');
  });

  it('does not log a failure its own domain already stated', async () => {
    const logs: CapturedLog[] = [];
    await throughTheRegistry(
      teamDelegate({
        getTeamStatus: async () => {
          throw new TeamNotFoundError('Team "ghost-a1b2" does not exist');
        },
      }),
      'status',
      { team_name: 'ghost-a1b2' },
      capturingLogger(logs),
    );
    expect(logs).toHaveLength(0);
  });

  it('reaches the model that way too, through the real shim', async () => {
    const harness = createCommandHarness();
    const result = await throughTheShim(
      harness,
      teamDelegate({
        getTeamStatus: async () => {
          throw native();
        },
      }),
      { name: 'status', arguments: { team_name: 'blue-1a2b' } },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toBe(`INTERNAL: ${NATIVE_MESSAGE}`);
  });
});

// ---------------------------------------------------------------------------
// Every advertised tool, both kinds of failure. Driven off the live catalogs.
// ---------------------------------------------------------------------------

describe('every advertised tool answers both kinds of failure the same way', () => {
  /** Every owning-object entry point, poisoned with one thrown value. */
  function poisonedWith(raise: () => never): FakeDispatcherOverrides {
    const fn = async () => raise();
    return {
      createTeam: fn,
      listTeams: fn,
      getTeamStatus: fn,
      getTeamHistory: fn,
      submitToTeamLeader: fn,
      dissolveTeam: fn,
      teammates: {
        spawn: fn,
        send: fn,
        close: fn,
        history: fn,
        list: fn,
        status: fn,
        last: fn,
        getCapabilities: () => raise(),
      },
      workflows: { run: fn, status: fn, stop: fn, list: fn },
      scheduler: { list: fn, create: fn, update: fn, delete: fn },
    };
  }

  /** Arguments good enough to pass each tool's own input reading. */
  const ARGS: Readonly<Record<string, Record<string, unknown>>> = {
    create: { name_prefix: 'blue', intent: 'ship it', leader_agent_runtime: 'r1' },
    send: { team_name: 'blue-1a2b', prompt: 'go', name: 'mate-9z' },
    status: { team_name: 'blue-1a2b', name: 'mate-9z' },
    history: {},
    list: {},
    dissolve: { team_name: 'blue-1a2b', note: 'done' },
    spawn: { name_prefix: 'mate', prompt: 'go', intent: 'do the thing' },
    close: { name: 'mate-9z', note: 'done' },
    last: { name: 'mate-9z' },
    get_capabilities: {},
    workflow_run: { script: 'export const meta = {}' },
    workflow_status: { run_id: 'run-1' },
    workflow_stop: { run_id: 'run-1' },
    workflow_list: {},
    cron_create: { cron: '17 3 * * *', prompt: 'sweep' },
    cron_update: { id: 'job-1' },
    cron_list: {},
    cron_delete: { id: 'job-1' },
  };

  const servers: {
    server: string;
    build: (overrides: FakeDispatcherOverrides) => McpServerDelegate;
  }[] = [
    { server: 'team', build: teamDelegate },
    { server: 'teammate', build: teammateDelegate },
    { server: 'cron', build: cronDelegate },
  ];

  for (const { server, build } of servers) {
    it(`${server}: a stated failure keeps its own code on every tool it advertises`, async () => {
      const stated = poisonedWith(() => {
        throw new ValidationError("param 'anything' is wrong");
      });
      const delegate = build(stated);
      const tools = delegate.describe().tools as ReadonlyArray<{ name: string }>;
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        const message = refusalMessage(
          await throughTheRegistry(build(stated), tool.name, ARGS[tool.name] ?? {}),
        );
        expect(message, `tool '${tool.name}'`).toMatch(/^BAD_REQUEST: /);
        expect(message, `tool '${tool.name}'`).not.toMatch(UNCLASSIFIED);
      }
    });

    it(`${server}: an unstated failure keeps its own words on every tool it advertises`, async () => {
      const unstated = poisonedWith(() => {
        throw new TypeError('cannot read properties of undefined (reading nope)');
      });
      const delegate = build(unstated);
      const tools = delegate.describe().tools as ReadonlyArray<{ name: string }>;
      for (const tool of tools) {
        const message = refusalMessage(
          await throughTheRegistry(build(unstated), tool.name, ARGS[tool.name] ?? {}),
        );
        expect(message, `tool '${tool.name}'`).toBe(
          'INTERNAL: cannot read properties of undefined (reading nope)',
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The boundary answers for the delegate, not only for the domain behind it.
// ---------------------------------------------------------------------------

describe('the admission boundary answers everything, including what never reached a delegate', () => {
  it('a refusal with nothing in it fails the Command instead of settling it', async () => {
    // A Channel provider states its own refusals; one that says nothing has
    // published neither shape, so `mcp.toolcall` refuses to report it as an
    // answer at all rather than hand a caller an empty settlement.
    const silent: McpServerDelegate = {
      name: 'channel-x',
      describe: () => ({
        identity: { name: 'dreamux-channel-x', version: '0.1.0' },
        tools: [
          {
            name: 'post',
            description: 'post a message',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      }),
      call: async () => ({ ok: false, message: '   ' }),
    };
    const harness = createCommandHarness();
    const minted = harness.mcpLeases.mint(fakeLease(), silent)!;
    await expect(
      harness.registry.invoke(adminContext(), 'mcp.toolcall', {
        token: minted.token,
        name: 'post',
        arguments: {},
      } as never),
    ).rejects.toThrow(/refused the call without stating a reason/);
  });

  it('a success with no object value fails the Command too', async () => {
    const shapeless: McpServerDelegate = {
      name: 'channel-x',
      describe: () => ({
        identity: { name: 'dreamux-channel-x', version: '0.1.0' },
        tools: [
          {
            name: 'post',
            description: 'post a message',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      }),
      call: async () => ({ ok: true, structured: 'not an object' }) as never,
    };
    const harness = createCommandHarness();
    const minted = harness.mcpLeases.mint(fakeLease(), shapeless)!;
    await expect(
      harness.registry.invoke(adminContext(), 'mcp.toolcall', {
        token: minted.token,
        name: 'post',
        arguments: {},
      } as never),
    ).rejects.toThrow(/success without an object value/);
  });

  it("a provider's own non-empty refusal is passed through as the Channel wrote it", async () => {
    const provider: McpServerDelegate = {
      name: 'channel-x',
      describe: () => ({
        identity: { name: 'dreamux-channel-x', version: '0.1.0' },
        tools: [
          {
            name: 'post',
            description: 'post a message',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      }),
      call: async () => ({
        ok: false,
        message: 'this chat no longer accepts posts from this bot',
      }),
    };
    const message = refusalMessage(await throughTheRegistry(provider, 'post'));
    expect(message).toBe('this chat no longer accepts posts from this bot');
  });

  it('a revoked lease is a stated fact, before any delegate is entered', async () => {
    let entered = 0;
    const delegate = teamDelegate({
      listTeams: async () => {
        entered += 1;
        return [];
      },
    });
    const registry = new McpLeaseRegistry();
    const minted = registry.mint(fakeLease(), delegate)!;
    registry.release([minted.token]);
    const result = await registry.invoke(minted.token, {
      name: 'list',
      arguments: {},
    });
    expect(refusalMessage(result)).toMatch(/^MCP_LEASE_REVOKED: /);
    expect(entered).toBe(0);
  });

  it('a tool outside the frozen catalog is refused by name, without entering the delegate', async () => {
    let entered = 0;
    const delegate = teamDelegate({
      listTeams: async () => {
        entered += 1;
        return [];
      },
    });
    const message = refusalMessage(
      await throughTheRegistry(delegate, 'not_a_tool'),
    );
    expect(message).toContain("Tool 'not_a_tool' is not available");
    // The catalog it was offered is named back, so the model can pick again.
    expect(message).toContain('list');
    expect(entered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The other adapter: the same failure, over the socket and in process.
// ---------------------------------------------------------------------------

describe('a stated failure carries the same code, reason, and action over the admin socket', () => {
  it('the wire carries the action beside the code and the reason', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: {
        getTeamStatus: async () => {
          throw new TeamNotFoundError('Team "ghost" does not exist');
        },
      },
    });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const response = await admin.send('team.status', {
        dispatcher_id: HARNESS_DISPATCHER_ID,
        team_name: 'ghost',
      });
      expect(response.ok).toBe(false);
      const error = (response as { error: Record<string, unknown> }).error;
      expect(error['code']).toBe('TEAM_NOT_FOUND');
      expect(error['message']).toBe('Team "ghost" does not exist');
      expect(error['action']).toBe(new TeamNotFoundError('x').action);
    } finally {
      await admin.close();
    }
  });

  it('the in-process rejection carries the same three parts, because it is the same object', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: {
        getTeamStatus: async () => {
          throw new TeamNotFoundError('Team "ghost" does not exist');
        },
      },
    });
    await expect(
      harness.port.invoke(adminContext(), 'team.status', {
        team_name: 'ghost',
      } as never),
    ).rejects.toMatchObject({
      code: 'TEAM_NOT_FOUND',
      message: 'Team "ghost" does not exist',
      action: new TeamNotFoundError('x').action,
    });
  });

  it('an unclassified Command failure crosses the wire as INTERNAL with its own message', async () => {
    const raw = 'boom at /Users/ops/.dreamux/state/team/blue/record.json';
    const harness = createCommandHarness({
      dispatcherOverrides: {
        getTeamStatus: async () => {
          throw new Error(raw);
        },
      },
    });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const response = await admin.send('team.status', {
        dispatcher_id: HARNESS_DISPATCHER_ID,
        team_name: 'blue-1a2b',
      });
      expect(response.ok).toBe(false);
      const error = (response as { error: Record<string, unknown> }).error;
      expect(error['code']).toBe('INTERNAL');
      expect(error['message']).toBe(raw);
      // Core never wrote a next step for a failure it does not own.
      expect(error['action']).toBeUndefined();

      const record = admin.logs.find(
        (entry) => entry.fields['method'] === 'team.status',
      );
      expect(record, 'the failure was not logged').toBeDefined();
      expect(record!.fields).not.toHaveProperty('failure_id');
      const err = record!.fields['err'] as { message: string; stack?: string };
      expect(err.message).toBe(raw);
      expect(typeof err.stack).toBe('string');
    } finally {
      await admin.close();
    }
  });

  it('a rejected invocation the shim never got an answer for is normalized there too', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const delegate = teamDelegate({});
      const minted = harness.mcpLeases.mint(fakeLease(), delegate)!;
      const connection = await connectMcpClient((transport) =>
        runDreamuxMcp({
          lease: minted.token,
          adminSocketPath: admin.socketPath,
          transport,
          log: () => {},
        }),
      );
      try {
        // The lease is revoked underneath the running shim: the Command still
        // answers, and what the model reads is the stated fact.
        harness.mcpLeases.release([minted.token]);
        const result = await callTool(connection.client, 'list', {});
        expect(result.isError).toBe(true);
        expect(toolText(result)).toMatch(/^MCP_LEASE_REVOKED: /);
      } finally {
        await connection.close();
      }
    } finally {
      await admin.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Two adapters, one operation: the values they publish must not drift.
// ---------------------------------------------------------------------------

describe('the Command surface and the MCP delegate are two adapters over one operation', () => {
  interface ParityCase {
    operation: string;
    overrides: FakeDispatcherOverrides;
    command: { name: string; params: Record<string, unknown> };
    tool: { delegate: 'team' | 'teammate' | 'cron'; name: string; args: Record<string, unknown> };
    /**
     * What the owning object actually answered, in public form. Both surfaces
     * are checked against it rather than only against each other: two adapters
     * that agree on a value neither owner produced would still be wrong.
     */
    expected: unknown;
  }

  const teamSummary = {
    team: { team_name: 'blue-1a2b', status: 'running' },
    leader: { name: 'blue-1a2b-leader', status: 'running' },
    member_count: 2,
  };
  const historyPage = {
    items: [{ team_name: 'blue-1a2b', status: 'closed' }],
    next_cursor: 'c-2',
  };
  const teammateRow = { name: 'mate-9z', status: 'running' };
  const cronJob = {
    id: 'job-1',
    dispatcher_id: HARNESS_DISPATCHER_ID,
    title: 'nightly',
    cron: '17 3 * * *',
    tz: 'UTC',
    recurring: true,
    action: { kind: 'prompt-agent', prompt: 'sweep' },
    enabled: true,
    created_at: 1,
    updated_at: 2,
    next_run_at: 3,
    last_fired_at: null,
  };

  const cases: ParityCase[] = [
    {
      operation: 'team.status',
      overrides: { getTeamStatus: async () => teamSummary },
      command: { name: 'team.status', params: { team_name: 'blue-1a2b' } },
      tool: { delegate: 'team', name: 'status', args: { team_name: 'blue-1a2b' } },
      expected: teamSummary,
    },
    {
      operation: 'team.history',
      overrides: { getTeamHistory: async () => historyPage },
      command: { name: 'team.history', params: { status: 'closed', limit: 10 } },
      tool: {
        delegate: 'team',
        name: 'history',
        args: { status: 'closed', limit: 10 },
      },
      expected: historyPage,
    },
    {
      operation: 'team.list',
      overrides: { listTeams: async () => [{ team_name: 'blue-1a2b' }] },
      command: { name: 'team.list', params: {} },
      tool: { delegate: 'team', name: 'list', args: {} },
      expected: { teams: [{ team_name: 'blue-1a2b' }] },
    },
    {
      operation: 'teammate.status',
      overrides: { teammates: { status: async () => teammateRow } },
      command: { name: 'teammate.status', params: { name: 'mate-9z' } },
      tool: { delegate: 'teammate', name: 'status', args: { name: 'mate-9z' } },
      expected: { teammate: teammateRow },
    },
    {
      operation: 'teammate.list',
      overrides: { teammates: { list: async () => [teammateRow] } },
      command: { name: 'teammate.list', params: {} },
      tool: { delegate: 'teammate', name: 'list', args: {} },
      expected: { teammates: [teammateRow] },
    },
    {
      operation: 'teammate.history',
      overrides: {
        teammates: {
          history: async () => ({ items: [teammateRow], next_cursor: null }),
        },
      },
      command: { name: 'teammate.history', params: { status: 'closed' } },
      tool: { delegate: 'teammate', name: 'history', args: { status: 'closed' } },
      expected: { items: [teammateRow], next_cursor: null },
    },
    {
      operation: 'teammate.last',
      overrides: {
        teammates: {
          last: async () => ({
            teammate: teammateRow,
            requested_records: 5,
            returned_records: 1,
            records: [{ kind: 'assistant_message', text: 'hi', occurred_at: null }],
            next_cursor: null,
            truncated: false,
          }),
        },
      },
      command: { name: 'teammate.last', params: { name: 'mate-9z', limit: 5 } },
      tool: {
        delegate: 'teammate',
        name: 'last',
        args: { name: 'mate-9z', limit: 5 },
      },
      expected: {
        teammate: teammateRow,
        requested_records: 5,
        returned_records: 1,
        records: [{ kind: 'assistant_message', text: 'hi', occurred_at: null }],
        next_cursor: null,
        truncated: false,
      },
    },
    {
      operation: 'teammate.capabilities',
      overrides: {
        teammates: {
          getCapabilities: () => ({
            verbs: ['spawn'],
            agent_runtimes: [{ id: 'r1' }],
          }),
        },
      },
      command: { name: 'teammate.capabilities', params: {} },
      tool: { delegate: 'teammate', name: 'get_capabilities', args: {} },
      expected: { verbs: ['spawn'], agent_runtimes: [{ id: 'r1' }] },
    },
    {
      operation: 'cron.list',
      overrides: { scheduler: { list: async () => ({ jobs: [cronJob] }) } },
      command: { name: 'scheduler.cron.list', params: {} },
      tool: { delegate: 'cron', name: 'cron_list', args: {} },
      expected: { jobs: [cronJob] },
    },
    {
      operation: 'cron.create',
      overrides: { scheduler: { create: async () => cronJob } },
      command: {
        name: 'scheduler.cron.create',
        params: { cron: '17 3 * * *', prompt: 'sweep' },
      },
      tool: {
        delegate: 'cron',
        name: 'cron_create',
        args: { cron: '17 3 * * *', prompt: 'sweep' },
      },
      expected: cronJob,
    },
    {
      operation: 'cron.delete',
      overrides: { scheduler: { delete: async (id: string) => ({ id, deleted: true }) } },
      command: { name: 'scheduler.cron.delete', params: { id: 'job-1' } },
      tool: { delegate: 'cron', name: 'cron_delete', args: { id: 'job-1' } },
      expected: { id: 'job-1', deleted: true },
    },
  ];

  function delegateFor(entry: {
    tool: { delegate: 'team' | 'teammate' | 'cron' };
    overrides: FakeDispatcherOverrides;
  }): McpServerDelegate {
    if (entry.tool.delegate === 'team') return teamDelegate(entry.overrides);
    if (entry.tool.delegate === 'teammate') return teammateDelegate(entry.overrides);
    return cronDelegate(entry.overrides);
  }

  for (const entry of cases) {
    it(`${entry.operation}: both surfaces answer the same owning object with the same value`, async () => {
      const harness = createCommandHarness({ dispatcherOverrides: entry.overrides });
      const viaCommand = await harness.registry.invoke(
        adminContext(),
        entry.command.name,
        entry.command.params as never,
      );
      const viaTool = await throughTheRegistry(
        delegateFor(entry),
        entry.tool.name,
        entry.tool.args,
      );
      expect(viaTool.ok).toBe(true);
      // Compared through JSON, because that is what both wires carry: the
      // admin socket writes it and `mcp.toolcall` canonicalizes it.
      const toolValue = json(viaTool.ok ? viaTool.structured : null);
      const commandValue = json(viaCommand);
      expect(toolValue).toEqual(commandValue);
      // …and both carry what the owning object answered, so two adapters that
      // agreed on a value neither owner produced would still fail here.
      expect(toolValue).toEqual(json(entry.expected));
    });
  }

  const failureCases: {
    operation: string;
    overrides: FakeDispatcherOverrides;
    command: { name: string; params: Record<string, unknown> };
    tool: { delegate: 'team' | 'teammate' | 'cron'; name: string; args: Record<string, unknown> };
    raised: StatedFailure;
  }[] = [
    {
      operation: 'team.status',
      overrides: {
        getTeamStatus: async () => {
          throw new TeamNotFoundError('Team "ghost" does not exist');
        },
      },
      command: { name: 'team.status', params: { team_name: 'ghost' } },
      tool: { delegate: 'team', name: 'status', args: { team_name: 'ghost' } },
      raised: new TeamNotFoundError('Team "ghost" does not exist'),
    },
    {
      operation: 'teammate.submit',
      overrides: {
        teammates: {
          send: async () => {
            throw new TeamMateNotFoundError('TeamMate "ghost" does not exist');
          },
        },
      },
      command: { name: 'teammate.submit', params: { name: 'ghost', prompt: 'go' } },
      tool: {
        delegate: 'teammate',
        name: 'send',
        args: { name: 'ghost', prompt: 'go' },
      },
      raised: new TeamMateNotFoundError('TeamMate "ghost" does not exist'),
    },
    {
      operation: 'cron.update',
      overrides: {
        scheduler: {
          update: async () => {
            throw new CronJobNotFoundError("cron job 'gone' does not exist");
          },
        },
      },
      command: { name: 'scheduler.cron.update', params: { id: 'gone' } },
      tool: { delegate: 'cron', name: 'cron_update', args: { id: 'gone' } },
      raised: new CronJobNotFoundError("cron job 'gone' does not exist"),
    },
    {
      operation: 'workflow.status',
      overrides: {
        workflows: {
          status: async () => {
            throw new WorkflowRunNotFoundError("workflow run 'gone' does not exist");
          },
        },
      },
      command: { name: 'workflow.status', params: { run_id: 'gone' } },
      tool: {
        delegate: 'teammate',
        name: 'workflow_status',
        args: { run_id: 'gone' },
      },
      raised: new WorkflowRunNotFoundError("workflow run 'gone' does not exist"),
    },
  ];

  for (const entry of failureCases) {
    it(`${entry.operation}: the same code, reason, and action reach a scripted caller and a model`, async () => {
      const harness = createCommandHarness({ dispatcherOverrides: entry.overrides });
      await expect(
        harness.registry.invoke(
          adminContext(),
          entry.command.name,
          entry.command.params as never,
        ),
      ).rejects.toMatchObject({
        code: entry.raised.code,
        message: entry.raised.message,
        action: entry.raised.action,
      });

      const viaTool = await throughTheRegistry(
        delegateFor(entry),
        entry.tool.name,
        entry.tool.args,
      );
      expect(refusalMessage(viaTool)).toBe(
        `${entry.raised.code}: ${entry.raised.message}. ${entry.raised.action}`,
      );
    });
  }

  it('a name neither surface accepts fails as the same caller mistake on both', async () => {
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke(adminContext(), 'teammate.status', {
        name: 'not a legal name',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const viaTool = await throughTheRegistry(teammateDelegate({}), 'status', {
      name: 'not a legal name',
    });
    expect(refusalMessage(viaTool).startsWith('BAD_REQUEST: ')).toBe(true);
  });

  it('an unusable history page is the caller`s mistake on both, stating the rule', async () => {
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke(adminContext(), 'teammate.history', {
        limit: 0,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const viaTool = refusalMessage(
      await throughTheRegistry(teammateDelegate({}), 'history', { limit: 0 }),
    );
    expect(viaTool.startsWith('BAD_REQUEST: ')).toBe(true);
    expect(viaTool).toContain('positive integer');
  });

  it('a history cursor nothing here issued is refused as the caller`s, not normalized', async () => {
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke(adminContext(), 'teammate.history', {
        cursor: 'not-a-cursor',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const viaTool = refusalMessage(
      await throughTheRegistry(teammateDelegate({}), 'history', {
        cursor: 'not-a-cursor',
      }),
    );
    expect(viaTool.startsWith('BAD_REQUEST: ')).toBe(true);
    expect(viaTool).not.toMatch(UNCLASSIFIED);
  });

  it('a cron owner the Team could never have is the caller`s mistake, not a server one', async () => {
    // `team_id` selects the scheduler's owner and only the Command surface
    // carries it: the MCP delegate is already bound to one owner, so the model
    // cannot name a Team at all. The field is still read through the Team's own
    // name codec, so an impossible owner is rejected here rather than surfacing
    // as INTERNAL from the lookup it would otherwise reach.
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke(adminContext(), 'scheduler.cron.list', {
        team_id: 'not a legal team',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ---------------------------------------------------------------------------
// The same failure, whichever boundary a caller is standing at.
// ---------------------------------------------------------------------------

describe('the admin socket and the in-process Channel port answer the same way', () => {
  const NATIVE = 'EACCES: permission denied, open /Users/ops/.dreamux/state/x';

  it('a stated failure keeps its code, reason, and action on both', async () => {
    const raised = 'Team "ghost-a1b2" does not exist';
    const overrides: FakeDispatcherOverrides = {
      getTeamStatus: async () => {
        throw new TeamNotFoundError(raised);
      },
    };
    const expected = {
      code: 'TEAM_NOT_FOUND',
      message: raised,
      action: new TeamNotFoundError(raised).action,
    };

    const harness = createCommandHarness({ dispatcherOverrides: overrides });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const response = await admin.send('team.status', {
        dispatcher_id: HARNESS_DISPATCHER_ID,
        team_name: 'ghost-a1b2',
      });
      expect((response as { error: unknown }).error).toEqual(expected);
    } finally {
      await admin.close();
    }

    const lease = createHarnessChannelInvoker(
      createCommandHarness({ dispatcherOverrides: overrides }),
    );
    await expect(
      lease.port.invoke.invoke('team.status', { team_name: 'ghost-a1b2' } as never),
    ).rejects.toMatchObject(expected);
  });

  it('a failure Core does not own keeps its own message on both, under INTERNAL', async () => {
    const overrides: FakeDispatcherOverrides = {
      getTeamStatus: async () => {
        throw new Error(NATIVE);
      },
    };

    const harness = createCommandHarness({ dispatcherOverrides: overrides });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const response = await admin.send('team.status', {
        dispatcher_id: HARNESS_DISPATCHER_ID,
        team_name: 'blue-1a2b',
      });
      expect((response as { error: unknown }).error).toEqual({
        code: 'INTERNAL',
        message: NATIVE,
      });
    } finally {
      await admin.close();
    }

    const logs: CapturedLog[] = [];
    const lease = createHarnessChannelInvoker(
      createCommandHarness({ dispatcherOverrides: overrides }),
      HARNESS_DISPATCHER_ID,
      undefined,
      logs,
    );
    await expect(
      lease.port.invoke.invoke('team.status', { team_name: 'blue-1a2b' } as never),
    ).rejects.toMatchObject({ code: 'INTERNAL', message: NATIVE });
    // The port that observed it logged the whole value, without an identifier.
    const record = logs.find((entry) => entry.fields['command'] === 'team.status');
    expect(record, 'the channel port did not log the failure').toBeDefined();
    expect(record!.fields).not.toHaveProperty('failure_id');
    expect((record!.fields['err'] as { message: string }).message).toBe(NATIVE);
  });

  it('never wraps an unclassified failure before it reaches a boundary', async () => {
    // The Command layer no longer flattens: what the boundary catches is the
    // very value the domain threw, so its type and stack are still readable.
    class StoreCorrupt extends Error {
      override readonly name = 'StoreCorrupt';
    }
    const harness = createCommandHarness({
      dispatcherOverrides: {
        createTeam: async () => {
          throw new StoreCorrupt(NATIVE);
        },
      },
    });
    await expect(
      harness.registry.invoke(adminContext(), 'team.create', {
        request_id: 'req-1',
        name_prefix: 'blue',
        intent: 'ship it',
        leader: { agent_runtime: 'r1' },
      } as never),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(StoreCorrupt);
      expect((error as Error).stack).toContain('StoreCorrupt');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// A Team that is gone and a Team that is over are different answers.
// ---------------------------------------------------------------------------

describe('a closed Team and a missing Team stay two facts', () => {
  it('a leader-scoped call on a closed Team says TEAM_CLOSED, not TEAM_NOT_FOUND', async () => {
    const delegate = createTeamMateMcpDelegate({
      kind: 'team_leader',
      team: async () => {
        throw new TeamClosedError('Team "blue-1a2b" is closed');
      },
    });
    const message = refusalMessage(await throughTheRegistry(delegate, 'list'));
    expect(message.startsWith('TEAM_CLOSED: ')).toBe(true);
    expect(message).toContain('is closed');
    expect(message).not.toContain('TEAM_NOT_FOUND');
  });

  it('a leader-scoped call on a Team that never existed still says TEAM_NOT_FOUND', async () => {
    const delegate = createTeamMateMcpDelegate({
      kind: 'team_leader',
      team: async () => {
        throw new TeamNotFoundError('Team "ghost-a1b2" does not exist');
      },
    });
    const message = refusalMessage(await throughTheRegistry(delegate, 'list'));
    expect(message.startsWith('TEAM_NOT_FOUND: ')).toBe(true);
  });

  it('resolving a Team leaves a failure it cannot name untouched', async () => {
    const delegate = createTeamMateMcpDelegate({
      kind: 'team_leader',
      team: async () => {
        throw new Error('EIO: i/o error reading the Team record');
      },
    });
    expect(refusalMessage(await throughTheRegistry(delegate, 'list'))).toBe(
      'INTERNAL: EIO: i/o error reading the Team record',
    );
  });

  it('the not-found next step names no tool the current surface may lack', () => {
    const action = new TeamNotFoundError('x').action;
    expect(action).not.toContain('team_name');
    expect(action).not.toContain('team.list');
    expect(action).not.toContain('team.create');
  });
});

// ---------------------------------------------------------------------------
// A blank argument is the caller's mistake, on both surfaces.
// ---------------------------------------------------------------------------

describe('a whitespace-only argument is a bad request, never an internal failure', () => {
  const BLANK = '   ';

  const cases: {
    what: string;
    method: string;
    params: Record<string, unknown>;
    tool: { delegate: () => McpServerDelegate; name: string; args: Record<string, unknown> };
  }[] = [
    {
      what: "team.create name_prefix",
      method: 'team.create',
      params: {
        request_id: 'req-1',
        name_prefix: BLANK,
        intent: 'ship it',
        leader: { agent_runtime: 'r1' },
      },
      tool: {
        delegate: () => teamDelegate({}),
        name: 'create',
        args: { name_prefix: BLANK, intent: 'ship it', leader_agent_runtime: 'r1' },
      },
    },
    {
      what: 'team.create intent',
      method: 'team.create',
      params: {
        request_id: 'req-1',
        name_prefix: 'blue',
        intent: BLANK,
        leader: { agent_runtime: 'r1' },
      },
      tool: {
        delegate: () => teamDelegate({}),
        name: 'create',
        args: { name_prefix: 'blue', intent: BLANK, leader_agent_runtime: 'r1' },
      },
    },
    {
      what: 'teammate.spawn name_prefix',
      method: 'teammate.spawn',
      params: { name_prefix: BLANK, prompt: 'go', intent: 'do the thing' },
      tool: {
        delegate: () => teammateDelegate({}),
        name: 'spawn',
        args: { name_prefix: BLANK, prompt: 'go', intent: 'do the thing' },
      },
    },
    {
      what: 'teammate.spawn intent',
      method: 'teammate.spawn',
      params: { name_prefix: 'mate', prompt: 'go', intent: BLANK },
      tool: {
        delegate: () => teammateDelegate({}),
        name: 'spawn',
        args: { name_prefix: 'mate', prompt: 'go', intent: BLANK },
      },
    },
    {
      what: 'teammate.close note',
      method: 'teammate.close',
      params: { name: 'mate-9z', note: BLANK },
      tool: {
        delegate: () => teammateDelegate({}),
        name: 'close',
        args: { name: 'mate-9z', note: BLANK },
      },
    },
  ];

  for (const entry of cases) {
    it(`${entry.what}: BAD_REQUEST on the Command and on the tool`, async () => {
      const harness = createCommandHarness();
      await expect(
        harness.registry.invoke(adminContext(), entry.method, entry.params as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      const message = refusalMessage(
        await throughTheRegistry(entry.tool.delegate(), entry.tool.name, entry.tool.args),
      );
      expect(message.startsWith('BAD_REQUEST: ')).toBe(true);
      expect(message).not.toMatch(UNCLASSIFIED);
    });
  }

  it('an unusable Team history page is the caller`s mistake on both', async () => {
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke(adminContext(), 'team.history', { limit: 0 } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const message = refusalMessage(
      await throughTheRegistry(teamDelegate({}), 'history', { limit: 0 }),
    );
    expect(message.startsWith('BAD_REQUEST: ')).toBe(true);
    expect(message).toContain('positive integer');
  });

  it('a Team history cursor nothing here issued is the caller`s mistake on both', async () => {
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke(adminContext(), 'team.history', {
        cursor: 'not-a-cursor',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const message = refusalMessage(
      await throughTheRegistry(teamDelegate({}), 'history', { cursor: 'not-a-cursor' }),
    );
    expect(message.startsWith('BAD_REQUEST: ')).toBe(true);
    expect(message).not.toMatch(UNCLASSIFIED);
  });

});

// ---------------------------------------------------------------------------
// A settled-but-unhappy submission still reports what the runtime said.
// ---------------------------------------------------------------------------

describe('a failed or ambiguous submission reports the runtime`s own message', () => {
  const NATIVE = 'codex rpc stream closed while turn/start was pending';

  it('the TeamMate receipt carries the native message', () => {
    expect(
      toSubmissionResult({ status: 'failed', error: new Error(NATIVE) }),
    ).toEqual({ status: 'failed', error: NATIVE });
    expect(
      toSubmissionResult({ status: 'ambiguous', error: new Error(NATIVE) }),
    ).toEqual({ status: 'ambiguous', error: NATIVE });
  });

  it('the Team receipt carries the native message under its own code', () => {
    expect(teamSubmitResult({ status: 'failed', error: new Error(NATIVE) })).toEqual({
      status: 'failed',
      error: { code: 'TEAM_SUBMIT_FAILED', message: NATIVE },
    });
    expect(
      teamSubmitResult({ status: 'ambiguous', error: new Error(NATIVE) }),
    ).toEqual({
      status: 'ambiguous',
      error: { code: 'TEAM_SUBMIT_AMBIGUOUS', message: NATIVE },
    });
  });

  it('it survives the real Command, on the admin socket and on the Channel port', async () => {
    const overrides: FakeDispatcherOverrides = {
      submitToTeamLeader: async () => ({
        status: 'ambiguous',
        error: new Error(NATIVE),
      }),
    };

    const harness = createCommandHarness({ dispatcherOverrides: overrides });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const response = await admin.send('team.submit', {
        dispatcher_id: HARNESS_DISPATCHER_ID,
        team_name: 'blue-1a2b',
        text: 'go',
      });
      expect(response.ok).toBe(true);
      expect((response as { result: unknown }).result).toEqual({
        status: 'ambiguous',
        error: { code: 'TEAM_SUBMIT_AMBIGUOUS', message: NATIVE },
      });
    } finally {
      await admin.close();
    }

    const lease = createHarnessChannelInvoker(
      createCommandHarness({ dispatcherOverrides: overrides }),
    );
    expect(
      await lease.port.invoke.invoke('team.submit', {
        team_name: 'blue-1a2b',
        text: 'go',
      } as never),
    ).toEqual({
      status: 'ambiguous',
      error: { code: 'TEAM_SUBMIT_AMBIGUOUS', message: NATIVE },
    });
  });
});

// ---------------------------------------------------------------------------
// An Activity read: named reasons keep their fact, everything else keeps its own.
// ---------------------------------------------------------------------------

describe('an Activity read answers with the failure that actually happened', () => {
  const NATIVE = 'EPIPE: broken pipe writing to the codex rpc stream';

  const throwingLast = (raise: () => never): FakeDispatcherOverrides => ({
    teammates: { last: async () => raise() },
  });

  it('a provider failure nobody named reaches the model as INTERNAL with its own message', async () => {
    const message = refusalMessage(
      await throughTheRegistry(
        teammateDelegate(
          throwingLast(() => {
            throw new Error(NATIVE);
          }),
        ),
        'last',
        { name: 'mate-9z' },
      ),
    );
    expect(message).toBe(`INTERNAL: ${NATIVE}`);
  });

  it('and reaches an admin caller the same way, on the Command surface', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: throwingLast(() => {
        throw new Error(NATIVE);
      }),
    });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const response = await admin.send('teammate.last', {
        dispatcher_id: HARNESS_DISPATCHER_ID,
        name: 'mate-9z',
      });
      expect((response as { error: unknown }).error).toEqual({
        code: 'INTERNAL',
        message: NATIVE,
      });
    } finally {
      await admin.close();
    }
  });

  for (const entry of ACTIVITY_PUBLIC_ERRORS) {
    it(`a recognized ${entry.reason} still states ${entry.code} with its own next step`, async () => {
      const message = refusalMessage(
        await throughTheRegistry(
          teammateDelegate(
            throwingLast(() => {
              throw new AgentActivityReadError(entry.reason);
            }),
          ),
          'last',
          { name: 'mate-9z' },
        ),
      );
      expect(message).toBe(`${entry.code}: ${entry.message} ${entry.action}`);
    });
  }
});
