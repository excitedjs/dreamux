/**
 * Small builders for the declared `input`/`output` schema of a Command.
 *
 * The schema is the Command's enforced shape, not documentation: the registry
 * validates every payload against `input` before `parse` and every canonical
 * result against `output` after `execute` (see `validate.ts`). `parse` then
 * narrows the validated payload into the domain's own input type. Builders and
 * Commands live behind the same registry, so no adapter can hold a second copy.
 *
 * The shape a schema enforces is exactly the shape it declares. An input is
 * closed all the way down, because every key of it is caller-supplied. A result
 * is closed at the level the Command owns, while the rich domain DTOs nested
 * inside it are declared {@link OBJECT} on purpose: their fields belong to the
 * services that evolve them, and mirroring those fields here would be the
 * second copy this layer exists to avoid. What still holds for every byte of a
 * result is Core's JSON canonicalization in the registry.
 */
import type { JsonSchema, JsonValue } from '@excitedjs/dreamux-types';

export const STRING: JsonSchema = { type: 'string' };
export const NON_EMPTY_STRING: JsonSchema = { type: 'string', minLength: 1 };
export const NULLABLE_STRING: JsonSchema = { type: ['string', 'null'] };
export const INTEGER: JsonSchema = { type: 'integer' };
export const BOOLEAN: JsonSchema = { type: 'boolean' };
export const NULL: JsonSchema = { type: 'null' };
/** A rich, evolving domain DTO validated only as "an object". */
export const OBJECT: JsonSchema = { type: 'object' };
export const NULLABLE_OBJECT: JsonSchema = { type: ['object', 'null'] };
export const ANY: JsonSchema = {};

/** A string with an explicit, justified upper bound on an untrusted value. */
export function boundedString(maxLength: number, minLength = 0): JsonSchema {
  return minLength > 0
    ? { type: 'string', minLength, maxLength }
    : { type: 'string', maxLength };
}

export function arrayOf(items: JsonSchema): JsonSchema {
  return { type: 'array', items };
}

export function enumOf(values: readonly string[]): JsonSchema {
  return { type: 'string', enum: values as readonly JsonValue[] };
}

/**
 * A closed object schema: an undeclared key is rejected, not silently dropped.
 * On an input that makes an unknown parameter a loud caller mistake; on a
 * result it makes an undeclared field a loud Core defect.
 */
export function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: required as readonly JsonValue[],
  };
}

/** The empty payload of a Command that takes no input. */
export const NO_INPUT: JsonSchema = objectSchema({});
