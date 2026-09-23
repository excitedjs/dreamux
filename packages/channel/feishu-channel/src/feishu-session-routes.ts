/**
 * The inbound route table one session lifecycle hands its bot.
 *
 * Every route checks that lifecycle's fence first and runs its work tracked,
 * so closing the session refuses new events and waits for the ones in flight.
 */
import type { FeishuCardActionEvent, FeishuInboundRoutes } from './bot.js';
import { recordBotAdded } from './chat-bots-store.js';
import type { FeishuDocumentComments } from './feishu-document-comments.js';
import type { FeishuSessionFence } from './feishu-inbound-work.js';
import { onMessage } from './feishu-session-inbound.js';
import type { SessionHandle } from './feishu-session-ops.js';

export function sessionBotRoutes(input: {
  fence: FeishuSessionFence;
  track<T>(work: Promise<T>): Promise<T>;
  stateDir: string;
  handle(): SessionHandle;
  onCardAction(event: FeishuCardActionEvent): Promise<unknown>;
  docComments: FeishuDocumentComments;
}): FeishuInboundRoutes {
  const { fence, track } = input;
  return {
    onBotMemberAdded: async (added) => {
      if (!fence.isCurrent()) return;
      await track(recordBotAdded(input.stateDir, added.chatId, added.eventId));
    },
    onMessage: async (event) => {
      if (!fence.isCurrent()) return;
      await track(onMessage(input.handle(), event));
    },
    onCardAction: async (event) => {
      if (!fence.isCurrent()) return {};
      return track(input.onCardAction(event));
    },
    onDocComment: async (event) => {
      if (!fence.isCurrent()) return;
      await track(input.docComments.deliver(event));
    },
  };
}
