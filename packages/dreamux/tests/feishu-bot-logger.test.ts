/**
 * #74 wiring test: `createFeishuBot` forwards an injected `logger` to the REAL
 * `createFeishuTransport` call.
 *
 * The production path is `?? createFeishuTransport(...)`, not the `deps`
 * test seam — so asserting through a `deps.createTransport` spy would not catch
 * a regression that dropped the second argument from the real call. This mocks
 * the transport module (keeping its other exports real) and asserts the real
 * `createFeishuTransport` receives `(creds, { logger })`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createFeishuTransport,
  type FeishuTransport,
  type TransportLogger,
} from '@excitedjs/feishu-transport';

import { createFeishuBot } from '../src/channel/feishu/bot.js';

vi.mock('@excitedjs/feishu-transport', async (importActual) => {
  const actual =
    await importActual<typeof import('@excitedjs/feishu-transport')>();
  return {
    ...actual,
    createFeishuTransport: vi.fn(() => ({}) as FeishuTransport),
  };
});

describe('createFeishuBot — logger forwarding (real transport path)', () => {
  it('passes the injected logger through to createFeishuTransport', () => {
    const logger: TransportLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    };

    createFeishuBot({ appId: 'app', appSecret: 'secret', logger });

    expect(createFeishuTransport).toHaveBeenCalledWith(
      { appId: 'app', appSecret: 'secret' },
      { logger },
    );
  });

  it('still calls the transport (with logger undefined) when none is injected', () => {
    vi.mocked(createFeishuTransport).mockClear();

    createFeishuBot({ appId: 'app', appSecret: 'secret' });

    expect(createFeishuTransport).toHaveBeenCalledWith(
      { appId: 'app', appSecret: 'secret' },
      { logger: undefined },
    );
  });
});
