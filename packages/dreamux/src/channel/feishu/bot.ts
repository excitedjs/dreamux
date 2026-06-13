/**
 * Re-export shim: the Feishu bot wrapper over `@excitedjs/feishu-transport` now
 * lives in the published `@excitedjs/feishu-channel` package (issue #209 slice
 * 5). Core and tests keep importing it from this path.
 */
export {
  createFeishuBot,
  createFakeFeishuBot,
  channelOutboundToFeishuTarget,
  type FeishuBot,
  type FakeFeishuBot,
  type CreateBotOptions,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';
