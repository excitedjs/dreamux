import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import {
  FEISHU_USER_NAME_RESOLUTION_TIMEOUT_MS,
  createFeishuTransport,
  type InboundRoutes,
} from '@excitedjs/feishu-transport';

import { createFeishuBot } from '../src/bot.js';
import {
  FeishuChannelSession,
  type FeishuInboundSubmitter,
} from '../src/feishu-channel.js';
import {
  defaultDispatcherAccessState,
  saveDispatcherAccess,
} from '../src/feishu-gate.js';

interface ContactResponse {
  code?: number;
  data?: { user?: { name?: string } };
}

interface ContactInput {
  path: { user_id: string };
  params: { user_id_type: 'open_id' };
}

interface ProductionHarness {
  session: FeishuChannelSession;
  submitted: InboundTurnInput[];
  contactUserGet: ReturnType<
    typeof vi.fn<(input: ContactInput) => Promise<ContactResponse>>
  >;
  dispatch(raw: unknown): Promise<void>;
  start(): Promise<void>;
}

const dirs: string[] = [];
const sessions = new Set<FeishuChannelSession>();

afterEach(async () => {
  await Promise.allSettled(
    [...sessions].map(async (session) => session.close()),
  );
  sessions.clear();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function logger(): DreamuxLogger {
  const noop = (): void => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger(),
  } as unknown as DreamuxLogger;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function rawMessage(messageId: string): unknown {
  return {
    event: {
      sender: {
        sender_id: { open_id: 'ou_allowed' },
        sender_type: 'user',
      },
      message: {
        message_id: messageId,
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        create_time: '1710000000000',
        mentions: [],
      },
    },
  };
}

async function createProductionHarness(
  contactLookup: (input: ContactInput) => Promise<ContactResponse>,
): Promise<ProductionHarness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-name-production-'));
  dirs.push(stateDir);
  const access = defaultDispatcherAccessState();
  access.dm_policy = 'allowlist';
  access.allow_users = ['ou_allowed'];
  await saveDispatcherAccess(stateDir, access);

  const contactUserGet = vi.fn(contactLookup);
  let reactionIndex = 0;
  const sdkClient = {
    contact: {
      v3: { user: { get: contactUserGet } },
    },
    im: {
      messageReaction: {
        create: vi.fn(async () => {
          reactionIndex += 1;
          return { data: { reaction_id: `reaction-${reactionIndex}` } };
        }),
        delete: vi.fn(async () => ({})),
      },
    },
  };
  const log = logger();
  const transport = createFeishuTransport(
    { appId: 'app-test', appSecret: 'secret' },
    { client: sdkClient as never, logger: log },
  );
  let activeRoutes: InboundRoutes | undefined;
  const closeTransport = transport.close.bind(transport);
  // Keep the production transport and resolver intact; replace only the live
  // WebSocket registration edge so the test can inject a raw SDK event.
  transport.start = async (routes): Promise<void> => {
    activeRoutes = routes;
  };
  transport.close = async (): Promise<void> => {
    activeRoutes = undefined;
    await closeTransport();
  };

  const bot = createFeishuBot(
    { appId: 'app-test', appSecret: 'secret', logger: log },
    { createTransport: () => transport },
  );
  const submitted: InboundTurnInput[] = [];
  const submitter: FeishuInboundSubmitter = {
    submitTurn: async (input): Promise<AgentRuntimeTurnResult> => {
      submitted.push(input);
      return { status: 'submitted', turnId: `turn-${input.sourceId}` };
    },
  };
  const session = new FeishuChannelSession({
    dispatcherId: 'dispatcher-a',
    appId: 'app-test',
    appSecret: 'secret',
    stateDir,
    attachmentCacheDir: join(stateDir, 'attachments'),
    log,
    botFactory: () => bot,
  });
  sessions.add(session);
  const start = async (): Promise<void> => session.start(submitter);
  await start();

  return {
    session,
    submitted,
    contactUserGet,
    async dispatch(raw: unknown): Promise<void> {
      const route = activeRoutes?.['im.message.receive_v1'];
      if (route === undefined) {
        throw new Error('production transport route is not active');
      }
      await route(raw);
    },
    start,
  };
}

describe('Feishu sender-name production path', () => {
  it('submits a 1,200ms real SDK lookup result on the same accepted turn', async () => {
    const lookupStarted = deferred<void>();
    const harness = await createProductionHarness(
      async () => {
        lookupStarted.resolve(undefined);
        return new Promise<ContactResponse>((resolve) => {
          setTimeout(() => {
            resolve({ code: 0, data: { user: { name: 'Ada SDK' } } });
          }, 1_200);
        });
      },
    );
    vi.useFakeTimers();

    const delivery = harness.dispatch(rawMessage('om_1200ms'));
    await lookupStarted.promise;
    expect(harness.contactUserGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_199);
    expect(harness.submitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await delivery;

    expect(harness.contactUserGet).toHaveBeenCalledWith({
      path: { user_id: 'ou_allowed' },
      params: { user_id_type: 'open_id' },
    });
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]?.sourceId).toBe('om_1200ms');
    expect(harness.submitted[0]?.attrs).toContainEqual([
      'sender_name',
      'Ada SDK',
    ]);
  });

  it('bounds the pre-submit wait at two seconds and retries the next miss', async () => {
    expect(FEISHU_USER_NAME_RESOLUTION_TIMEOUT_MS).toBe(2_000);
    const lookupStarted = deferred<void>();
    let lookupIndex = 0;
    const harness = await createProductionHarness(async () => {
      lookupIndex += 1;
      if (lookupIndex === 1) {
        lookupStarted.resolve(undefined);
        return new Promise<ContactResponse>(() => undefined);
      }
      return { code: 0, data: { user: { name: 'Retry Ada' } } };
    });
    vi.useFakeTimers();

    const timedOutDelivery = harness.dispatch(rawMessage('om_timeout'));
    await lookupStarted.promise;
    expect(harness.contactUserGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(
      FEISHU_USER_NAME_RESOLUTION_TIMEOUT_MS + 1,
    );
    await timedOutDelivery;

    expect(harness.submitted).toHaveLength(1);
    expect(
      harness.submitted[0]?.attrs?.some(([name]) => name === 'sender_name'),
    ).toBe(false);

    await harness.dispatch(rawMessage('om_retry'));
    expect(harness.contactUserGet).toHaveBeenCalledTimes(2);
    expect(harness.submitted[1]?.attrs).toContainEqual([
      'sender_name',
      'Retry Ada',
    ]);
  });

  it('fences a late real-resolver result across close and restart', async () => {
    const stale = deferred<ContactResponse>();
    const fresh = deferred<ContactResponse>();
    let lookupIndex = 0;
    const harness = await createProductionHarness(async () => {
      lookupIndex += 1;
      if (lookupIndex === 1) return stale.promise;
      if (lookupIndex === 2) return fresh.promise;
      throw new Error('unexpected uncached sender-name lookup');
    });

    const oldDelivery = harness.dispatch(rawMessage('om_old'));
    await vi.waitFor(() => {
      expect(harness.contactUserGet).toHaveBeenCalledTimes(1);
    });
    await harness.session.close();
    await oldDelivery;
    expect(harness.submitted).toEqual([]);

    await harness.start();
    const newDelivery = harness.dispatch(rawMessage('om_new'));
    await vi.waitFor(() => {
      expect(harness.contactUserGet).toHaveBeenCalledTimes(2);
    });
    fresh.resolve({ code: 0, data: { user: { name: 'Fresh Ada' } } });
    await newDelivery;
    expect(harness.submitted.map((input) => input.sourceId)).toEqual(['om_new']);
    expect(harness.submitted[0]?.attrs).toContainEqual([
      'sender_name',
      'Fresh Ada',
    ]);

    stale.resolve({ code: 0, data: { user: { name: 'Stale Ada' } } });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.dispatch(rawMessage('om_cached'));

    expect(harness.contactUserGet).toHaveBeenCalledTimes(2);
    expect(harness.submitted.map((input) => input.sourceId)).toEqual([
      'om_new',
      'om_cached',
    ]);
    expect(harness.submitted[1]?.attrs).toContainEqual([
      'sender_name',
      'Fresh Ada',
    ]);
  });
});
