/**
 * Sending one binding notification card: bounded, retried once, and silent
 * once the session lifecycle that asked for it has ended.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { ChannelOutboundTarget } from './bot.js';
import {
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from './feishu-bounded-operation.js';
import { sendCard, type SessionHandle } from './feishu-session-ops.js';
import { errorMessage } from './feishu-submit.js';

const FEISHU_BINDING_NOTIFICATION_SEND_TIMEOUT_MS = 20_000;

/** The sent message id, or `undefined` when nothing was sent. */
export async function sendBindingNotification(input: {
  handle: SessionHandle;
  lifecycleSignal: AbortSignal;
  isCurrent(): boolean;
  outbound: ChannelOutboundTarget;
  card: unknown;
  log: DreamuxLogger;
  logFields: Record<string, unknown>;
}): Promise<string | undefined> {
  const { lifecycleSignal } = input;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (!input.isCurrent()) return undefined;
    const requestController = new AbortController();
    const abortRequest = (): void => requestController.abort();
    lifecycleSignal.addEventListener('abort', abortRequest, { once: true });
    if (lifecycleSignal.aborted) abortRequest();
    try {
      const result = await runFeishuBoundedOperation({
        signal: lifecycleSignal,
        deadlineAt: Date.now() + FEISHU_BINDING_NOTIFICATION_SEND_TIMEOUT_MS,
        operation: () => sendCard(input.handle, {
          target: input.outbound,
          card: input.card,
          signal: requestController.signal,
          mode: 'background',
        }),
      });
      return result.messageIds[0];
    } catch (err) {
      if (isFeishuOperationError(err, 'aborted')) return undefined;
      requestController.abort();
      const retrying = attempt === 1 && input.isCurrent();
      input.log.warn(
        {
          ...input.logFields,
          attempt,
          err: { message: errorMessage(err) },
        },
        retrying
          ? 'Feishu binding notification failed; retrying once'
          : 'Feishu binding notification failed after retry',
      );
      if (!retrying) return undefined;
    } finally {
      lifecycleSignal.removeEventListener('abort', abortRequest);
    }
  }
  return undefined;
}
