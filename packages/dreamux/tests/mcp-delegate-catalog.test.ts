/**
 * Coverage for the generic MCP catalog/registration infrastructure that is
 * NOT the lease admission edge (see mcp-lease-shim.test.ts for that half):
 *
 * - mcp/catalog.ts: transport-level structural validation of a tool catalog.
 * - service/mcp/tool-metadata.ts: the shared vocabulary domain delegates build
 *   catalogs from, proven to actually survive that same validation.
 * - service/mcp/descriptor.ts: the AgentRuntimeMcpServer launch data Core hands
 *   a runtime — proven to carry only an admin-socket path and an opaque token.
 * - service/mcp/commands.ts + command/catalog.ts: the "only two MCP-shaped
 *   Commands exist" invariant, structurally, at the composition root.
 * - service/channel-service/mcp-delegate.ts: the one delegate implementation
 *   that bridges an *external* neutral seam (ChannelProvider) into this
 *   infrastructure, used here as the concrete proof of "Core validates the
 *   session/provider pair before injection" and "caller-scoped catalogs are
 *   the delegate's own describe(), not a Core policy".
 *
 * Every fake below is intentionally minimal and local: this cell owns the
 * generic mechanism, not any one domain's business behavior.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ChannelMcpCall,
  ChannelMcpCallContext,
  ChannelMcpCaller,
  ChannelMcpToolOutcome,
  ChannelMcpToolRegistration,
  ChannelProvider,
  ChannelSessionMcpCapability,
} from '@excitedjs/dreamux-types';
import { describe, expect, it } from 'vitest';

import type { CoreCommandHost } from '../src/command/host.js';
import { validateMcpToolCatalog } from '../src/mcp/catalog.js';
import { createChannelMcpDelegate } from '../src/service/channel-service/mcp-delegate.js';
import {
  DREAMUX_MCP_LEASE_ENV,
  DREAMUX_MCP_SUBCOMMAND,
  assertUniqueMcpServerNames,
  mcpServerDescriptor,
} from '../src/service/mcp/descriptor.js';
import { mcpCommands } from '../src/service/mcp/commands.js';
import { McpLeaseRegistry } from '../src/service/mcp/leases.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  closedObjectSchema,
  repoInputSchema,
  toolMetadata,
} from '../src/service/mcp/tool-metadata.js';
import { InternalError, StatedFailure } from '../src/platform/errors.js';
import { createCommandHarness } from './helpers/command-harness.js';

const SRC_ROOT = join(fileURLToPath(new URL('../src/', import.meta.url)));

function goodTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'do_thing',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...overrides,
  };
}

describe('mcp/catalog.ts — validateMcpToolCatalog', () => {
  it('rejects a non-array and an empty array as distinct failures', () => {
    expect(() => validateMcpToolCatalog('nope' as never, 'x')).toThrow(/must be an array/);
    expect(() => validateMcpToolCatalog([], 'x')).toThrow(/must not be empty/);
  });

  it('requires a unique, non-empty name per descriptor', () => {
    expect(() =>
      validateMcpToolCatalog([goodTool({ name: '' })], 'x'),
    ).toThrow(/non-empty name/);
    expect(() =>
      validateMcpToolCatalog([goodTool(), goodTool()], 'x'),
    ).toThrow(/duplicated/);
  });

  it('rejects an unknown top-level descriptor key', () => {
    expect(() =>
      validateMcpToolCatalog([goodTool({ extra: 1 })], 'x'),
    ).toThrow(/unknown property 'extra'/);
  });

  it('compiles inputSchema/outputSchema through the same SDK adapter registration uses', () => {
    expect(() =>
      validateMcpToolCatalog(
        [goodTool({ inputSchema: { type: 'not-a-real-type' } })],
        'x',
      ),
    ).toThrow(/not a valid JSON Schema/);
    expect(() =>
      validateMcpToolCatalog(
        [goodTool({ outputSchema: { type: 'not-a-real-type' } })],
        'x',
      ),
    ).toThrow(/not a valid JSON Schema/);
  });

  it('defaults title/description to the tool name when omitted', () => {
    const [tool] = validateMcpToolCatalog([goodTool()], 'x');
    expect(tool.title).toBe('do_thing');
    expect(tool.description).toBe('do_thing');
  });

  it('restricts annotations to the MCP-defined key set and value types', () => {
    expect(() =>
      validateMcpToolCatalog(
        [goodTool({ annotations: { madeUpKey: true } })],
        'x',
      ),
    ).toThrow(/unknown property 'madeUpKey'/);
    expect(() =>
      validateMcpToolCatalog(
        [goodTool({ annotations: { readOnlyHint: 'yes' } })],
        'x',
      ),
    ).toThrow(/must be a boolean/);
    expect(() =>
      validateMcpToolCatalog([goodTool({ annotations: { title: '' } })], 'x'),
    ).toThrow(/non-empty string/);
  });

  it('restricts icons to the MCP-defined key set and required src', () => {
    expect(() =>
      validateMcpToolCatalog([goodTool({ icons: [{ src: 'x', bogus: 1 }] })], 'x'),
    ).toThrow(/unknown property 'bogus'/);
    expect(() =>
      validateMcpToolCatalog(
        [goodTool({ icons: [{ src: 'icon.png', theme: 'ultraviolet' }] })],
        'x',
      ),
    ).toThrow(/'light' or 'dark'/);
  });

  it('rejects a descriptor that would not survive a JSON round trip', () => {
    expect(() =>
      validateMcpToolCatalog([goodTool({ inputSchema: { fn: () => 1 } })], 'x'),
    ).toThrow(/non-JSON function/);
    expect(() =>
      validateMcpToolCatalog([goodTool({ inputSchema: { n: Number.NaN } })], 'x'),
    ).toThrow(/non-finite number/);
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic['self'] = cyclic;
    expect(() =>
      validateMcpToolCatalog([goodTool({ inputSchema: cyclic })], 'x'),
    ).toThrow(/circular reference/);
    class NotPlain {
      type = 'object';
    }
    expect(() =>
      validateMcpToolCatalog([goodTool({ inputSchema: new NotPlain() })], 'x'),
    ).toThrow(/non-plain object/);
  });
});

describe('service/mcp/tool-metadata.ts — shared catalog vocabulary', () => {
  it('builds a closed inputSchema and passes it straight through validateMcpToolCatalog', () => {
    const descriptor = toolMetadata({
      name: 'spawn_thing',
      title: 'Spawn Thing',
      description: 'Spawns a thing.',
      properties: { name: { type: 'string' } },
      required: ['name'],
      outputSchema: closedObjectSchema({ id: { type: 'string' } }, ['id']),
      annotations: MUTATING_ANNOTATIONS,
    });
    expect(descriptor.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['name'],
    });
    // The real integration point: whatever this builder produces must be
    // exactly what the transport-level validator accepts, because that
    // validator runs on every domain's catalog at mint time.
    const [validated] = validateMcpToolCatalog([descriptor], 'spawn suite');
    expect(validated.name).toBe('spawn_thing');
    expect(validated.inputSchema).toEqual(descriptor.inputSchema);
  });

  it('merges inputConstraints into the closed object schema without dropping the closure', () => {
    const descriptor = toolMetadata({
      name: 'x',
      title: 'X',
      description: 'x',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: [],
      inputConstraints: { anyOf: [{ required: ['a'] }, { required: ['b'] }] },
      outputSchema: closedObjectSchema({}, []),
      annotations: READ_ONLY_ANNOTATIONS,
    });
    expect(descriptor.inputSchema['anyOf']).toBeDefined();
    expect(descriptor.inputSchema['additionalProperties']).toBe(false);
    validateMcpToolCatalog([descriptor], 'x'); // must not throw
  });

  it('repoInputSchema requires mode and enumerates the canonical mode/cleanup values', () => {
    const schema = repoInputSchema();
    expect(schema['required']).toEqual(['mode']);
    const properties = schema['properties'] as Record<string, { enum?: string[] }>;
    expect(properties['mode']?.enum).toEqual(['reuse-cwd', 'managed']);
    expect(properties['cleanup']?.enum).toEqual(['keep', 'delete-on-close']);
  });

  it('keeps the three standard annotation presets distinct and internally consistent', () => {
    expect(READ_ONLY_ANNOTATIONS).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(MUTATING_ANNOTATIONS).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(DESTRUCTIVE_ANNOTATIONS).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('service/mcp/descriptor.ts — shim launch data', () => {
  it('assertUniqueMcpServerNames only rejects an actual collision', () => {
    const server = (name: string) =>
      mcpServerDescriptor({ name, token: 't', adminSocketPath: '/tmp/a.sock', command: '/bin/true' });
    expect(() => assertUniqueMcpServerNames([server('a'), server('b')])).not.toThrow();
    expect(() => assertUniqueMcpServerNames([server('a'), server('a')])).toThrow(
      /composed twice/,
    );
  });

  it('carries only the admin-socket location and the opaque lease token — nothing else', () => {
    const descriptor = mcpServerDescriptor({
      name: 'team',
      token: 'lease-abc-123',
      adminSocketPath: '/run/dreamux/admin.sock',
      command: '/usr/bin/dreamux',
    });
    expect(descriptor).toEqual({
      name: 'team',
      command: '/usr/bin/dreamux',
      args: [DREAMUX_MCP_SUBCOMMAND, '--admin-socket', '/run/dreamux/admin.sock'],
      env: { [DREAMUX_MCP_LEASE_ENV]: 'lease-abc-123' },
    });
    // No base64 catalog, no caller fields, no domain/provider ref, no Channel
    // policy: the env object's only key is the lease token env var.
    expect(Object.keys(descriptor.env ?? {})).toEqual([DREAMUX_MCP_LEASE_ENV]);
    expect(descriptor.args.join(' ')).not.toMatch(/token|catalog|caller/i);
  });
});

function stubHost(): CoreCommandHost {
  return {
    summarize: () => {
      throw new Error('mcpCommands must not call summarize()');
    },
    dispatcherRow: () => {
      throw new Error('mcpCommands must not call dispatcherRow()');
    },
    dispatcherRuntimeStatus: () => {
      throw new Error('mcpCommands must not call dispatcherRuntimeStatus()');
    },
    dispatcher: () => {
      throw new Error('mcpCommands must not call dispatcher()');
    },
    mcpLeases: new McpLeaseRegistry(),
  };
}

describe('service/mcp/commands.ts — the only two MCP-shaped Commands', () => {
  it('contributes exactly mcp.describe and mcp.toolcall, regardless of what is leased', () => {
    const names = mcpCommands(stubHost()).map((c) => c.name);
    expect(names).toEqual(['mcp.describe', 'mcp.toolcall']);
  });

  it('never grows a third Command no matter how many delegates a runtime leases', () => {
    // mcpCommands takes only the host: it has no catalog/delegate parameter it
    // could iterate to mint a per-tool Command from. Minting several leases
    // before asking proves the two-Command list cannot depend on lease count.
    const host = stubHost();
    for (let i = 0; i < 5; i++) {
      host.mcpLeases.mint(
        { isCurrent: () => true } as never,
        {
          name: `fake-${i}`,
          describe: () => ({
            identity: { name: `fake-${i}`, version: '1.0.0' },
            tools: [goodTool({ name: `fake_tool_${i}` })],
          }),
          call: async () => ({ ok: true, structured: {} }),
        },
      );
    }
    expect(mcpCommands(host).map((c) => c.name)).toEqual(['mcp.describe', 'mcp.toolcall']);
  });

  it('at the composition root, no individual agent-facing tool name is ever a registered Command', () => {
    const harness = createCommandHarness();
    const names = harness.registry.names();
    const mcpNames = names.filter((n) => n.startsWith('mcp.'));
    expect(mcpNames).toEqual(['mcp.describe', 'mcp.toolcall']);
    // A representative sample of tool-shaped names a delegate might advertise
    // must never collide with the Command catalog: they are two different
    // vocabularies by construction (dotted domain.verb vs snake_case tool).
    for (const forbidden of ['team_spawn', 'teammate_send', 'cron_create', 'reply', 'react']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('Channel MCP is injected only into Dispatcher/TeamLeader create contexts (absence-of-import contract)', () => {
  it('channelMcpDelegates() is defined once and consumed only by dispatcher-service role assembly', async () => {
    // Absence is the contract here: no teammate/workflow/team-service module
    // may reach into channel-service's caller-scoped MCP builder, because
    // that would let Channel MCP leak into an ordinary TeamMate's tool set.
    const importers = await findImportersOf(SRC_ROOT, 'channelMcpDelegates');
    const relative = importers.map((p) => p.replace(SRC_ROOT, ''));
    expect(relative.sort()).toEqual(
      [
        // its own definition
        'service/channel-service/mcp-delegates.ts',
        // its one consumer: the Dispatcher-Agent-vs-TeamLeader role split
        'service/dispatcher-service/mcp-delegates.ts',
      ].sort(),
    );
  });
});

/** Recursively find every .ts file under `root` whose text mentions `symbol`. */
async function findImportersOf(root: string, symbol: string): Promise<string[]> {
  const hits: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const text = await readFile(full, 'utf8');
        if (text.includes(symbol)) hits.push(full);
      }
    }
  }
  await walk(root);
  return hits;
}

