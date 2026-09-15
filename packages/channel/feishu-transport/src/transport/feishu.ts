import * as lark from '@larksuiteoapi/node-sdk'
import type { Readable } from 'node:stream'

import type { OutboundTarget } from '../contract/outbound.js'
import { sendFeishuMessage } from './outbound-message.js'
import {
  assertMessageContentFits,
  cardContents,
} from './message-content.js'
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
     * It fires before the next part is sent, preserving partial-send
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

function feishuChatClient(client: lark.Client): {
  chat?: {
    create?: (input: unknown) => Promise<{ data?: { chat_id?: string } }>
    get?: (input: unknown) => Promise<{ data?: { chat_mode?: string; name?: string } }>
    members?: { create?: (input: unknown) => Promise<unknown> }
  }
} {
  const root = client as unknown as {
    im?: {
      chat?: {
        create?: (input: unknown) => Promise<{ data?: { chat_id?: string } }>
        get?: (input: unknown) => Promise<{ data?: { chat_mode?: string; name?: string } }>
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

/**
 * What a metadata read actually established.
 *
 * A caller uses this read as a permission proof, and the three answers it used
 * to collapse into `null` are not one fact: a token Feishu reports in
 * `failed_list` proves this app cannot see the document, a type the metadata
 * API does not take proves only that, and a request that failed proves nothing
 * at all — so it is not an answer here, it is a rejected promise.
 */
export type FeishuDocMetaResult =
  | { readonly kind: 'visible' }
  | { readonly kind: 'invisible' }
  | { readonly kind: 'unsupported_type' }

/** The document a wiki node points at. */
export interface FeishuWikiNode {
    objToken: string
    objType: string
}

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
 * The one comment a `drive.notice.comment_add_v1` event names.
 *
 * The event payload carries identifying ids only, so a caller that wants to
 * show a person what was written has to read the thread. Only the named item
 * is returned: a whole thread is what lark-cli is for.
 */
export interface FeishuDocCommentText {
    /**
     * The document text the comment is anchored to, empty for a comment on the
     * whole document. It is what says which part of the document is discussed.
     */
    quote: string
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
    /** Optional best-effort lookup of a chat's current Feishu name. */
    resolveChatName?(chatId: string): Promise<string | undefined>
    addReaction(messageId: string, emoji: string): Promise<string>
    /** Repaint an already-sent card in place, by message id. */
    editCard(messageId: string, card: unknown): Promise<void>
    fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMetaResult>
    /**
     * The text of the one comment a request names, or `null` when the thread
     * Feishu returns does not hold it. Every `null` means the same thing to a
     * caller — there is no text to show — so it is one value and not a
     * discriminated result.
     */
    fetchDocCommentText(request: FeishuDocCommentRequest): Promise<FeishuDocCommentText | null>
    /**
     * The document a wiki node holds, or `null` when this app cannot see that
     * node. A wiki URL names the node, while every comment API — and the
     * comment event itself — names the object inside it.
     */
    resolveWikiNode(token: string): Promise<FeishuWikiNode | null>
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
      const messageIds: string[] = []
      for (const content of cardContents(text)) {
        const res = await sendFeishuMessage(client, target, content)
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
      assertMessageContentFits(content)
      const res = await sendFeishuMessage(client, target, content, options?.signal)
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

    async resolveChatName(chatId: string): Promise<string | undefined> {
      const chatClient = feishuChatClient(client)
      if (chatClient.chat?.get === undefined) return undefined
      const res = await chatClient.chat.get({ path: { chat_id: chatId } })
      const name = res.data?.name
      return typeof name === 'string' && name !== '' ? name : undefined
    },

    async addReaction(messageId: string, emoji: string): Promise<string> {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return res.data?.reaction_id ?? ''
    },

    async editCard(messageId: string, card: unknown): Promise<void> {
      const cardContent = JSON.stringify(card)
      assertMessageContentFits(cardContent)
      await client.im.message.patch({
        path: { message_id: messageId },
        data: { content: cardContent },
      })
    },

    async fetchDocMeta(
      fileToken: string,
      fileType: string,
    ): Promise<FeishuDocMetaResult> {
      const dt = asMetaDocType(fileType)
      if (!dt) return { kind: 'unsupported_type' }
      const res = await client.drive.meta.batchQuery({
        data: { request_docs: [{ doc_token: fileToken, doc_type: dt }] },
      })
      if (res.data?.metas?.some((row) => row.doc_token === fileToken)) {
        return { kind: 'visible' }
      }
      if (res.data?.failed_list?.some((row) => row.token === fileToken)) {
        return { kind: 'invisible' }
      }
      // Neither list claims the token, so nothing here was established. Saying
      // "invisible" would send an operator to fix permissions that are fine.
      throw new Error(
        `Feishu returned no metadata verdict for ${fileToken} ` +
          `(code ${res.code ?? 'none'}: ${res.msg ?? ''})`,
      )
    },

    async fetchDocCommentText(
      request: FeishuDocCommentRequest,
    ): Promise<FeishuDocCommentText | null> {
      const ct = asCommentFileType(request.fileType)
      if (!ct) return null
      const res = await client.drive.fileComment.batchQuery({
        path: { file_token: request.fileToken },
        params: { file_type: ct, user_id_type: 'open_id' },
        data: { comment_ids: [request.commentId] },
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
      // An empty reply id names the thread's own comment, which the API
      // carries as the first entry of the same `reply_list` its replies are in.
      const replies = item.reply_list?.replies ?? []
      const reply = request.replyId === ''
        ? replies[0]
        : replies.find((row) => row.reply_id === request.replyId)
      if (!reply) return null
      return {
        quote: item.quote ?? '',
        segments: reply.content.elements.map(commentElementSegment),
      }
    },

    async resolveWikiNode(token: string): Promise<FeishuWikiNode | null> {
      const res = await client.wiki.v2.space.getNode({ params: { token } })
      // A non-zero business code arrives on a successful HTTP response, so it
      // has to be read here: rate limiting or a revoked scope is not this app
      // failing to see the node, and must not be reported as one.
      if (res.code !== undefined && res.code !== 0) {
        throw new Error(
          `Feishu wiki node lookup for ${token} failed ` +
            `(code ${res.code}: ${res.msg ?? ''})`,
        )
      }
      const node = res.data?.node
      if (node?.obj_token === undefined || node.obj_token === '') return null
      return { objToken: node.obj_token, objType: node.obj_type }
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

function raceConnectionReady(ready: Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), WS_STARTUP_GRACE_MS)
    void ready.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
