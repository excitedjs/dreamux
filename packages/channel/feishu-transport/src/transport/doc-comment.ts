/**
 * Reading the one comment a `drive.notice.comment_add_v1` event names.
 *
 * A comment is two facts, and this module keeps both: what the commenter
 * wrote, and which part of the document they wrote it about. The second is the
 * one Feishu answers in pieces — some of them outside the SDK's own response
 * type — so it is assembled here rather than at the reader.
 */
import * as lark from '@larksuiteoapi/node-sdk'

/**
 * One piece of a comment's body.
 *
 * A mention stays a mention rather than being flattened into text here,
 * because the element a model reads it as is an agent-facing body format and
 * this package does not assemble those. The caller decides how to write it.
 */
export type FeishuCommentSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'mention'; readonly openId: string }

/**
 * What a comment is about: the whole document, or something in it.
 *
 * Feishu states this itself, and it is not the same fact as an unread comment.
 * A caller that could not read the comment learns nothing about its anchor,
 * while this says the commenter chose the document rather than a part of it.
 */
export type FeishuCommentAnchor =
  | { readonly kind: 'whole_document' }
  | {
      readonly kind: 'content'
      /**
       * Feishu's own id for the anchored content, empty when it returns none.
       * What the id names follows the document type — for a docx it is a block
       * id — so a reader pairs it with the type it arrived with. A selection
       * spanning several parts records the one it starts at.
       */
      readonly anchorId: string
      /**
       * The anchored text as Feishu previews it. Feishu derives it and cuts it
       * at a length of its own, saying neither that it cut anything nor how
       * long the original was, so it reads a passage and does not reproduce
       * one.
       */
      readonly preview: string
      /**
       * Whether Feishu says the anchored content has since been deleted. False
       * also covers a response that does not say, which is every document type
       * that carries no relation.
       */
      readonly deleted: boolean
    }

/**
 * The one comment a `drive.notice.comment_add_v1` event names.
 *
 * The event payload carries identifying ids only, so a caller that wants to
 * show a person what was written has to read the thread. Only the named item
 * is returned: a whole thread is what lark-cli is for.
 */
export interface FeishuDocCommentText {
  /** Which part of the document this comment is about. */
  anchor: FeishuCommentAnchor
  /** What the commenter wrote, in order. */
  segments: readonly FeishuCommentSegment[]
}

/** The one comment to read: a thread, and the item inside it. */
export interface FeishuDocCommentRequest {
  fileToken: string
  fileType: string
  commentId: string
  /** Empty names the thread's own top-level comment. */
  replyId: string
}

/**
 * The document types the comment API takes, intersected with the types a
 * comment event can name. It is narrower than the metadata API's list, so the
 * two conversions cannot share one.
 */
const COMMENT_FILE_TYPES = ['doc', 'docx', 'sheet', 'bitable', 'slides', 'file'] as const
type CommentFileType = (typeof COMMENT_FILE_TYPES)[number]

function asCommentFileType(fileType: string): CommentFileType | undefined {
  return (COMMENT_FILE_TYPES as readonly string[]).includes(fileType)
    ? (fileType as CommentFileType)
    : undefined
}

interface RawCommentElement {
  type: 'text_run' | 'docs_link' | 'person'
  text_run?: { text: string }
  docs_link?: { url: string }
  person?: { user_id: string }
}

/**
 * One comment's elements, in order, as the two kinds of thing they can be.
 *
 * A `docs_link` is text: it is a URL the commenter typed and reads as one. A
 * `person` is not, because the caller writes it as the same mention element an
 * inbound chat message's mention becomes, and only the caller owns that form.
 *
 * Each element's payload is optional in Feishu's own types even when `type`
 * names it, so an element that carries nothing contributes nothing.
 */
function commentElementSegment(element: RawCommentElement): FeishuCommentSegment {
  switch (element.type) {
    case 'text_run':
      return { kind: 'text', text: element.text_run?.text ?? '' }
    case 'docs_link':
      return { kind: 'text', text: element.docs_link?.url ?? '' }
    case 'person':
      return element.person === undefined
        ? { kind: 'text', text: '' }
        : { kind: 'mention', openId: element.person.user_id }
  }
}

/**
 * The comment fields Feishu returns and the SDK's response type omits. `extra`
 * arrives on every item; `relation` only when the read asks for it, and only
 * for a document type that has one.
 */
interface UndeclaredCommentFields {
  extra?: { content_anchor_id?: string }
  relation?: { content_deleted?: boolean }
}

/**
 * Read where a comment is anchored, from the item that carries it.
 *
 * `is_whole` is the platform's own answer and is taken as it stands: a comment
 * on the whole document carries no quote and no anchor, and every other
 * comment is about content, named as well as the response names it.
 */
function commentAnchor(item: { is_whole?: boolean; quote?: string }): FeishuCommentAnchor {
  if (item.is_whole === true) return { kind: 'whole_document' }
  const undeclared = item as unknown as UndeclaredCommentFields
  return {
    kind: 'content',
    anchorId: undeclared.extra?.content_anchor_id ?? '',
    preview: item.quote ?? '',
    deleted: undeclared.relation?.content_deleted === true,
  }
}

/**
 * Read the comment the event names, or `null`.
 *
 * Every way of not finding it is one answer to the caller — there is no text
 * to show — so a missing thread, a missing reply, and a document type the
 * comment API does not take are all `null`. A platform failure is not one of
 * them and throws.
 */
export async function readDocComment(
  client: lark.Client,
  request: FeishuDocCommentRequest,
): Promise<FeishuDocCommentText | null> {
  const ct = asCommentFileType(request.fileType)
  if (!ct) return null
  const res = await client.drive.fileComment.batchQuery({
    path: { file_token: request.fileToken },
    params: { file_type: ct, user_id_type: 'open_id' },
    // `need_relation` is what makes Feishu say whether the anchored content
    // still exists. The same response carries it, so asking costs nothing.
    data: { comment_ids: [request.commentId], need_relation: true },
  })
  // A non-zero business code arrives on a successful HTTP response, so a
  // revoked scope would otherwise read as "this thread holds no such item".
  if (res.code !== undefined && res.code !== 0) {
    throw new Error(
      `Feishu comment read for ${request.commentId} failed ` +
        `(code ${res.code}: ${res.msg ?? ''})`,
    )
  }
  const item = res.data?.items?.find((row) => row.comment_id === request.commentId)
  if (!item) return null
  // An empty reply id names the thread's own comment, which the API carries as
  // the first entry of the same `reply_list` its replies are in.
  const replies = item.reply_list?.replies ?? []
  const reply = request.replyId === ''
    ? replies[0]
    : replies.find((row) => row.reply_id === request.replyId)
  if (!reply) return null
  return {
    anchor: commentAnchor(item),
    segments: reply.content.elements.map(commentElementSegment),
  }
}
