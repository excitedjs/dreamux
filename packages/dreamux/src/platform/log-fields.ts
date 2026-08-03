export const LOG_IDENTITY_MAX_LENGTH = 512;
export const LOG_ERROR_MAX_LENGTH = 1_024;

/** Bound and flatten a string before it crosses a structured-log boundary. */
export function boundedLogText(
  value: string,
  maxLength: number = LOG_IDENTITY_MAX_LENGTH,
): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, maxLength);
}
