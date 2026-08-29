import type {
  InboundDeliveryResult,
  TurnAdmission,
} from '../teammate-service/turn-recording.js';

export function asInboundDeliveryResult(
  result: TurnAdmission,
): InboundDeliveryResult {
  switch (result.status) {
    case 'submitted':
      return { status: 'submitted' };
    case 'duplicate':
      return { status: 'duplicate' };
    case 'stopped':
      return { status: 'stopped' };
    case 'failed':
      return { status: 'failed', error: result.error };
    case 'ambiguous':
      return { status: 'ambiguous', error: result.error };
    case 'skipped':
      return { status: 'stopped' };
  }
}
