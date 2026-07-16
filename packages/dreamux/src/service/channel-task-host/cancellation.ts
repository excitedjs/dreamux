import type {
  ChannelTaskCancelInput,
  ChannelTaskCancelResult,
  ChannelTaskReceipt,
} from '@excitedjs/dreamux-types';

import { validateTaskCancelInput } from './identity.js';
import { boundedText } from './service-helpers.js';
import type { TaskHostStore } from './store.js';
import { TaskManifestFenceError } from './types.js';

export async function cancelTaskAttempt(
  context: {
    store: TaskHostStore;
    isNegotiated: () => boolean;
    isAccepting: () => boolean;
    assertSessionActive: () => void;
    lookupSubmission: () => Promise<ChannelTaskReceipt | null>;
    startFinalizer: (targetId: string) => void;
  },
  input: ChannelTaskCancelInput,
): Promise<ChannelTaskCancelResult> {
  context.assertSessionActive();
  if (!context.isNegotiated()) {
    return {
      status: 'rejected',
      code: 'TASK_HOST_NOT_NEGOTIATED',
      message: 'task channel host capabilities are not negotiated',
      retryable: false,
    };
  }
  if (!context.isAccepting()) {
    return {
      status: 'rejected',
      code: 'TASK_HOST_SHUTTING_DOWN',
      message: 'task channel host is not accepting cancellations',
      retryable: true,
    };
  }
  try {
    validateTaskCancelInput(input);
    context.store.assertManifestRevision(input.manifest_revision);
  } catch (error) {
    if (error instanceof TaskManifestFenceError) {
      return manifestRejected(error);
    }
    return {
      status: 'rejected',
      code: 'TASK_INPUT_INVALID',
      message: 'task cancellation is invalid',
      retryable: false,
    };
  }
  const receipt = await context.lookupSubmission();
  context.assertSessionActive();
  if (receipt === null) return { status: 'not_found' };
  try {
    const result = await context.store.setTerminal({
      targetId: receipt.target_id,
      expectedRevision: null,
      terminal: {
        outcome: 'cancelled',
        ...(input.reason !== undefined
          ? { summary: boundedText(input.reason, 64 * 1024) }
          : {}),
      },
      manifestRevision: input.manifest_revision,
      containerGeneration: input.container_generation,
      assertAuthorized: context.assertSessionActive,
    });
    context.startFinalizer(receipt.target_id);
    if (!result.changed) {
      return {
        status: 'already_terminal',
        receipt: result.record.receipt,
        terminal: result.record.terminal!,
      };
    }
    return { status: 'accepted', receipt: result.record.receipt };
  } catch (error) {
    if (error instanceof TaskManifestFenceError) return manifestRejected(error);
    throw error;
  }
}

function manifestRejected(
  error: TaskManifestFenceError,
): Extract<ChannelTaskCancelResult, { status: 'rejected' }> {
  return {
    status: 'rejected',
    code: error.code === 'TASK_CONTAINER_GENERATION_MISMATCH'
      ? error.code
      : 'TASK_CONTAINER_MANIFEST_NOT_APPLIED',
    message: error.message,
    retryable: error.retryable,
  };
}
