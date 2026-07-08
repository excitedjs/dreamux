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

export function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
