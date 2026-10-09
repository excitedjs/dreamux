/**
 * Package-root default: neutral provider factory for configured npm providers.
 * The named plugin factory contributes the builtin provider and plugin APIs.
 * This package never imports Dreamux Core.
 */

export { createFeishuPlugin } from './plugin.js';

export {
  createFeishuChannelProvider,
  type FeishuChannelConfig,
} from './provider.js';

export type {
  FeishuApi,
  FeishuExtension,
  FeishuExtensionAction,
  FeishuExtensionActionResult,
  FeishuExtensionContext,
  FeishuExtensionForward,
  FeishuExtensionTool,
  FeishuInstanceApi,
} from './extension.js';

// The extension contract's own transitive types: what an extension author
// needs to build a `FeishuExtensionAction`/`FeishuExtensionTool` and drive
// `FeishuInstanceApi`, and nothing an extension never touches.
export type { FeishuCardActionEvent } from '@excitedjs/feishu-transport';
export { DREAMUX_ACTION_KEY } from './card-actions.js';
export {
  rawCardActionResponse,
  type FeishuCardActionResponse,
} from './cards/pairing.js';
export type { FeishuTarget } from './routing/target.js';
export type { FeishuToolResult } from './tools/types.js';

// `packages/dreamux/tests/channel-input-format.test.ts`'s own cross-package
// need, and nothing else.
export type { FeishuInboundEvent } from '@excitedjs/feishu-transport';
export { formatFeishuMessageForRuntime } from './inbound/attachments.js';

import type { ChannelProviderFactory } from '@excitedjs/dreamux-types';
import type { FeishuChannelConfig } from './provider.js';
import { createFeishuChannelProvider } from './provider.js';

const providerFactory: ChannelProviderFactory<FeishuChannelConfig> = () =>
  createFeishuChannelProvider();
export default providerFactory;
