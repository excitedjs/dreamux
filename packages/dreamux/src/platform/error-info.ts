export interface ErrorInfo {
  message: string;
  stack?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorInfo(error: unknown): ErrorInfo {
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack === undefined
    ? { message: error.message }
    : { message: error.message, stack: error.stack };
}
