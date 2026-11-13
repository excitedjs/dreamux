/**
 * Self-identity recovery for `createFeishuTransport`.
 *
 * A failed or empty `/open-apis/bot/v3/info` lookup is not an identity: it is
 * never cached, and the transport exposes `ensureSelfIdentity` so a caller can
 * retry it at a moment of its own choosing — inside work it owns, never on a
 * platform acknowledgement path. Concurrent retries share one in-flight
 * lookup.
 *
 * Everything here goes through the real route seam — the routes the transport
 * registers on the SDK event dispatcher, dispatched the way the SDK would —
 * rather than by calling the lookup helpers directly. The Lark SDK is mocked so
 * the real `openInbound` path runs with no live connection; the bot-info
 * responses come from an injected stub client.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as lark from '@larksuiteoapi/node-sdk';

import type { InboundRoutes } from '../src/transport/feishu';
import type { TransportLogger } from '../src/transport/diagnostics';
import { BOT_MEMBER_ADDED_EVENT_TYPE } from '../src/parse/bot-member';

const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1';

const captured = vi.hoisted(() => ({
  registered: [] as InboundRoutes[],
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {}
  class EventDispatcher {
    register(routes: InboundRoutes): this {
      captured.registered.push(routes);
      return this;
    }
  }
  class WSClient {
    private readonly opts: Record<string, () => void>;
    constructor(opts: Record<string, () => void>) {
      this.opts = opts;
    }
    async start(): Promise<void> {
      this.opts['onReady']?.();
    }
    close(): void {}
    getConnectionStatus(): { state: string } {
      return { state: 'connected' };
    }
  }
  return { Client, EventDispatcher, WSClient };
});

// Imported after the mock is registered (vi.mock is hoisted above the imports).
const { createFeishuTransport } = await import('../src/transport/feishu');

const silentLogger: TransportLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/** A bot-info response the transport must not accept as an identity. */
const NO_OPEN_ID = { bot: {} };
const RESOLVED = { bot: { open_id: 'ou_self', app_name: 'Dreamux' } };

function messageEvent(): unknown {
  return {
    schema: '2.0',
    header: { event_type: IM_MESSAGE_EVENT_TYPE },
    event: { message: { message_id: 'om_1' } },
  };
}

/**
 * Starts a transport over a stub client whose `request` answers the bot-info
 * lookup, and returns the routes the transport actually registered plus what
 * `selfId` looked like inside each dispatched message handler.
 */
async function startTransport(request: ReturnType<typeof vi.fn>) {
  const transport = createFeishuTransport(
    { appId: 'app', appSecret: 'secret' },
    { client: { request } as unknown as lark.Client, logger: silentLogger },
  );
  const seenSelfIds: Array<string | undefined> = [];
  const handled: unknown[] = [];
  const otherRouteCalls: unknown[] = [];
  const started = transport.start({
    [IM_MESSAGE_EVENT_TYPE]: async (raw: unknown) => {
      seenSelfIds.push(transport.selfId);
      handled.push(raw);
    },
    [BOT_MEMBER_ADDED_EVENT_TYPE]: async (raw: unknown) => {
      otherRouteCalls.push(raw);
    },
  });
  return { transport, started, seenSelfIds, handled, otherRouteCalls };
}

function registeredRoutes(): InboundRoutes {
  const routes = captured.registered[0];
  expect(routes).toBeDefined();
  return routes as InboundRoutes;
}

function dispatchMessage(): Promise<unknown> {
  const handler = registeredRoutes()[IM_MESSAGE_EVENT_TYPE];
  expect(handler).toBeDefined();
  return handler!(messageEvent());
}

