/**
 * `@excitedjs/feishu-transport` — the Feishu platform-I/O core.
 *
 * The single owner of the `@larksuiteoapi/node-sdk` import: connect / receive /
 * send / auth / parse (Feishu content → ordered parts). Stateless and
 * routing-agnostic — it knows nothing about engine threads, sessions, or
 * drop/deliver decisions; those live in the channel layer.
 *
 * See dreamux#25 for the responsibility model and contract.
 */

// ── contract/ — the pure types (the future `@excitedjs/channel-contract`
//    extraction point when a second platform lands) ──
export type { Mention } from './contract/types.js'
export type { OutboundTarget } from './contract/outbound.js'

// ── parse/ — Feishu content → ordered parts + comment-event decode ──
export {
  parseInbound,
  mergeInteractiveInbound,
  narrowMetaFromEvent,
  type InboundMessage,
  type ParsedInbound,
  type InboundResource,
  type InboundResourceType,
  type InboundContentPart,
} from './parse/content.js'
export {
  normalizeBotMemberAddedEvent,
  BOT_MEMBER_ADDED_EVENT_TYPE,
  type FeishuBotMemberAddedEvent,
} from './parse/bot-member.js'
export {
  normalizeCommentEvent,
  DOC_COMMENT_EVENT_TYPE,
  type FeishuCommentEvent,
} from './parse/comment.js'
export {
  isBotMentioned,
  isBotSenderType,
} from './parse/mentions.js'

// ── transport/ — the Feishu SDK boundary (the only lark importer) ──
export {
  createFeishuTransport,
  commentFromBatchQuery,
  FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER,
  type FeishuTransport,
  type FeishuCredentials,
  type FeishuTransportOptions,
  type FeishuWebSocketRegistration,
  type FeishuAppOwnerIdentity,
  type FeishuSendOptions,
  type FeishuSendResult,
  type FeishuCreateGroupInput,
  type FeishuCreateGroupResult,
  type FeishuInviteMembersInput,
  type FeishuInviteMembersResult,
  type FeishuChatMode,
  type FeishuDocComment,
  type FeishuDocCommentReply,
  type FeishuDocMeta,
  type FeishuMessageResourceFetcher,
  type FeishuMessageResourceRequest,
  type FeishuMessageResourceResponse,
  type FeishuMessageResourceType,
  type FeishuMessageReader,
  type FeishuMessageReadItem,
  type FeishuMessageReadMode,
  type FeishuMessageReadRequest,
  type FeishuMessageReadResponse,
  type InboundRoutes,
  type RouteHandler,
} from './transport/feishu.js'
export {
  FEISHU_COT_APPEND_MAX_EVENTS,
  FeishuCotApiError,
  createFeishuCotClient,
  type FeishuCotAppendInput,
  type FeishuCotClient,
  type FeishuCotClientOptions,
  type FeishuCotCompleteInput,
  type FeishuCotCompleteReason,
  type FeishuCotCreateInput,
  type FeishuCotCreateResult,
  type FeishuCotEventInput,
} from './transport/cot.js'
export type { TransportLogger } from './transport/diagnostics.js'

// ── small shared util ──
export { isRecord, asString } from './json.js'

/**
 * Package marker — a stable export the channel layer can import to assert the
 * core resolves end to end. Kept from the PR0 scaffold so the `feishu-channel`
 * smoke test stays green.
 */
export const FEISHU_TRANSPORT_PACKAGE = '@excitedjs/feishu-transport'
