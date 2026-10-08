import { InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { AdminClientError } from '../src/admin/client.js';
import { runDreamuxMcp } from '../src/mcp/shim.js';
import { McpLeaseRegistry } from '../src/service/mcp/leases.js';
import type {
  McpDelegateCall,
  McpDelegateResult,
  McpServerDelegate,
} from '../src/service/mcp/types.js';
import {
  callTool,
  connectMcpClient,
  listedTools,
} from './helpers/mcp-client.js';
import {
  createCommandHarness,
  startHarnessAdminSocket,
} from './helpers/mcp-command-harness.js';

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

function spyDelegate(
  input: {
    name?: string;
    tools?: unknown[];
    call?: (call: McpDelegateCall) => Promise<McpDelegateResult>;
  } = {},
): Spy {
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
      return { tools };
    },
    call: async (call) => {
      calls.push(call);
      return (input.call ?? (async () => ({ ok: true, structured: {} })))(call);
    },
  };
  return { delegate, calls, describeCallCount: () => describeCalls };
}

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

      const connection = await connectMcpClient(
        serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }),
      );
      try {
        const tools = await listedTools(connection.client);
        expect(tools.map((t) => t.name)).toEqual(['echo_tool']);

        const result = await callTool(connection.client, 'echo_tool', {
          value: 'hi',
        });
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
      const connection = await connectMcpClient(
        serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }),
      );
      try {
        const result = await callTool(connection.client, 'echo_tool', {
          value: 'x',
        });
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
          throw new Error(
            'internal stack trace with a secret path /Users/ops/.dreamux',
          );
        },
      });
      const minted = harness.mcpLeases.mint(fakeLease(), spy.delegate)!;
      const connection = await connectMcpClient(
        serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }),
      );
      try {
        const result = await callTool(connection.client, 'echo_tool', {
          value: 'x',
        });
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
      const connection = await connectMcpClient(
        serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }),
      );
      try {
        await callTool(connection.client, 'echo_tool', { value: 'first' });
        expect(spy.calls).toHaveLength(1);

        harness.mcpLeases.release([minted.token]);

        const result = await callTool(connection.client, 'echo_tool', {
          value: 'second',
        });
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
      ).rejects.toMatchObject({
        code: 'MCP_LEASE_REVOKED',
      } satisfies Partial<AdminClientError>);
    } finally {
      await admin.close();
    }
  });

  it('rejects synchronously with no lease token, touching neither the socket nor a transport', async () => {
    await expect(runDreamuxMcp({ lease: '' })).rejects.toThrow(
      /requires a lease token/,
    );
  });

  it('reports the transport failure it observed when the admin socket disappears mid-session', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    const spy = spyDelegate();
    const minted = harness.mcpLeases.mint(fakeLease(), spy.delegate)!;
    const connection = await connectMcpClient(
      serveShim({ lease: minted.token, adminSocketPath: admin.socketPath }),
    );
    try {
      // describe() already happened while the socket was up; now it is gone.
      await admin.close();
      const result = await callTool(connection.client, 'echo_tool', {
        value: 'x',
      });
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
        call: async (call) => ({
          ok: true,
          structured: { servedBy: 'legit', arguments: call.arguments },
        }),
      });
      const other = spyDelegate({ name: 'other' });
      const legitimateMinted = harness.mcpLeases.mint(
        fakeLease(),
        legitimate.delegate,
      )!;
      harness.mcpLeases.mint(fakeLease(), other.delegate); // a second, unrelated live generation

      const connection = await connectMcpClient(
        serveShim({
          lease: legitimateMinted.token,
          adminSocketPath: admin.socketPath,
        }),
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
        const result = await callTool(
          connection.client,
          'echo_tool',
          forgedArguments,
        );
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
