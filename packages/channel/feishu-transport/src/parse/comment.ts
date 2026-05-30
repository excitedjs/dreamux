/**
 * Decoding the `drive.notice.comment_add_v1` event payload.
 *
 * The Feishu SDK's own `normalizeComment` is the authoritative decoder for this
 * event — it tolerates both the flat and the `notice_meta`-nested payload
 * variants Feishu sends, which a hand-written path table is bound to drift from.
 * Because the SDK is the only Feishu-platform import in this package, this
 * decoder lives in core; a host's comment handler calls it instead of importing
 * the lark SDK itself (claudemux#155 §六.2 / dreamux#25 §7.1).
 *
 * The decode is pure: no I/O, never throws. Enriching the comment (fetching its
 * text and the document title) is the transport's `fetchDocComment` /
 * `fetchDocMeta`; shaping the notification body is the host handler's job.
 */

import * as lark from '@larksuiteoapi/node-sdk'

import { isRecord } from '../json.js'

/** The Feishu event_type this decoder is for. */
export const DOC_COMMENT_EVENT_TYPE = 'drive.notice.comment_add_v1'

/** A normalized document-comment event — the identifying fields the payload carries. */
export interface FeishuCommentEvent {
  /** Token of the document the comment is on. */
  fileToken: string
  /** Document type — `doc` / `docx` / `sheet` / `bitable` / ... */
  fileType: string
  /** Comment id. */
  commentId: string
  /** Reply id — set only when the event is a reply within a thread, `''` otherwise. */
  replyId: string
  /** open_id of the commenter. */
  commenterId: string
  /** True when the comment @-mentions the bot. */
  mentionedBot: boolean
}

/**
 * Reshape a raw `drive.notice.comment_add_v1` payload into a
 * `FeishuCommentEvent`, using the Feishu SDK's `normalizeComment` as the
 * decoder. Returns `null` for a non-object input or a payload the SDK cannot
 * resolve a file token, file type, comment id, and commenter from. Pure: no
 * I/O, never throws. Tolerates either the event body alone (what the SDK's
 * `EventDispatcher` delivers) or a full `{ event: ... }` envelope.
 */
export function normalizeCommentEvent(raw: unknown): FeishuCommentEvent | null {
  if (!isRecord(raw)) return null
  const event = isRecord(raw.event) ? raw.event : raw

  let decoded: lark.CommentEvent | null
  try {
    decoded = lark.normalizeComment(event as lark.RawCommentEvent)
  } catch {
    // `normalizeComment` is pure but not contractually total — guard it so a
    // surprising input shape is a dropped event, not a thrown one.
    return null
  }
  if (!decoded) return null

  return {
    fileToken: decoded.fileToken,
    fileType: decoded.fileType,
    commentId: decoded.commentId,
    replyId: decoded.replyId ?? '',
    commenterId: decoded.operator.openId,
    mentionedBot: decoded.mentionedBot,
  }
}
