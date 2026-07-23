import { afterEach, describe, expect, it, vi } from 'vitest';

import { trustIntroducedBots } from '../src/chat-bots-store.js';
import {
  defaultDispatcherAccessState,
  saveDispatcherAccess,
} from '../src/feishu-gate.js';
import {
  cleanupRealFeishuHarnesses,
  createRealFeishuHarness,
  rawMessage,
} from './helpers/real-feishu-harness.js';

afterEach(async () => {
  await cleanupRealFeishuHarnesses();
  vi.useRealTimers();
});

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

function unnamedMessage(
  messageId: string,
  input: Parameters<typeof rawMessage>[3] = {},
): unknown {
  return rawMessage(messageId, 'text', { text: 'hello' }, input);
}

describe('Feishu sender-name production path', () => {
  it('submits a 1,200ms SDK lookup result on the same accepted turn', async () => {
    const lookupStarted = deferred<void>();
    const harness = await createRealFeishuHarness({
      contactLookup: async () => {
        lookupStarted.resolve(undefined);
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ code: 0, data: { user: { name: 'Ada SDK' } } });
          }, 1_200);
        });
      },
    });
    vi.useFakeTimers();

    const delivery = harness.dispatch(unnamedMessage('om_1200ms'));
    await lookupStarted.promise;
    await vi.advanceTimersByTimeAsync(1_199);
    expect(harness.submitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await delivery;

    expect(harness.contactUserGet).toHaveBeenCalledWith({
      path: { user_id: 'ou_allowed' },
      params: { user_id_type: 'open_id' },
    });
    expect(harness.submitted[0]?.attrs).toContainEqual([
      'sender_name',
      'Ada SDK',
    ]);
  });

  it('bounds one lookup at two seconds and calls Feishu again next message', async () => {
    const lookupStarted = deferred<void>();
    let lookupIndex = 0;
    const harness = await createRealFeishuHarness({
      contactLookup: async () => {
        lookupIndex += 1;
        if (lookupIndex === 1) {
          lookupStarted.resolve(undefined);
          return new Promise(() => undefined);
        }
        return { code: 0, data: { user: { name: 'Retry Ada' } } };
      },
    });
    vi.useFakeTimers();

    const timedOut = harness.dispatch(unnamedMessage('om_timeout'));
    await lookupStarted.promise;
    await vi.advanceTimersByTimeAsync(2_001);
    await timedOut;
    expect(harness.submitted[0]?.attrs?.some(
      ([name]) => name === 'sender_name',
    )).toBe(false);

    await harness.dispatch(unnamedMessage('om_retry'));
    expect(harness.contactUserGet).toHaveBeenCalledTimes(2);
    expect(harness.submitted[1]?.attrs).toContainEqual([
      'sender_name',
      'Retry Ada',
    ]);
  });

  it('does one fresh lookup for every accepted unnamed human message', async () => {
    const responses = [
      { code: 99991672 },
      { code: 7 },
      { code: 0, data: { user: {} } },
      { code: 0, data: { user: { name: 'Recovered Ada' } } },
      { code: 0, data: { user: { name: 'Changed Ada' } } },
    ];
    const harness = await createRealFeishuHarness({
      contactLookup: async () => responses.shift() ?? { code: 0 },
    });

    for (let index = 0; index < 5; index += 1) {
      await harness.dispatch(unnamedMessage(`om_attempt_${index}`));
    }

    expect(harness.contactUserGet).toHaveBeenCalledTimes(5);
    expect(harness.submitted.slice(0, 3).every((input) =>
      !input.attrs?.some(([name]) => name === 'sender_name'))).toBe(true);
    expect(harness.submitted[3]?.attrs).toContainEqual([
      'sender_name',
      'Recovered Ada',
    ]);
    expect(harness.submitted[4]?.attrs).toContainEqual([
      'sender_name',
      'Changed Ada',
    ]);
  });

  it('contains a thrown lookup to its message and retries afterward', async () => {
    let lookupIndex = 0;
    const harness = await createRealFeishuHarness({
      contactLookup: async () => {
        lookupIndex += 1;
        if (lookupIndex === 1) throw new Error('transient');
        return { code: 0, data: { user: { name: 'Recovered' } } };
      },
    });

    await harness.dispatch(unnamedMessage('om_throw'));
    await harness.dispatch(unnamedMessage('om_after_throw'));

    expect(harness.contactUserGet).toHaveBeenCalledTimes(2);
    expect(harness.submitted[0]?.attrs?.some(
      ([name]) => name === 'sender_name',
    )).toBe(false);
    expect(harness.submitted[1]?.attrs).toContainEqual([
      'sender_name',
      'Recovered',
    ]);
  });

  it('fences a late result across close and restart without caching it', async () => {
    const stale = deferred<{
      code: number;
      data: { user: { name: string } };
    }>();
    const fresh = deferred<{
      code: number;
      data: { user: { name: string } };
    }>();
    let lookupIndex = 0;
    const harness = await createRealFeishuHarness({
      contactLookup: async () => {
        lookupIndex += 1;
        if (lookupIndex === 1) return stale.promise;
        if (lookupIndex === 2) return fresh.promise;
        return { code: 0, data: { user: { name: 'Newest Ada' } } };
      },
    });

    const oldDelivery = harness.dispatch(unnamedMessage('om_old'));
    await vi.waitFor(() => {
      expect(harness.contactUserGet).toHaveBeenCalledTimes(1);
    });
    await harness.session.close();
    await oldDelivery;
    expect(harness.submitted).toEqual([]);

    await harness.start();
    const newDelivery = harness.dispatch(unnamedMessage('om_new'));
    await vi.waitFor(() => {
      expect(harness.contactUserGet).toHaveBeenCalledTimes(2);
    });
    fresh.resolve({ code: 0, data: { user: { name: 'Fresh Ada' } } });
    await newDelivery;
    stale.resolve({ code: 0, data: { user: { name: 'Stale Ada' } } });
    await Promise.resolve();
    await harness.dispatch(unnamedMessage('om_next'));

    expect(harness.contactUserGet).toHaveBeenCalledTimes(3);
    expect(harness.submitted.map((input) => input.sourceId)).toEqual([
      'om_new',
      'om_next',
    ]);
    expect(harness.submitted[1]?.attrs).toContainEqual([
      'sender_name',
      'Newest Ada',
    ]);
  });

  it('event and known-bot names avoid contact lookup', async () => {
    const harness = await createRealFeishuHarness();
    await harness.session.close();
    await trustIntroducedBots(harness.stateDir, 'oc_group', [{
      openId: 'ou_known_bot',
      name: 'Known Bot',
    }]);
    await harness.start();

    await harness.dispatch(unnamedMessage('om_event_name', {
      senderName: 'Event Ada',
    }));
    await harness.dispatch(unnamedMessage('om_known_bot', {
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_known_bot',
      senderType: 'app',
      mentions: [{
        key: '@_user_1',
        id: { open_id: 'ou_bot' },
        name: 'Dreamux',
      }],
    }));

    expect(harness.contactUserGet).not.toHaveBeenCalled();
    expect(harness.submitted[0]?.attrs).toContainEqual([
      'sender_name',
      'Event Ada',
    ]);
    expect(harness.submitted[1]?.attrs).toContainEqual([
      'sender_name',
      'Known Bot',
    ]);
  });

  it('does not query contacts before the access gate accepts', async () => {
    const harness = await createRealFeishuHarness();

    await harness.dispatch(unnamedMessage('om_dropped', {
      senderId: 'ou_not_allowed',
    }));
    const pairing = defaultDispatcherAccessState();
    pairing.dm_policy = 'pairing';
    await saveDispatcherAccess(harness.stateDir, pairing);
    await harness.dispatch(unnamedMessage('om_pair', {
      senderId: 'ou_pairing',
    }));

    expect(harness.submitted).toEqual([]);
    expect(harness.contactUserGet).not.toHaveBeenCalled();
  });
});