// ---------------------------------------------------------------------------
// createChannelMcpDelegate: the one built-in delegate implementation this
// cell owns end to end, used as the concrete proof of the registration and
// dispatch contract every McpServerDelegate must satisfy.
// ---------------------------------------------------------------------------

function fakeProvider(
  describeFn: (
    config: unknown,
    context: { caller: ChannelMcpCaller },
  ) => readonly ChannelMcpToolRegistration[],
  invokeFn?: (
    call: ChannelMcpCall,
    context: ChannelMcpCallContext,
  ) => Promise<ChannelMcpToolOutcome>,
): ChannelProvider<unknown> {
  return {
    createSession: () => {
      throw new Error('not used by this delegate');
    },
    mcp: {
      describe: describeFn,
      ...(invokeFn !== undefined ? { invoke: invokeFn } : {}),
    },
  };
}

function sessionCapability(
  invokeFn: (
    call: ChannelMcpCall,
    context: ChannelMcpCallContext,
  ) => Promise<ChannelMcpToolOutcome>,
): ChannelSessionMcpCapability {
  return { invoke: invokeFn };
}

const DISPATCHER_CALLER: ChannelMcpCaller = { kind: 'dispatcher' };

/**
 * `McpDelegateDescription.tools` is `readonly unknown[]` by contract (the
 * generic infrastructure never reads a tool's shape — see mcp/types.ts). This
 * cast is the test's own concession to that opacity, not a claim the
 * production seam is more typed than it is.
 */
