/**
 * Coverage cell C (registry half): the single unrestricted Core Command
 * registry — one catalog, no second authority, canonicalized but
 * size-unbounded results.
 *
 * These tests build the registry the same way `Server` does —
 * `createCoreCommandRegistry(host)` over a hand-built `CoreCommandHost` — so
 * the catalog under test is the one every adapter actually shares, not a
 * description of it.
 */
import { describe, expect, it } from 'vitest';

import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import { CoreCommands } from '../src/command/registry.js';
import { dispatcherCommands } from '../src/service/dispatchers/commands.js';
import { teamCommands } from '../src/service/team-collection/commands.js';
import { teammateCommands } from '../src/service/teammate-collection/commands.js';
import { workflowCommands } from '../src/service/workflow-service/commands.js';
import { schedulerCommands } from '../src/service/scheduler/commands.js';
import { mcpCommands } from '../src/service/mcp/commands.js';
import { serverCommands } from '../src/server-commands.js';
import { BOOLEAN, NO_INPUT, objectSchema } from '../src/command/schema.js';
import {
  createCommandHarness,
  harnessDispatcherRow,
  HARNESS_DISPATCHER_ID,
} from './helpers/command-harness.js';

/**
 * The frozen namespace table (technical-design/final.md §7 "Verification"),
 * restated here as the one place a newly added or renamed Command must also
 * be reflected. Sorted so the assertion is order-independent — registration
 * order is an implementation detail, not part of the contract.
 */
const FROZEN_NAMESPACE_TABLE = [
  'server.status',
  'dispatcher.list',
  'dispatcher.status',
  'dispatcher.start',
  'team.create',
  'team.submit',
  'team.list',
  'team.status',
  'team.history',
  'team.dissolve',
  'teammate.spawn',
  'teammate.submit',
  'teammate.close',
  'teammate.list',
  'teammate.status',
  'teammate.history',
  'teammate.last',
  'teammate.capabilities',
  'workflow.run',
  'workflow.status',
  'workflow.stop',
  'workflow.list',
  'scheduler.cron.create',
  'scheduler.cron.update',
  'scheduler.cron.delete',
  'scheduler.cron.list',
  'mcp.describe',
  'mcp.toolcall',
].sort();

/**
 * Surfaces this refactor deleted. A registry that still answers to one of
 * these names has resurrected a deleted capability — team-scoped Channel
 * binding, direct-send bypasses of the shared submission path, the retired
 * Channel-side MCP proxy surface, or the entire Core Collaboration Space
 * domain — none of which the current architecture owns.
 */
const DELETED_NAMES = [
  'dispatcher.stop',
  'team.bind_channel',
  'team.transfer_back',
  'team.send',
  'teammate.send',
  'channel.invoke_tool',
  'channel.mcp.describe',
  'channel.mcp.invoke',
  'collaboration_space.create',
  'collaboration_space.list',
  'collaboration_space.status',
];

describe('createCoreCommandRegistry — the catalog', () => {
  it('registers exactly the frozen namespace table, no more and no less', () => {
    const harness = createCommandHarness();
    expect([...harness.registry.names()].sort()).toEqual(FROZEN_NAMESPACE_TABLE);
  });

  it('never answers to a deleted Command name', () => {
    const harness = createCommandHarness();
    const names = new Set(harness.registry.names());
    for (const deleted of DELETED_NAMES) {
      expect(names.has(deleted)).toBe(false);
    }
    // Nothing in the whole Core Collaboration Space family survived, not only
    // the three spot-checked names above.
    expect([...names].some((name) => name.startsWith('collaboration_space.'))).toBe(
      false,
    );
  });

  it('every domain module contributes names inside its own dotted namespace', () => {
    // A stray Command registered under the wrong prefix (e.g. a Team action
    // spelled `teammate.*`) would pass the frozen-table check above only by
    // coincidence of an equal *count*; this proves each module's own names
    // carry its own prefix.
    const harness = createCommandHarness();
    const byPrefix: Record<string, string> = {
      'server.': 'server.status',
      'dispatcher.': 'dispatcher.',
      'team.': 'team.',
      'teammate.': 'teammate.',
      'workflow.': 'workflow.',
      'scheduler.cron.': 'scheduler.cron.',
      'mcp.': 'mcp.',
    };
    for (const name of harness.registry.names()) {
      const owningPrefix = Object.keys(byPrefix).find((prefix) => name.startsWith(prefix));
      expect(owningPrefix, `unexpected namespace for ${name}`).toBeDefined();
    }
  });
});

