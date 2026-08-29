/**
 * The two Commands the generic MCP shim speaks, and the only two.
 *
 * They are the whole Core-side MCP transport: one to learn what to advertise,
 * one to run a call. Neither knows a business tool name, and adding an
 * Agent-facing tool anywhere in Dreamux never adds, widens, or renames a
 * Command here — that is the point of the delegate boundary.
 *
 * They are ordinary registered Commands, so they inherit the whole Command
 * contract for free: payload bounds, schema validation, JSON canonicalization,
 * and — the reason it matters most — the process shutdown fence. A tool call in
 * flight when the server begins shutting down is drained with every other
 * admitted Command; one that arrives after the fence is refused as
 * `SERVER_SHUTTING_DOWN` rather than reaching a half-torn-down dispatcher. The
 * narrower per-entity edge works the same way: both enter through the lease
 * registry, so a shim whose owner released it is refused here, before any
 * owning object is touched, while calls already past this point converge
 * through the admission gate the delegate itself dispatches under.
 *
 * A call is also admitted against the catalog its own token was minted with,
 * and that check belongs to the registry rather than to this file: proving a
 * name is one the token was granted is the same generic question for every
 * delegate, and answering it here would be a second place that has to agree
 * with the frozen catalog.
 *
 * They carry no `dispatcher_id`. Addressing, caller identity, and scope all
 * live in the lease the token resolves to, which is what keeps the shim
 * genuinely identity-free.
 */
import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import { ValidationError } from '../../command/errors.js';
import type { CoreCommandHost } from '../../command/host.js';
import { commandPayload, mustNonEmptyString } from '../../command/payload.js';
import type { AnyCoreCommand } from '../../command/registry.js';
import {
  ANY,
  BOOLEAN,
  NON_EMPTY_STRING,
  OBJECT,
  STRING,
  arrayOf,
  objectSchema,
} from '../../command/schema.js';
import type { McpDelegateResult } from './types.js';

/**
 * The maximum length of a lease token. Tokens are Core-minted UUIDs; the bound
 * exists so a hostile caller cannot make the registry hash an enormous string.
 */
const MAX_TOKEN_LENGTH = 128;

interface McpDescribeInput {
  token: string;
}

interface McpToolCallInput {
  token: string;
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}

interface McpDescribeResult {
  identity: { name: string; version: string };
  tools: readonly unknown[];
}

export function mcpCommands(host: CoreCommandHost): readonly AnyCoreCommand[] {
  const describe: CoreCommandDefinition<
    'mcp.describe',
    McpDescribeInput,
    McpDescribeResult
  > = {
    name: 'mcp.describe',
    version: 1,
    input: objectSchema({ token: NON_EMPTY_STRING }, ['token']),
    output: objectSchema(
      {
        identity: objectSchema({ name: STRING, version: STRING }, [
          'name',
          'version',
        ]),
        // Opaque to the Command layer by design. These descriptors were
        // validated structurally against the official SDK at mint time; no
        // schema here should have to mirror the MCP descriptor shape.
        tools: arrayOf(OBJECT),
      },
      ['identity', 'tools'],
    ),
    parse(payload) {
      return { token: token(payload) };
    },
    async execute(_context, input) {
      // The catalog was already asked for, validated, and frozen when this
      // token was minted — before the runtime that is now asking existed. The
      // delegate is deliberately not consulted again: serving the snapshot is
      // what makes "immutable for one generation" a fact rather than a rule a
      // delegate is trusted to keep.
      const catalog = host.mcpLeases.catalog(input.token);
      return {
        identity: {
          name: catalog.identity.name,
          version: catalog.identity.version,
        },
        tools: catalog.tools,
      };
    },
  };

  const toolcall: CoreCommandDefinition<
    'mcp.toolcall',
    McpToolCallInput,
    McpDelegateResult
  > = {
    name: 'mcp.toolcall',
    version: 1,
    input: objectSchema(
      {
        token: NON_EMPTY_STRING,
        name: NON_EMPTY_STRING,
        // Already validated against the tool's own advertised input schema by
        // the official SDK, on the shim side. Re-declaring those properties
        // here would be the second copy the Command layer exists to avoid.
        arguments: OBJECT,
      },
      ['token', 'name', 'arguments'],
    ),
    output: objectSchema(
      {
        ok: BOOLEAN,
        /** Present on success; the tool's own canonical public value. */
        structured: ANY,
        /** Present on success when the operation chose to say something. */
        text: STRING,
        /** Present on a delegate-approved public failure. */
        message: STRING,
      },
      ['ok'],
    ),
    parse(payload) {
      const params = commandPayload(payload);
      const args = params['arguments'];
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new ValidationError("param 'arguments' must be an object");
      }
      return {
        token: token(payload),
        name: mustNonEmptyString(params, 'name'),
        arguments: args as Readonly<Record<string, unknown>>,
      };
    },
    async execute(_context, input) {
      // No try/catch: an unclassified failure must fail the Command so Core
      // logs it in full and the shim can only report the sanitized error. A
      // delegate that wants a model to read a failure says so in its result.
      return host.mcpLeases.invoke(input.token, {
        name: input.name,
        arguments: input.arguments,
      });
    },
  };

  return [describe, toolcall] as unknown as readonly AnyCoreCommand[];
}

function token(payload: Parameters<typeof commandPayload>[0]): string {
  const value = mustNonEmptyString(commandPayload(payload), 'token');
  if (value.length > MAX_TOKEN_LENGTH) {
    throw new ValidationError(
      `param 'token' must be at most ${MAX_TOKEN_LENGTH} characters`,
    );
  }
  return value;
}
