/**
 * Shared JSON-shape validation helpers for Dreamux config readers.
 *
 * Any code that reads a config block validates it with these: each provider
 * package's own `config.ts` for its provider's block, and the host's config
 * module and plugin loader for theirs. They are runtime-agnostic — they know
 * only JSON shapes — and every rejection they throw is a {@link RuleViolation}
 * carrying a `dreamux config error in <file>: ...` message, so a host reader
 * that received the value from a caller can tell a refused value from a
 * failure of its own.
 */

import { isPlainObject } from './json-shape.js';
import { RuleViolation } from './rule-violation.js';

export function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function ensureString(v: unknown, key: string, file: string): string {
  if (typeof v !== 'string') {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${key} must be a string (got ${describeType(v)})`,
    );
  }
  return v;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  fallback: string,
  file: string,
  prefix = '',
): string {
  const v = obj[key];
  if (v === undefined) return fallback;
  return ensureString(v, `${prefix}${key}`, file);
}

export function readNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix = '',
): string {
  const value = requireString(obj, key, '', file, prefix);
  if (value.trim() !== '') return value;
  throw new RuleViolation(
    `dreamux config error in ${file}: ${prefix}${key} must be a non-empty string`,
  );
}

export function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix = '',
): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  return ensureString(v, `${prefix}${key}`, file);
}

export function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  file: string,
  prefix = '',
): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  throw new RuleViolation(
    `dreamux config error in ${file}: ${prefix}${key} must be a boolean (got ${describeType(v)})`,
  );
}

export function readStringArray(
  obj: Record<string, unknown>,
  key: string,
  fallback: string[],
  file: string,
  prefix = '',
): string[] {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}${key} must be an array of strings (got ${describeType(v)})`,
    );
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}${key}[${i}] must be a string (got ${describeType(item)})`,
      );
    }
    return item;
  });
}

export function readStringRecord(
  obj: Record<string, unknown>,
  key: string,
  fallback: Record<string, string>,
  file: string,
  prefix = '',
): Record<string, string> {
  const v = obj[key];
  if (v === undefined) return { ...fallback };
  if (!isPlainObject(v)) {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}${key} must be an object of strings (got ${describeType(v)})`,
    );
  }
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(v)) {
    if (typeof entryValue !== 'string') {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}${key}.${entryKey} must be a string (got ${describeType(entryValue)})`,
      );
    }
    out[entryKey] = entryValue;
  }
  return out;
}

function readInt(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix: string,
): number | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  throw new RuleViolation(
    `dreamux config error in ${file}: ${prefix}${key} must be an integer (got ${describeType(v)})`,
  );
}

export function readPositiveInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  file: string,
  prefix = '',
): number {
  const n = readInt(obj, key, file, prefix);
  if (n === null) return fallback;
  if (n <= 0) {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}${key} must be > 0 (got ${n})`,
    );
  }
  return n;
}

export function readProviderConfigObject(
  rawConfig: unknown,
  file: string,
  name: string,
  options: { allowMissing?: boolean } = {},
): Record<string, unknown> {
  if (rawConfig === undefined && options.allowMissing === true) return {};
  if (!isPlainObject(rawConfig)) {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${name} must be an object (got ${describeType(rawConfig)})`,
    );
  }
  return rawConfig;
}
