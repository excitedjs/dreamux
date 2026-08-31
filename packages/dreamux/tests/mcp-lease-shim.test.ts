/**
 * Coverage for the Agent-facing MCP admission edge (mcp/leases.ts) and its one
 * consumer, the generic stdio shim (mcp/shim.ts), end to end over a real
 * `admin.sock` — the same two pieces mcp-delegate-catalog.test.ts does not
 * cover.
 *
 * The lower half of this file exercises `McpLeaseRegistry` directly, against
 * hand-built spy delegates: membership admission, immutability-per-generation,
 * and revocation are properties of the registry alone and need neither a real
 * Command nor a real socket to prove.
 *
 * The upper half runs the real `runDreamuxMcp` shim against a real
 * `mcp.describe`/`mcp.toolcall` `CoreCommands` registry, reached over an actual
 * Unix admin socket (`tests/helpers/command-harness.ts`, owned by the
 * core-command-registry test cell — imported read-only here, exactly as
 * production wires `Server`). This is what proves the whole chain the
 * requirement describes: native tool call -> stdio shim -> `mcp.toolcall` ->
 * `McpLeaseRegistry` -> delegate -> canonical result, with no shim-to-domain
 * mapping and no route a model can forge.
 */
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { AdminClientError } from '../src/admin/client.js';
import { runDreamuxMcp } from '../src/mcp/shim.js';
import { McpLeaseRegistry, McpLeaseRevokedError } from '../src/service/mcp/leases.js';
import type {
  McpDelegateCall,
  McpDelegateResult,
  McpServerDelegate,
} from '../src/service/mcp/types.js';
import { callTool, connectMcpClient, listedTools } from './helpers/mcp-client.js';
import { createCommandHarness, startHarnessAdminSocket } from './helpers/command-harness.js';

/**
 * An `AgentRuntimeGenerationLease`-shaped fake. Every registry code path this
 * file exercises reads only `isCurrent()`; the leased state sink is never
 * touched by mint/catalog/invoke/release, so this narrow shape is honest, not
 * a shortcut (mirrors `command-harness.ts`'s own `mintFakeMcpServer`).
 */
function fakeLease(isCurrent: () => boolean = () => true) {
  return { isCurrent } as unknown as Parameters<McpLeaseRegistry['mint']>[0];
}

interface Spy {
  delegate: McpServerDelegate;
  calls: McpDelegateCall[];
  describeCallCount(): number;
}

function spyDelegate(input: {
  name?: string;
  tools?: unknown[];
  call?: (call: McpDelegateCall) => Promise<McpDelegateResult>;
} = {}): Spy {
  let describeCalls = 0;
  const calls: McpDelegateCall[] = [];
  const tools =
    input.tools ??
    ([
      {
        name: 'echo_tool',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        },
      },
    ] as const);
  const name = input.name ?? 'harness-server';
  const delegate: McpServerDelegate = {
    name,
    describe: () => {
      describeCalls++;
      return { identity: { name: `dreamux-${name}`, version: '1.0.0' }, tools };
    },
    call: async (call) => {
      calls.push(call);
      return (input.call ?? (async () => ({ ok: true, structured: {} })))(call);
    },
  };
  return { delegate, calls, describeCallCount: () => describeCalls };
}