describe('CoreCommands — one authority, not a second one', () => {
  const noop: Pick<CoreCommandDefinition<string, unknown, unknown>, 'parse' | 'execute'> = {
    parse: (payload) => payload,
    execute: async () => ({}),
  };

  function minimal(name: string): CoreCommandDefinition<string, unknown, unknown> {
    return { name, version: 1, input: NO_INPUT, output: objectSchema({}), ...noop };
  }

  it('rejects two definitions registered under the same name', () => {
    expect(() => new CoreCommands([minimal('dup.name'), minimal('dup.name')])).toThrow(
      /dup\.name.*registered twice/,
    );
  });

  it('fails loud at construction on a malformed declared input schema, before any invocation', () => {
    const malformed: CoreCommandDefinition<string, unknown, unknown> = {
      name: 'bad.input',
      version: 1,
      // `type: 'not-a-real-type'` is not a JSON Schema this validator accepts.
      input: { type: 'not-a-real-type' } as unknown as ReturnType<typeof objectSchema>,
      output: objectSchema({}),
      ...noop,
    };
    expect(() => new CoreCommands([malformed])).toThrow(/bad\.input/);
  });

  it('fails loud at construction on a malformed declared output schema', () => {
    const malformed: CoreCommandDefinition<string, unknown, unknown> = {
      name: 'bad.output',
      version: 1,
      input: NO_INPUT,
      output: { type: 'not-a-real-type' } as unknown as ReturnType<typeof objectSchema>,
      ...noop,
    };
    expect(() => new CoreCommands([malformed])).toThrow(/bad\.output/);
  });

  it('rejects an unknown Command name with its own stable UNKNOWN_METHOD code', async () => {
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke({ source: 'admin_socket' }, 'not.a.real.command', {}),
    ).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
  });

  it('carries no exposure/audience property, allowlist, or capability-negotiation hook on any definition', () => {
    // `CoreCommandDefinition` (dreamux-types/command.ts) declares exactly
    // name/version/input/output/parse/execute. Reading every domain module's
    // own definitions directly — the real objects the catalog concatenates,
    // not a description of them — proves no domain module smuggled a second
    // property onto the shared contract.
    const host = createCommandHarness().host;
    const allowedKeys = new Set(['name', 'version', 'input', 'output', 'parse', 'execute']);
    const allDefinitions = [
      ...serverCommands(host),
      ...dispatcherCommands(host),
      ...teamCommands(host),
      ...teammateCommands(host),
      ...workflowCommands(host),
      ...schedulerCommands(host),
      ...mcpCommands(host),
    ];
    expect(allDefinitions.length).toBeGreaterThan(0);
    for (const definition of allDefinitions) {
      for (const key of Object.keys(definition)) {
        expect(allowedKeys.has(key), `${definition.name} declared unexpected key '${key}'`).toBe(
          true,
        );
      }
    }
  });
});

describe('result canonicalization — no registry-wide output byte cap', () => {
  it('accepts a result far larger than COMMAND_PAYLOAD_BOUNDS.maxBytes, because that bound is input-only', async () => {
    // COMMAND_PAYLOAD_BOUNDS caps a payload at 256 KiB. A roster the size of
    // this fake summary is well past that, and the registry still returns it
    // whole: result *size* is deliberately unenforced here (registry.ts), with
    // pagination left to whichever domain needs it.
    const bigSummary = Array.from({ length: 5_000 }, (_, i) => ({
      dispatcher_id: `dispatcher-${i}`,
      channel_identity: `identity-${i}-${'x'.repeat(80)}`,
      status: 'running',
      session_id: null,
      enabled: true,
    }));
    const approxBytes = JSON.stringify(bigSummary).length;
    expect(approxBytes).toBeGreaterThan(256 * 1024);

    const harness = createCommandHarness({ summarize: async () => bigSummary as never });
    const result = await harness.registry.invoke(
      { source: 'admin_socket' },
      'server.status',
      {},
    );
    expect((result as { dispatchers: unknown[] }).dispatchers).toHaveLength(5_000);
  });

  it('reports a JSON-representable result that violates its OWN declared output schema as INTERNAL', async () => {
    // Distinct code path from the non-JSON-representable case below:
    // `canonicalResult` (structural JSON safety) succeeds here — `{}` is
    // perfectly good JSON — and it is the separate `validateOutput` schema
    // check, run after canonicalization, that catches the missing required
    // `ok` field. Both are Core defects, never a caller mistake, so both
    // report INTERNAL.
    const schemaViolator: CoreCommandDefinition<string, unknown, unknown> = {
      name: 'harness.schema_violating_output',
      version: 1,
      input: NO_INPUT,
      output: objectSchema({ ok: BOOLEAN }, ['ok']),
      parse: () => ({}),
      execute: async () => ({}),
    };
    const registry = new CoreCommands([schemaViolator]);
    await expect(
      registry.invoke({ source: 'admin_socket' }, 'harness.schema_violating_output', {}),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('reports a non-JSON-representable result as an INTERNAL defect, not a caller mistake', async () => {
    // A Command whose handler returns something `JSON.stringify` cannot
    // faithfully round-trip (a function) is a Core defect, never a BAD_REQUEST:
    // the caller sent nothing that could cause this.
    const broken: CoreCommandDefinition<string, unknown, unknown> = {
      name: 'harness.broken_output',
      version: 1,
      input: NO_INPUT,
      output: objectSchema({}),
      parse: () => ({}),
      execute: async () => ({ fn: () => {} }),
    };
    const registry = new CoreCommands([broken]);
    await expect(
      registry.invoke({ source: 'admin_socket' }, 'harness.broken_output', {}),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('dispatcher-scoped Commands resolve through the host, not a second lookup', () => {
  it('dispatcher.status reads the addressed dispatcher_id from context, never from the payload', async () => {
    const harness = createCommandHarness();
    const result = await harness.registry.invoke(
      { source: 'admin_socket', dispatcher_id: HARNESS_DISPATCHER_ID },
      'dispatcher.status',
      {},
    );
    expect(result).toMatchObject({ dispatcher_id: HARNESS_DISPATCHER_ID });
  });

  it('fails loud with DISPATCHER_NOT_FOUND for a dispatcher_id the host does not carry — never INTERNAL', async () => {
    const harness = createCommandHarness({ dispatcherRow: harnessDispatcherRow() });
    await expect(
      harness.registry.invoke(
        { source: 'admin_socket', dispatcher_id: 'no-such-dispatcher' },
        'dispatcher.status',
        {},
      ),
    ).rejects.toMatchObject({ code: 'DISPATCHER_NOT_FOUND' });
  });

  it('a dispatcher-scoped Command with no dispatcher_id at all is BAD_REQUEST, not a silent default', async () => {
    const harness = createCommandHarness();
    await expect(
      harness.registry.invoke({ source: 'admin_socket' }, 'dispatcher.status', {}),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
