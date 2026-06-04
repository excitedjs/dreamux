/**
 * The Feishu platform boundary — the only module in the workspace that imports
 * the Feishu SDK.
 *
 * Everything that talks to Feishu — the inbound long-lived WebSocket and the
 * outbound message API — sits behind the `FeishuTransport` interface. A host
 * depends only on that interface, so its wiring can be exercised against an
 * injected fake with no live connection.
 *
 * The transport is event-type agnostic. `start` is handed a route table mapping
 * each Feishu event_type to a callback and registers every entry with the SDK's
 * event dispatcher; decoding a specific event's payload is the job of that
 * event's handler (see `../parse`), not this module. Adding a new event type to
 * a host therefore never touches this file.
 *
 * Cross-process single-instance election is intentionally **not** here. dreamux
 * gives each dispatcher its own bot identity (election is moot), and claudemux
 * wraps this transport with its own elected-transport layer. Core opens the
 * inbound WebSocket directly; whether exactly one process may do so is the
 * host's concern, layered on top. (claudemux#155 §二 / dreamux#25 §7.2.)
 *
 * Ported from claudemux's `feishu-channel/src/feishu.ts` (the source of truth),
 * with the instance-lock removed, `sendText` upgraded to the structured
 * `send(OutboundTarget, …)` contract, and `botOpenId` renamed to `selfId`.
 */

import * as lark from '@larksuiteoapi/node-sdk'

import type { OutboundTarget } from '../contract/outbound.js'
import {
  cardToContent,
  renderMarkdownToCards,
  FEISHU_CARD_REQUEST_LIMIT_BYTES,
  type RenderedCard,
} from '../render/render.js'
import {
  connectionErrorLogLine,
  reconnectedLogLine,
  reconnectingLogLine,
  startupTimeoutLogLine,
} from './connection.js'
import {
  createTransportDiagnostics,
  type TransportDiagnostics,
  type TransportLogger,
} from './diagnostics.js'

/** Cap on a single WebSocket handshake before it is aborted into a retry. */
const WS_HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * How long the initial connection is given to come up before the channel
 * stops it. Long enough to absorb a brief blip and the SDK's own early
 * retries; past it, an unreachable Feishu would otherwise retry in a tight
 * loop, so the transport cuts the attempt off.
 */
const WS_STARTUP_GRACE_MS = 30_000

/** Outcome of an outbound send. */
export interface FeishuSendResult {
  /**
   * message_ids of every card the send produced, in order. A Markdown body
   * that fits one card produces one entry; a longer body that the renderer
   * split over several cards produces several. Empty when Feishu omitted the
   * message_ids.
   */
  messageIds: string[]
}

/**
 * Build the `content` string for a Feishu plain-text message — the legacy
 * `msg_type: 'text'` payload, used by `editText`'s fallback path so an edit
 * on a message that was sent before this channel switched to interactive
 * cards still works.
 */
export function textMessageContent(text: string): string {
  return JSON.stringify({ text })
}

/**
 * Safe ceiling for the serialised card `content` string. Stays a few hundred
 * bytes below the documented 30 KB request-body limit so HTTP headers and the
 * `{ params, data: { receive_id, msg_type, content } }` envelope still fit.
 */
export const FEISHU_CARD_CONTENT_SAFE_BYTES = 28 * 1024

/**
 * Throw a clear, model-actionable error when a single card's content would
 * exceed Feishu's request-body limit, before the SDK round-trips and returns a
 * low-level Feishu code with no fix path. The renderer normally keeps each card
 * under the cap by splitting at element boundaries; this guards the residual
 * case where a card cannot be split smaller (an un-splittable oversized token).
 * Used by both `send` (preserving dreamux's prior per-card guard) and `editText`
 * (which additionally cannot fan out a multi-card body).
 */
function assertCardContentFits(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > FEISHU_CARD_CONTENT_SAFE_BYTES) {
    throw new Error(
      `card content is ${bytes} bytes; Feishu rejects a card-message body over ${FEISHU_CARD_REQUEST_LIMIT_BYTES} bytes. ` +
        'Shorten the message, or break up an oversized table or code block the renderer could not split smaller.',
    )
  }
}

