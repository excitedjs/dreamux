/**
 * The sole stdio MCP transport and tool-registration owner.
 *
 * This module is the one place Dreamux talks to the official
 * `@modelcontextprotocol/server` SDK for stdio serving. It receives a server
 * identity, an already caller-bound tool catalog (metadata plus handler
 * closures), an optional injected transport, and an out-of-band logger. It
 * constructs a fresh official `McpServer` for whichever protocol era
 * `serveStdio` selects, registers every tool from the same catalog, and lets
 * the SDK own protocol parsing, schema validation, version negotiation, modern
 * discovery/metadata, cancellation, and JSON-RPC error framing.
 *
 * It deliberately imports no admin, service, Channel provider, or caller-scope
 * types: the caller binds scope into the handler closures before handing the
 * catalog here. It never hand-writes a JSON-RPC envelope, protocol version
 * field, discovery result, or protocol error.
 */
import type { Readable, Writable } from 'node:stream';

import {
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
  type CallToolResult,
  type Icon,
  type ToolAnnotations,
  type McpServer as McpServerType,
  type Transport,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';

/**
 * The exact ordered set of official MCP revisions Dreamux serves. Modern
 * (`2026-07-28`) traffic is negotiated through `server/discover`; the two
 * legacy revisions are negotiated through the official `initialize` handshake.
 * The list is intentionally narrower than the SDK's broader default so a newly
 * added SDK-global revision stays unsupported until this contract is revised.
 */
export const DREAMUX_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
];

/**
 * The fixed, model-safe text emitted for any tool failure that a domain
 * adapter did not explicitly mark as a public error. It carries no admin code,
 * provider message, or internal detail.
 */
export const SANITIZED_TOOL_ERROR =
  'The tool call could not be completed. See the Dreamux server logs for details.';

/**
 * A domain-adapter-approved, model-facing tool execution error. A domain MCP
 * adapter throws this from a handler when it has mapped a specific admin or
 * provider failure to a safe public message. The shared executor formats it as
 * an `isError` tool result with that message and no `structuredContent`. Any
 * other thrown value is logged in full out of band and becomes
 * {@link SANITIZED_TOOL_ERROR}.
 */
export class PublicToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicToolError';
  }
}

/**
 * The canonical public value a tool handler resolves with. It is validated
 * against the advertised `outputSchema` (when present) by the SDK and returned
 * unchanged as `structuredContent`.
 */
export type McpToolResult = Record<string, unknown>;

/** A handler for one registered tool, receiving SDK-validated arguments. */
export type McpToolHandler = (
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

/**
 * Tool advertisement metadata, the neutral JSON-Schema-backed descriptor a
 * domain module produces for both `tools/list` inspection tests and runner
 * registration. `inputSchema` and `outputSchema` are JSON Schema objects; the
 * runner wraps them through the SDK's `fromJsonSchema` adapter so the same
 * schema advertises and validates.
 */
export interface McpToolMetadata {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The canonical successful public result schema. Optional only at the
   * neutral Channel provider seam (MCP permits its omission and existing
   * external providers must remain loadable); every Dreamux-owned tool and
   * every built-in Channel provider tool supplies one.
   */
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  icons?: Icon[];
}

/** A fully bound tool: advertisement metadata plus its execution policy. */
export interface McpToolDefinition extends McpToolMetadata {
  handler: McpToolHandler;
  /** Optional operation-local text selected from the projected success value. */
  successText?: (result: McpToolResult) => string | undefined;
  /**
   * Fixed out-of-band diagnostic for failures whose upstream error may carry
   * private provider or filesystem detail. Public output remains sanitized.
   */
  failureLogMessage?: string | ((error: unknown) => string | undefined);
}

export interface McpServerIdentity {
  name: string;
  version: string;
}

export interface RunMcpServerOptions {
  identity: McpServerIdentity;
  /** Caller-bound, deterministically ordered tool catalog. */
  tools: readonly McpToolDefinition[];
  /**
   * An injected transport (e.g. an official linked in-memory transport in
   * tests). When provided, the transport owns its own lifecycle and the runner
   * does not attach input-end shutdown.
   */
  transport?: Transport;
  /** Input stream for the default stdio transport. Defaults to `process.stdin`. */
  input?: Readable;
  /** Output stream for the default stdio transport. Defaults to `process.stdout`. */
  output?: Writable;
  /** Out-of-band logger. Diagnostics never reach the MCP wire. */
  log?: (message: string) => void;
}

/**
 * A thin transport wrapper that forwards every operation to an inner transport
 * while exposing a `whenClosed` promise the runner awaits for deterministic
 * shutdown. `serveStdio` owns the transport it is handed (it sets the message,
 * error, and close callbacks and drives `start`/`send`/`close`), so this
 * wrapper bridges the inner transport's callbacks up to whatever `serveStdio`
 * installs and resolves `whenClosed` when the connection ends from either side.
 */
class ObservableTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?:
    | (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void)
    | undefined;

  private closed = false;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  readonly whenClosed: Promise<void>;

  constructor(private readonly inner: Transport) {
    this.whenClosed = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => {
      this.finish();
      this.onclose?.();
    };
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  async start(): Promise<void> {
    try {
      await this.inner.start();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async send(
    message: JSONRPCMessage,
    options?: Parameters<Transport['send']>[1],
  ): Promise<void> {
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    try {
      await this.inner.close();
    } finally {
      this.finish();
    }
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectClosed(error instanceof Error ? error : new Error(String(error)));
  }
}

function buildMcpServer(
  identity: McpServerIdentity,
  tools: readonly McpToolDefinition[],
  log: (message: string) => void,
): McpServerType {
  const server = new McpServer(
    { name: identity.name, version: identity.version },
    {
      capabilities: { tools: {} },
      supportedProtocolVersions: [...DREAMUX_SUPPORTED_PROTOCOL_VERSIONS],
    },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
        ...(tool.outputSchema !== undefined
          ? { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType) }
          : {}),
        ...(tool.annotations !== undefined
          ? { annotations: tool.annotations }
          : {}),
        ...(tool.icons !== undefined ? { icons: tool.icons } : {}),
      },
      (args) => executeTool(tool, args as Record<string, unknown>, log),
    );
  }
  return server;
}

