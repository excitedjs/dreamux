import { describe, expect, test } from 'vitest'
import { asString, isRecord } from '../src/json'

describe('isRecord', () => {
  test('accepts plain objects and arrays', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([])).toBe(true)
  })

  test('rejects null, undefined, and primitives', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord('s')).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(true)).toBe(false)
  })
})

describe('asString', () => {
  test('returns a string value unchanged', () => {
    expect(asString('hello')).toBe('hello')
    expect(asString('')).toBe('')
  })

  test('returns the empty string for any non-string', () => {
    expect(asString(undefined)).toBe('')
    expect(asString(null)).toBe('')
    expect(asString(42)).toBe('')
    expect(asString({})).toBe('')
    expect(asString(['a'])).toBe('')
  })
})