/**
 * Render `text` as a single v2 card, throwing when the body exceeds what
 * one card can hold. Used by `editText` — an edit patches one message_id
 * in place and cannot fan out, so a multi-card body has no destination.
 */
function renderSingleCard(text: string): RenderedCard {
  const cards = renderMarkdownToCards(text)
  if (cards.length !== 1) {
    throw new Error(
      `edit body produced ${cards.length} cards, but an edit can only update one ` +
        'card in place. Reduce the body length, drop oversized tables, or send a ' +
        'fresh reply (which the channel splits automatically) instead of editing.',
    )
  }
  // The renderer always returns a non-empty array, but TypeScript can't
  // narrow that — pull the element out with the assertion that we just
  // verified there is exactly one.
  return cards[0] as RenderedCard
}

/** One reply within a fetched document-comment thread. */
export interface FeishuDocCommentReply {
  /** reply_id of this reply; `''` when Feishu omitted it. */
  replyId: string
  /** open_id of the reply's author. */
  authorId: string
  /** Raw Feishu rich-content elements of the reply body, rendered by the handler. */
  elements: unknown[]
}

/**
 * A document comment and its reply thread, fetched to enrich a comment event.
 *
 * The `drive.notice.comment_add_v1` payload carries only the comment's ids, so
 * the comment text is fetched separately — this is the fetched result.
 */
export interface FeishuDocComment {
  /** False for a comment anchored to a text selection; `quote` then holds it. */
  isWhole: boolean
  /** The selected text a local-selection comment is anchored to; `''` otherwise. */
  quote: string
  /** The comment's replies, oldest first. */
  replies: FeishuDocCommentReply[]
}

/** A document's human-readable identity, fetched to render a comment event. */
export interface FeishuDocMeta {
  /** Document title. */
  title: string
  /** Browser URL of the document. */
  url: string
}

/** Document types the drive file-comment API serves; others have no comment API. */
const COMMENT_FILE_TYPES = ['doc', 'docx', 'sheet', 'file'] as const
type CommentFileType = (typeof COMMENT_FILE_TYPES)[number]

/** Narrow an event's file_type to one the file-comment API accepts, or `undefined`. */
function asCommentFileType(fileType: string): CommentFileType | undefined {
  return (COMMENT_FILE_TYPES as readonly string[]).includes(fileType)
    ? (fileType as CommentFileType)
    : undefined
}

/**
 * One comment as `drive.v1.fileComment.batchQuery` returns it — only the
 * fields the channel reads. The SDK's response type carries more; this is the
 * structural subset `commentFromBatchQuery` decodes, and the shape a unit
 * test builds a fixture against.
 */
interface RawCommentItem {
  comment_id?: string
  is_whole?: boolean
  quote?: string
  reply_list?: {
    replies?: Array<{
      reply_id?: string
      user_id?: string
      content?: { elements?: unknown[] }
    }>
  }
}

/**
 * Pick the comment with `commentId` out of a `fileComment.batchQuery` response
 * and shape it into a `FeishuDocComment`. Returns `null` when the response
 * carried no such comment. Pure: no I/O, never throws — exported so the decode
 * is unit-tested without a live Feishu connection.
 */
export function commentFromBatchQuery(
  items: RawCommentItem[],
  commentId: string,
): FeishuDocComment | null {
  const item = items.find((c) => c.comment_id === commentId)
  if (!item) return null
  const replies: FeishuDocCommentReply[] = (item.reply_list?.replies ?? []).map((reply) => ({
    replyId: reply.reply_id ?? '',
    authorId: reply.user_id ?? '',
    elements: reply.content?.elements ?? [],
  }))
  return { isWhole: item.is_whole ?? true, quote: item.quote ?? '', replies }
}

/** Document types the drive metadata API serves. */
const META_DOC_TYPES = [
  'doc',
  'docx',
  'sheet',
  'bitable',
  'mindnote',
  'file',
  'wiki',
  'folder',
  'synced_block',
  'slides',
] as const
type MetaDocType = (typeof META_DOC_TYPES)[number]

