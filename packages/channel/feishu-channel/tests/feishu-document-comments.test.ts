/**
 * `FeishuDocumentComments` owns both halves of one fact: a recipient follows a
 * document, and a comment on that document reaches whoever follows it.
 *
 * These tests drive it against a real `FeishuRouting` over a temp-dir store,
 * because both halves are statements about what the committed document holds —
 * a refusal that wrote nothing, and a rejection that removed exactly one row.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  FeishuCommentEvent,
  FeishuDocCommentText,
} from '@excitedjs/feishu-transport';
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FeishuDocumentComments,
  type FeishuDocumentCommentsOptions,
} from '../src/feishu-document-comments.js';
import type { FeishuSubmission, FeishuSubmitOutcome } from '../src/feishu-submit.js';
import { FeishuRouting } from '../src/routing/index.js';
import { FeishuRoutingStore } from '../src/routing/store.js';

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-doc-comments-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly comments: FeishuDocumentComments;
  readonly routing: FeishuRouting;
  readonly lookups: string[];
  readonly submissions: Array<{
    teamName: string | null;
    submission: FeishuSubmission;
  }>;
  outcomeFor: Map<string | null, FeishuSubmitOutcome>;
  trusted: Set<string>;
  /** Every comment-text read, as `fileToken:commentId:replyId`. */
  readonly commentReads: string[];
  /** What that read answers with; `null` is "Feishu holds no text for it". */
  readonly comment: { value: FeishuDocCommentText | Error | null };
}

async function harness(
  overrides: Partial<FeishuDocumentCommentsOptions> = {},
): Promise<Harness> {
  const store = new FeishuRoutingStore({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    stateDir: dir,
  });
  await store.load();
  const routing = new FeishuRouting({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    store,
  });
  const lookups: string[] = [];
  const submissions: Harness['submissions'] = [];
  const outcomeFor = new Map<string | null, FeishuSubmitOutcome>();
  const trusted = new Set<string>();
  const commentReads: string[] = [];
  const comment: Harness['comment'] = { value: null };
  const comments = new FeishuDocumentComments({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    log: silentLogger,
    routing,
    async submit(teamName, submission) {
      submissions.push({ teamName, submission });
      return outcomeFor.get(teamName) ?? { status: 'submitted', turnId: 't-1' };
    },
    async fetchDocMeta(fileToken, fileType) {
      lookups.push(`meta:${fileToken}:${fileType}`);
      return { kind: 'visible', meta: { title: '', url: '' } };
    },
    async resolveWikiNode(token) {
      lookups.push(`wiki:${token}`);
      return { objToken: 'doc_from_wiki', objType: 'docx' };
    },
    async fetchDocCommentText(request) {
      commentReads.push(
        `${request.fileToken}:${request.commentId}:${request.replyId}`,
      );
      if (comment.value instanceof Error) throw comment.value;
      return comment.value;
    },
    async resolveUserName() {
      return 'Commenter';
    },
    async isTrustedUser(openId) {
      return trusted.has(openId);
    },
    ...overrides,
  });
  return {
    comments,
    routing,
    lookups,
    submissions,
    outcomeFor,
    trusted,
    commentReads,
    comment,
  };
}

function commentEvent(
  overrides: Partial<FeishuCommentEvent> = {},
): FeishuCommentEvent {
  return {
    fileToken: 'doc_tok',
    fileType: 'docx',
    commentId: 'cmt_1',
    replyId: '',
    commenterId: 'ou_commenter',
    mentionedBot: true,
    timestamp: 1757894400000,
    ...overrides,
  };
}

describe('subscribe_document — what it proves before it writes', () => {
  it('resolves a wiki node before reading metadata, and stores the object it holds', async () => {
    const h = await harness();

    const result = await h.comments.subscribe({
      document: 'https://example.invalid/wiki/WikNode',
      type: null,
      teamName: 'team-a',
    });

    expect(h.lookups).toEqual(['wiki:WikNode', 'meta:doc_from_wiki:docx']);
    expect(result).toEqual({
      file_token: 'doc_from_wiki',
      file_type: 'docx',
      already_subscribed: false,
    });
    expect(h.routing.subscribersFor('doc_from_wiki')).toHaveLength(1);
  });

  it('refuses and writes nothing when Feishu proves the document is invisible', async () => {
    const h = await harness({
      fetchDocMeta: async () => ({ kind: 'invisible' }),
    });

    await expect(
      h.comments.subscribe({ document: 'doc_tok', type: 'docx', teamName: null }),
    ).rejects.toBeInstanceOf(PublicInvokeFailure);
    expect(h.routing.subscribersFor('doc_tok')).toEqual([]);
  });

  it('a failed metadata request propagates, and never reads as missing permission', async () => {
    const h = await harness({
      fetchDocMeta: async () => {
        throw new Error('network down');
      },
    });

    const failure = await h.comments
      .subscribe({ document: 'doc_tok', type: 'docx', teamName: null })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PublicInvokeFailure);
    expect((failure as Error).message).toBe('network down');
  });

  it('an unsupported type is its own refusal, not a permission claim', async () => {
    const h = await harness({
      fetchDocMeta: async () => ({ kind: 'unsupported_type' }),
    });

    await expect(
      h.comments.subscribe({ document: 'doc_tok', type: 'minutes', teamName: null }),
    ).rejects.toThrow(/does not take type/);
  });

  it('a bare token with no type is refused before any platform call', async () => {
    const h = await harness();

    await expect(
      h.comments.subscribe({ document: 'doc_tok', type: null, teamName: null }),
    ).rejects.toThrow(/does not say what kind of document/);
    expect(h.lookups).toEqual([]);
  });

  it('a wiki node this bot cannot see is refused, with nothing written', async () => {
    const h = await harness({ resolveWikiNode: async () => null });

    await expect(
      h.comments.subscribe({
        document: 'https://example.invalid/wiki/WikNode',
        type: null,
        teamName: 'team-a',
      }),
    ).rejects.toThrow(/cannot see wiki node/);
    expect(h.routing.listSubscriptions('team-a')).toEqual([]);
  });
});

