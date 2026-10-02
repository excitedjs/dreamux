/**
 * Coverage for the Agent-facing MCP admission edge (mcp/leases.ts): membership
 * admission, immutability-per-generation, and revocation, exercised directly
 * against `McpLeaseRegistry` with hand-built spy delegates — properties of the
 * registry alone that need neither a real Command nor a real socket to prove.
 */
import { describe, expect, it } from 'vitest';

import {
  McpLeaseRegistry,
  McpLeaseRevokedError,
} from '../src/service/mcp/leases.js';
import type {
  McpDelegateCall,
  McpDelegateResult,
  McpServerDelegate,
} from '../src/service/mcp/types.js';

/**
 * An `AgentRuntimeGenerationLease`-shaped fake. Every registry code path this
 * file exercises reads only `isCurrent()`; the leased state sink is never
 * touched by mint/catalog/invoke/release, so this narrow shape is honest, not
 * a shortcut.
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
      call: async (call) => ({
        ok: true,
        structured: { echoed: call.arguments },
      }),
    });
    const minted = registry.mint(fakeLease(), spy.delegate);
    const result = await registry.invoke(minted!.token, {
      name: 'echo_tool',
      arguments: { value: 'hi' },
    });
    expect(result).toEqual({
      ok: true,
      structured: { echoed: { value: 'hi' } },
    });
    expect(spy.calls).toEqual([
      { name: 'echo_tool', arguments: { value: 'hi' } },
    ]);
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
    expect(() =>
      registry.release([minted.token, 'never-issued']),
    ).not.toThrow();
  });

  it('a stale generation alone revokes admission, without an explicit release() call', () => {
    const registry = new McpLeaseRegistry();
    let current = true;
    const minted = registry.mint(
      fakeLease(() => current),
      spyDelegate().delegate,
    )!;
    expect(() => registry.catalog(minted.token)).not.toThrow();
    current = false;
    expect(() => registry.catalog(minted.token)).toThrow(McpLeaseRevokedError);
  });

  it('two independently-leased generations are isolated: revoking one leaves the other admitting', async () => {
    const registry = new McpLeaseRegistry();
    let generationOneCurrent = true;
    const one = registry.mint(
      fakeLease(() => generationOneCurrent),
      spyDelegate({ name: 's1' }).delegate,
    )!;
    const two = registry.mint(
      fakeLease(() => true),
      spyDelegate({ name: 's2' }).delegate,
    )!;
    generationOneCurrent = false;
    expect(() => registry.catalog(one.token)).toThrow(McpLeaseRevokedError);
    expect(() => registry.catalog(two.token)).not.toThrow();
  });

  it('mints nothing for a delegate that advertises no tools', () => {
    const registry = new McpLeaseRegistry();
    const empty = spyDelegate({ tools: [] });
    expect(registry.mint(fakeLease(), empty.delegate)).toBeNull();
  });
});
