import * as lark from '@larksuiteoapi/node-sdk'
import type { Readable } from 'node:stream'

import type { OutboundTarget } from '../contract/outbound.js'
import { sendInteractiveCard } from './outbound-card.js'
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
  type TransportLogger,
} from './diagnostics.js'
import {
  normalizeMessageReadItem,
  type FeishuMessageReader,
  type FeishuMessageReadRequest,
  type FeishuMessageReadResponse,
} from './message-read.js'
import {
  createFeishuCotClient,
  type FeishuCotClient,
} from './cot.js'
import {
  createSelfIdentityCache,
  resolveAppOwner,
  type FeishuAppOwnerIdentity,
} from './identity.js'
export {
  FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER,
  type FeishuAppOwnerIdentity,
} from './identity.js'
export type {
  FeishuMessageReadItem,
  FeishuMessageReadMode,
  FeishuMessageReadRequest,
  FeishuMessageReadResponse,
  FeishuMessageReader,
} from './message-read.js'

const WS_HANDSHAKE_TIMEOUT_MS = 15_000
const WS_STARTUP_GRACE_MS = 30_000

/**
 * The Feishu event type carrying inbound chat messages. It is the only route
 * that retries self-identity resolution, because it is the only one whose
 * handling depends on knowing this app's own open_id.
 */
const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1'

export interface FeishuSendResult {
    messageIds: string[]
}

export interface FeishuSendOptions {
    signal?: AbortSignal
    /**
     * Synchronous receipt for each message the platform confirms creating.
     * It fires before the next rendered card is sent, preserving partial-send
     * ordering for callers that need platform-visible facts as they happen.
     * Observer failures are non-authoritative and never affect message sends.
     * Text `send` consumes this field; `sendCard` accepts only `signal`.
     */
    readonly onMessageCreated?: (receipt: {
      readonly messageId: string
      readonly ordinal: number
    }) => void
}

function notifyMessageCreated(
  options: Pick<FeishuSendOptions, 'onMessageCreated'> | undefined,
  messageId: string,
  ordinal: number,
): void {
  try {
    options?.onMessageCreated?.({ messageId, ordinal })
  } catch {
    // Display observers are non-authoritative after platform success.
  }
}

export interface FeishuCreateGroupInput {
  name: string
  userOpenIds: string[]
}
export interface FeishuCreateGroupResult {
  chatId: string
}
export interface FeishuInviteMembersInput {
  chatId: string
  userOpenIds: string[]
}
export interface FeishuInviteMembersResult {
  addedOpenIds: string[]
}

export type FeishuChatMode = 'p2p' | 'group' | 'topic'

export function textMessageContent(text: string): string {
  return JSON.stringify({ text })
}

export const FEISHU_CARD_CONTENT_SAFE_BYTES = 28 * 1024

function assertCardContentFits(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > FEISHU_CARD_CONTENT_SAFE_BYTES) {
    throw new Error(
      `card content is ${bytes} bytes; Feishu rejects a card-message body over ${FEISHU_CARD_REQUEST_LIMIT_BYTES} bytes. ` +
        'Shorten the message, or break up an oversized table or code block the renderer could not split smaller.',
    )
  }
}

function renderSingleCard(text: string): RenderedCard {
  const cards = renderMarkdownToCards(text)
  if (cards.length !== 1) {
    throw new Error(
      `edit body produced ${cards.length} cards, but an edit can only update one ` +
        'card in place. Reduce the body length, drop oversized tables, or send a ' +
        'fresh reply (which the channel splits automatically) instead of editing.',
    )
  }
  return cards[0] as RenderedCard
}

function feishuChatClient(client: lark.Client): {
  chat?: {
    create?: (input: unknown) => Promise<{ data?: { chat_id?: string } }>
    get?: (input: unknown) => Promise<{ data?: { chat_mode?: string } }>
    members?: { create?: (input: unknown) => Promise<unknown> }
  }
} {
  const root = client as unknown as {
    im?: {
      chat?: {
        create?: (input: unknown) => Promise<{ data?: { chat_id?: string } }>
        get?: (input: unknown) => Promise<{ data?: { chat_mode?: string } }>
        members?: { create?: (input: unknown) => Promise<unknown> }
      }
    }
  }
  return { chat: root.im?.chat }
}

