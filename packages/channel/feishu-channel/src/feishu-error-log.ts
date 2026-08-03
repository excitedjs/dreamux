import { projectFeishuOutboundErrorLog } from '@excitedjs/feishu-transport';

const GENERIC_ERROR_MESSAGE_MAX = 512;
const GENERIC_ERROR_STACK_MAX = 4_096;

/** Project a Feishu outbound failure into safe upstream or generic log fields. */
export function feishuOutboundErrorLogInfo(
  error: unknown,
): Record<string, unknown> {
  const upstream = projectFeishuOutboundErrorLog(error);
  if (upstream !== null) return { ...upstream };
  return feishuErrorLogInfo(error);
}

/** Preserve generic message/stack logging with explicit string bounds. */
export function feishuErrorLogInfo(error: unknown): Record<string, unknown> {
  try {
    if (error instanceof Error) {
      return error.stack !== undefined
        ? {
            message: boundedErrorText(error.message, GENERIC_ERROR_MESSAGE_MAX),
            stack: boundedErrorText(error.stack, GENERIC_ERROR_STACK_MAX),
          }
        : {
            message: boundedErrorText(error.message, GENERIC_ERROR_MESSAGE_MAX),
          };
    }
    return {
      message: boundedErrorText(String(error), GENERIC_ERROR_MESSAGE_MAX),
    };
  } catch {
    return { message: 'Unknown error' };
  }
}

function boundedErrorText(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}
