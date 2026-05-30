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
})
