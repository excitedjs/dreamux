/**
 * Reading an arbitrary thrown value, which TypeScript types as `unknown` and
 * may not be an `Error` at all. Shared across the host and every provider
 * package instead of each one carrying its own copy.
 */

export interface ErrorInfo {
  message: string;
  stack?: string;
}

/** The message of an arbitrary thrown value, for wrapping into a typed error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorInfo(error: unknown): ErrorInfo {
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack === undefined
    ? { message: error.message }
    : { message: error.message, stack: error.stack };
}