/** Narrow an event's file_type to one the metadata API accepts, or `undefined`. */
function asMetaDocType(fileType: string): MetaDocType | undefined {
  return (META_DOC_TYPES as readonly string[]).includes(fileType)
    ? (fileType as MetaDocType)
    : undefined
}

/**
 * A single inbound-event route handler. Receives the raw event payload exactly
 * as the Feishu SDK delivered it; decoding it is the handler's job (`../parse`).
 *
 * Deferred-ACK invariant (claudemux#155 §七.3 / dreamux#25 §7.3): the Feishu SDK
 * sends the platform ACK frame only **after** this promise resolves. The
 * returned promise MUST therefore resolve only once the message is durable in
 * the host (dreamux: the SQLite `enqueueInbound` INSERT; claudemux: the inbox
 * tmp+rename). Returning before durability — or returning a non-promise — would
 * ACK an unpersisted message and lose it on a crash. The type is
 * `=> Promise<void>`, not `=> void | Promise<void>`, precisely to keep that
 * gate from being bypassed by a synchronous handler.
 */
export type RouteHandler = (raw: unknown) => Promise<void>

/**
 * Inbound event routes: Feishu event_type → handler. A host builds this from
 * its event registry; the transport registers every entry with the SDK's event
 * dispatcher.
 */
export type InboundRoutes = Record<string, RouteHandler>

/**
 * The platform boundary a host depends on. The real implementation
 * (`createFeishuTransport`) wraps the Feishu SDK; tests inject a fake so the
 * inbound and outbound wiring runs without a live Feishu connection.
 */
export interface FeishuTransport {
  /** The app id this transport was created with. */
  readonly appId: string
  /**
   * open_id of the bot itself, for group mention-gating. `undefined` until
   * `start` has resolved it (and stays `undefined` if resolution failed).
   */
  readonly selfId: string | undefined
  /**
   * Open the inbound WebSocket and dispatch every subscribed event_type through
   * `routes`. Core opens the connection directly — single-instance election, if
   * a deployment needs it, is layered on top by the host. **Rejects** if the
   * connection does not come up within the startup grace window, so a host can
   * fail a dispatcher loudly instead of registering a silently-dark bot.
   */
  start(routes: InboundRoutes): Promise<void>
  /**
   * Send a text message to the target chat. Without `replyToMessageId`, routing
   * is by `target.chatId`. With `replyToMessageId`, Feishu's reply endpoint
   * routes by the source message id; callers must only pass a message id that
   * was observed in `target.chatId`, never an arbitrary external message id.
   * `mentionUserIds` are rendered as leading card mentions. `conversationKey`
   * is a channel-layer routing hint the transport never reads.
   */
  send(target: OutboundTarget, text: string): Promise<FeishuSendResult>
  /**
   * Add an emoji reaction to a message and return the reaction_id Feishu
   * assigned. That id is what `removeReaction` needs to take the same reaction
   * back off; Feishu can omit it, in which case an empty string is returned.
   */
  addReaction(messageId: string, emoji: string): Promise<string>
  /**
   * Remove a reaction from a message, identified by the reaction_id that
   * `addReaction` returned. Feishu only lets the app that added a reaction
   * remove it, so this is always paired with a prior `addReaction` from the
   * same channel.
   */
  removeReaction(messageId: string, reactionId: string): Promise<void>
  /** Replace the text of a message the bot previously sent. */
  editText(messageId: string, text: string): Promise<void>
  /**
   * Fetch one document comment and its reply thread. The comment-add event
   * payload carries no comment text, so the doc-comment handler calls this to
   * fill it in. Best-effort: returns `null` for a file type with no comment
   * API or on any API failure, and never throws — a failure degrades the
   * notification rather than dropping the event.
   */
  fetchDocComment(
    fileToken: string,
    fileType: string,
    commentId: string,
  ): Promise<FeishuDocComment | null>
  /**
   * Fetch a document's title and URL, so a comment notification names the
   * document a human would recognize. Best-effort: returns `null` for a file
   * type with no metadata API or on any API failure, and never throws.
   */
  fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null>
  /** Close the connection and release every resource it holds. */
  close(): Promise<void>
}

