/**
 * The inbound route table one session lifecycle hands its bot.
 *
 * Every route checks that lifecycle first and runs its work tracked, so
 * closing the session refuses new events and waits for the ones in flight.
 */
import type { FeishuCardActionEvent } from '@excitedjs/feishu-transport';
import type { TransactionalStore } from '@excitedjs/dreamux-utils';

import type { FeishuInboundRoutes } from '../bot.js';
import { recordBotAdded, type ChatBotsState } from '../chat-bots-store.js';
import type { FeishuDocumentComments } from '../feishu-document-comments.js';
import { onMessage, type FeishuInboundHandle } from './pipeline.js';
import type { FeishuLifecycle } from '../session/lifecycle.js';

export function sessionBotRoutes(input: {
  lifecycle: FeishuLifecycle;
  /** Stable for the session's whole life; no factory needed. */
  chatBotsStore: TransactionalStore<ChatBotsState>;
  inboundHandle(): FeishuInboundHandle;
  onCardAction(event: FeishuCardActionEvent): Promise<unknown>;
  docComments: FeishuDocumentComments;
}): FeishuInboundRoutes {
  const { lifecycle } = input;
  return {
    onBotMemberAdded: async (added) => {
      if (!lifecycle.isLive()) return;
      await lifecycle.track(
        recordBotAdded(input.chatBotsStore, added.chatId, added.eventId),
      );
    },
    onMessage: async (event) => {
      if (!lifecycle.isLive()) return;
      await lifecycle.track(onMessage(input.inboundHandle(), event));
    },
    onCardAction: async (event) => {
      if (!lifecycle.isLive()) return {};
      return lifecycle.track(input.onCardAction(event));
    },
    onDocComment: async (event) => {
      if (!lifecycle.isLive()) return;
      await lifecycle.track(input.docComments.deliver(event));
    },
  };
}
