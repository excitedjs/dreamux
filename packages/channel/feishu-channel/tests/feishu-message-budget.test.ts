import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('counts cached attachments against per-resource and aggregate budgets', async () => {
    const cache = cacheDir();
    const first = await formatFeishuMessageForRuntime(event({
      resources: [
        { type: 'file', key: 'cached-a' },
        { type: 'file', key: 'cached-b' },
      ],
    }), {
      cacheDir: cache,
      work: budgetWork({}),
      resourceFetcher: {
        async fetchMessageResource() {
          return { stream: Readable.from([Buffer.from('four')]), headers: {} };
        },
      },
    });
    expect(first.attachments.every((attachment) => attachment.status === 'downloaded'))
      .toBe(true);

    const aggregate = budgetWork({ maxAggregateResourceBytes: 5 });
    const second = await formatFeishuMessageForRuntime(event({
      resources: [
        { type: 'file', key: 'cached-a' },
        { type: 'file', key: 'cached-b' },
      ],
    }), {
      cacheDir: cache,
      work: aggregate,
      resourceFetcher: {
        async fetchMessageResource() {
          throw new Error('cache hit should not fetch');
        },
      },
    });
    expect(second.attachments.map(({ status, reason }) => ({ status, reason })))
      .toEqual([
        { status: 'downloaded', reason: undefined },
        { status: 'not_downloaded', reason: 'aggregate_limit' },
      ]);
    expect(aggregate.remainingAggregateBytes).toBe(1);

    const perResource = await formatFeishuMessageForRuntime(event({
      resources: [{ type: 'file', key: 'cached-a' }],
    }), {
      cacheDir: cache,
      work: budgetWork({ maxResourceBytes: 3 }),
      resourceFetcher: {
        async fetchMessageResource() {
          throw new Error('cache hit should not fetch');
        },
      },
    });
    expect(perResource.attachments[0]).toMatchObject({
      status: 'not_downloaded',
      reason: 'too_large',
    });
  });

  it('charges bytes read before an aggregate-limit failure', async () => {
    const work = budgetWork({
      maxResourceBytes: 20,
      maxAggregateResourceBytes: 5,
    });
    const result = await formatFeishuMessageForRuntime(event({
      resources: [
        { type: 'file', key: 'over-budget' },
        { type: 'file', key: 'after-budget' },
      ],
    }), {
      cacheDir: cacheDir(),
      work,
      resourceFetcher: {
        async fetchMessageResource(request) {
          return {
            stream: Readable.from([
              Buffer.from(request.fileKey === 'over-budget' ? '123456' : 'x'),
            ]),
            headers: {},
          };
        },
      },
    });

    expect(result.attachments.map(({ reason }) => reason)).toEqual([
      'aggregate_limit',
      'aggregate_limit',
    ]);
    expect(work.remainingAggregateBytes).toBe(0);
  });

  it('caps escaped rich content without cutting an XML entity', async () => {
    const result = await formatFeishuMessageForRuntime(event({
      parsedText: `${'x'.repeat(159_995)}<&>tail`,
    }));

    expect(result.body.length).toBeLessThanOrEqual(160_000);
    expect(result.body).toContain('[message content truncated: 160000-character limit reached]');
    expect(result.body).not.toMatch(/&(?:a|am|amp|l|lt|g|gt)?$/);
  });

  it('caps the complete rich body without cutting channel-owned XML tags', async () => {
    const result = await formatFeishuMessageForRuntime(event({
      resources: [{
        type: 'file',
        key: 'large-name',
        name: 'x'.repeat(200_000),
      }],
    }));

    expect(result.body.length).toBeLessThanOrEqual(160_000);
    expect(result.body).toContain('[message content truncated: 160000-character limit reached]');
    expect(result.body.match(/<attachment\b/g)?.length ?? 0).toBe(
      result.body.match(/<\/attachment>/g)?.length ?? 0,
    );
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

  it('destroys a resource stream that arrives after the request deadline', async () => {
    const pending = deferred<{
      stream: Readable;
      headers: Record<string, unknown>;
    }>();
    const resultPromise = formatFeishuMessageForRuntime(event({
      resources: [{ type: 'image', key: 'late-api' }],
    }), {
      cacheDir: cacheDir(),
      work: budgetWork({ timeoutMs: 20 }),
      timeoutMs: 100,
      resourceFetcher: {
        async fetchMessageResource() {
          return pending.promise;
        },
      },
    });
    const result = await resultPromise;
    expect(result.attachments[0]).toMatchObject({
      status: 'not_downloaded',
      reason: 'deadline',
    });

    const lateStream = Readable.from([Buffer.from('late')]);
    pending.resolve({ stream: lateStream, headers: {} });
    await vi.waitFor(() => expect(lateStream.destroyed).toBe(true));
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

  it('uses the operation deadline for a hanging resource stream', async () => {
    const stream = new Readable({ read() {} });
    const result = await formatFeishuMessageForRuntime(event({
      resources: [{ type: 'file', key: 'resource-timeout' }],
    }), {
      cacheDir: cacheDir(),
      work: budgetWork({ timeoutMs: 100 }),
      timeoutMs: 20,
      resourceFetcher: {
        async fetchMessageResource() {
          return { stream, headers: {} };
        },
      },
    });

    expect(result.attachments[0]).toMatchObject({
      status: 'not_downloaded',
      reason: 'timeout',
    });
    expect(stream.destroyed).toBe(true);
  });
});
