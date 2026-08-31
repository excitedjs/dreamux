/**
 * `@excitedjs/feishu-channel` — the built-in Feishu `ChannelProvider` for
 * Dreamux (alias `builtin:feishu`). Owns Feishu channel session logic, inbound
 * normalization, access/trust behavior, attachment handling, its own external
 * routing and Collaboration Space policy, and MCP tool backing on top of
 * `@excitedjs/feishu-transport`. Depends on `@excitedjs/dreamux-types` +
 * `@excitedjs/dreamux-utils` + `@excitedjs/feishu-transport` only; never
 * imports `@excitedjs/dreamux` core.
 */

export {
  default,
  createFeishuChannelProvider,
  type CreateFeishuChannelProviderOptions,
  type FeishuChannelConfig,
} from './provider.js';

export {
  FeishuChannelSession,
  toWireChatBot,
  type FeishuChannelSessionOptions,
  type FeishuListChatBotsResult,
  type WireChatBot,
  type ChannelLogger,
} from './feishu-channel.js';

export { createFeishuSessionMcp } from './feishu-session-mcp.js';

export {
  CHANNEL_REMINDER,
  type FeishuInboundDelivery,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
  type FeishuTeamSubmitter,
} from './feishu-submit.js';

export {
  FEISHU_TOOLS,
  feishuToolRegistrations,
  feishuToolsFor,
  findFeishuTool,
  type FeishuToolContext,
  type FeishuToolDef,
  type FeishuToolResult,
  type FeishuToolSession,
} from './tools/registry.js';

export {
  FeishuRouting,
  type FeishuBindingView,
  type FeishuRoutingPlan,
} from './routing/index.js';
export {
  FeishuRoutingStore,
  routingDocumentFilename,
} from './routing/store.js';
export {
  FEISHU_ROUTING_DOCUMENT_VERSION,
  type FeishuBindingRecord,
  type FeishuRoutingDocument,
  type FeishuSpaceRecord,
} from './routing/document.js';
export {
  chatTarget,
  describeTarget,
  targetKey,
  topicTarget,
  type FeishuTarget,
  type FeishuTargetKind,
} from './routing/target.js';

export {
  createFeishuBot,
  channelOutboundToFeishuTarget,
  type FeishuBot,
  type CreateBotOptions,
  type FeishuInboundEvent,
  type FeishuCardActionEvent,
} from './bot.js';

export {
  DREAMUX_ACTION_KEY,
  DREAMUX_PAIRING_CARD_ACTION,
  DREAMUX_PAIRING_TOKEN_KEY,
  buildPairingApprovalCard,
  buildPairingSuccessCard,
  rawCardActionResponse,
  type FeishuCardActionResponse,
} from './feishu-pairing-card.js';

export {
  listChatBots,
  loadChatBots,
  type PeerBot,
  type ChatBotsListing,
} from './chat-bots-store.js';

export {
  formatFeishuMessageForRuntime,
  formatFeishuCreateTime,
  FEISHU_SKILL_FALLBACK_NOTE,
  type FormatFeishuMessageOptions,
  type FormatFeishuMessageResult,
  type FormattedFeishuAttachment,
} from './feishu-message.js';

export {
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
  defaultDispatcherAccessState,
  TRUST_DOMAIN_WARNING,
  type DispatcherAccessState,
} from './feishu-gate.js';

export { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';