describe('McpLeaseRegistry — admission edge', () => {
  it('refuses a tool outside the frozen catalog before the delegate is ever reached', async () => {
    const registry = new McpLeaseRegistry();
    const spy = spyDelegate();
    const minted = registry.mint(fakeLease(), spy.delegate);
    expect(minted).not.toBeNull();
    const result = await registry.invoke(minted!.token, {
      name: 'not_a_real_tool',
      arguments: {},
    });
    expect(result).toEqual({
      ok: false,
      message:
        "Tool 'not_a_real_tool' is not available on the Dreamux harness-server server. " +
        'Available tools: echo_tool.',
    });
    expect(spy.calls).toEqual([]);
  });

  it('dispatches an admitted call to the delegate with the arguments unchanged', async () => {
    const registry = new McpLeaseRegistry();
    const spy = spyDelegate({
      call: async (call) => ({ ok: true, structured: { echoed: call.arguments } }),
    });
    const minted = registry.mint(fakeLease(), spy.delegate);
    const result = await registry.invoke(minted!.token, {
      name: 'echo_tool',
      arguments: { value: 'hi' },
    });
    expect(result).toEqual({ ok: true, structured: { echoed: { value: 'hi' } } });
    expect(spy.calls).toEqual([{ name: 'echo_tool', arguments: { value: 'hi' } }]);
  });

  it('release() revokes synchronously: catalog() and invoke() fail, and the delegate is never reached again', async () => {
    const registry = new McpLeaseRegistry();
    const spy = spyDelegate();
    const minted = registry.mint(fakeLease(), spy.delegate)!;
    await registry.invoke(minted.token, { name: 'echo_tool', arguments: {} });
    expect(spy.calls).toHaveLength(1);

    registry.release([minted.token]);

    expect(() => registry.catalog(minted.token)).toThrow(McpLeaseRevokedError);
    // `invoke` is the boundary that answers a caller, so a revoked token is
    // settled as the fact it is rather than thrown past it.
    const revoked = await registry.invoke(minted.token, {
      name: 'echo_tool',
      arguments: {},
    });
    expect(revoked.ok).toBe(false);
    expect(revoked.ok ? '' : revoked.message).toMatch(/^MCP_LEASE_REVOKED: /);
    expect(spy.calls).toHaveLength(1); // unchanged — the revoked call never dispatched

    // Releasing an already-released (or never-minted) token is a documented no-op.
    expect(() => registry.release([minted.token, 'never-issued'])).not.toThrow();
  });

  it('a stale generation alone revokes admission, without an explicit release() call', () => {
    const registry = new McpLeaseRegistry();
    let current = true;
    const minted = registry.mint(fakeLease(() => current), spyDelegate().delegate)!;
    expect(() => registry.catalog(minted.token)).not.toThrow();
    current = false;
    expect(() => registry.catalog(minted.token)).toThrow(McpLeaseRevokedError);
  });

  it('two independently-leased generations are isolated: revoking one leaves the other admitting', async () => {
    const registry = new McpLeaseRegistry();
    let generationOneCurrent = true;
    const one = registry.mint(fakeLease(() => generationOneCurrent), spyDelegate({ name: 's1' }).delegate)!;
    const two = registry.mint(fakeLease(() => true), spyDelegate({ name: 's2' }).delegate)!;
    generationOneCurrent = false;
    expect(() => registry.catalog(one.token)).toThrow(McpLeaseRevokedError);
    expect(() => registry.catalog(two.token)).not.toThrow();
  });

  it('mint reads describe() exactly once and freezes a canonical copy, immune to later mutation', () => {
    const registry = new McpLeaseRegistry();
    const mutableTools = [{ name: 'echo_tool', inputSchema: { type: 'object' } }];
    const spy = spyDelegate({ tools: mutableTools });
    const minted = registry.mint(fakeLease(), spy.delegate)!;
    expect(spy.describeCallCount()).toBe(1);

    // Mutate what the delegate itself still holds; the registry copied through
    // Core's own JSON boundary at mint time, so this must not be visible.
    mutableTools[0]!.name = 'renamed-after-mint';
    mutableTools.push({ name: 'smuggled_tool', inputSchema: { type: 'object' } });

    const catalog = registry.catalog(minted.token);
    expect(catalog.tools.map((t) => t.name)).toEqual(['echo_tool']);
    expect(Object.isFrozen(catalog.tools)).toBe(true);
    expect(Object.isFrozen(catalog.tools[0])).toBe(true);
    expect(Object.isFrozen(catalog.identity)).toBe(true);

    // describe() is still not asked again by a later read.
    void registry.catalog(minted.token);
    expect(spy.describeCallCount()).toBe(1);
  });

  it('mints nothing for a delegate that advertises no tools', () => {
    const registry = new McpLeaseRegistry();
    const empty = spyDelegate({ tools: [] });
    expect(registry.mint(fakeLease(), empty.delegate)).toBeNull();
  });

  it('fails mint loudly, before any token exists, on a malformed identity', () => {
    const registry = new McpLeaseRegistry();
    const broken: McpServerDelegate = {
      name: 'broken',
      describe: () => ({
        identity: { name: '', version: '1.0.0' },
        tools: [{ name: 't', inputSchema: { type: 'object' } }],
      }),
      call: async () => ({ ok: true, structured: {} }),
    };
    expect(() => registry.mint(fakeLease(), broken)).toThrow(/identity.name/);
  });
});

