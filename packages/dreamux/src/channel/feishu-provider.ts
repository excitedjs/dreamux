/**
 * `builtin:feishu` Channel provider (issue #110 PR4).
 *
 * The Phase 1 channel provider. It moves the Feishu channel surface — MCP args,
 * connection lifecycle, access/trust gating, reply, and reaction — behind the
 * {@link ChannelProvider} boundary by delegating to the existing Feishu
 * modules. Behavior is unchanged; the difference is that the server now reaches
 * these through the provider instead of constructing them by hard-coded name.
 *
 * Capabilities are declared by this provider; the registry only validates the
 * provider ref and kind.
 */

import { feishuMcpServerDescriptor } from '../codex/mcp-config.js';
import {
  channelOutboundToFeishuTarget,
  createFeishuBot,
} from '../feishu/bot.js';
import {
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
} from './feishu-gate.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from '../runtime/config.js';
import { type ProviderDescriptor } from '../registry/index.js';
import type {
  ChannelAccessOps,
  ChannelCapabilityKind,
  ChannelProvider,
  ChannelReactInput,
  ChannelReactResult,
  ChannelReplyInput,
  ChannelReplyResult,
  ChannelConnection,
} from './provider.js';

export const FEISHU_CHANNEL_CAPABILITIES: readonly ChannelCapabilityKind[] = [
  'mcpServer',
  'reply',
  'react',
  'access',
];

/** Build the Phase 1 `builtin:feishu` channel provider. */
export function builtinFeishuChannelProvider(
  descriptor: ProviderDescriptor,
): ChannelProvider {
  const capabilities = new Set<ChannelCapabilityKind>(FEISHU_CHANNEL_CAPABILITIES);

  const access: ChannelAccessOps = {
    load: loadDispatcherAccess,
    save: saveDispatcherAccess,
    gate: dreamuxFeishuGate,
  };

  return {
    ref: BUILTIN_FEISHU_PROVIDER_REF,
    descriptor,
    hasCapability: (kind: ChannelCapabilityKind): boolean =>
      capabilities.has(kind),
    mcpServerDescriptors: (context) => [
      feishuMcpServerDescriptor({
        dispatcherId: context.dispatcherId,
        adminSocketPath: context.adminSocketPath,
      }),
    ],
    createConnection: (opts) => createFeishuBot(opts),
    access,
    reply: async (
      connection: ChannelConnection,
      input: ChannelReplyInput,
    ): Promise<ChannelReplyResult> => {
      const result = await connection.send(
        channelOutboundToFeishuTarget({
          conversationId: input.chatId,
          ...(input.replyToMessageId !== undefined
            ? { replyTo: input.replyToMessageId }
            : {}),
          ...(input.mentionUserIds !== undefined
            ? { mentionUsers: input.mentionUserIds }
            : {}),
        }),
        input.text,
      );
      return { messageIds: result.messageIds };
    },
    react: async (
      connection: ChannelConnection,
      input: ChannelReactInput,
    ): Promise<ChannelReactResult> => {
      const reactionId = await connection.addReaction(
        input.messageId,
        input.emoji,
      );
      return { reactionId };
    },
  };
}