beforeEach(() => {
  captured.registered.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createFeishuTransport — self-identity recovery', () => {
  test('a failed startup lookup is retried by an explicit call, before the caller runs its work', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(RESOLVED as never);
    const { transport, started, seenSelfIds, handled } =
      await startTransport(request);
    // Let the bounded startup retry (500ms + 1000ms backoff) run out.
    await vi.advanceTimersByTimeAsync(2_000);
    await started;

    expect(transport.selfId).toBeUndefined();
    expect(transport.selfName).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);

    // The caller runs the retry inside its own work, so a success applies to
    // the same message before that message's gate reads `selfId`.
    await transport.ensureSelfIdentity();
    await dispatchMessage();

    expect(seenSelfIds).toEqual(['ou_self']);
    expect(handled).toHaveLength(1);
    expect(transport.selfId).toBe('ou_self');
    expect(transport.selfName).toBe('Dreamux');
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenLastCalledWith({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
      // Bounded: this lookup runs inside work the session drains on close.
      timeout: 2_000,
    });
  });

  test('a response without an open_id is not an identity and is not cached', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(NO_OPEN_ID as never)
      .mockResolvedValueOnce(NO_OPEN_ID as never)
      .mockResolvedValue(RESOLVED as never);
    const { transport, started, seenSelfIds } = await startTransport(request);
    await started;

    expect(transport.selfId).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);

    // A failed retry still delivers the message — the caller stays fail-closed
    // for it — and leaves identity unresolved rather than caching the failure.
    await transport.ensureSelfIdentity();
    await dispatchMessage();
    expect(seenSelfIds).toEqual([undefined]);
    expect(transport.selfId).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);

    await transport.ensureSelfIdentity();
    await dispatchMessage();
    expect(seenSelfIds).toEqual([undefined, 'ou_self']);
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('a resolved identity is cached for the rest of the process', async () => {
    const request = vi.fn().mockResolvedValue(RESOLVED as never);
    const { transport, started, seenSelfIds } = await startTransport(request);
    await started;

    expect(transport.selfId).toBe('ou_self');
    expect(request).toHaveBeenCalledTimes(1);

    await dispatchMessage();
    await dispatchMessage();

    expect(seenSelfIds).toEqual(['ou_self', 'ou_self']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('concurrent retries share one in-flight lookup', async () => {
    let releaseLookup: (() => void) | undefined;
    const request = vi
      .fn()
      .mockResolvedValueOnce(NO_OPEN_ID as never)
      .mockImplementation(
        async () =>
          await new Promise((resolve) => {
            releaseLookup = () => resolve(RESOLVED);
          }),
      );
    const { transport, started, seenSelfIds, handled } =
      await startTransport(request);
    await started;
    expect(request).toHaveBeenCalledTimes(1);

    const first = transport.ensureSelfIdentity();
    const second = transport.ensureSelfIdentity();
    await vi.waitFor(() => expect(releaseLookup).toBeDefined());

    // Both callers are parked on the same lookup, not on two of them.
    expect(request).toHaveBeenCalledTimes(2);
    expect(handled).toHaveLength(0);

    releaseLookup?.();
    await Promise.all([first, second]);
    await dispatchMessage();
    await dispatchMessage();

    expect(seenSelfIds).toEqual(['ou_self', 'ou_self']);
    expect(transport.selfId).toBe('ou_self');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('dispatching a message no longer performs the lookup itself', async () => {
    const request = vi.fn().mockResolvedValue(NO_OPEN_ID as never);
    const { transport, started, seenSelfIds } = await startTransport(request);
    await started;
    expect(request).toHaveBeenCalledTimes(1);

    // The transport no longer wraps the message route: the caller owns the
    // retry, so a raw dispatch must not spend a lookup on the acknowledgement
    // path.
    await dispatchMessage();
    expect(request).toHaveBeenCalledTimes(1);
    expect(seenSelfIds).toEqual([undefined]);
    expect(transport.selfId).toBeUndefined();
  });

  test('other inbound event types do not trigger the lookup', async () => {
    const request = vi.fn().mockResolvedValue(NO_OPEN_ID as never);
    const { transport, started, otherRouteCalls } =
      await startTransport(request);
    await started;
    expect(request).toHaveBeenCalledTimes(1);

    const handler = registeredRoutes()[BOT_MEMBER_ADDED_EVENT_TYPE];
    expect(handler).toBeDefined();
    await handler!({ header: { event_type: BOT_MEMBER_ADDED_EVENT_TYPE } });

    expect(otherRouteCalls).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(transport.selfId).toBeUndefined();
  });

  test('a lookup that never answers is given up on, not waited for', async () => {
    vi.useFakeTimers();
    // A request that accepts the call and never settles: the SDK's own HTTP
    // client has no timeout, so without a deadline around the whole lookup this
    // promise would stay pending forever and whatever awaits it would too.
    const request = vi.fn().mockReturnValue(new Promise(() => undefined));
    const { transport, started } = await startTransport(request);
    await vi.advanceTimersByTimeAsync(60_000);
    await started;

    expect(transport.selfId).toBeUndefined();

    const retry = transport.ensureSelfIdentity();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(retry).resolves.toBeUndefined();
    expect(transport.selfId).toBeUndefined();
  });

  test('the whole lookup leaves room inside the host shutdown deadline', async () => {
    vi.useFakeTimers();
    // The host gives a signal-initiated shutdown fifteen seconds before it
    // exits (packages/dreamux/src/cli/server.ts), and the channel session
    // spends up to five of them draining its card writer before it reaches this
    // work. A lookup that outlasts the remainder turns a converging teardown
    // into a failed one. Asserting against the full fifteen would pass a
    // fourteen-second ceiling that leaves nothing for the closes after it, so
    // this asserts against what is actually left.
    const HOST_SHUTDOWN_DEADLINE_MS = 15_000;
    const COT_DRAIN_BEFORE_THIS_MS = 5_000;
    const available = HOST_SHUTDOWN_DEADLINE_MS - COT_DRAIN_BEFORE_THIS_MS;
    const request = vi.fn().mockReturnValue(new Promise(() => undefined));
    const { transport } = await startTransport(request);

    let settled = false;
    const lookup = transport.ensureSelfIdentity().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(available - 1);
    expect(settled).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await lookup;
  });
});