/** Feishu self-built-app credentials. */
export interface FeishuCredentials {
  appId: string
  appSecret: string
}

/**
 * Optional knobs for `createFeishuTransport`. The `client` seam lets unit
 * tests inject a stub of just the SDK methods this module touches, so the
 * outbound paths (`send`, `editText`, the doc-comment fetchers) are covered
 * without a live Feishu app.
 */
export interface FeishuTransportOptions {
  /**
   * SDK client to use for outbound API calls. Default: a fresh `lark.Client`
   * built from `creds`. Tests pass a stub; production never sets this.
   */
  client?: lark.Client
  /**
   * Structured logger for this transport's own diagnostics — the Lark SDK's
   * logging, the WebSocket connection lifecycle, and the best-effort failures
   * of the doc-comment / metadata / bot-info / socket-close paths. Additive and
   * opt-in: with no logger the transport keeps its historical stderr behavior
   * byte-for-byte (the `[feishu-sdk]` / `[feishu-transport]` prefixes, the ISO
   * connection lines, and never a byte to stdout). A host injects this to fold
   * the transport's lines into its own per-component log; see
   * `./diagnostics.ts` for the seam and its safety boundary. Instance-level: the
   * transport derives its SDK and connection sinks from this one logger, so
   * several dispatchers in one process never cross-write each other's logs.
   */
  logger?: TransportLogger
}

/**
 * The real Feishu transport, wrapping the official SDK.
 *
 * Inbound: a `WSClient` opens a long-lived WebSocket and an `EventDispatcher`
 * routes every subscribed event_type to its callback. Outbound: a `Client`
 * calls the `im` message API; it manages the `tenant_access_token` internally.
 * The outbound paths are unit-tested through the `client` seam in
 * `FeishuTransportOptions`; inbound still needs a live Feishu connection.
 */
