import { PassThrough } from 'node:stream';

import {
  Client,
  InMemoryTransport,
  ProtocolErrorCode,
  UnsupportedProtocolVersionError,
  type JSONRPCMessage,
} from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  DREAMUX_SUPPORTED_PROTOCOL_VERSIONS,
  runMcpServer,
  type McpToolDefinition,
} from '../src/mcp/server.js';
import { callTool, connectMcpClient, listedTools } from './helpers/mcp-client.js';

const ECHO_TOOL: McpToolDefinition = {
  name: 'echo',
  title: 'Echo value',
  description: 'Return the validated value.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string', minLength: 2 } },
    required: ['value'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { echoed: { type: 'string', minLength: 2 } },
    required: ['echoed'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => ({ structured: { echoed: args['value'] } }),
};

function serve(
  transport: Parameters<typeof runMcpServer>[0]['transport'],
  tools: readonly McpToolDefinition[] = [ECHO_TOOL],
): Promise<void> {
  if (transport === undefined) throw new Error('test transport is required');
  return runMcpServer({
    identity: { name: 'dreamux-conformance-test', version: '1.0.0' },
    tools,
    transport,
    log: () => {},
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('shared MCP protocol conformance', () => {
  it('pins exactly the approved protocol revisions in preference order', () => {
    expect(DREAMUX_SUPPORTED_PROTOCOL_VERSIONS).toEqual([
      '2026-07-28',
      '2025-11-25',
      '2025-06-18',
    ]);
  });

  it('discovers only 2026-07-28 and handles modern metadata-bearing calls', async () => {
    const connection = await connectMcpClient(
      (transport) => serve(transport),
      '2026-07-28',
    );
    try {
      expect(connection.client.getProtocolEra()).toBe('modern');
      expect(connection.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(connection.client.getDiscoverResult()).toMatchObject({
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
      });
      expect((await listedTools(connection.client)).map((tool) => tool.name)).toEqual([
        'echo',
      ]);
      await expect(callTool(connection.client, 'echo', { value: 'modern' })).resolves.toEqual({
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'dreamux-conformance-test',
            version: '1.0.0',
          },
        },
        content: [],
        structuredContent: { echoed: 'modern' },
      });
    } finally {
      await connection.close();
    }
  });

  for (const version of ['2025-11-25', '2025-06-18'] as const) {
    it(`negotiates, lists, and calls through the ${version} legacy handshake`, async () => {
      const connection = await connectMcpClient(
        (transport) => serve(transport),
        version,
      );
      try {
        expect(connection.client.getProtocolEra()).toBe('legacy');
        expect(connection.client.getNegotiatedProtocolVersion()).toBe(version);
        const [tool] = await listedTools(connection.client);
        expect(tool).toMatchObject({
          name: 'echo',
          title: 'Echo value',
          description: 'Return the validated value.',
          inputSchema: ECHO_TOOL.inputSchema,
          outputSchema: ECHO_TOOL.outputSchema,
          annotations: ECHO_TOOL.annotations,
        });
        expect(tool).not.toHaveProperty('successText');
        await expect(callTool(connection.client, 'echo', { value: version })).resolves.toEqual({
          content: [],
          structuredContent: { echoed: version },
        });
      } finally {
        await connection.close();
      }
    });
  }

  it('counter-offers 2025-11-25 instead of negotiating 2024-11-05', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const run = serve(serverTransport);
    const client = new Client(
      { name: 'old-offer-test', version: '1.0.0' },
      {
        supportedProtocolVersions: ['2024-11-05', '2025-11-25'],
        versionNegotiation: { mode: 'legacy' },
      },
    );
    try {
      await client.connect(clientTransport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      expect(client.getProtocolEra()).toBe('legacy');
    } finally {
      await client.close();
      await run;
    }
  });

  it('rejects an unsupported modern revision with the SDK -32022 error', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const run = serve(serverTransport);
    const client = new Client(
      { name: 'future-version-test', version: '1.0.0' },
      {
        supportedProtocolVersions: ['2027-01-01'],
        versionNegotiation: { mode: { pin: '2027-01-01' } },
      },
    );
    try {
      await expect(client.connect(clientTransport)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(UnsupportedProtocolVersionError);
        expect(error).toMatchObject({
          code: ProtocolErrorCode.UnsupportedProtocolVersion,
          data: {
            requested: '2027-01-01',
            supported: ['2026-07-28'],
          },
        });
        return true;
      });
    } finally {
      await clientTransport.close();
      await run;
    }
  });

  it('keeps protocol errors separate from known-tool schema errors', async () => {
    const connection = await connectMcpClient((transport) => serve(transport));
    try {
      await expect(
        callTool(connection.client, 'unknown_tool', {}),
      ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });

      await expect(
        callTool(connection.client, 'echo', { value: 'x', extra: true }),
      ).resolves.toMatchObject({
        isError: true,
        content: [expect.objectContaining({ type: 'text' })],
      });
    } finally {
      await connection.close();
    }
  });

  it('validates successful structured output against the advertised schema', async () => {
    const invalidOutputTool: McpToolDefinition = {
      ...ECHO_TOOL,
      name: 'invalid_output',
      handler: async () => ({ structured: { echoed: 42 } }),
    };
    const connection = await connectMcpClient((transport) =>
      serve(transport, [invalidOutputTool]),
    );
    try {
      await listedTools(connection.client);
      await expect(
        callTool(connection.client, 'invalid_output', { value: 'valid' }),
      ).resolves.toMatchObject({
        isError: true,
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringMatching(/output validation error/i),
          }),
        ],
      });
    } finally {
      await connection.close();
    }
  });

  it('emits only handler-owned text beside unchanged structured content', async () => {
    // The handler is the sole owner of whether a call says anything beyond its
    // structured value (see McpToolOutcome in src/mcp/server.ts) — there is no
    // separate selector hook the runner consults after the fact.
    const successTextTool: McpToolDefinition = {
      ...ECHO_TOOL,
      name: 'echo_with_success_text',
      handler: async (args) => ({
        structured: { echoed: args['value'] },
        text: 'Operation-specific success text.',
      }),
    };
    const connection = await connectMcpClient((transport) =>
      serve(transport, [successTextTool]),
    );
    try {
      await expect(
        callTool(connection.client, 'echo_with_success_text', { value: 'valid' }),
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'Operation-specific success text.' }],
        structuredContent: { echoed: 'valid' },
      });
    } finally {
      await connection.close();
    }
  });

  it('does not recognize the retired bare initialized notification', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const run = serve(serverTransport);
    const received: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => received.push(message);
    await clientTransport.start();
    try {
      await clientTransport.send({
        jsonrpc: '2.0',
        method: 'initialized',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(received).toEqual([]);
    } finally {
      await clientTransport.close();
      await run;
    }
  });

  it('cancels response work without rolling back an already accepted operation', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let accepted = false;
    const tool: McpToolDefinition = {
      ...ECHO_TOOL,
      name: 'accept_then_wait',
      handler: async (args) => {
        accepted = true;
        started.resolve();
        await release.promise;
        return { structured: { echoed: args['value'] } };
      },
    };
    const connection = await connectMcpClient((transport) => serve(transport, [tool]));
    try {
      const controller = new AbortController();
      const call = callTool(
        connection.client,
        'accept_then_wait',
        { value: 'accepted' },
        controller.signal,
      );
      await started.promise;
      controller.abort();
      await expect(call).rejects.toThrow(/AbortError/);
      expect(accepted).toBe(true);
      release.resolve();
    } finally {
      release.resolve();
      await connection.close();
    }
  });

  it('shuts custom stdio streams down on EOF without contaminating stdout', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stdout: Buffer[] = [];
    output.on('data', (chunk: Buffer) => stdout.push(chunk));

    const run = runMcpServer({
      identity: { name: 'dreamux-eof-test', version: '1.0.0' },
      tools: [ECHO_TOOL],
      input,
      output,
      log: () => {},
    });
    input.end();
    await run;

    expect(Buffer.concat(stdout).toString('utf8')).toBe('');
  });

  it('rejects deterministically when an injected transport fails to start', async () => {
    const startupError = new Error('injected transport start failed');
    const transport: Transport = {
      async start(): Promise<void> {
        throw startupError;
      },
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };
    const logs: string[] = [];

    await expect(
      runMcpServer({
        identity: { name: 'dreamux-start-failure-test', version: '1.0.0' },
        tools: [ECHO_TOOL],
        transport,
        log: (message) => logs.push(message),
      }),
    ).rejects.toBe(startupError);
    expect(logs.join('\n')).toContain('injected transport start failed');
  });
});
