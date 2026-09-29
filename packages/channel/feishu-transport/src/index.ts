/**
 * `@excitedjs/feishu-transport` — the Feishu platform-I/O core.
 *
 * The single owner of the `@larksuiteoapi/node-sdk` import: connect / receive /
 * send / auth / parse (Feishu content → one text body). Stateless and
 * routing-agnostic — it knows nothing about engine threads, sessions, or
 * drop/deliver decisions; those live in the channel layer.
 *
 * See dreamux#25 for the responsibility model and contract.
 */

// ── parse/ — Feishu content → one text body, the event-envelope decodes, and
//    the document-reference decode ──
export {
  parseInbound,
  type InboundMessage,
  type ParsedInbound,
  type InboundResource,
  type InboundResourceType,
} from './parse/content.js';
export {
  normalizeBotMemberAddedEvent,
  BOT_MEMBER_ADDED_EVENT_TYPE,
  type FeishuBotMemberAddedEvent,
} from './parse/bot-member.js';
export {
  normalizeCommentEvent,
  DOC_COMMENT_EVENT_TYPE,
  type FeishuCommentEvent,
} from './parse/comment.js';
export {
  parseFeishuDocumentRef,
  type FeishuDocumentRef,
} from './parse/document-ref.js';
export {
  isBotMentioned,
  isBotSenderType,
  type Mention,
} from './parse/mentions.js';
export {
  parseFeishuInboundEvent,
  type FeishuInboundEvent,
} from './parse/message-event.js';
export {
  normalizeCardActionEvent,
  normalizeCardActionAck,
  type FeishuCardActionEvent,
} from './parse/card-action.js';

// ── transport/ — the Feishu SDK boundary (the only lark importer) ──
export type { OutboundTarget } from './transport/outbound-message.js';
export {
  createFeishuTransport,
  FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER,
  type FeishuTransport,
  type FeishuCredentials,
  type FeishuTransportOptions,
  type FeishuAppOwnerIdentity,
  type FeishuSendOptions,
  type FeishuSendResult,
  type FeishuSentMessage,
  type FeishuChatMode,
  type FeishuCommentAnchor,
  type FeishuCommentSegment,
  type FeishuDocCommentRequest,
  type FeishuDocCommentText,
  type FeishuDocMetaResult,
  type FeishuWikiNode,
  type FeishuMessageResourceFetcher,
  type FeishuMessageResourceRequest,
  type FeishuMessageResourceResponse,
  type FeishuMessageResourceType,
  type FeishuMessageReadItem,
  type FeishuMessageReadRequest,
  type FeishuMessageReadResponse,
  type InboundRoutes,
  type RouteHandler,
} from './transport/feishu.js';
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
} from './transport/cot.js';
export type { TransportLogger } from './transport/diagnostics.js';

// ── small shared util ──
export { isRecord, asString } from './json.js';