export function createFeishuTransport(
  creds: FeishuCredentials,
  options: FeishuTransportOptions = {},
): FeishuTransport {
  // One diagnostics seam per transport instance: with no injected logger it
  // reproduces the historical stderr behavior byte-for-byte; with one it routes
  // structured into the host's log. Built before the SDK client so all three
  // SDK objects below share this instance's single SDK logger.
  const diag = createTransportDiagnostics(options.logger)
  const client =
    options.client ??
    new lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      logger: diag.sdkLogger,
    })
  let wsClient: lark.WSClient | undefined
  let resolvedSelfId: string | undefined

  /**
   * Open the inbound WebSocket and dispatch events through `routes`. Core opens
   * the connection directly; a host that needs single-instance election wraps
   * this transport rather than threading a lock through here.
   */
  async function openInbound(routes: InboundRoutes): Promise<void> {
    resolvedSelfId = await resolveBotOpenId(client, diag)
    const dispatcher = new lark.EventDispatcher({ logger: diag.sdkLogger }).register(routes)

    // Resolves the first time the connection reaches `ready`; the startup
    // watchdog below races against it.
    let markReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })

    const ws = new lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      // Route the SDK's own logging through this instance's diagnostics seam —
      // stderr by default, the host's log when a logger is injected.
      logger: diag.sdkLogger,
      // Bound a stuck WebSocket handshake so it fails into a retry rather
      // than holding a stuck DNS / NAT path open indefinitely.
      handshakeTimeoutMs: WS_HANDSHAKE_TIMEOUT_MS,
      // autoReconnect stays on: an established connection that drops should
      // self-heal. The callbacks make every step of that loop visible, so a
      // failing connection is observable instead of a silent retry loop.
      autoReconnect: true,
      onReady: () => {
        diag.connection('Feishu WebSocket connection is ready')
        markReady()
      },
      onReconnecting: () => diag.connection(reconnectingLogLine()),
      onReconnected: () => diag.connection(reconnectedLogLine()),
      onError: (err) => diag.connection(connectionErrorLogLine(err), 'error'),
    })
    wsClient = ws

    void ws.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
      diag.connection(connectionErrorLogLine(err), 'error')
    })

    // The SDK retries pullConnectConfig with no delay until it first
    // succeeds — it has no server-provided reconnect interval yet — so a
    // Feishu that is unreachable at startup spins a tight retry loop.
    // Give the initial connection a grace window; if it is still not up,
    // stop it so the loop does not run unbounded and unobserved.
    const cameUp = await raceConnectionReady(ready)
    if (!cameUp) {
      const gaveUp = ws.getConnectionStatus().state === 'failed'
      diag.connection(startupTimeoutLogLine(WS_STARTUP_GRACE_MS, gaveUp), 'error')
      ws.close()
      // Fail loud rather than leave a dispatcher whose bot is silently dark:
      // the host (dreamux's server) cleans up and surfaces the failure. A host
      // that prefers to stand by on failure catches this in its own wrapper.
      throw new Error(
        `Feishu inbound WebSocket for app ${creds.appId} did not connect within ${WS_STARTUP_GRACE_MS}ms`,
      )
    }
  }

  return {
    get appId(): string {
      return creds.appId
    },

    get selfId(): string | undefined {
      return resolvedSelfId
    },

    async start(routes: InboundRoutes): Promise<void> {
      await openInbound(routes)
    },

    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      // Render the markdown source into one or more v2 cards. Routing per
      // block type — headings to `header.title`, tables to `tag: table`,
      // everything else to `tag: markdown` (lark_md) — keeps GFM tables and
      // ATX headings from leaking through as literal `|` and `#`. A body
      // too large for one card produces several cards, each sent as its own
      // message_id so the recipient sees a threaded continuation.
      //
      const cards = renderMarkdownToCards(textWithLeadingMentions(target, text))
      const messageIds: string[] = []
      for (const card of cards) {
        const content = cardToContent(card)
        // Fail fast on a card that could not be split under Feishu's hard cap,
        // preserving dreamux's prior per-card send guard (see assertCardContentFits).
        assertCardContentFits(content)
        const res = await sendInteractiveCard(client, target, content)
        const id = res.data?.message_id
        if (id) messageIds.push(id)
      }
      return { messageIds }
    },

    async addReaction(messageId: string, emoji: string): Promise<string> {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return res.data?.reaction_id ?? ''
    },

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      await client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    },

    async editText(messageId: string, text: string): Promise<void> {
      // An edit patches one message_id in place and cannot fan out, so
      // `renderSingleCard` rejects a body the renderer would otherwise split
      // across several cards. `assertCardContentFits` then catches the
      // residual case of a single-card body that still serialises past the
      // 30 KB request cap — both checks surface as actionable errors before
      // any SDK round-trip.
      const card = renderSingleCard(text)
      const cardContent = cardToContent(card)
      assertCardContentFits(cardContent)
      try {
        // The send path produces an interactive card, so the matching edit
        // is `im.message.patch` (card-content update). The original card was
        // sent with `update_multi: true`, which Feishu requires for a later
        // patch on the same message_id to be accepted.
        await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: cardContent },
        })
      } catch (patchErr) {
        // Legacy compatibility: a message_id a host is still holding may
        // belong to a `msg_type: 'text'` message that this channel sent
        // before the upgrade to interactive cards. Feishu rejects `patch`
        // on a non-card target, so fall back to `im.message.update` with
        // the legacy text payload. If the update also fails — auth, rate
        // limit, deleted message — surface the original patch error, which
        // describes the path the channel actually intends to use.
        try {
          await client.im.message.update({
            path: { message_id: messageId },
            data: { msg_type: 'text', content: textMessageContent(text) },
          })
        } catch {
          throw patchErr
        }
      }
    },

    async fetchDocComment(
      fileToken: string,
      fileType: string,
      commentId: string,
    ): Promise<FeishuDocComment | null> {
      // The file-comment API only serves a subset of document types; for any
      // other type there is no comment to fetch, so skip the call outright.
      const ct = asCommentFileType(fileType)
      if (!ct) return null
      try {
        // `batchQuery` resolves a comment by id and serves both
        // whole-document and local-selection comments. The single-comment
        // `get` endpoint serves only whole-document comments — it returns
        // "not exist" for a comment anchored to a text selection, which is
        // most document comments.
        const res = await client.drive.fileComment.batchQuery({
          path: { file_token: fileToken },
          // Resolve reply authors to open_id, so they match the open_id the
          // event carries and the sender_id of chat messages.
          params: { file_type: ct, user_id_type: 'open_id' },
          data: { comment_ids: [commentId] },
        })
        return commentFromBatchQuery(res.data?.items ?? [], commentId)
      } catch (err) {
        diag.diagnostic(`could not fetch comment ${commentId} on ${fileToken}:`, err)
        return null
      }
    },

    async fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null> {
      const dt = asMetaDocType(fileType)
      if (!dt) return null
      try {
        const res = await client.drive.meta.batchQuery({
          data: { request_docs: [{ doc_token: fileToken, doc_type: dt }], with_url: true },
        })
        const meta = res.data?.metas?.[0]
        if (!meta) return null
        return { title: meta.title ?? '', url: meta.url ?? '' }
      } catch (err) {
        diag.diagnostic(`could not fetch metadata for ${fileToken}:`, err)
        return null
      }
    },

    async close(): Promise<void> {
      try {
        wsClient?.close()
      } catch (err) {
        // A close on an already-closed socket is expected; anything else
        // (e.g. the SDK's close surface changed) is worth a diagnostic line.
        diag.diagnostic('error while closing the Feishu WebSocket:', err)
      }
      wsClient = undefined
    },
  }
}