// ---------------------------------------------------------------------------
// End to end: native Agent -> stdio shim -> mcp.toolcall over a real admin
// socket -> McpLeaseRegistry -> delegate -> canonical result.
// ---------------------------------------------------------------------------

/** Run the real shim over an in-memory MCP transport, exactly as `connectMcpClient` expects. */
function serveShim(input: { lease: string; adminSocketPath: string }) {
  return (transport: Parameters<typeof runDreamuxMcp>[0]['transport']) =>
    runDreamuxMcp({
      lease: input.lease,
      adminSocketPath: input.adminSocketPath,
      transport,
      log: () => {},
    });
}

describe('runDreamuxMcp — end to end over a real admin socket', () => {
  it('advertises the frozen catalog and returns the delegate structured value plus its text', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const spy = spyDelegate({
        call: async (call) => ({
          ok: true,
          structured: { echoed: call.arguments['value'] },
          text: 'said it back',
        }),
      });
      const minted = harness.mcpLeases.mint(fakeLease(), spy.delegate)!;

      const connection = await connectMcpClient(serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }));
      try {
        const tools = await listedTools(connection.client);
        expect(tools.map((t) => t.name)).toEqual(['echo_tool']);

        const result = await callTool(connection.client, 'echo_tool', { value: 'hi' });
        expect(result).toEqual({
          content: [{ type: 'text', text: 'said it back' }],
          structuredContent: { echoed: 'hi' },
        });
      } finally {
        await connection.close();
      }
    } finally {
      await admin.close();
    }
  });

  it('surfaces a delegate-approved refusal verbatim through mcp.toolcall', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const spy = spyDelegate({
        call: async () => ({ ok: false, message: 'that Team is closed' }),
      });
      const minted = harness.mcpLeases.mint(fakeLease(), spy.delegate)!;
      const connection = await connectMcpClient(serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }));
      try {
        const result = await callTool(connection.client, 'echo_tool', { value: 'x' });
        expect(result).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: 'that Team is closed' }],
        });
      } finally {
        await connection.close();
      }
    } finally {
      await admin.close();
    }
  });

  it('carries an unclassified delegate failure to the model under its own message', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const spy = spyDelegate({
        call: async () => {
          throw new Error('internal stack trace with a secret path /Users/ops/.dreamux');
        },
      });
      const minted = harness.mcpLeases.mint(fakeLease(), spy.delegate)!;
      const connection = await connectMcpClient(serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }));
      try {
        const result = await callTool(connection.client, 'echo_tool', { value: 'x' });
        expect(result.isError).toBe(true);
        const text = (result.content as { text?: string }[])[0]?.text ?? '';
        // Core does not own this failure, so it reports the code it assigns and
        // repeats the only concrete fact anybody has: the message itself.
        expect(text).toBe(
          'INTERNAL: internal stack trace with a secret path /Users/ops/.dreamux',
        );
      } finally {
        await connection.close();
      }
    } finally {
      await admin.close();
    }
  });

  it('revokes mid-session: the next call fails before the delegate is dispatched again, and the model reads the revocation as its own fact', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const spy = spyDelegate();
      const minted = harness.mcpLeases.mint(fakeLease(), spy.delegate)!;
      const connection = await connectMcpClient(serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }));
      try {
        await callTool(connection.client, 'echo_tool', { value: 'first' });
        expect(spy.calls).toHaveLength(1);

        harness.mcpLeases.release([minted.token]);

        const result = await callTool(connection.client, 'echo_tool', { value: 'second' });
        expect(result.isError).toBe(true);
        const text = (result.content as { text?: string }[])[0]?.text ?? '';
        expect(text).toMatch(/^MCP_LEASE_REVOKED: /);
        expect(text).toContain('agent runtime generation ended');
        // The revoked lease failed admission before the delegate ran again.
        expect(spy.calls).toHaveLength(1);
      } finally {
        await connection.close();
      }
    } finally {
      await admin.close();
    }
  });

  it('never comes up for an unknown/revoked token: describe fails before the transport is ever used', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const [, serverTransport] = InMemoryTransport.createLinkedPair();
      await expect(
        runDreamuxMcp({
          lease: 'token-nobody-ever-minted',
          adminSocketPath: admin.socketPath,
          transport: serverTransport,
          log: () => {},
        }),
      ).rejects.toMatchObject({ code: 'MCP_LEASE_REVOKED' } satisfies Partial<AdminClientError>);
    } finally {
      await admin.close();
    }
  });

  it('rejects synchronously with no lease token, touching neither the socket nor a transport', async () => {
    await expect(runDreamuxMcp({ lease: '' })).rejects.toThrow(/requires a lease token/);
  });

  it('reports the transport failure it observed when the admin socket disappears mid-session', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    const spy = spyDelegate();
    const minted = harness.mcpLeases.mint(fakeLease(), spy.delegate)!;
    const connection = await connectMcpClient(serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }));
    try {
      // describe() already happened while the socket was up; now it is gone.
      await admin.close();
      const result = await callTool(connection.client, 'echo_tool', { value: 'x' });
      expect(result).toMatchObject({ isError: true });
      const text = (result.content as { text?: string }[])[0]?.text ?? '';
      // The one failure this process observes for itself keeps its own code and
      // the words Node wrote. An absent socket says ENOENT; restating that as
      // advice would replace the only concrete fact there is.
      expect(text).toMatch(/^TRANSPORT_ERROR: /);
      expect(text).toContain(`connect ENOENT ${admin.socketPath}`);
      expect(text).not.toMatch(/is the server running/);
      expect(spy.calls).toHaveLength(0); // the call never reached the delegate at all
    } finally {
      await connection.close();
    }
  });

  it('cannot forge routing identity through tool arguments: token/dispatcher-shaped fields travel as opaque data only', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const legitimate = spyDelegate({
        name: 'legit',
        // Deliberately open (no `additionalProperties: false`): the point of
        // this test is that arguments are opaque data to the routing layer no
        // matter what a tool's own schema permits, not that a closed schema
        // happens to reject the forged fields first.
        tools: [{ name: 'echo_tool', inputSchema: { type: 'object' } }],
        call: async (call) => ({ ok: true, structured: { servedBy: 'legit', arguments: call.arguments } }),
      });
      const other = spyDelegate({ name: 'other' });
      const legitimateMinted = harness.mcpLeases.mint(fakeLease(), legitimate.delegate)!;
      harness.mcpLeases.mint(fakeLease(), other.delegate); // a second, unrelated live generation

      const connection = await connectMcpClient(
        serveShim({ lease: legitimateMinted.token, adminSocketPath: admin.socketPath }),
      );
      try {
        // A model-controlled argument bag can contain anything, including
        // fields that look like routing identity. McpDelegateCall has no
        // context field for them to land in, so they are just data.
        const forgedArguments = {
          value: 'hi',
          token: 'other-server-token-attempt',
          dispatcher_id: 'attacker-dispatcher',
          caller: { kind: 'dispatcher' },
        };
        const result = await callTool(connection.client, 'echo_tool', forgedArguments);
        expect(result.structuredContent).toEqual({
          servedBy: 'legit',
          arguments: forgedArguments,
        });
      } finally {
        await connection.close();
      }
      // The forged fields never caused the *other* live delegate to be reached.
      expect(other.calls).toEqual([]);
    } finally {
      await admin.close();
    }
  });
});
