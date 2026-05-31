import { isBotSenderType } from '@excitedjs/feishu-transport';

export interface CompatibleFeishuGateInput {
  senderId: string;
  senderType?: string;
  chatType: string;
  botOpenId?: string;
}

export type CompatibleFeishuGateResult =
  | { action: 'deliver' }
  | { action: 'drop'; reason: string };

/**
 * Compatibility-first inbound gate for dreamux's Feishu channel.
 *
 * This deliberately does not enable pairing or allowlists yet. The current
 * product behavior stays open, while the loop/ambiguity hazards that can make
 * a channel self-amplify are blocked before messages enter the durable FIFO.
 */
export function compatibleFeishuGate(
  input: CompatibleFeishuGateInput,
): CompatibleFeishuGateResult {
  if (input.senderId === '') {
    return { action: 'drop', reason: 'missing sender id' };
  }
  if (input.botOpenId !== undefined && input.senderId === input.botOpenId) {
    return { action: 'drop', reason: 'message sent by this bot' };
  }
  if (isBotSenderType(input.senderType)) {
    return { action: 'drop', reason: `bot sender type: ${input.senderType}` };
  }
  if (input.chatType === 'group' && input.botOpenId === undefined) {
    return {
      action: 'drop',
      reason: 'group message received before bot open_id was resolved',
    };
  }
  return { action: 'deliver' };
}
