/**
 * Small shared JSON-schema and argument validators for Feishu tools.
 *
 * A rejected argument is something the model can fix on its next attempt, so
 * every validator here raises the public failure marker: the sentence it wrote
 * is what the model reads. That is the whole reason this is not a plain
 * `Error` — a plain one would be an unexplained tool failure, and a model
 * cannot correct what it is not told.
 */
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';

export function closedObjectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

export const nonEmptyString = { type: 'string', minLength: 1 } as const;

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicInvokeFailure(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
): string {
  const value = obj[key];
  if (typeof value !== 'string' || value === '') {
    throw new PublicInvokeFailure(`${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const value = obj[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new PublicInvokeFailure(`${key} must be a string`);
  }
  return value;
}

export function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
): string[] | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PublicInvokeFailure(`${key} must be an array of strings`);
  }
  return value as string[];
}

export function optionalRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  return asRecord(value, key);
}
