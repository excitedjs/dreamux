
import * as lark from '@larksuiteoapi/node-sdk'
import type { Readable } from 'node:stream'

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
import {
  normalizeMessageReadItem,
  type FeishuMessageReader,
  type FeishuMessageReadRequest,
  type FeishuMessageReadResponse,
} from './message-read.js'
export type {
  FeishuMessageReadItem,
  FeishuMessageReadMode,
  FeishuMessageReadRequest,
  FeishuMessageReadResponse,
  FeishuMessageReadSender,
  FeishuMessageReader,
} from './message-read.js'

const WS_HANDSHAKE_TIMEOUT_MS = 15_000

const WS_STARTUP_GRACE_MS = 30_000

// application/v6 owner.type: enterprise-member owner for a custom app.
export const FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER = 2

export interface FeishuSendResult {
    messageIds: string[]
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

/**
 * Raw identity of the app creator / owner, returned by
 * `GET /open-apis/application/v6/applications/{appId}` with
 * `user_id_type=open_id`.
 */
export interface FeishuAppOwnerIdentity {
  creatorOpenId?: string
  ownerOpenId?: string
  ownerType?: number
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
    send(target: OutboundTarget, text: string): Promise<FeishuSendResult>
    sendCard(target: OutboundTarget, card: unknown): Promise<FeishuSendResult>
    createGroup(input: FeishuCreateGroupInput): Promise<FeishuCreateGroupResult>
    inviteMembers(input: FeishuInviteMembersInput): Promise<FeishuInviteMembersResult>
    /** Optional capability for custom transports; callers must fail safe when absent. */
    getChatMode?(chatId: string): Promise<FeishuChatMode | undefined>
    addReaction(messageId: string, emoji: string): Promise<string>
    removeReaction(messageId: string, reactionId: string): Promise<void>
    editText(messageId: string, text: string): Promise<void>
    fetchDocComment(
    fileToken: string,
    fileType: string,
    commentId: string,
  ): Promise<FeishuDocComment | null>
    fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null>
    fetchMessageResource(
    request: FeishuMessageResourceRequest,
  ): Promise<FeishuMessageResourceResponse>
    readMessage?(request: FeishuMessageReadRequest): Promise<FeishuMessageReadResponse>
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
  let resolvedSelfInfo: FeishuBotInfo | undefined

    async function openInbound(routes: InboundRoutes): Promise<void> {
    resolvedSelfInfo = await resolveBotInfo(client, diag)
    const dispatcher = new lark.EventDispatcher({ logger: diag.sdkLogger }).register(routes)
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
      return resolvedSelfInfo?.openId
    },

    get selfName(): string | undefined {
      return resolvedSelfInfo?.appName
    },

    async start(routes: InboundRoutes): Promise<void> {
      await openInbound(routes)
    },

    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      const cards = renderMarkdownToCards(textWithLeadingMentions(target, text))
      const messageIds: string[] = []
      for (const card of cards) {
        const content = cardToContent(card)
        assertCardContentFits(content)
        const res = await sendInteractiveCard(client, target, content)
        const id = res.data?.message_id
        if (id) messageIds.push(id)
      }
      return { messageIds }
    },

    async sendCard(target: OutboundTarget, card: unknown): Promise<FeishuSendResult> {
      const content = JSON.stringify(card)
      assertCardContentFits(content)
      const res = await sendInteractiveCard(client, target, content)
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

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      await client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
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

    async resolveAppOwner(): Promise<FeishuAppOwnerIdentity> {
      return resolveAppOwner(client, diag, creds.appId)
    },

    async close(): Promise<void> {
      try {
        wsClient?.close()
      } catch (err) {
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

const BOT_INFO_ATTEMPTS = 3

interface FeishuBotInfo {
  openId?: string
  appName?: string
}

async function resolveBotInfo(
  client: lark.Client,
  diag: TransportDiagnostics,
): Promise<FeishuBotInfo | undefined> {
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{ bot?: { open_id?: string, app_name?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })
      const openId = res.bot?.open_id
      const appName = res.bot?.app_name
      if (openId) {
        return {
          openId,
          ...(appName !== undefined && appName !== '' ? { appName } : {}),
        }
      }
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

async function resolveAppOwner(
  client: lark.Client,
  diag: TransportDiagnostics,
  appId: string,
): Promise<FeishuAppOwnerIdentity> {
  const identity: FeishuAppOwnerIdentity = {}
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{
        data?: {
          app?: {
            creator_id?: string
            owner?: { owner_id?: string; type?: number; owner_type?: number }
          }
        }
      }>({
        method: 'GET',
        url: `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`,
        params: { lang: 'zh_cn', user_id_type: 'open_id' },
      })
      const app = res.data?.app
      if (typeof app?.creator_id === 'string' && app.creator_id !== '') {
        identity.creatorOpenId = app.creator_id
      }
      const ownerId = app?.owner?.owner_id
      const ownerType = app?.owner?.type ?? app?.owner?.owner_type
      if (typeof ownerType === 'number') identity.ownerType = ownerType
      if (
        typeof ownerId === 'string' &&
        ownerId !== '' &&
        (ownerType === undefined || ownerType === FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER)
      ) {
        identity.ownerOpenId = ownerId
      }
      return identity
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500)
        continue
      }
      diag.diagnostic(
        'could not resolve the Feishu app owner via application/v6. ' +
          'Ensure the app has scope `application:application:self_manage` ' +
          'or `admin:app.info:readonly`:',
        err,
      )
      return identity
    }
  }
  return identity
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
