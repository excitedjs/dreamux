import { describe, expect, test } from 'vitest'
import { generatePairingCode, PAIRING_CODE_LENGTH } from '../src/policy/pairing'

describe('pairing', () => {
  test('generated codes have the expected length', () => {
    expect(generatePairingCode()).toHaveLength(PAIRING_CODE_LENGTH)
  })

  test('every generated code is lowercase hex of the fixed length', () => {
    // The claudemux original drives this with fast-check; core avoids the extra
    // dev dependency and runs the same assertion over a fixed sample instead.
    for (let i = 0; i < 1000; i++) {
      expect(generatePairingCode()).toMatch(/^[0-9a-f]{6}$/)
    }
  })

  test('generated codes vary — randomBytes is actually exercised', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePairingCode()))
    expect(codes.size).toBeGreaterThan(1)
  })
})
