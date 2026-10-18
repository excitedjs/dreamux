import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { CodexRpcClient } from '../src/rpc.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function stdioClient() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received = createInterface({ input: stdin });
  const client = new CodexRpcClient({ stdio: { stdin, stdout } });
  cleanup.push(() => {
    client.close();
    received.close();
    stdin.destroy();
  });
  return { client, received, stdout, stdin };
}

describe('Codex stdio RPC', () => {
  it('routes split UTF-8 and multiple newline-delimited responses by request id', async () => {
    const { client, received, stdout } = stdioClient();
    await client.ready();
    const firstFrame = once(received, 'line');
    const first = client.request('first', { text: 'hello' });
    expect(JSON.parse((await firstFrame)[0])).toEqual({
      id: 1,
      method: 'first',
      params: { text: 'hello' },
    });
    const secondFrame = once(received, 'line');
    const second = client.request('second', {});
    expect(JSON.parse((await secondFrame)[0]).id).toBe(2);

    const frames = Buffer.from(
      `${JSON.stringify({ id: 2, result: '中文' })}\n` +
        `${JSON.stringify({ id: 1, result: 'first answer' })}\n`,
    );
    const split = frames.indexOf(Buffer.from('中文')) + 1;
    stdout.write(frames.subarray(0, split));
    stdout.write(frames.subarray(split));
    await expect(first).resolves.toBe('first answer');
    await expect(second).resolves.toBe('中文');
  });

  it('sends notifications and answers native server requests on the same pipe', async () => {
    const { client, received, stdout } = stdioClient();
    const notifications: unknown[] = [];
    client.onNotification((notification) => notifications.push(notification));
    client.setServerRequestHandler(async (request) => ({
      method: request.method,
    }));

    const initialized = once(received, 'line');
    client.notify('initialized', undefined);
    expect(JSON.parse((await initialized)[0])).toEqual({
      method: 'initialized',
    });

    const response = once(received, 'line');
    stdout.write('{"method":"turn/started","params":{"turnId":"turn-1"}}\n');
    stdout.write('{"method":"approval","id":42,"params":{}}\n');
    expect(JSON.parse((await response)[0])).toEqual({
      id: 42,
      result: { method: 'approval' },
    });
    expect(notifications).toEqual([
      { method: 'turn/started', params: { turnId: 'turn-1' } },
    ]);
  });

  it.each(['caller', 'stdout'] as const)(
    'rejects outstanding requests when %s closes the connection',
    async (closer) => {
      const { client, stdout, stdin } = stdioClient();
      const request = client.request('turn/start', {});
      const rejected = expect(request).rejects.toThrow(/closed/);
      if (closer === 'caller') {
        client.close();
        expect(stdin.writableEnded).toBe(true);
      } else {
        stdout.end();
      }
      await rejected;
      await expect(client.request('thread/start', {})).rejects.toThrow(
        /closed/,
      );
    },
  );
});

it('preserves WebSocket request and notification routing', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (typeof address === 'string' || address === null)
    throw new Error('missing TCP address');
  const connected = once(server, 'connection');
  const client = new CodexRpcClient({ url: `ws://127.0.0.1:${address.port}` });
  cleanup.push(() => client.close());
  const [socket] = await connected;
  await client.ready();
  const frame = once(socket, 'message');
  const request = client.request('thread/start', {});
  const sent = JSON.parse((await frame)[0].toString());
  socket.send(
    JSON.stringify({ id: sent.id, result: { thread: { id: 'thread-1' } } }),
  );
  await expect(request).resolves.toEqual({ thread: { id: 'thread-1' } });
  const notification = once(socket, 'message');
  client.notify('initialized', undefined);
  expect(JSON.parse((await notification)[0].toString())).toEqual({
    method: 'initialized',
  });
});
