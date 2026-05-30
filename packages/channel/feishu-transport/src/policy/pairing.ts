/**
 * Pairing codes — the short secret a new sender must echo back through the
 * access skill before the channel will trust them. Ported verbatim from
 * claudemux.
 */

import { randomBytes } from 'node:crypto'

/** A pairing code is this many random bytes, rendered as lowercase hex. */
export const PAIRING_CODE_BYTES = 3
/** Resulting code length in characters (two hex digits per byte). */
export const PAIRING_CODE_LENGTH = PAIRING_CODE_BYTES * 2

/** Generate a fresh, cryptographically-random pairing code. */
export function generatePairingCode(): string {
  return randomBytes(PAIRING_CODE_BYTES).toString('hex')
}