type MessageSendResponse = { data?: { message_id?: string } }

type MessageApiWithReply = {
  reply(args: {
    path: { message_id: string }
    data: { msg_type: string; content: string }
  }): Promise<MessageSendResponse>
}

async function sendInteractiveCard(
  client: lark.Client,
  target: OutboundTarget,
  content: string,
): Promise<MessageSendResponse> {
  const data = { msg_type: 'interactive', content }
  if (target.replyToMessageId !== undefined) {
    const messageApi = client.im.message as unknown as MessageApiWithReply
    return messageApi.reply({
      path: { message_id: target.replyToMessageId },
      data,
    })
  }
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: target.chatId,
      ...data,
    },
  })
}

function textWithLeadingMentions(target: OutboundTarget, text: string): string {
  const mentions = target.mentionUserIds ?? []
  if (mentions.length === 0) return text
  return `${mentions.map((id) => `<@${id}>`).join(' ')}\n${text}`
}

/** How many times to try resolving the bot's open_id before giving up. */
const BOT_INFO_ATTEMPTS = 3

/**
 * Resolve the bot's own open_id, needed for group mention-gating. The SDK does
 * not expose a bot-info method, so this calls the raw endpoint through the
 * client (which still attaches the token).
 *
 * Best-effort: a failure leaves the open_id unknown rather than blocking
 * startup — but it is not silent. An unknown open_id makes `isBotMentioned`
 * never match, so every mention-gated group would drop every message; each
 * failure is logged with that consequence spelled out, and a transient error
 * is retried a few times before the transport gives up.
 */
async function resolveBotOpenId(
  client: lark.Client,
  diag: TransportDiagnostics,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{ bot?: { open_id?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })
      const openId = res.bot?.open_id
      if (openId) return openId
      // A well-formed response that simply lacks the field will not improve
      // on retry — stop here rather than spend the remaining attempts.
      diag.diagnostic(
        'bot info response carried no open_id — groups that ' +
          'require an @-mention will drop every message until the channel restarts',
      )
      return undefined
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500)
        continue
      }
      diag.diagnostic(
        `could not resolve the bot open_id after ${BOT_INFO_ATTEMPTS} ` +
          'attempts — groups that require an @-mention will drop every message ' +
          'until the channel restarts:',
        err,
      )
      return undefined
    }
  }
  return undefined
}

/** Resolve after `ms` milliseconds — the backoff between bot-info attempts. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve `true` if `ready` settles within the startup grace window, `false`
 * if the window elapses first. The timer is cleared on the winning path so it
 * does not keep the process alive after the race is decided.
 */
function raceConnectionReady(ready: Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), WS_STARTUP_GRACE_MS)
    void ready.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
