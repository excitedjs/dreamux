/**
 * The Channel-ingress boundary, end to end: a Channel formats one inbound
 * event into opaque attrs + body (its own business), and Core turns that into
 * the one submission envelope every runtime reads.
 *
 * `renderChannelBlock` / `renderChannelInput` / `InboundTurnInput` — the
 * dreamux-utils pre-renderers this file used to exercise — are gone: no
 * runtime-neutral layer pre-renders XML any more. `FormatFeishuMessageResult`
 * says so directly ("The channel no longer renders the final XML — each
 * runtime wraps these into its own channel envelope"). The CURRENT owner of
 * that wrap is `channelSubmission` + `renderSubmission`
 * (`packages/dreamux/src/service/channel-submission.ts`,
 * `.../teammate-service/submission.ts`); `submission-envelope.test.ts` covers
 * that owner's contract in isolation, so this file's job is narrower: prove a
 * REAL Feishu-shaped `formatFeishuMessageForRuntime` result survives that
 * pipeline unchanged, plus the attachment-cache filesystem-security behavior
 * that lives in the same formatter and touches neither deleted symbol.
 */
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

import { formatFeishuMessageForRuntime } from '@excitedjs/feishu-channel';
import type { FeishuInboundEvent } from '@excitedjs/feishu-channel';

import { channelSubmission } from '../src/service/channel-submission.js';
import { renderSubmission } from '../src/service/teammate-service/submission.js';

/** The same attribute-value escaping `renderSubmission` applies — asserted independently in submission-envelope.test.ts. */
function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

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
  it('returns the six baseline attrs and omits an absent thread id', async () => {
    const result = await formatFeishuMessageForRuntime(inboundEvent());
    expect(result.attrs.map(([k]) => k)).toEqual([
      'chat_id',
      'chat_type',
      'message_id',
      'sender_id',
      'sender_name',
      'create_time',
    ]);
    // The channel layer still renders no wrapper of its own: Core is the sole
    // owner of the <channel ...> envelope.
    expect(result.body).not.toContain('<channel');
    expect(result.body).not.toContain('source="feishu"');
    expect(result.attrs.find(([k]) => k === 'chat_id')?.[1]).toBe('chat-1');
    expect(result.attrs.find(([k]) => k === 'thread_id')).toBeUndefined();
  });

  it('omits an empty Feishu thread id', async () => {
    const result = await formatFeishuMessageForRuntime(inboundEvent({ threadId: '' }));
    expect(result.attrs.find(([key]) => key === 'thread_id')).toBeUndefined();
  });
});

describe('the Channel → Core submission pipeline: formatFeishuMessageForRuntime into channelSubmission + renderSubmission', () => {
  it('carries every Feishu attr through as escaped start-tag attributes, keyed by CHANNEL_SOURCE', async () => {
    const result = await formatFeishuMessageForRuntime(
      inboundEvent({ threadId: 'topic-a' }),
    );

    const submission = channelSubmission({
      sourceId: 'msg-1',
      attrs: result.attrs,
      text: result.body,
    });
    const rendered = renderSubmission(submission);

    // Core's own provenance name, not whatever the Channel calls itself.
    expect(rendered.startsWith('<channel ')).toBe(true);
    expect(rendered).toContain(' chat_id="chat-1"');
    expect(rendered).toContain(' thread_id="topic-a"');
    expect(rendered.endsWith('</channel>')).toBe(true);
  });

  it('carries the Channel-formatted body through byte for byte, attachment refs and group_bots block included', async () => {
    // No resourceFetcher → the attachment is not downloaded and renders as a
    // text ref in the body; trustedBots adds a <group_bots> block. Both must
    // survive the envelope wrap with no content regression, since the body is
    // passed through untouched (no entity rewriting, no CDATA, no reindent).
    const result = await formatFeishuMessageForRuntime(inboundEvent(), {
      trustedBots: [{ openId: 'bot-open-1', name: 'Helper' }],
    });
    expect(result.body).toContain('<attachment');
    expect(result.body).toContain('<group_bots');

    const submission = channelSubmission({
      sourceId: 'msg-1',
      attrs: result.attrs,
      text: result.body,
    });
    const rendered = renderSubmission(submission);

    // Every attr the Channel produced (its own concern — including the
    // human-formatted `create_time`, tested in feishu-channel's own suite —
    // survives escaped, in the Channel's own order) plus the untouched body.
    const expectedAttrs = result.attrs
      .map(([name, value]) => ` ${name}="${escapeXmlAttr(value)}"`)
      .join('');
    expect(rendered).toBe(`<channel${expectedAttrs}>${result.body}</channel>`);
  });

  it('bypasses admission dedup for an empty Feishu message id (no source_id key at all)', async () => {
    const result = await formatFeishuMessageForRuntime(inboundEvent());
    const submission = channelSubmission({ sourceId: '', attrs: result.attrs, text: result.body });
    expect('sourceId' in submission).toBe(false);
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