type FeishuContactUserRequest = { path: { user_id: string }; params: { user_id_type: 'open_id' } }
type FeishuContactUserResponse = { code?: number; data?: { user?: { name?: string } } }
type FeishuContactUserApi = { get(input: FeishuContactUserRequest): Promise<FeishuContactUserResponse> }

function contactUserApi(client: lark.Client): FeishuContactUserApi | undefined {
  return (client as unknown as {
    contact?: { v3?: { user?: FeishuContactUserApi } }
  }).contact?.v3?.user
}

async function fetchUserName(client: lark.Client, openId: string):
  Promise<string | undefined> {
  const user = contactUserApi(client)
  if (openId === '' || user === undefined) return undefined
  const response = await user.get({
    path: { user_id: openId },
    params: { user_id_type: 'open_id' },
  })
  if (response.code !== undefined && response.code !== 0) return undefined
  const name = response.data?.user?.name
  return typeof name === 'string' && name !== '' ? name : undefined
}

export interface FeishuDocCommentReply {
    replyId: string
    authorId: string
    elements: unknown[]
}

export interface FeishuDocComment {
    isWhole: boolean
    quote: string
    replies: FeishuDocCommentReply[]
}

export interface FeishuDocMeta {
    title: string
    url: string
}

export type FeishuMessageResourceType = 'file' | 'image'

export interface FeishuMessageResourceRequest {
  messageId: string
  fileKey: string
  type: FeishuMessageResourceType
}

export interface FeishuMessageResourceResponse {
  stream: Readable
  headers: Record<string, unknown>
}

export interface FeishuMessageResourceFetcher {
  fetchMessageResource(
    request: FeishuMessageResourceRequest,
  ): Promise<FeishuMessageResourceResponse>
}

const COMMENT_FILE_TYPES = ['doc', 'docx', 'sheet', 'file'] as const
type CommentFileType = (typeof COMMENT_FILE_TYPES)[number]

function asCommentFileType(fileType: string): CommentFileType | undefined {
  return (COMMENT_FILE_TYPES as readonly string[]).includes(fileType)
    ? (fileType as CommentFileType)
    : undefined
}

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

function asMetaDocType(fileType: string): MetaDocType | undefined {
  return (META_DOC_TYPES as readonly string[]).includes(fileType)
    ? (fileType as MetaDocType)
    : undefined
}

export type RouteHandler = (raw: unknown) => Promise<unknown>

export type InboundRoutes = Record<string, RouteHandler>

export interface FeishuTransport {
    readonly appId: string
    readonly selfId: string | undefined
    readonly selfName: string | undefined
    start(routes: InboundRoutes): Promise<void>
    send(
      target: OutboundTarget,
      text: string,
      options?: Pick<FeishuSendOptions, 'onMessageCreated'>,
    ): Promise<FeishuSendResult>
    sendCard(
      target: OutboundTarget,
      card: unknown,
      options?: Pick<FeishuSendOptions, 'signal'>,
    ): Promise<FeishuSendResult>
    createGroup(input: FeishuCreateGroupInput): Promise<FeishuCreateGroupResult>
    inviteMembers(input: FeishuInviteMembersInput): Promise<FeishuInviteMembersResult>
    /** Optional capability for custom transports; callers must fail safe when absent. */
    getChatMode?(chatId: string): Promise<FeishuChatMode | undefined>
    addReaction(messageId: string, emoji: string): Promise<string>
    editText(messageId: string, text: string): Promise<void>
    fetchDocComment(fileToken: string, fileType: string, commentId: string): Promise<FeishuDocComment | null>
    fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null>
    fetchMessageResource(request: FeishuMessageResourceRequest): Promise<FeishuMessageResourceResponse>
    readMessage?(request: FeishuMessageReadRequest): Promise<FeishuMessageReadResponse>
    /** Optional best-effort contact lookup for an accepted human sender. */
    resolveUserName?(openId: string): Promise<string | undefined>
    /**
     * Optional COT (chain-of-thought) message operations. Absent on a custom or
     * older transport; callers must treat absence as "no COT surface" and keep
     * working without one.
     */
    readonly cot?: FeishuCotClient
    resolveAppOwner(): Promise<FeishuAppOwnerIdentity>
    close(): Promise<void>
}

