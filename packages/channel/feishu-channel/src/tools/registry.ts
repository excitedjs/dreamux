/**
 * The single source of truth for the Feishu MCP surface.
 *
 * The catalog is caller-specific, and that is the whole authorization model:
 * Core asks the provider what this caller may see, freezes the answer for one
 * runtime generation, and admits only names in it.
 *
 * A name may therefore appear twice with different authority rather than once
 * with an authority check inside it. `bind_channel` and `unbind_channel` do.
 * The Dispatcher's take a Team and reach every route; the TeamLeader's take
 * none and reach only that Team's own. Collaboration Space policy and the
 * channel-wide binding list are operator work, and appear only for the
 * Dispatcher.
 *
 * Every registration targets the live session. There is no sessionless Feishu
 * tool any more: the provider-level entry receives no state root, so it could
 * not honestly serve one — and the window it used to cover is already covered,
 * because Core takes a channel's MCP capability from the built instance, which
 * exists from creation rather than from connection.
 */
import type {
  ChannelMcpCaller,
  ChannelMcpToolRegistration,
} from '@excitedjs/dreamux-types';

import { askUserQuestionDef } from './ask-user-question.js';
import {
  listChatBotsDef,
  reactDef,
  replyDef,
} from './messaging-tools.js';
import {
  bindChannelDef,
  leaderBindChannelDef,
  leaderUnbindChannelDef,
  listBindingsDef,
  unbindChannelDef,
} from './routing-tools.js';
import {
  bindSpaceDef,
  getSpaceDef,
  listSpacesDef,
  unbindSpaceDef,
} from './space-tools.js';
import type { FeishuToolDef } from './types.js';

export const FEISHU_TOOLS: readonly FeishuToolDef[] = [
  replyDef,
  reactDef,
  listChatBotsDef,
  askUserQuestionDef,
  bindChannelDef,
  unbindChannelDef,
  leaderBindChannelDef,
  leaderUnbindChannelDef,
  listBindingsDef,
  bindSpaceDef,
  unbindSpaceDef,
  getSpaceDef,
  listSpacesDef,
];

export function feishuToolsFor(
  caller: ChannelMcpCaller,
): readonly FeishuToolDef[] {
  return FEISHU_TOOLS.filter((def) => def.callers.includes(caller.kind));
}

/**
 * The definition this caller means by that name.
 *
 * A name can belong to more than one definition, because two callers can be
 * offered the same operation with different authority: `bind_channel` names a
 * Team for the Dispatcher and derives one for a TeamLeader. Resolving with the
 * caller is what keeps the served definition identical to the advertised one,
 * rather than one definition branching on who called it.
 */
export function findFeishuTool(
  name: string,
  caller: ChannelMcpCaller['kind'],
): FeishuToolDef | undefined {
  return FEISHU_TOOLS.find(
    (def) => def.name === name && def.callers.includes(caller),
  );
}

/** Project this caller's tools into the neutral registration shape. */
export function feishuToolRegistrations(
  caller: ChannelMcpCaller,
): readonly ChannelMcpToolRegistration[] {
  return feishuToolsFor(caller).map((def) => ({
    tool: {
      name: def.name,
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations,
    },
    target: 'session' as const,
  }));
}

export type {
  ChannelLogger,
  FeishuListChatBotsResult,
  FeishuToolContext,
  FeishuToolDef,
  FeishuToolResult,
  FeishuToolSession,
  WireChatBot,
} from './types.js';
