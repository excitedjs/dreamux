import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import {
  runChannelMcp,
  validateChannelToolCatalog,
} from '../src/mcp/channel-mcp.js';
import { callTool, connectMcpClient, listedTools } from './helpers/mcp-client.js';

interface FakeAdminServer {
  socketPath: string;
  requests: AdminRequest[];
  close(): Promise<void>;
}

async function startFakeAdminServer(
  respond: (request: AdminRequest) => AdminResponse,
): Promise<FakeAdminServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-channel-mcp-admin-'));
  const socketPath = join(dir, 'admin.sock');
  const requests: AdminRequest[] = [];
  const server: NetServer = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        const request = JSON.parse(line) as AdminRequest;
        requests.push(request);
        socket.write(`${JSON.stringify(respond(request))}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const REPORT_TOOL = {
  name: 'repository_report',
  title: 'Repository report',
  description: 'Read one provider-owned repository report.',
  inputSchema: {
    type: 'object',
    properties: { repository: { type: 'string', minLength: 1 } },
    required: ['repository'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string', minLength: 1 } },
    required: ['summary'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  icons: [
    {
      src: 'data:image/svg+xml;base64,PHN2Zy8+',
      mimeType: 'image/svg+xml',
      sizes: ['any'],
      theme: 'light',
    },
  ],
} as const;

describe('channel MCP provider catalog', () => {
  let admin: FakeAdminServer | null = null;

  afterEach(async () => {
    await admin?.close();
    admin = null;
  });

  it('preserves provider metadata and allows an omitted output schema', () => {
    expect(validateChannelToolCatalog([REPORT_TOOL])).toEqual([REPORT_TOOL]);
    expect(
      validateChannelToolCatalog([
        {
          name: 'external_tool',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ]),
    ).toEqual([
      {
        name: 'external_tool',
        title: 'external_tool',
        description: 'external_tool',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ]);
  });

  it.each([
    ['non-array', {} as never, /must be an array/],
    ['empty catalog', [], /must not be empty/],
    ['non-object descriptor', ['bad'], /must be an object/],
    ['missing input schema', [{ name: 'bad' }], /inputSchema/],
    [
      'duplicate name',
      [
        { ...REPORT_TOOL, name: 'same' },
        { ...REPORT_TOOL, name: 'same' },
      ],
      /duplicated/,
    ],
    [
      'unknown descriptor field',
      [{ ...REPORT_TOOL, providerResult: true }],
      /unknown property 'providerResult'/,
    ],
    [
      'invalid JSON Schema',
      [{ ...REPORT_TOOL, inputSchema: { type: 'not-a-json-schema-type' } }],
      /not a valid JSON Schema/,
    ],
    [
      'non-JSON value',
      [{ ...REPORT_TOOL, description: undefined }],
      /non-JSON undefined value/,
    ],
    [
      'non-finite number',
      [{ ...REPORT_TOOL, inputSchema: { type: 'object', maximum: Number.NaN } }],
      /non-finite number/,
    ],
    [
      'null annotations',
      [{ ...REPORT_TOOL, annotations: null }],
      /annotations must be an object/,
    ],
    [
      'invalid icon metadata',
      [{ ...REPORT_TOOL, icons: [{ src: '', sizes: [''] }] }],
      /src must be a non-empty string/,
    ],
  ])('fails loud for %s', (_label, catalog, expected) => {
    expect(() => validateChannelToolCatalog(catalog as readonly unknown[])).toThrow(
      expected as RegExp,
    );
  });

  it('rejects circular and non-plain descriptor values before encoding', () => {
    const circular: Record<string, unknown> = { ...REPORT_TOOL };
    circular['self'] = circular;
    expect(() => validateChannelToolCatalog([circular])).toThrow(/circular reference/);
    expect(() =>
      validateChannelToolCatalog([
        { ...REPORT_TOOL, inputSchema: new Date() },
      ]),
    ).toThrow(/non-plain object/);
  });

  it('lists, validates, invokes, and projects a provider-owned tool without interpreting it', async () => {
    admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { summary: 'provider result' },
    }));
    const connection = await connectMcpClient((transport) =>
      runChannelMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'team_leader',
        teamId: 'team-a',
        leaderName: 'leader-a',
        providerRef: 'npm:@example/repository-channel',
        channelId: 'repository',
        adminSocketPath: admin?.socketPath,
        tools: [REPORT_TOOL],
        transport,
        log: () => {},
      }),
    );
    try {
      expect(await listedTools(connection.client)).toEqual([
        expect.objectContaining(REPORT_TOOL),
      ]);
      await expect(
        callTool(connection.client, 'repository_report', {
          repository: 'excitedjs/dreamux',
        }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: '{"summary":"provider result"}' }],
        structuredContent: { summary: 'provider result' },
      });
      expect(admin.requests).toHaveLength(1);
      expect(admin.requests[0]).toMatchObject({
        method: 'channel.invoke_tool',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'team_leader',
          team_id: 'team-a',
          leader_name: 'leader-a',
          provider_ref: 'npm:@example/repository-channel',
          channel_id: 'repository',
          name: 'repository_report',
          arguments: { repository: 'excitedjs/dreamux' },
        },
      });

      await expect(
        callTool(connection.client, 'repository_report', {
          repository: 'excitedjs/dreamux',
          dispatcher_id: 'evil',
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(admin.requests).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it('turns a provider output-schema mismatch into an SDK tool error', async () => {
    admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { wrong: true },
    }));
    const connection = await connectMcpClient((transport) =>
      runChannelMcp({
        dispatcherId: 'dispatcher-a',
        adminSocketPath: admin?.socketPath,
        tools: [REPORT_TOOL],
        transport,
        log: () => {},
      }),
    );
    try {
      await listedTools(connection.client);
      await expect(
        callTool(connection.client, 'repository_report', { repository: 'repo' }),
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
});
