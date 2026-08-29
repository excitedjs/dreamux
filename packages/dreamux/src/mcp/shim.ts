/**
 * The one Agent-facing MCP stdio shim.
 *
 * It replaces five scoped shims that each knew a dispatcher id, a caller kind,
 * a Team, a tool catalog, an admin-method map, and a public-error allowlist.
 * This one knows none of that, and structurally cannot: everything it is given
 * is an admin socket to reach and an opaque lease token to present.
 *
 * Start-up asks `mcp.describe` what to advertise and registers it. Every call
 * forwards `{name, arguments}` to `mcp.toolcall` under the same token. There is
 * no branch on a tool name anywhere in this file — adding, removing, or
 * renaming an Agent-facing tool never touches it.
 *
 * Both are ordinary Commands over the shared JSON invoker, and this file is the
 * only place their answers become MCP. Everything below it — the invoker, the
 * socket, the two Commands, the delegate — is transport and domain code that
 * has never heard of the MCP SDK; everything above it is the SDK. A tool result
 * and a refusal the delegate published cross that line as data and are mapped
 * here, once.
 *
 * The catalog is re-validated here, but only defensively. Core already proved
 * it, against this same SDK adapter, before the runtime that spawned this
 * process existed; a malformed catalog therefore fails a launch rather than a
 * child. What this pass actually guards is the wire: bytes that arrived over a
 * socket are not the object Core validated, and this is the last place to say
 * so before handing them to the SDK.
 *
 * Diagnostics go out of band to stderr. The authoritative detail for a failed
 * tool call is in the server log, because the delegate that failed runs there;
 * what reaches the model is the delegate's own approved message or the fixed
 * sanitized error.
 */
import type { Readable, Writable } from 'node:stream';

import type { JsonInvoker, JsonValue } from '@excitedjs/dreamux-types';

import { adminJsonInvoker } from '../admin/client.js';
import { TransportError } from '../platform/errors.js';
import { validateMcpToolCatalog } from './catalog.js';
import {
  PublicToolError,
  runMcpServer,
  type McpServerIdentity,
  type McpToolDefinition,
  type McpToolOutcome,
  type RunMcpServerOptions,
} from './server.js';

export interface DreamuxMcpShimOptions {
  /** The opaque lease token this server presents on every request. */
  lease: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  transport?: RunMcpServerOptions['transport'];
  log?: (message: string) => void;
}

/**
 * The one public sentence for a conduit that never reached the server.
 *
 * A caller told only "the tool failed" retries a request that cannot succeed,
 * so the model is told the one actionable thing instead. It is projected here
 * rather than by any delegate because only this process can observe it: from
 * the server's side, a request that never arrived did not happen. The wording
 * carries no socket path or host detail — that is operator diagnosis, and it
 * stays in the stderr diagnostics.
 */
const TRANSPORT_PUBLIC_MESSAGE =
  'the Dreamux server is not reachable right now; ask the operator to check ' +
  'that it is running, then retry';

export async function runDreamuxMcp(opts: DreamuxMcpShimOptions): Promise<void> {
  if (opts.lease === '') {
    throw new Error('the Dreamux MCP shim requires a lease token');
  }
  const core = adminJsonInvoker(
    opts.adminSocketPath !== undefined
      ? { socketPath: opts.adminSocketPath }
      : {},
  );
  // Fail loud before serving anything: a server that cannot learn its own
  // catalog must not come up advertising an empty one.
  const description = await describe(core, opts.lease);
  // Defensive, not authoritative — see the module note.

  const tools = validateMcpToolCatalog(
    description.tools,
    `${description.identity.name} tool catalog`,
  );
  await runMcpServer({
    identity: description.identity,
    tools: tools.map(
      (tool): McpToolDefinition => ({
        ...tool,
        handler: (args) => callTool(core, opts.lease, tool.name, args),
      }),
    ),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

async function describe(
  core: JsonInvoker,
  lease: string,
): Promise<{ identity: McpServerIdentity; tools: readonly unknown[] }> {
  const result = asRecord(
    await core.invoke('mcp.describe', { token: lease }),
    'mcp.describe result',
  );
  const identity = asRecord(result['identity'], 'mcp.describe identity');
  const name = identity['name'];
  const version = identity['version'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('mcp.describe identity.name must be a non-empty string');
  }
  if (typeof version !== 'string' || version === '') {
    throw new Error('mcp.describe identity.version must be a non-empty string');
  }
  const tools = result['tools'];
  if (!Array.isArray(tools)) {
    throw new Error('mcp.describe tools must be an array');
  }
  return { identity: { name, version }, tools };
}

/**
 * Forward one call and unwrap the delegate's envelope.
 *
 * The envelope has exactly two shapes because the delegate had exactly two
 * choices: a result the model reads, or a message the delegate decided the
 * model may read. Everything else already failed the Command, so it arrives
 * here as a server-reported error that is deliberately *not* translated —
 * rethrowing it lets the shared executor log it and answer with the fixed
 * sanitized error, which is the only correct answer for a failure nobody
 * approved.
 */
async function callTool(
  core: JsonInvoker,
  lease: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolOutcome> {
  let result: unknown;
  try {
    result = await core.invoke('mcp.toolcall', {
      token: lease,
      name,
      // They arrived as JSON on stdin and are forwarded unchanged.
      arguments: args as Record<string, JsonValue>,
    });
  } catch (error) {
    if (error instanceof TransportError) {
      throw new PublicToolError(TRANSPORT_PUBLIC_MESSAGE);
    }
    throw error;
  }
  const envelope = asRecord(result, `tool '${name}' result`);
  if (envelope['ok'] !== true) {
    const message = envelope['message'];
    if (typeof message !== 'string' || message === '') {
      throw new Error(
        `tool '${name}' reported a failure with no public message`,
      );
    }
    throw new PublicToolError(message);
  }
  const structured = asRecord(envelope['structured'], `tool '${name}' value`);
  const text = envelope['text'];
  return {
    structured,
    ...(typeof text === 'string' && text !== '' ? { text } : {}),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
