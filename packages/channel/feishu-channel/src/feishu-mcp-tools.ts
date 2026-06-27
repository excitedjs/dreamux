/**
 * Feishu MCP tool surface — re-export shim.
 *
 * @deprecated Import from `./tools/registry.js` directly in new code. Kept so
 * existing callers (`provider.ts`, the barrel `index.ts`) keep compiling while
 * the centralization settles.
 */

import {
  FEISHU_TOOLS,
  FeishuToolName,
  buildToolCatalog,
} from './tools/registry.js';
export type {
  FeishuToolDef,
  FeishuToolResultEnvelope,
  FeishuToolContext,
  ChannelLogger,
  PeerBot,
} from './tools/registry.js';
export { FEISHU_TOOLS, buildToolCatalog };
// Value + type re-export: FeishuToolName is a string-literal union type (no
// runtime value), so `export type { ... }` would work, but using a two-line
// re-export mirrors the above split for readability.
export type { FeishuToolName };

/** @deprecated Use {@link FeishuToolName} instead. */
export type FeishuMcpToolName = FeishuToolName;

/** @deprecated Internal to the `reply` tool; use the generic `FeishuToolDef.parse` shape. */
export type FeishuMcpReplyInput = {
  chatId: string;
  text: string;
  messageId?: string;
  mentionUserIds?: string[];
};

/** @deprecated Internal to the `react` tool; use the generic `FeishuToolDef.parse` shape. */
export type FeishuMcpReactInput = {
  chatId?: string;
  messageId: string;
  emoji: string;
};

/** @deprecated Internal to the `list_chat_bots` tool; use the generic `FeishuToolDef.parse` shape. */
export type FeishuMcpListChatBotsInput = {
  chatId: string;
};

/** @deprecated Use a per-definition `FeishuToolDef` discriminated union instead. */
export type FeishuMcpToolInput =
  | { toolName: 'reply'; input: FeishuMcpReplyInput }
  | { toolName: 'react'; input: FeishuMcpReactInput }
  | { toolName: 'list_chat_bots'; input: FeishuMcpListChatBotsInput }
  | { toolName: 'access'; input: { code: string } };

/**
 * @deprecated Use `buildToolCatalog()` from `./tools/registry.js` instead.
 * Same return shape.
 */
export function feishuMcpTools(): Array<Record<string, unknown>> {
  return buildToolCatalog() as unknown as Array<Record<string, unknown>>;
}

/**
 * Parse raw MCP-call arguments for a given Feishu tool name.
 *
 * Mirrors the legacy `{ toolName, input }` discriminated-union return so
 * `handleSessionlessTool` in `provider.ts` keeps compiling unchanged in P1.
 *
 * @deprecated Use `FEISHU_TOOLS.find(t => t.name === name)?.parse(args)`
 * from `./tools/registry.js` directly.
 */
export function parseFeishuMcpToolInput(
  toolName: string,
  value: unknown,
): { toolName: FeishuToolName; input: unknown } {
  const def = FEISHU_TOOLS.find((t) => t.name === toolName);
  if (def === undefined) {
    throw new Error(`unknown Feishu tool '${toolName}'`);
  }
  return { toolName: def.name, input: def.parse(value) };
}