/**
 * The single MCP-adapter-owned execution projector. It emits the handler's
 * canonical value as structured content, adds only text selected by that
 * definition's optional success policy, formats an explicitly public tool
 * error as an `isError` result, and turns every other failure into a fixed
 * sanitized error after emitting either the tool's bounded diagnostic or the
 * ordinary full out-of-band diagnostic. It never exposes a raw `Error.message`
 * to the model.
 */
async function executeTool(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  log: (message: string) => void,
): Promise<CallToolResult> {
  try {
    const value = await tool.handler(args);
    const successText = tool.successText?.(value);
    return {
      content:
        successText === undefined
          ? []
          : [{ type: 'text', text: successText }],
      structuredContent: value,
    };
  } catch (err) {
    if (err instanceof PublicToolError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    const failureLogMessage =
      typeof tool.failureLogMessage === 'function'
        ? tool.failureLogMessage(err)
        : tool.failureLogMessage;
    log(failureLogMessage ?? `tool '${tool.name}' failed: ${describeError(err)}`);
    return {
      content: [{ type: 'text', text: SANITIZED_TOOL_ERROR }],
      isError: true,
    };
  }
}

/**
 * Compile one raw JSON Schema through the same official SDK adapter used for
 * registration. Descriptor assembly uses this to fail before spawning a
 * channel MCP process when a provider publishes an invalid schema.
 */
export function validateMcpJsonSchema(
  schema: Record<string, unknown>,
  label: string,
): void {
  try {
    fromJsonSchema(schema as JsonSchemaType);
  } catch (err) {
    throw new Error(`${label} is not a valid JSON Schema: ${describeError(err)}`);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const prefix = typeof code === 'string' ? `[${code}] ` : '';
    return `${prefix}${err.stack ?? err.message}`;
  }
  return String(err);
}

/**
 * Serve a caller-bound MCP tool catalog over stdio through the official SDK.
 * Resolves when the connection ends: on input-stream EOF for the default or
 * custom-stream `StdioServerTransport`, or on transport close for an injected
 * transport (e.g. the in-memory pair used by tests).
 */
export async function runMcpServer(opts: RunMcpServerOptions): Promise<void> {
  const log = opts.log ?? ((message: string) => console.error(message));

  let inner: Transport;
  let inputForEof: Readable | undefined;
  if (opts.transport !== undefined) {
    inner = opts.transport;
  } else {
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    inner = new StdioServerTransport(input, output);
    inputForEof = input;
  }

  const transport = new ObservableTransport(inner);
  const handle = serveStdio(
    ({ era }) => {
      void era;
      return buildMcpServer(opts.identity, opts.tools, log);
    },
    {
      legacy: 'serve',
      transport,
      onerror: (error) => log(`mcp transport error: ${describeError(error)}`),
    },
  );

  if (inputForEof !== undefined) {
    // serveStdio owns the transport but never tears the connection down on
    // stdin EOF; the runner owns input-end shutdown so a closed input pipe
    // deterministically ends the server (process exit / awaited completion).
    const shutdown = (): void => {
      handle.close().catch((error) => log(`mcp shutdown error: ${describeError(error)}`));
    };
    inputForEof.once('end', shutdown);
    inputForEof.once('close', shutdown);
  }

  await transport.whenClosed;
}
