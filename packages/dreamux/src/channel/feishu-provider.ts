/**
 * `builtin:feishu` Channel provider (issue #110 PR4).
 *
 * The Phase 1 channel provider. It moves the Feishu channel surface — MCP args,
 * connection lifecycle, access/trust gating, reply, and reaction — behind the
 * {@link ChannelProvider} boundary by delegating to the existing Feishu
 * modules. Behavior is unchanged; the difference is that the server now reaches
 * these through the provider instead of constructing them by hard-coded name.
 *
 * Capabilities are read from the registry descriptor for `builtin:feishu`
 * (`src/registry/builtins.ts`), so the catalog stays the single source of truth
 * for what this provider exposes.
 */

import { createBuiltinRegistry } from '../registry/index.js';
import { feishuMcpCodexArgs } from '../codex/mcp-config.js';
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

/** Build the Phase 1 `builtin:feishu` channel provider. */
export function builtinFeishuChannelProvider(): ChannelProvider {
  const descriptor = createBuiltinRegistry().resolve(BUILTIN_FEISHU_PROVIDER_REF);
  const capabilities = new Set<string>(
    descriptor.capabilities.map((capability) => capability.kind),
  );

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
    mcpCodexArgs: (opts) => feishuMcpCodexArgs(opts),
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
