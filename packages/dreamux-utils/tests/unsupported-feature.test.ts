/**
 * The unsupported-feature failure shape (unsupported-feature.ts): a runtime
 * signals "I understood the ask, but cannot serve this feature" via a
 * structurally-typed Error rather than a shared class, so it crosses a
 * package edge without both sides importing the same constructor.
 */
import { describe, it, expect } from 'vitest';

import { unsupportedFeatureError, isUnsupportedFeatureError } from '../src/unsupported-feature.js';

describe('unsupportedFeatureError', () => {
  it('produces a real Error carrying the discriminant name and feature', () => {
    const error = unsupportedFeatureError('resume', 'runtime cannot resume');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnsupportedAgentRuntimeFeatureError');
    expect(error.feature).toBe('resume');
    expect(error.message).toBe('runtime cannot resume');
  });
});

describe('isUnsupportedFeatureError', () => {
  it('recognizes an error produced by the constructor', () => {
    const error = unsupportedFeatureError('resume', 'cannot resume');
    expect(isUnsupportedFeatureError(error)).toBe(true);
  });

  it('narrows to a specific feature when one is given', () => {
    const error = unsupportedFeatureError('resume', 'cannot resume');
    expect(isUnsupportedFeatureError(error, 'resume')).toBe(true);
    expect(isUnsupportedFeatureError(error, 'pause')).toBe(false);
  });

  it('rejects a plain Error without the marker shape', () => {
    expect(isUnsupportedFeatureError(new Error('boom'))).toBe(false);
  });

  it('rejects a structurally-similar object crossing a duck-typed edge, purely on shape', () => {
    // The predicate is structural (no instanceof / shared class), so a
    // hand-built object with the right shape from a different package must
    // still be recognized — that IS the contract of a cross-package marker.
    const lookalike = { name: 'UnsupportedAgentRuntimeFeatureError', feature: 'resume' };
    expect(isUnsupportedFeatureError(lookalike)).toBe(true);
  });

  it('rejects an object with the right name but a non-string feature', () => {
    const malformed = { name: 'UnsupportedAgentRuntimeFeatureError', feature: 42 };
    expect(isUnsupportedFeatureError(malformed)).toBe(false);
  });

  it('rejects non-object values, including null and undefined', () => {
    expect(isUnsupportedFeatureError(null)).toBe(false);
    expect(isUnsupportedFeatureError(undefined)).toBe(false);
    expect(isUnsupportedFeatureError('not an error')).toBe(false);
    expect(isUnsupportedFeatureError(42)).toBe(false);
  });
});
