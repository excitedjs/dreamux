import type {
  ChannelTargetLifecycleEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { isFeishuOutboundError } from '@excitedjs/feishu-transport';

import type { FeishuSessionFence } from './feishu-inbound-work.js';
import type {
  FeishuTargetRouter,
  FeishuTopicRoute,
} from './feishu-target-router.js';

const FEISHU_LIFECYCLE_LOG_ID_MAX = 512;
const FEISHU_LIFECYCLE_UPSTREAM_LOG_ID_MAX = 256;

export type FeishuTopicCloseSignal =
  | {
      kind: 'message_recalled';
      eventId: string;
      recallType: string;
      recallTime: string;
    }
  | {
      kind: 'reply_error';
      code: number;
      logId?: string;
    };

export async function handleFeishuReplyFailure(input: {
  dispatcherId: string;
  chatId: string;
  messageId?: string;
  error: unknown;
  targetRouter: FeishuTargetRouter;
  fence: FeishuSessionFence;
  targetLifecycle?: (event: ChannelTargetLifecycleEvent) => Promise<void>;
  log: DreamuxLogger;
}): Promise<void> {
  const safeError = isFeishuOutboundError(input.error) ? input.error : undefined;
  input.log.error(
    {
      dispatcher_id: boundedLogId(input.dispatcherId),
      chat_id: boundedLogId(input.chatId),
      ...(input.messageId !== undefined
        ? { message_id: boundedLogId(input.messageId) }
        : {}),
      ...(safeError !== undefined
        ? {
            upstream_code: safeError.code,
            ...(safeError.logId !== undefined
              ? {
                  upstream_log_id: boundedLogId(
                    safeError.logId,
                    FEISHU_LIFECYCLE_UPSTREAM_LOG_ID_MAX,
                  ),
                }
              : {}),
          }
        : { error_kind: 'unknown' }),
    },
    'feishu send failed',
  );
  if (
    safeError?.code !== 230019 ||
    input.messageId === undefined
  ) {
    return;
  }
  const route = input.targetRouter.observedTopicMessage(
    input.messageId,
    input.chatId,
  );
  if (route === null) return;
  try {
    await emitFeishuTargetClosed({
      dispatcherId: input.dispatcherId,
      chatId: input.chatId,
      messageId: input.messageId,
      route,
      signal: {
        kind: 'reply_error',
        code: safeError.code,
        ...(safeError.logId !== undefined ? { logId: safeError.logId } : {}),
      },
      fence: input.fence,
      ...(input.targetLifecycle !== undefined
        ? { targetLifecycle: input.targetLifecycle }
        : {}),
      log: input.log,
    });
  } catch {
    input.log.error(
      {
        dispatcher_id: boundedLogId(input.dispatcherId),
        chat_id: boundedLogId(input.chatId),
        message_id: boundedLogId(input.messageId),
        target_key: boundedLogId(route.target.target_key),
        upstream_code: safeError.code,
        lifecycle_error: true,
      },
      'Feishu topic-close lifecycle delivery failed after reply error',
    );
  }
}

export async function emitFeishuTargetClosed(input: {
  dispatcherId: string;
  chatId: string;
  messageId: string;
  route: FeishuTopicRoute;
  signal: FeishuTopicCloseSignal;
  fence: FeishuSessionFence;
  targetLifecycle?: (event: ChannelTargetLifecycleEvent) => Promise<void>;
  log: DreamuxLogger;
}): Promise<void> {
  if (!input.fence.isCurrent()) return;
  const fields = lifecycleLogFields(input);
  input.log.info(
    fields,
    input.signal.kind === 'message_recalled'
      ? 'Feishu recalled an observed topic root'
      : 'Feishu reply reported an observed topic as closed',
  );
  if (input.targetLifecycle === undefined) {
    input.log.warn(
      fields,
      'Feishu topic-close signal could not be delivered because target lifecycle is unavailable',
    );
    return;
  }
  const event: ChannelTargetLifecycleEvent = {
    kind: 'target_closed',
    container: input.route.container,
    target: input.route.target,
    ...(input.signal.kind === 'message_recalled'
      ? {
          event_id: input.signal.eventId,
          ...recallTimestamp(input.signal.recallTime),
        }
      : {}),
  };
  input.log.info(fields, 'emitting neutral target_closed lifecycle event');
  // This exact captured session generation is the final authority immediately
  // before invoking the host capability.
  if (!input.fence.isCurrent()) return;
  await input.targetLifecycle(event);
}

function lifecycleLogFields(input: {
  dispatcherId: string;
  chatId: string;
  messageId: string;
  route: FeishuTopicRoute;
  signal: FeishuTopicCloseSignal;
}): Record<string, unknown> {
  return {
    dispatcher_id: boundedLogId(input.dispatcherId),
    signal: input.signal.kind,
    chat_id: boundedLogId(input.chatId),
    message_id: boundedLogId(input.messageId),
    target_type: boundedLogId(input.route.target.target_type),
    target_key: boundedLogId(input.route.target.target_key),
    container_type: boundedLogId(input.route.container.container_type),
    container_key: boundedLogId(input.route.container.container_key),
    ...(input.signal.kind === 'message_recalled'
      ? {
          event_id: boundedLogId(input.signal.eventId),
          recall_type: boundedLogId(input.signal.recallType),
          recall_time: boundedLogId(input.signal.recallTime),
        }
      : {
          upstream_code: input.signal.code,
          ...(input.signal.logId !== undefined
            ? {
                upstream_log_id: boundedLogId(
                  input.signal.logId,
                  FEISHU_LIFECYCLE_UPSTREAM_LOG_ID_MAX,
                ),
              }
            : {}),
        }),
  };
}

function recallTimestamp(recallTime: string): { timestamp?: number } {
  const timestamp = Number(recallTime);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? { timestamp } : {};
}

function boundedLogId(
  value: string,
  max = FEISHU_LIFECYCLE_LOG_ID_MAX,
): string {
  return value.slice(0, max);
}