describe('unsubscribe_document', () => {
  it('resolves a wiki URL to the stored object token, so the link a caller subscribed with works', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'https://example.invalid/wiki/WikNode',
      type: null,
      teamName: 'team-a',
    });

    await expect(
      h.comments.unsubscribe({
        document: 'https://example.invalid/wiki/WikNode',
        teamName: 'team-a',
      }),
    ).resolves.toEqual({ file_token: 'doc_from_wiki', unsubscribed: true });
  });

  it('removes nothing when the row belongs to another recipient', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });

    await expect(
      h.comments.unsubscribe({ document: 'doc_tok', teamName: null }),
    ).resolves.toEqual({ file_token: 'doc_tok', unsubscribed: false });
    expect(h.routing.listSubscriptions('team-a')).toHaveLength(1);
  });
});

describe('document comment delivery', () => {
  it('drops an unfollowed comment that does not mention the bot', async () => {
    const h = await harness();

    await h.comments.deliver(commentEvent({ mentionedBot: false }));

    expect(h.submissions).toEqual([]);
  });

  it('drops an unfollowed mention from a commenter this Dispatcher does not trust', async () => {
    const h = await harness();

    await h.comments.deliver(commentEvent({ mentionedBot: true }));

    expect(h.submissions).toEqual([]);
  });

  it('delivers an unfollowed mention from a trusted commenter to the Dispatcher Agent, writing no row', async () => {
    const h = await harness();
    h.trusted.add('ou_commenter');

    await h.comments.deliver(commentEvent({ mentionedBot: true }));

    expect(h.submissions.map((call) => call.teamName)).toEqual([null]);
    expect(h.submissions[0]!.submission.kind).toBe('doc_comment');
    expect(h.routing.subscribersFor('doc_tok')).toEqual([]);
  });

  it('a rejected Dispatcher delivery of an unfollowed mention removes nothing', async () => {
    const h = await harness();
    h.trusted.add('ou_commenter');
    h.outcomeFor.set(null, {
      status: 'rejected',
      code: 'TEAM_NOT_FOUND',
      message: 'gone',
    });

    await h.comments.deliver(commentEvent({ mentionedBot: true }));

    expect(h.submissions).toHaveLength(1);
    expect(h.routing.subscribersFor('doc_tok')).toEqual([]);
  });

  it('a followed document is answered by its subscribers, never by the trust check', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });

    await h.comments.deliver(commentEvent({ mentionedBot: true }));

    expect(h.submissions.map((call) => call.teamName)).toEqual(['team-a']);
  });

  it('submits once per subscriber, and never falls back to the Dispatcher Agent', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-b',
    });

    await h.comments.deliver(commentEvent());

    expect(h.submissions.map((call) => call.teamName).sort()).toEqual([
      'team-a',
      'team-b',
    ]);
  });

  it('a rejected subscriber loses its own row while the other still receives its submission', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'closed-team',
    });
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: null,
    });
    h.outcomeFor.set('closed-team', {
      status: 'rejected',
      code: 'TEAM_CLOSED',
      message: 'closed',
    });

    await h.comments.deliver(commentEvent());

    expect(h.submissions.map((call) => call.teamName)).toEqual(
      expect.arrayContaining([null, 'closed-team']),
    );
    expect(h.submissions).toHaveLength(2);
    expect(h.routing.subscribersFor('doc_tok').map((row) => row.team_name))
      .toEqual([null]);
  });

  it('two replies in one thread carry different source ids, so both are admitted', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });

    await h.comments.deliver(commentEvent({ replyId: 'rpl_1' }));
    await h.comments.deliver(commentEvent({ replyId: 'rpl_2' }));

    expect(h.submissions.map((call) => call.submission.sourceId)).toEqual([
      'doc_tok:cmt_1:rpl_1',
      'doc_tok:cmt_1:rpl_2',
    ]);
  });

  it('builds one anchorless submission whose body is a single doc-comment element', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });

    await h.comments.deliver(commentEvent({ replyId: 'rpl_1' }));

    const { submission } = h.submissions[0]!;
    expect(submission.kind).toBe('doc_comment');
    expect(submission).not.toHaveProperty('anchor');
    expect(submission.attrs).toEqual({
      source: 'feishu',
      sender_id: 'ou_commenter',
      sender_name: 'Commenter',
      create_time: expect.stringContaining('2025'),
    });
    expect(submission.text).toBe(
      '<doc-comment file_token="doc_tok" file_type="docx" comment_id="cmt_1" ' +
        'reply_id="rpl_1" notice_type="add_reply" mentioned="true" ' +
        'note="read the thread and the document with lark-cli" />',
    );
    expect(submission.reminder).toContain('--as bot');
  });

  it('carries what the commenter wrote, and the document text it is anchored to', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });
    h.comment.value = {
      quote: 'the paragraph in question',
      text: '@ou_bot please rework this',
    };

    await h.comments.deliver(commentEvent({ replyId: 'rpl_1' }));

    expect(h.commentReads).toEqual(['doc_tok:cmt_1:rpl_1']);
    expect(h.submissions[0]!.submission.text).toBe(
      '<doc-comment file_token="doc_tok" file_type="docx" comment_id="cmt_1" ' +
        'reply_id="rpl_1" notice_type="add_reply" mentioned="true" ' +
        'note="read the thread and the document with lark-cli">\n' +
        '<quote note="the document text this comment is anchored to">\n' +
        'the paragraph in question\n' +
        '</quote>\n' +
        '<content>\n' +
        '@ou_bot please rework this\n' +
        '</content>\n' +
        '</doc-comment>',
    );
  });

  it('a whole-document comment carries no quote block', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });
    h.comment.value = { quote: '', text: 'looks good' };

    await h.comments.deliver(commentEvent());

    const { text } = h.submissions[0]!.submission;
    expect(text).not.toContain('<quote');
    expect(text).toContain('<content>\nlooks good\n</content>');
  });

  it('escapes the comment text exactly as a chat body is escaped', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });
    h.comment.value = { quote: 'a & b', text: 'use <at> & not <b>' };

    await h.comments.deliver(commentEvent());

    const { text } = h.submissions[0]!.submission;
    expect(text).toContain('<content>\nuse &lt;at&gt; &amp; not &lt;b&gt;\n</content>');
    expect(text).toContain('a &amp; b');
  });

  it('a failed text read delivers the ids alone rather than dropping the event', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });
    h.comment.value = new Error('feishu said no');

    await h.comments.deliver(commentEvent({ replyId: 'rpl_1' }));

    expect(h.submissions).toHaveLength(1);
    expect(h.submissions[0]!.submission.text).toBe(
      '<doc-comment file_token="doc_tok" file_type="docx" comment_id="cmt_1" ' +
        'reply_id="rpl_1" notice_type="add_reply" mentioned="true" ' +
        'note="read the thread and the document with lark-cli" />',
    );
  });

  it('reads the text once for an event with several subscribers', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-b',
    });

    await h.comments.deliver(commentEvent());

    expect(h.commentReads).toEqual(['doc_tok:cmt_1:']);
  });

  it('spends no platform call on an event it drops', async () => {
    const h = await harness();

    await h.comments.deliver(commentEvent({ mentionedBot: false }));
    await h.comments.deliver(commentEvent({ mentionedBot: true }));

    expect(h.submissions).toEqual([]);
    expect(h.commentReads).toEqual([]);
  });

  it('an unfollowed mention reaching the Dispatcher carries the text too', async () => {
    const h = await harness();
    h.trusted.add('ou_commenter');
    h.comment.value = { quote: '', text: 'who owns this?' };

    await h.comments.deliver(commentEvent({ mentionedBot: true }));

    expect(h.commentReads).toEqual(['doc_tok:cmt_1:']);
    expect(h.submissions[0]!.submission.text).toContain(
      '<content>\nwho owns this?\n</content>',
    );
  });

  it('a top-level comment reads as add_comment, a reply as add_reply', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });

    await h.comments.deliver(commentEvent());
    await h.comments.deliver(commentEvent({ replyId: 'rpl_1' }));

    expect(h.submissions[0]!.submission.text).toContain('notice_type="add_comment"');
    expect(h.submissions[1]!.submission.text).toContain('notice_type="add_reply"');
  });

  it('delivers a subscribed comment that does not mention the bot, recording what Feishu said', async () => {
    const h = await harness();
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });

    await h.comments.deliver(commentEvent({ mentionedBot: false }));

    expect(h.submissions).toHaveLength(1);
    expect(h.submissions[0]!.submission.text).toContain('mentioned="false"');
  });

  it('a sender-name lookup that fails still delivers, without the name', async () => {
    const h = await harness({
      resolveUserName: async () => {
        throw new Error('contact lookup is down');
      },
    });
    await h.comments.subscribe({
      document: 'doc_tok',
      type: 'docx',
      teamName: 'team-a',
    });

    await h.comments.deliver(commentEvent());

    expect(h.submissions[0]!.submission.attrs).not.toHaveProperty('sender_name');
  });
});
