import type {
  AgentRuntimeTurnResult,
  ChannelSession,
  InboundDeliveryResult,
} from '@excitedjs/dreamux-types';

export function asInboundDeliveryResult(
  result: AgentRuntimeTurnResult,
): InboundDeliveryResult {
  return result.status === 'skipped' ? { status: 'stopped' } : result;
}

export async function closeAllBuilt(
  channels: Map<string, ChannelSession>,
): Promise<void> {
  for (const session of channels.values()) {
    try {
      await session.close();
    } catch {
      /* best effort */
    }
  }
}
