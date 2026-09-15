/**
 * Guard-path coverage for `normalizeCommentEvent` — the comment-event decode
 * core exposes so a host's doc-comment handler never imports the lark SDK
 * itself. The happy path delegates to the SDK's own `normalizeComment` (lark's
 * tested code); these tests pin the defensive wrapper: a non-object input or a
 * payload the SDK cannot resolve must yield `null`, never a throw.
 */

import { describe, expect, test } from 'vitest'
import { normalizeCommentEvent } from '../src/parse/comment'

describe('normalizeCommentEvent', () => {
  test('returns null for non-object inputs', () => {
    expect(normalizeCommentEvent(null)).toBeNull()
    expect(normalizeCommentEvent(undefined)).toBeNull()
    expect(normalizeCommentEvent('not an event')).toBeNull()
    expect(normalizeCommentEvent(42)).toBeNull()
  })

  test('returns null when the payload carries nothing the SDK can decode', () => {
    expect(normalizeCommentEvent({})).toBeNull()
    expect(normalizeCommentEvent({ event: {} })).toBeNull()
  })

  test('carries the identifying fields a host body is built from', () => {
    expect(
      normalizeCommentEvent({
        event: {
          file_token: 'doc_tok',
          file_type: 'docx',
          comment_id: 'cmt_1',
          reply_id: 'rpl_2',
          is_mentioned: true,
          create_time: '1757894400000',
          user_id: { open_id: 'ou_commenter' },
        },
      }),
    ).toEqual({
      fileToken: 'doc_tok',
      fileType: 'docx',
      commentId: 'cmt_1',
      replyId: 'rpl_2',
      commenterId: 'ou_commenter',
      mentionedBot: true,
      timestamp: 1757894400000,
    })
  })

  test('a top-level comment reports an empty reply id', () => {
    expect(
      normalizeCommentEvent({
        file_token: 'doc_tok',
        file_type: 'docx',
        comment_id: 'cmt_1',
        is_mentioned: false,
        create_time: '1757894400000',
        user_id: { open_id: 'ou_commenter' },
      })?.replyId,
    ).toBe('')
  })
})
