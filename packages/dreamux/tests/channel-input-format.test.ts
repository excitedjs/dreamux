import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  renderChannelBlock,
  renderChannelInput,
  type InboundTurnInput,
} from '../src/agent-runtime/turn.js';
import { formatFeishuMessageForRuntime } from '../src/channel/feishu/feishu-message.js';
import type { FeishuInboundEvent } from '../src/channel/feishu/bot.js';

describe('renderChannelBlock (native <channel> wrap, shared by both runtimes)', () => {
  it('renders source + attrs + body in the native envelope', () => {
    const out = renderChannelBlock(
      'feishu',
      [
        ['chat_id', 'chat-1'],
        ['sender_id', 'sender-1'],
      ],
      'hello world',
    );
    expect(out).toBe(
      '<channel source="feishu" chat_id="chat-1" sender_id="sender-1">\nhello world\n</channel>',
    );
  });

  it('XML-escapes attribute values and drops unsafe attribute keys', () => {
    const out = renderChannelBlock(
      'feishu',
      [
        ['chat_id', 'a"b<c>&d'],
        ['bad-key', 'dropped'],
        ['1leading', 'dropped'],
      ],
      'body',
    );
    expect(out).toContain('chat_id="a&quot;b&lt;c&gt;&amp;d"');
    expect(out).not.toContain('bad-key');
    expect(out).not.toContain('1leading');
  });
});

describe('renderChannelInput', () => {
  it('wraps a structured channel input into the <channel> block', () => {
    const input: InboundTurnInput = {
      sourceId: 'm1',
      source: 'feishu',
      text: 'ignored fallback',
      attrs: [['chat_id', 'chat-1']],
      body: 'the message',
    };
    expect(renderChannelInput(input)).toBe(
      '<channel source="feishu" chat_id="chat-1">\nthe message\n</channel>',
    );
  });

  it('passes plain input (no attrs/body) through unchanged', () => {
    const input: InboundTurnInput = { sourceId: 'm1', text: 'a trigger turn' };
    expect(renderChannelInput(input)).toBe('a trigger turn');
  });
});

function inboundEvent(overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'file',
    rawContent: JSON.stringify({ file_key: 'file-key-1', file_name: 'report.pdf' }),
    parsedText: '(file message)',
    resources: [{ type: 'file', key: 'file-key-1', name: 'report.pdf' }],
    mentions: [],
    createTime: '1700000000000',
    raw: {},
    ...overrides,
  };
}

describe('formatFeishuMessageForRuntime (structured, no pre-rendered XML)', () => {
  it('returns the six display attrs and an unwrapped body (no pre-rendered envelope)', async () => {
    const result = await formatFeishuMessageForRuntime(inboundEvent());
    expect(result.attrs.map(([k]) => k)).toEqual([
      'chat_id',
      'chat_type',
      'message_id',
      'sender_id',
      'sender_name',
      'create_time',
    ]);
    // The channel layer no longer pre-renders any message wrapper — the runtime
    // owns adding the <channel> envelope.
    expect(result.body).not.toContain('<channel');
    expect(result.body).not.toContain('source="feishu"');
    expect(result.attrs.find(([k]) => k === 'chat_id')?.[1]).toBe('chat-1');
  });

  it('keeps attachment refs and the group_bots block inside the rendered <channel>', async () => {
    // No resourceFetcher → the attachment is not downloaded and renders as a
    // text ref in the body; trustedBots adds a <group_bots> block. Both must
    // survive into the wrapped channel block (no content regression).
    const result = await formatFeishuMessageForRuntime(inboundEvent(), {
      trustedBots: [{ openId: 'bot-open-1', name: 'Helper' }],
    });
    expect(result.body).toContain('<attachment');
    expect(result.body).toContain('<group_bots');

    const wrapped = renderChannelInput({
      sourceId: 'msg-1',
      source: 'feishu',
      text: result.body,
      attrs: result.attrs,
      body: result.body,
    });
    expect(wrapped.startsWith('<channel source="feishu"')).toBe(true);
    expect(wrapped).toContain('<attachment');
    expect(wrapped).toContain('<group_bots');
    expect(wrapped.endsWith('</channel>')).toBe(true);
  });
});

describe('attachment cache owner-only enforcement (issue #182 PR-2)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function cacheDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dx-attach-cache-'));
    dirs.push(dir);
    return dir;
  }

  /** A fetcher that streams fixed bytes; counts how many times it was called. */
  function countingFetcher(): {
    fetchMessageResource: () => Promise<{ stream: Readable; headers: Record<string, unknown> }>;
    calls: number;
  } {
    const f = {
      calls: 0,
      async fetchMessageResource() {
        f.calls += 1;
        return { stream: Readable.from([Buffer.from('pdf-bytes')]), headers: {} };
      },
    };
    return f;
  }

  it('tightens a pre-existing permissive cache dir on a cache HIT, not only on a miss', async () => {
    const cache = cacheDir();
    const fetcher = countingFetcher();

    // First call: cache miss populates the file and creates the dir 0700.
    const miss = await formatFeishuMessageForRuntime(inboundEvent(), {
      cacheDir: cache,
      resourceFetcher: fetcher,
    });
    expect(miss.attachments[0]?.status).toBe('downloaded');
    expect(fetcher.calls).toBe(1);

    // Someone loosens the cache dir behind our back.
    chmodSync(cache, 0o755);
    expect(statSync(cache).mode & 0o777).toBe(0o755);

    // Second call: cache HIT. The fix runs ensureOwnerOnlyDir BEFORE the
    // fast-path return, so the dir is re-tightened and the fetcher is not hit.
    const hit = await formatFeishuMessageForRuntime(inboundEvent(), {
      cacheDir: cache,
      resourceFetcher: fetcher,
    });
    expect(hit.attachments[0]?.status).toBe('downloaded');
    expect(fetcher.calls).toBe(1);
    expect(statSync(cache).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlinked cache dir instead of returning a downloaded path', async () => {
    const real = cacheDir();
    const link = `${real}-link`;
    symlinkSync(real, link);
    dirs.push(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const fetcher = countingFetcher();
    const result = await formatFeishuMessageForRuntime(inboundEvent(), {
      cacheDir: link,
      resourceFetcher: fetcher,
    });
    // ensureOwnerOnlyDir rejects the symlinked leaf; the attachment falls back
    // to not_downloaded rather than exposing a path under an unverified dir.
    expect(result.attachments[0]?.status).toBe('not_downloaded');
    expect(fetcher.calls).toBe(0);
  });
});