export interface FeishuCredentials {
  appId: string
  appSecret: string
}

export interface FeishuTransportOptions {
    client?: lark.Client
    logger?: TransportLogger
    /** Narrow test/embedding edge replacing only WebSocket route registration. */
    webSocketRegistration?: FeishuWebSocketRegistration
}

export interface FeishuWebSocketRegistration {
  open(routes: InboundRoutes): Promise<{ openId?: string; appName?: string } | void>
  close(): void | Promise<void>
}

export function createFeishuTransport(
  creds: FeishuCredentials,
  options: FeishuTransportOptions = {},
): FeishuTransport & FeishuMessageReader {
  const diag = createTransportDiagnostics(options.logger)
  const client =
    options.client ??
    new lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      logger: diag.sdkLogger,
    })
  let wsClient: lark.WSClient | undefined
  const selfIdentity = createSelfIdentityCache(client, diag)

  /**
   * Retry self-identity resolution ahead of an inbound chat message while it is
   * still unresolved, so a successful retry applies to that same message before
   * a caller's mention gate reads `selfId`. A failed retry still delivers the
   * message — the caller stays fail-closed for it — and leaves identity
   * unresolved so the next message tries again.
   */
  function withSelfIdentityRecovery(routes: InboundRoutes): InboundRoutes {
    const onMessage: RouteHandler | undefined = routes[IM_MESSAGE_EVENT_TYPE]
    if (onMessage === undefined) return routes
    return {
      ...routes,
      [IM_MESSAGE_EVENT_TYPE]: async (raw: unknown): Promise<unknown> => {
        await selfIdentity.ensureResolved()
        return onMessage(raw)
      },
    }
  }

  async function openInbound(routes: InboundRoutes): Promise<void> {
    const inbound = withSelfIdentityRecovery(routes)
    if (options.webSocketRegistration !== undefined) {
      selfIdentity.accept(
        (await options.webSocketRegistration.open(inbound)) || undefined,
      )
      return
    }
    await selfIdentity.ensureResolved()
    const dispatcher = new lark.EventDispatcher({ logger: diag.sdkLogger }).register(inbound)
    let markReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })

    const ws = new lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      logger: diag.sdkLogger,
      handshakeTimeoutMs: WS_HANDSHAKE_TIMEOUT_MS,
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
    const cameUp = await raceConnectionReady(ready)
    if (!cameUp) {
      const gaveUp = ws.getConnectionStatus().state === 'failed'
      diag.connection(startupTimeoutLogLine(WS_STARTUP_GRACE_MS, gaveUp), 'error')
      ws.close()
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
      return selfIdentity.resolved?.openId
    },

    get selfName(): string | undefined {
      return selfIdentity.resolved?.appName
    },

    async start(routes: InboundRoutes): Promise<void> {
      await openInbound(routes)
    },

    async send(
      target: OutboundTarget,
      text: string,
      options?: Pick<FeishuSendOptions, 'onMessageCreated'>,
    ): Promise<FeishuSendResult> {
      const cards = renderMarkdownToCards(textWithLeadingMentions(target, text))
      const messageIds: string[] = []
      for (const card of cards) {
        const content = cardToContent(card)
        assertCardContentFits(content)
        const res = await sendInteractiveCard(client, target, content)
        const id = res.data?.message_id
        if (id) {
          const ordinal = messageIds.length
          messageIds.push(id)
          notifyMessageCreated(options, id, ordinal)
        }
      }
      return { messageIds }
    },

    async sendCard(
      target: OutboundTarget,
      card: unknown,
      options?: Pick<FeishuSendOptions, 'signal'>,
    ): Promise<FeishuSendResult> {
      const content = JSON.stringify(card)
      assertCardContentFits(content)
      const res = await sendInteractiveCard(
        client,
        target,
        content,
        options?.signal,
      )
      const id = res.data?.message_id
      return { messageIds: id ? [id] : [] }
    },

    async createGroup(input: FeishuCreateGroupInput): Promise<FeishuCreateGroupResult> {
      const chatClient = feishuChatClient(client)
      if (chatClient.chat?.create === undefined) {
        throw new Error('Feishu chat create API is not available in this SDK/client; grant chat create permission or upgrade the Feishu transport client.')
      }
      const res = await chatClient.chat.create({
        params: { user_id_type: 'open_id' },
        data: {
          name: input.name,
          user_id_list: input.userOpenIds,
        },
      })
      const chatId = res.data?.chat_id
      if (typeof chatId !== 'string' || chatId === '') {
        throw new Error('Feishu chat create API returned no chat_id')
      }
      return { chatId }
    },

    async inviteMembers(input: FeishuInviteMembersInput): Promise<FeishuInviteMembersResult> {
      if (input.userOpenIds.length === 0) return { addedOpenIds: [] }
      const chatClient = feishuChatClient(client)
      if (chatClient.chat?.members?.create === undefined) {
        throw new Error('Feishu chat member invite API is not available in this SDK/client; grant chat member permission or upgrade the Feishu transport client.')
      }
      await chatClient.chat.members.create({
        path: { chat_id: input.chatId },
        data: { id_list: input.userOpenIds },
        params: { member_id_type: 'open_id' },
      })
      return { addedOpenIds: input.userOpenIds }
    },

    async getChatMode(chatId: string): Promise<FeishuChatMode | undefined> {
      const chatClient = feishuChatClient(client)
      if (chatClient.chat?.get === undefined) {
        throw new Error(
          'Feishu chat get API is not available in this SDK/client; upgrade the Feishu transport client.',
        )
      }
      const res = await chatClient.chat.get({ path: { chat_id: chatId } })
      const mode = res.data?.chat_mode
      return mode === 'p2p' || mode === 'group' || mode === 'topic'
        ? mode
        : undefined
    },

    async addReaction(messageId: string, emoji: string): Promise<string> {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return res.data?.reaction_id ?? ''
    },

    async editText(messageId: string, text: string): Promise<void> {
      const card = renderSingleCard(text)
      const cardContent = cardToContent(card)
      assertCardContentFits(cardContent)
      try {
        await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: cardContent },
        })
      } catch (patchErr) {
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
      const ct = asCommentFileType(fileType)
      if (!ct) return null
      try {
        const res = await client.drive.fileComment.batchQuery({
          path: { file_token: fileToken },
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

    async fetchMessageResource(
      request: FeishuMessageResourceRequest,
    ): Promise<FeishuMessageResourceResponse> {
      const res = await client.im.v1.messageResource.get({
        path: {
          message_id: request.messageId,
          file_key: request.fileKey,
        },
        params: { type: request.type },
      })
      return {
        stream: res.getReadableStream(),
        headers: res.headers as Record<string, unknown>,
      }
    },

    async readMessage(
      request: FeishuMessageReadRequest,
    ): Promise<FeishuMessageReadResponse> {
      const res = await client.im.v1.message.get({
        path: { message_id: request.messageId },
        params: {
          user_id_type: 'open_id',
          ...(request.cardContent === 'user_card_content'
            ? { card_msg_content_type: 'user_card_content' }
            : {}),
        },
      })
      return {
        items: (res.data?.items ?? []).map(normalizeMessageReadItem),
      }
    },

    resolveUserName(openId: string): Promise<string | undefined> {
      return fetchUserName(client, openId)
    },

    cot: createFeishuCotClient(client),

    async resolveAppOwner(): Promise<FeishuAppOwnerIdentity> {
      return resolveAppOwner(client, diag, creds.appId)
    },

    async close(): Promise<void> {
      try {
        if (options.webSocketRegistration !== undefined) {
          await options.webSocketRegistration.close()
        } else {
          wsClient?.close()
        }
      } catch (err) {
        diag.diagnostic('error while closing the Feishu WebSocket:', err)
      }
      wsClient = undefined
    },
  }
}

function textWithLeadingMentions(target: OutboundTarget, text: string): string {
  const mentions = target.mentionUserIds ?? []
  if (mentions.length === 0) return text
  return `${mentions.map((id) => `<@${id}>`).join(' ')}\n${text}`
}

function raceConnectionReady(ready: Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), WS_STARTUP_GRACE_MS)
    void ready.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
