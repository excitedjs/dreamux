/**
 * `@excitedjs/feishu-transport` — the shared Feishu platform-I/O core.
 *
 * The single owner of the `@larksuiteoapi/node-sdk` import: connect / receive /
 * send / auth / render (md→card) / parse (Feishu content→text) + the pure,
 * stateless access policy (`gate` / pairing). Stateless and routing-agnostic —
 * it knows nothing about engine threads, sessions, or drop/deliver decisions;
 * those live in each host's channel layer. Imported in-process by both dreamux
 * (`@excitedjs/feishu-channel`) and claudemux's proxy.
 *
 * See dreamux#25 / claudemux#155 for the responsibility model and contract.
 */

// ── contract/ — the pure types (the future `@excitedjs/channel-contract`
//    extraction point when a second platform lands) ──
export type {
  Access,
  DmPolicy,
  GroupPolicy,
  GroupEntry,
  PendingEntry,
  Mention,
} from './contract/types.js'
export type { OutboundTarget } from './contract/outbound.js'
export type { AccessStore } from './contract/access-store.js'

// ── parse/ — Feishu content → forwardable text + comment-event decode ──
export {
  parseInbound,
  narrowMetaFromEvent,
  toChannelInbound,
  applyMentions,
  mentionName,
  extractPostText,
  type InboundMessage,
  type ParsedInbound,
  type ChannelInbound,
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

// ── policy/ — pure access gate + pairing ──
export {
  gate,
  isBotMentioned,
  pruneExpiredPending,
  isBotSenderType,
  isGroupAuthorized,
  MAX_PENDING,
  MAX_PAIRING_REPLIES,
  PAIRING_TTL_MS,
  type GateInput,
  type GateResult,
} from './policy/gate.js'
export {
  generatePairingCode,
  PAIRING_CODE_BYTES,
  PAIRING_CODE_LENGTH,
} from './policy/pairing.js'

// ── render/ — markdown → Feishu v2 card (incl. inline `<@open_id>` mentions) ──
export {
  renderMarkdownToCards,
  cardToContent,
  cardContentBytes,
  splitMarkdownByBytes,
  FEISHU_CARD_REQUEST_LIMIT_BYTES,
  FEISHU_CARD_ELEMENT_HARD_CAP,
  CELL_MAX_BYTES,
  type RenderedCard,
} from './render/render.js'

// ── transport/ — the Feishu SDK boundary (the only lark importer) ──
export {
  createFeishuTransport,
  commentFromBatchQuery,
  textMessageContent,
  FEISHU_CARD_CONTENT_SAFE_BYTES,
  type FeishuTransport,
  type FeishuCredentials,
  type FeishuTransportOptions,
  type FeishuSendResult,
  type FeishuDocComment,
  type FeishuDocCommentReply,
  type FeishuDocMeta,
  type InboundRoutes,
  type RouteHandler,
} from './transport/feishu.js'
export type { TransportLogger } from './transport/diagnostics.js'

// ── small shared util ──
export { isRecord, asString } from './json.js'

/**
 * Package marker — a stable export the channel layer can import to assert the
 * core resolves end to end. Kept from the PR0 scaffold so the `feishu-channel`
 * smoke test stays green.
 */
export const FEISHU_TRANSPORT_PACKAGE = '@excitedjs/feishu-transport'
