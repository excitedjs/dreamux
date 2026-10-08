/** Real transport lifetime over a mocked SDK: no external Feishu connection. */
import type * as lark from '@larksuiteoapi/node-sdk';
import { afterEach, expect, test, vi } from 'vitest';
import type { TransportLogger } from '../src/transport/diagnostics.js';
const fixture = vi.hoisted(() => ({
  secret: 'fake-not-a-real-secret',
  body: 'do-not-log-body',
  closes: 0,
}));
vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {}
  class EventDispatcher {
    register(): this {
      return this;
    }
  }
  class WSClient {
    constructor(
      private readonly options: {
        logger: { info(...args: unknown[]): void };
        onReady?: () => void;
      },
    ) {}
    async start(): Promise<void> {
      this.options.logger.info({
        app_secret: fixture.secret,
        body: fixture.body,
      });
      this.options.onReady?.();
    }
    getConnectionStatus() {
      return { state: 'connected' };
    }
    close(): void {
      fixture.closes++;
      throw new Error('the socket was already gone');
    }
  }
  return { Client, EventDispatcher, WSClient };
});
import { createFeishuTransport } from '../src/transport/feishu.js';
afterEach(() => {
  vi.restoreAllMocks();
});
test('a sentinel appSecret and message body never reach the injected logger', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => {
    calls.push(args);
  };
  const logger: TransportLogger = {
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
  };
  const request = vi.fn(async (raw: unknown) => {
    const payload = raw as { url: string };
    return payload.url.includes('/bot/v3/info')
      ? { bot: { open_id: 'bot', app_name: 'Fixture' } }
      : { code: 0, data: { message_id: 'message', chat_id: 'chat' } };
  });
  const transport = createFeishuTransport(
    { appId: 'app', appSecret: fixture.secret },
    { client: { request } as unknown as lark.Client, logger },
  );
  await transport.start({});
  await transport.send({ chatId: 'chat' }, fixture.body);
  await transport.close();
  expect(fixture.closes).toBe(1);
  expect(JSON.stringify(request.mock.calls)).toContain(fixture.body);
  expect(JSON.stringify(calls)).toContain('the socket was already gone');
  expect(JSON.stringify(calls)).not.toContain(fixture.secret);
  expect(JSON.stringify(calls)).not.toContain(fixture.body);
  expect(output).not.toHaveBeenCalled();
});
