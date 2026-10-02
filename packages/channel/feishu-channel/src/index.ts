/**
 * `@excitedjs/feishu-channel` — the built-in Feishu plugin for Dreamux. Its
 * default export is the plugin factory: the plugin contributes the Feishu
 * `ChannelProvider` (addressed as `builtin:feishu`) and publishes the Feishu
 * extension api. Owns Feishu channel session logic, inbound
 * normalization, access/trust behavior, attachment handling, its own external
 * routing and Collaboration Space policy, and MCP tool backing on top of
 * `@excitedjs/feishu-transport`. Depends on `@excitedjs/dreamux-types` +
 * `@excitedjs/dreamux-utils` + `@excitedjs/feishu-transport` only; never
 * imports `@excitedjs/dreamux` core.
 *
 * This barrel is the package's entire public surface (the sole `package.json`
 * `exports` target): the plugin entry, `createFeishuChannelProvider` (a bare
 * provider with no extensions, for a test or an embedder outside the plugin
 * system), the full extension contract another plugin implements against, and
 * the two names `packages/dreamux/tests/channel-input-format.test.ts` reads as
 * a cross-package consumer. Every other type below internal modules stays a
 * relative import inside this package; re-exporting it here would grow the
 * public contract for no reader.
 */

export { createFeishuPlugin, default } from './plugin.js';

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
