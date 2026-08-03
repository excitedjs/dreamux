import { isFeishuOutboundError } from '@excitedjs/feishu-transport';

/** Project an error into the Channel's structured-log safety boundary. */
export function feishuErrorLogInfo(error: unknown): Record<string, unknown> {
  if (isFeishuOutboundError(error)) {
    return {
      name: error.name,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.logId !== undefined ? { log_id: error.logId } : {}),
    };
  }
  if (error instanceof Error) {
    return error.stack !== undefined
      ? { message: error.message, stack: error.stack }
      : { message: error.message };
  }
  return { message: String(error) };
}
