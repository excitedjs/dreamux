import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { FeishuInboundEvent } from '../src/bot.js';
import {
  alwaysActiveSessionFence,
  createFeishuInboundWork,
  type FeishuInboundWorkContext,
} from '../src/feishu-inbound-work.js';
import { formatFeishuMessageForRuntime } from '../src/feishu-message.js';

const dirs: string[] = [];
const works: FeishuInboundWorkContext[] = [];

afterEach(() => {
  for (const work of works.splice(0)) work.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function event(overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  return {
    messageId: 'om_budget',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_sender',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'post',
    rawContent: '{}',
    parsedText: 'body',
    resources: [],
    mentions: [],
    createTime: '1710000000000',
    raw: {},
    ...overrides,
  };
}

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-budget-'));
  dirs.push(dir);
  return dir;
}

function budgetWork(options: Parameters<typeof createFeishuInboundWork>[1]): FeishuInboundWorkContext {
  const value = createFeishuInboundWork(alwaysActiveSessionFence(), options);
  works.push(value);
  return value;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('Feishu inbound resource budgets', () => {
  it('downloads at most the configured number of unique resources', async () => {
    const calls: string[] = [];
    const result = await formatFeishuMessageForRuntime(event({
      resources: [
        { type: 'image', key: 'a' },
        { type: 'file', key: 'b' },
        { type: 'image', key: 'c' },
      ],
    }), {
      cacheDir: cacheDir(),
      work: budgetWork({ maxUniqueResources: 2 }),
      resourceFetcher: {
        async fetchMessageResource(request) {
          calls.push(request.fileKey);
          return { stream: Readable.from([Buffer.from('x')]), headers: {} };
        },
      },
    });

    expect(calls).toEqual(['a', 'b']);
    expect(result.attachments).toHaveLength(2);
    expect(result.body).toContain('[1 attachment(s) omitted: resource limit reached]');
  });

  it('enforces one aggregate byte budget across sequential downloads', async () => {
    const result = await formatFeishuMessageForRuntime(event({
      resources: [
        { type: 'file', key: 'a' },
        { type: 'file', key: 'b' },
      ],
    }), {
      cacheDir: cacheDir(),
      work: budgetWork({
        maxResourceBytes: 4,
        maxAggregateResourceBytes: 5,
      }),
      resourceFetcher: {
        async fetchMessageResource() {
          return { stream: Readable.from([Buffer.from('four')]), headers: {} };
        },
      },
    });

    expect(result.attachments.map((attachment) => ({
      status: attachment.status,
      reason: attachment.reason,
    }))).toEqual([
      { status: 'downloaded', reason: undefined },
      { status: 'not_downloaded', reason: 'aggregate_limit' },
    ]);
  });

  it('caps escaped rich content without cutting an XML entity', async () => {
    const result = await formatFeishuMessageForRuntime(event({
      parsedText: `${'x'.repeat(159_995)}<&>tail`,
    }));

    expect(result.body.length).toBeLessThanOrEqual(160_000);
    expect(result.body).toContain('[message content truncated: 160000-character limit reached]');
    expect(result.body).not.toMatch(/&(?:a|am|amp|l|lt|g|gt)?$/);
  });

  it('bounds a hanging resource API request by the per-message deadline', async () => {
    const pending = deferred<{
      stream: Readable;
      headers: Record<string, unknown>;
    }>();
    const result = await formatFeishuMessageForRuntime(event({
      resources: [{ type: 'image', key: 'slow-api' }],
    }), {
      cacheDir: cacheDir(),
      work: budgetWork({ timeoutMs: 25 }),
      timeoutMs: 100,
      resourceFetcher: {
        async fetchMessageResource() {
          return pending.promise;
        },
      },
    });

    expect(result.attachments[0]).toMatchObject({
      status: 'not_downloaded',
      reason: 'deadline',
    });
    pending.resolve({ stream: Readable.from([Buffer.from('late')]), headers: {} });
  });

  it('bounds a hanging resource stream by the per-message deadline', async () => {
    const stream = new Readable({ read() {} });
    const result = await formatFeishuMessageForRuntime(event({
      resources: [{ type: 'file', key: 'slow-stream' }],
    }), {
      cacheDir: cacheDir(),
      work: budgetWork({ timeoutMs: 25 }),
      timeoutMs: 100,
      resourceFetcher: {
        async fetchMessageResource() {
          return { stream, headers: {} };
        },
      },
    });

    expect(result.attachments[0]).toMatchObject({
      status: 'not_downloaded',
      reason: 'deadline',
    });
    expect(stream.destroyed).toBe(true);
  });
});
