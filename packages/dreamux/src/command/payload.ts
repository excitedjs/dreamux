/**
 * Transport-neutral payload readers shared by every Command's `parse`.
 *
 * These were the admin socket's parameter validators. They are not transport
 * code: a Command's input contract is the same whatever adapter carried it, so
 * the readers live beside the registry and every adapter reuses them instead of
 * re-validating a payload it forwards.
 *
 * `parse` is synchronous and touches only the payload. Anything that needs the
 * process — resolving a dispatcher, normalizing skill sources against the
 * filesystem — belongs in `execute`.
 *
 * Only genuinely generic JSON and scalar readers live here. What a repository
 * request, a history query, or a Team status means is domain knowledge, and it
 * is read by the layer that owns it; a reader that has to name one of those
 * belongs there, not in this module.
 */
import type { JsonValue } from '@excitedjs/dreamux-types';

import { ValidationError } from './errors.js';

/** One Command payload in the object form every `parse` reads. */
export type CommandPayload = Record<string, unknown>;

/**
 * Read the invocation payload as an object. An absent payload is the empty
 * object, so a Command with only optional inputs stays callable with no payload
 * at all; anything else is a malformed request rather than a domain failure.
 */
export function commandPayload(payload: JsonValue | undefined): CommandPayload {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('command payload must be an object');
  }
  return payload as CommandPayload;
}

export function mustString(params: CommandPayload, key: string): string {
  if (typeof params[key] !== 'string') {
    throw new ValidationError(`missing or non-string param '${key}'`);
  }
  return params[key] as string;
}

export function mustNonEmptyString(params: CommandPayload, key: string): string {
  const value = mustString(params, key);
  if (value === '') {
    throw new ValidationError(`param '${key}' must be a non-empty string`);
  }
  return value;
}

export function mustNonBlankString(params: CommandPayload, key: string): string {
  const value = mustString(params, key);
  if (value.trim() === '') {
    throw new ValidationError(`param '${key}' must be a non-empty string`);
  }
  return value;
}

export function mustRecord(params: CommandPayload, key: string): Record<string, unknown> {
  const value = params[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`param '${key}' must be an object`);
  }
  return value as Record<string, unknown>;
}

export function optionalString(params: CommandPayload, key: string): string | null {
  const v = params[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    throw new ValidationError(`param '${key}' must be a string`);
  }
  return v;
}

export function optionalNonBlankString(
  params: CommandPayload,
  key: string,
): string | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value.trim() === '') {
    throw new ValidationError(`param '${key}' must be a non-empty string`);
  }
  return value;
}

export function optionalInteger(params: CommandPayload, key: string): number | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    throw new ValidationError(`param '${key}' must be an integer`);
  }
  return value as number;
}

export function optionalStringField(
  params: CommandPayload,
  key: string,
): Record<string, string> {
  const value = optionalString(params, key);
  return value === null ? {} : { [key]: value };
}

export function optionalNullableStringField(
  params: CommandPayload,
  key: string,
): Record<string, string | null> {
  if (!(key in params)) return {};
  const value = params[key];
  if (value === null) return { [key]: null };
  if (typeof value !== 'string') {
    throw new ValidationError(`param '${key}' must be a string or null`);
  }
  return { [key]: value };
}

export function optionalBooleanField(
  params: CommandPayload,
  key: string,
): Record<string, boolean> {
  if (!(key in params)) return {};
  const value = params[key];
  if (typeof value !== 'boolean') {
    throw new ValidationError(`param '${key}' must be a boolean`);
  }
  return { [key]: value };
}

export function optionalRecordField(
  params: CommandPayload,
  key: string,
): Record<string, Record<string, unknown>> {
  if (!(key in params)) return {};
  const value = params[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`param '${key}' must be an object`);
  }
  return { [key]: value as Record<string, unknown> };
}
