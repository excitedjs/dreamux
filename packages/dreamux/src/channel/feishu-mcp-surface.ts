/**
 * Host-owned half of the Feishu Channel MCP surface (issue #209).
 *
 * The channel-owned half — tool names, input shapes, JSON-schema descriptors,
 * and the raw-argument parser — lives in `@excitedjs/feishu-channel`; importers
 * take it from the package directly. What stays here is host/shim machinery that
 * core legitimately owns (see the package CLAUDE.md "Boundaries"): the MCP
 * *server descriptor* (Dreamux bin + admin socket + the core `feishu-mcp` shim),
 * the admin-method routing the shim forwards a tool call through, and the
 * sessionless `list_chat_bots` helper (the dispatcher-level admin path that has
 * no live channel session). It never constructs a channel session — production
 * drives sessions through the neutral `ChannelProvider`/`ChannelSession` seam.
 */
import { dreamuxBinPath } from '../platform/package-bin.js';
import { dispatcherDir } from '../platform/paths.js';
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';
import {
  FeishuChannelCapabilityError,
  listChatBots,
  parseFeishuMcpToolInput,
  toWireChatBot,
  type FeishuMcpListChatBotsResult,
  type FeishuMcpToolInput,
  type FeishuMcpToolName,
} from '@excitedjs/feishu-channel';

export const FEISHU_MCP_SERVER_NAME = 'feishu';

export interface FeishuMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export function feishuMcpServerDescriptor(
  opts: FeishuMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return {
    name: FEISHU_MCP_SERVER_NAME,
    command,
    args: [
      'feishu-mcp',
      '--dispatcher',
      opts.dispatcherId,
      ...(opts.callerKind !== undefined ? ['--caller', opts.callerKind] : []),
      ...(opts.teamId !== undefined ? ['--team-id', opts.teamId] : []),
      ...(opts.leaderName !== undefined ? ['--leader-name', opts.leaderName] : []),
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}

export function feishuMcpAdminMethod(toolName: FeishuMcpToolName): string {
  switch (toolName) {
    case 'reply':
      return 'mcp.reply';
    case 'react':
      return 'mcp.react';
    case 'list_chat_bots':
      return 'mcp.list_chat_bots';
  }
}

export function feishuMcpAdminLabel(toolName: FeishuMcpToolName): string {
  return toolName === 'list_chat_bots' ? 'list_chat_bots' : toolName;
}

export function feishuMcpAdminParams(
  dispatcherId: string,
  parsed: FeishuMcpToolInput,
): Record<string, unknown> {
  switch (parsed.toolName) {
    case 'reply':
      return {
        dispatcher_id: dispatcherId,
        chat_id: parsed.input.chatId,
        text: parsed.input.text,
        ...(parsed.input.messageId !== undefined
          ? { message_id: parsed.input.messageId }
          : {}),
        ...(parsed.input.mentionUserIds !== undefined
          ? { mention_user_ids: parsed.input.mentionUserIds }
          : {}),
      };
    case 'react':
      return {
        dispatcher_id: dispatcherId,
        ...(parsed.input.chatId !== undefined ? { chat_id: parsed.input.chatId } : {}),
        message_id: parsed.input.messageId,
        emoji: parsed.input.emoji,
      };
    case 'list_chat_bots':
      return {
        dispatcher_id: dispatcherId,
        chat_id: parsed.input.chatId,
      };
  }
}

/**
 * Sessionless `list_chat_bots` host helper (the dispatcher-level admin path that
 * has no live channel session). Resolves the dispatcher's state dir, then reuses
 * the channel package's chat-bots store + wire projection.
 */
export async function handleFeishuListChatBots(
  dispatcherId: string,
  rawArguments: unknown,
): Promise<FeishuMcpListChatBotsResult> {
  const parsed = parseFeishuMcpToolInput('list_chat_bots', rawArguments);
  if (parsed.toolName !== 'list_chat_bots') {
    throw new FeishuChannelCapabilityError(parsed.toolName);
  }
  const listing = await listChatBots(dispatcherDir(dispatcherId), parsed.input.chatId);
  return {
    chat_id: parsed.input.chatId,
    known: listing.known.map(toWireChatBot),
    trusted: listing.trusted.map(toWireChatBot),
  };
}
