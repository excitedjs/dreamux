/**
 * `team.create` request identity.
 *
 * While a valid Team record carries its acceptance, a retried `team.create` with the same
 * accepted request id and payload resolves to the same concrete name without
 * creating another Team. The Team record itself carries that
 * identity: publication of `team/<team>/record.json` through its canonical
 * serialized owner is the acceptance point, the concrete-name ownership point,
 * and the durable record of which request produced it. There is no second
 * persisted authority. Deleting or damaging a fully retired record removes
 * that request and name claim, so a later request can create a Team anew.
 *
 * This module owns only the two derived facts that identity needs — the bound on
 * a caller-supplied id, and the canonical payload hash written into the record.
 */
import { createHash } from 'node:crypto';

/**
 * The maximum length of a caller-supplied `request_id`.
 *
 * Generous enough for any UUID, ULID, or provider-scoped saga key, and short
 * enough that one hostile caller cannot inflate a Team record with a single
 * field. The character set is deliberately unrestricted: an id is an opaque map
 * key, and `constructor` or `__proto__` must behave like any other.
 */
export const MAX_REQUEST_ID_LENGTH = 256;

/** A sha256 digest in lowercase hex. */
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The canonical hash of one accepted creation payload.
 *
 * Key order is normalized and `undefined` members are dropped, so two requests
 * that differ only in serialization are the same request. Reusing an id with a
 * different canonical payload is an idempotency conflict, not a replay.
 */
export function teamCreatePayloadHash(payload: unknown): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

/** Whether a persisted value is a well-formed canonical payload hash. */
export function isTeamCreatePayloadHash(value: unknown): boolean {
  return typeof value === 'string' && PAYLOAD_HASH_PATTERN.test(value);
}

/** Whether a persisted value is a well-formed accepted request id. */
export function isTeamCreateRequestId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_REQUEST_ID_LENGTH
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}