function toolNames(tools: readonly unknown[]): string[] {
  return tools.map((tool) => (tool as { name: string }).name);
}

describe('service/channel-service/mcp-delegate.ts — createChannelMcpDelegate', () => {
  it('names its server channel-<id> and its identity dreamux-channel-<id>', () => {
    const provider = fakeProvider(() => []);
    const delegate = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'feishu-main',
      provider,
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: null,
      dispatch: (task) => task(),
    });
    expect(delegate.name).toBe('channel-feishu-main');
    expect(delegate.describe().identity.name).toBe('dreamux-channel-feishu-main');
  });

  it('drops a session-target registration when no created-instance capability exists', () => {
    const provider = fakeProvider(() => [
      {
        target: 'session',
        tool: { name: 'reply', inputSchema: { type: 'object' } },
      },
    ]);
    const delegate = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'c1',
      provider,
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: null, // no live instance capability
      dispatch: (task) => task(),
    });
    expect(delegate.describe().tools).toEqual([]);
  });

  it('advertises a session-target tool once a created-instance capability is proven, and routes calls to it', async () => {
    const seen: { call: ChannelMcpCall; context: ChannelMcpCallContext }[] = [];
    const session = sessionCapability(async (call, context) => {
      seen.push({ call, context });
      return { ok: true, value: { replied: true } };
    });
    const provider = fakeProvider(() => [
      { target: 'session', tool: { name: 'reply', inputSchema: { type: 'object' } } },
    ]);
    const delegate = createChannelMcpDelegate({
      dispatcherId: 'd7',
      channelId: 'feishu-main',
      provider,
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: session,
      dispatch: (task) => task(),
    });
    expect(toolNames(delegate.describe().tools)).toEqual(['reply']);
    const result = await delegate.call({ name: 'reply', arguments: { text: 'hi' } });
    expect(result).toEqual({ ok: true, structured: { replied: true } });
    expect(seen).toEqual([
      {
        call: { name: 'reply', arguments: { text: 'hi' } },
        context: { dispatcher_id: 'd7', channel_id: 'feishu-main', caller: DISPATCHER_CALLER },
      },
    ]);
  });

  it('drops a provider-target registration when the provider composes no sessionless invoke', () => {
    const provider = fakeProvider(() => [
      {
        target: 'provider',
        tool: { name: 'list_chat_bots', inputSchema: { type: 'object' } },
      },
    ]); // no invokeFn supplied: registration contract requires it, so it drops
    const delegate = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'c1',
      provider,
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: null,
      dispatch: (task) => task(),
    });
    expect(delegate.describe().tools).toEqual([]);
  });

  it('routes a provider-target tool to the provider sessionless invoke, working with no live session', async () => {
    const seen: ChannelMcpCallContext[] = [];
    const provider = fakeProvider(
      () => [
        { target: 'provider', tool: { name: 'list_chat_bots', inputSchema: { type: 'object' } } },
      ],
      async (_call, context) => {
        seen.push(context);
        return { ok: true, value: { bots: [] } };
      },
    );
    const delegate = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'c1',
      provider,
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: null, // no live session — provider target must still work
      dispatch: (task) => task(),
    });
    const result = await delegate.call({ name: 'list_chat_bots', arguments: {} });
    expect(result).toEqual({ ok: true, structured: { bots: [] } });
    expect(seen).toEqual([{ dispatcher_id: 'd1', channel_id: 'c1', caller: DISPATCHER_CALLER }]);
  });

  it('passes a Channel refusal through verbatim (ok:false is a value, not an exception)', async () => {
    const provider = fakeProvider(
      () => [{ target: 'provider', tool: { name: 't', inputSchema: { type: 'object' } } }],
      async () => ({ ok: false, message: 'that chat is not bound to your Team' }),
    );
    const delegate = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'c1',
      provider,
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: null,
      dispatch: (task) => task(),
    });
    const result = await delegate.call({ name: 't', arguments: {} });
    expect(result).toEqual({ ok: false, message: 'that chat is not bound to your Team' });
  });

  it('raises a Team-lease failure for the admission boundary to render, and keeps no list of its own', async () => {
    class FakeTeamNotFoundError extends StatedFailure {
      constructor() {
        super('TEAM_NOT_FOUND', 'no such Team', 'Use team.list for live Teams.');
      }
    }
    class FakeInternalError extends InternalError {
      constructor() {
        super('boom');
      }
    }
    // `dispatch` is where a TeamLeader-scoped call enters that Team's own work
    // fence (see mcp-delegates.ts: `runForTeamLeader`); a fenced call raises
    // its Team-lease failure from `dispatch` itself, before the handler ever
    // runs. The delegate passes it on rather than classifying it: which
    // failures a caller may read is decided at the one boundary every delegate
    // is reached through, not per delegate.
    const delegateWithFencedDispatch = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'c1',
      provider: fakeProvider(() => [
        { target: 'provider', tool: { name: 't', inputSchema: { type: 'object' } } },
      ], async () => ({ ok: true, value: {} })),
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: null,
      dispatch: async () => {
        throw new FakeTeamNotFoundError();
      },
    });
    await expect(
      delegateWithFencedDispatch.call({ name: 't', arguments: {} }),
    ).rejects.toBeInstanceOf(FakeTeamNotFoundError);

    const delegateWithUnlistedFailure = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'c1',
      provider: fakeProvider(() => [
        { target: 'provider', tool: { name: 't', inputSchema: { type: 'object' } } },
      ], async () => ({ ok: true, value: {} })),
      config: {},
      caller: DISPATCHER_CALLER,
      sessionMcp: null,
      dispatch: async () => {
        throw new FakeInternalError();
      },
    });
    // Identical treatment, which is the point: the delegate does not sort them.
    await expect(
      delegateWithUnlistedFailure.call({ name: 't', arguments: {} }),
    ).rejects.toBeInstanceOf(FakeInternalError);
  });

  it('caller-scoped catalogs: the same channel id yields two different tool sets for dispatcher vs team_leader callers', () => {
    const describeByCaller = (
      _config: unknown,
      context: { caller: ChannelMcpCaller },
    ): readonly ChannelMcpToolRegistration[] =>
      context.caller.kind === 'dispatcher'
        ? [
            { target: 'provider', tool: { name: 'bind_channel', inputSchema: { type: 'object' } } },
            { target: 'provider', tool: { name: 'reply', inputSchema: { type: 'object' } } },
          ]
        : [{ target: 'provider', tool: { name: 'reply', inputSchema: { type: 'object' } } }];
    const provider = fakeProvider(describeByCaller, async () => ({ ok: true, value: {} }));

    const dispatcherDelegate = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'feishu-main',
      provider,
      config: {},
      caller: { kind: 'dispatcher' },
      sessionMcp: null,
      dispatch: (task) => task(),
    });
    const teamLeaderDelegate = createChannelMcpDelegate({
      dispatcherId: 'd1',
      channelId: 'feishu-main',
      provider,
      config: {},
      caller: { kind: 'team_leader', team_name: 'team-a', leader_name: 'leader-a' },
      sessionMcp: null,
      dispatch: (task) => task(),
    });

    expect(toolNames(dispatcherDelegate.describe().tools).sort()).toEqual([
      'bind_channel',
      'reply',
    ]);
    expect(toolNames(teamLeaderDelegate.describe().tools)).toEqual(['reply']);
    // Neither delegate leaks the other caller's tool: TeamLeader never sees
    // bind_channel, and this was decided entirely by the Channel's own
    // describe(), not by any Core policy.
    expect(toolNames(teamLeaderDelegate.describe().tools)).not.toContain('bind_channel');
  });
});
