export const DISPATCHER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DISPATCHER_ID_RULE =
  '1-64 characters, starting with an ASCII letter or digit, and containing only ASCII letters, digits, dot, underscore, or dash';

export function validateDispatcherId(id: string, label = 'dispatcher id'): string {
  if (!DISPATCHER_ID_PATTERN.test(id)) {
    throw new Error(`${label} must be ${DISPATCHER_ID_RULE}: ${id}`);
  }
  return id;
}
