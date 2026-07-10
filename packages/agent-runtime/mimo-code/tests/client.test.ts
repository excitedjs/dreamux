import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { MimoBusyError, MimoHttpClient } from '../src/client.js';

describe('MiMo HTTP client', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('creates sessions and submits message turns through the durable HTTP path', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: { authorization: string | undefined };
      body: unknown;
    }> = [];
    const server = await startFakeHttpServer(async (req, res) => {
      const body = await readJson(req);
      requests.push({
        method: req.method,
        url: req.url,
        headers: { authorization: req.headers.authorization },
        body,
      });
      if (req.method === 'POST' && req.url === '/session') {
        writeJson(res, { id: 'sess-http-1' });
        return;
      }
      if (req.method === 'POST' && req.url === '/session/sess-http-1/message') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          `\n\n ${JSON.stringify({
            info: { id: 'assistant-1', role: 'assistant' },
            parts: [
              { type: 'reasoning', text: 'thinking' },
              { type: 'text', text: 'done' },
            ],
          })}\n`,
        );
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    servers.push(server);
    const client = new MimoHttpClient({ baseUrl: server.url, password: 'pw' });

    await expect(
      client.createSession({
        cwd: '/workspace',
        model: 'model-a',
        agent: 'agent-a',
        systemPrompt: 'system',
        mcpServers: [{ name: 'tool', command: 'node', args: ['tool.mjs'] }],
      }),
    ).resolves.toBe('sess-http-1');
    await expect(
      client.sendMessage('sess-http-1', {
        text: 'plain text',
        turnId: 'turn-1',
        timeoutMs: 1_000,
        model: 'model-a',
        agent: 'agent-a',
        systemPrompt: 'system',
      }),
    ).resolves.toEqual({ text: 'done' });

    expect(requests).toMatchObject([
      {
        method: 'POST',
        url: '/session',
        headers: {
          authorization: `Basic ${Buffer.from('mimocode:pw').toString('base64')}`,
        },
        body: {},
      },
      {
        method: 'POST',
        url: '/session/sess-http-1/message',
        headers: {
          authorization: `Basic ${Buffer.from('mimocode:pw').toString('base64')}`,
        },
        body: {
          modelRef: 'model-a',
          agent: 'agent-a',
          system: 'system',
          parts: [{ type: 'text', text: 'plain text' }],
        },
      },
    ]);
  });

  it('maps 409 busy responses to MimoBusyError', async () => {
    const server = await startFakeHttpServer((_req, res) => {
      res.writeHead(409);
      res.end('busy');
    });
    servers.push(server);
    const client = new MimoHttpClient({ baseUrl: server.url });

    await expect(
      client.sendMessage('sess-busy', {
        text: 'work',
        turnId: 'turn-busy',
        timeoutMs: 1_000,
        model: null,
        agent: null,
        systemPrompt: null,
      }),
    ).rejects.toBeInstanceOf(MimoBusyError);
  });
});

interface FakeHttpServer {
  url: string;
  close(): Promise<void>;
}

async function startFakeHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<FakeHttpServer> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake server did not bind a TCP address');
  }
  const tcpAddress: AddressInfo = address;
  return {
    url: `http://127.0.0.1:${tcpAddress.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? null : JSON.parse(text);
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
