import { isPlainObject } from '../src/json-shape.js';
/**
 * Neutral config-validation primitives (config-validate.ts).
 *
 * These helpers are the ONLY place `dreamux config error in <file>: ...`
 * messages get formed for the providerized config v2 schema. The exact wording
 * is the contract other packages string-match or surface verbatim to the
 * operator, so assertions check exact messages, not just "it throws".
 */
import { describe, it, expect } from 'vitest';

import {
  describeType,
  readNonEmptyString,
  readOptionalString,
  readOptionalBoolean,
  readStringArray,
  readStringRecord,
  readPositiveInt,
  readProviderConfigObject,
} from '../src/config-validate.js';

describe('isPlainObject', () => {
  it('accepts a plain object literal', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('rejects null, arrays, and primitives', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe('describeType', () => {
  it('names null explicitly rather than reporting "object"', () => {
    expect(describeType(null)).toBe('null');
  });

  it('names arrays explicitly rather than reporting "object"', () => {
    expect(describeType([1, 2])).toBe('array');
  });

  it('falls back to typeof for everything else', () => {
    expect(describeType('x')).toBe('string');
    expect(describeType(1)).toBe('number');
    expect(describeType(true)).toBe('boolean');
    expect(describeType({})).toBe('object');
    expect(describeType(undefined)).toBe('undefined');
  });
});

describe('readNonEmptyString', () => {
  it('returns the value when present and non-blank', () => {
    expect(readNonEmptyString({ name: 'alice' }, 'name', 'f.json')).toBe(
      'alice',
    );
  });

  it('rejects a missing key with the "must be a non-empty string" message', () => {
    expect(() => readNonEmptyString({}, 'name', 'f.json')).toThrowError(
      'dreamux config error in f.json: name must be a non-empty string',
    );
  });

  it('rejects a whitespace-only value the same as missing', () => {
    expect(() =>
      readNonEmptyString({ name: '   ' }, 'name', 'f.json'),
    ).toThrowError(
      'dreamux config error in f.json: name must be a non-empty string',
    );
  });

  it('rejects a non-string value with the type it actually got', () => {
    expect(() =>
      readNonEmptyString({ name: 42 }, 'name', 'f.json'),
    ).toThrowError(
      'dreamux config error in f.json: name must be a string (got number)',
    );
  });

  it('honors the prefix when naming the offending field', () => {
    expect(() =>
      readNonEmptyString({}, 'name', 'f.json', 'agents[0].'),
    ).toThrowError(
      'dreamux config error in f.json: agents[0].name must be a non-empty string',
    );
  });
});

describe('readOptionalString', () => {
  it('returns null for both undefined and null (both count as "absent")', () => {
    expect(readOptionalString({}, 'k', 'f.json')).toBeNull();
    expect(readOptionalString({ k: null }, 'k', 'f.json')).toBeNull();
  });

  it('returns the string when present, even if empty', () => {
    expect(readOptionalString({ k: '' }, 'k', 'f.json')).toBe('');
    expect(readOptionalString({ k: 'v' }, 'k', 'f.json')).toBe('v');
  });

  it('rejects a non-string, non-null value', () => {
    expect(() => readOptionalString({ k: 5 }, 'k', 'f.json')).toThrowError(
      'dreamux config error in f.json: k must be a string (got number)',
    );
  });
});

describe('readOptionalBoolean', () => {
  it('returns the fallback when absent', () => {
    expect(readOptionalBoolean({}, 'k', true, 'f.json')).toBe(true);
    expect(readOptionalBoolean({}, 'k', false, 'f.json')).toBe(false);
  });

  it('returns the explicit boolean when present', () => {
    expect(readOptionalBoolean({ k: true }, 'k', false, 'f.json')).toBe(true);
    expect(readOptionalBoolean({ k: false }, 'k', true, 'f.json')).toBe(false);
  });

  it('rejects a non-boolean value loudly instead of coercing it', () => {
    // "silently coerced" is explicitly the failure mode the repo rule forbids:
    // the string "true" must NOT become boolean true.
    expect(() =>
      readOptionalBoolean({ k: 'true' }, 'k', false, 'f.json'),
    ).toThrowError(
      'dreamux config error in f.json: k must be a boolean (got string)',
    );
  });
});

describe('readStringArray', () => {
  it('returns the fallback when absent', () => {
    expect(readStringArray({}, 'k', ['a'], 'f.json')).toEqual(['a']);
  });

  it('returns a copy of the array when every element is a string', () => {
    expect(readStringArray({ k: ['a', 'b'] }, 'k', [], 'f.json')).toEqual([
      'a',
      'b',
    ]);
  });

  it('rejects a non-array value', () => {
    expect(() =>
      readStringArray({ k: 'nope' }, 'k', [], 'f.json'),
    ).toThrowError(
      'dreamux config error in f.json: k must be an array of strings (got string)',
    );
  });

  it('rejects a non-string element and names its index', () => {
    expect(() =>
      readStringArray({ k: ['a', 2] }, 'k', [], 'f.json'),
    ).toThrowError(
      'dreamux config error in f.json: k[1] must be a string (got number)',
    );
  });
});

describe('readStringRecord', () => {
  it('returns a shallow copy of the fallback when absent', () => {
    const fallback = { a: '1' };
    const result = readStringRecord({}, 'k', fallback, 'f.json');
    expect(result).toEqual({ a: '1' });
    expect(result).not.toBe(fallback);
  });

  it('returns the object when every value is a string', () => {
    expect(readStringRecord({ k: { x: 'y' } }, 'k', {}, 'f.json')).toEqual({
      x: 'y',
    });
  });

  it('rejects a non-object value (including arrays)', () => {
    expect(() =>
      readStringRecord({ k: ['a'] }, 'k', {}, 'f.json'),
    ).toThrowError(
      'dreamux config error in f.json: k must be an object of strings (got array)',
    );
  });

  it('rejects a non-string entry value and names the dotted key', () => {
    expect(() =>
      readStringRecord({ k: { x: 5 } }, 'k', {}, 'f.json'),
    ).toThrowError(
      'dreamux config error in f.json: k.x must be a string (got number)',
    );
  });
});

describe('readPositiveInt', () => {
  it('returns the fallback when absent', () => {
    expect(readPositiveInt({}, 'k', 7, 'f.json')).toBe(7);
  });

  it('accepts a positive integer', () => {
    expect(readPositiveInt({ k: 3 }, 'k', 7, 'f.json')).toBe(3);
  });

  it('rejects a non-integer number', () => {
    expect(() => readPositiveInt({ k: 1.5 }, 'k', 7, 'f.json')).toThrowError(
      'dreamux config error in f.json: k must be an integer (got number)',
    );
  });

  it('rejects a non-number value', () => {
    expect(() => readPositiveInt({ k: '3' }, 'k', 7, 'f.json')).toThrowError(
      'dreamux config error in f.json: k must be an integer (got string)',
    );
  });

  it('rejects zero and negative integers with the ">0" message', () => {
    expect(() => readPositiveInt({ k: 0 }, 'k', 7, 'f.json')).toThrowError(
      'dreamux config error in f.json: k must be > 0 (got 0)',
    );
    expect(() => readPositiveInt({ k: -1 }, 'k', 7, 'f.json')).toThrowError(
      'dreamux config error in f.json: k must be > 0 (got -1)',
    );
  });
});

describe('readProviderConfigObject', () => {
  it('returns the raw object unchanged when it is a plain object', () => {
    const raw = { a: 1 };
    expect(readProviderConfigObject(raw, 'f.json', 'agents[0].codex')).toBe(
      raw,
    );
  });

  it('returns {} for an undefined block when allowMissing is set', () => {
    expect(
      readProviderConfigObject(undefined, 'f.json', 'agents[0].codex', {
        allowMissing: true,
      }),
    ).toEqual({});
  });

  it('rejects an undefined block when allowMissing is not set', () => {
    expect(() =>
      readProviderConfigObject(undefined, 'f.json', 'agents[0].codex'),
    ).toThrowError(
      'dreamux config error in f.json: agents[0].codex must be an object (got undefined)',
    );
  });

  it('rejects a non-object block (array, string, number) even with allowMissing set', () => {
    // allowMissing only waives the undefined case; a wrong-shaped present value
    // must still fail loud rather than being coerced into {}.
    expect(() =>
      readProviderConfigObject([1, 2], 'f.json', 'agents[0].codex', {
        allowMissing: true,
      }),
    ).toThrowError(
      'dreamux config error in f.json: agents[0].codex must be an object (got array)',
    );
  });
});
