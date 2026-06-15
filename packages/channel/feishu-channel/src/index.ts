/**
 * `@excitedjs/feishu-channel` — the built-in Feishu `ChannelProvider` for
 * Dreamux (alias `builtin:feishu`). Owns Feishu channel session logic, inbound
 * normalization, access/trust behavior, attachment handling, and MCP tool
 * backing on top of `@excitedjs/feishu-transport`. Depends on
 * `@excitedjs/dreamux-types` + `@excitedjs/feishu-transport` only; never imports
 * `@excitedjs/dreamux` core.
 */

export {
  default,
  createFeishuChannelProvider,
  type CreateFeishuChannelProviderOptions,
  type FeishuChannelConfig,
} from './provider.js';

export {
  FeishuChannelSession,
  FeishuChannelCapabilityError,
  RECEIVED_REACTION_EMOJI,
  IN_PROGRESS_REACTION_EMOJI,
  toWireChatBot,
  type FeishuChannelSessionOptions,
  type FeishuChannelLogger,
  type FeishuInboundSubmitter,
  type FeishuInboundEnvelope,
  type FeishuMcpListChatBotsResult,
  type WireChatBot,
} from './feishu-channel.js';

export {
  feishuMcpTools,
  parseFeishuMcpToolInput,
  type FeishuMcpToolName,
  type FeishuMcpToolInput,
  type FeishuMcpReplyInput,
  type FeishuMcpReactInput,
  type FeishuMcpListChatBotsInput,
} from './feishu-mcp-tools.js';

export {
  createFeishuBot,
  createFakeFeishuBot,
  channelOutboundToFeishuTarget,
  type FeishuBot,
  type FakeFeishuBot,
  type CreateBotOptions,
  type FeishuInboundEvent,
} from './bot.js';

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
