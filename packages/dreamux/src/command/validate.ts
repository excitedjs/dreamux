/**
 * The one validator behind the Core Command registry.
 *
 * A declared `input`/`output` schema is only a contract if something enforces
 * it. This module is that enforcement, and it runs inside the registry so every
 * adapter gets the identical check: an adapter never validates a payload it
 * forwards, and no second copy of a Command's shape exists anywhere.
 *
 * It implements exactly the JSON Schema subset the catalog uses — `type`
 * (single or union), `enum`, `properties`, `required`, `additionalProperties`,
 * `items`, and the `minLength`/`maxLength`/`minimum`/`maximum`/`minItems`/
 * `maxItems` size bounds — and fails loud on a schema keyword it does not
 * implement, so a Command can never silently opt out of validation by writing
 * one.
 *
 * There are two separate jobs here, at two separate times.
 * {@link validateSchemaDefinition} proves a *schema* is well formed, and the
 * registry runs it over every registered definition at composition, so a schema
 * bug fails at server construction rather than on whichever invocation first
 * reaches that branch. {@link validateJsonSchema} then validates one *value*
 * against an already-proven schema on every invocation.
 *
 * What that enforces is a precise, deliberately partial contract, not a fully
 * closed result shape: a Command's own declared object — its keys, its required
 * names, its declared bounds — plus the JSON canonicalization the registry
 * applies to the whole tree. Rich, evolving domain DTOs are declared as open
 * `OBJECT` on purpose, so their interiors are checked for JSON
 * representability, not for a field list this layer would then have to mirror.
 */
import type { JsonSchema, JsonValue } from '@excitedjs/dreamux-types';

import { isPlainObject } from '../platform/json-value.js';

/** The keywords this validator implements. Anything else is a schema bug. */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  // Documentation-only keywords carried for the published contract.
  'description',
  'title',
]);

const TYPE_NAMES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

/** One schema violation, located by its path inside the validated value. */
export class SchemaViolation extends Error {
  constructor(
    /** Dotted path from the validated root, `''` for the root itself. */
    readonly path: string,
    readonly detail: string,
  ) {
    super(path === '' ? detail : `${path}: ${detail}`);
    this.name = 'SchemaViolation';
  }
}

/**
 * Validate `value` against an already well-formed `schema`, throwing
 * {@link SchemaViolation} on the first failure. Callers map the violation onto
 * their own typed error.
 *
 * The schema's own shape is proven once by {@link validateSchemaDefinition} at
 * composition; the schema-shape guards below are unreachable defense in depth.
 */
export function validateJsonSchema(value: unknown, schema: JsonSchema): void {
  check(value, schema, '');
}

function check(value: unknown, schema: JsonSchema, path: string): void {
  for (const name of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(name)) {
      throw new SchemaViolation(path, `schema uses unsupported keyword '${name}'`);
    }
  }
  const types = declaredTypes(schema, path);
  if (types !== null && !types.some((type) => matchesType(value, type))) {
    throw new SchemaViolation(
      path,
      `expected ${types.join(' or ')}, got ${describe(value)}`,
    );
  }
  checkEnum(value, schema, path);
  if (typeof value === 'string') checkString(value, schema, path);
  if (typeof value === 'number') checkNumber(value, schema, path);
  if (Array.isArray(value)) checkArray(value, schema, path);
  else if (isPlainObject(value)) checkObject(value, schema, path);
}

function checkEnum(value: unknown, schema: JsonSchema, path: string): void {
  const allowed = keyword(schema, 'enum');
  if (allowed === undefined) return;
  if (!Array.isArray(allowed)) {
    throw new SchemaViolation(path, 'schema enum must be an array');
  }
  const values = allowed as unknown as readonly JsonValue[];
  if (!values.some((entry) => entry === value)) {
    throw new SchemaViolation(path, `${describe(value)} is not an allowed value`);
  }
}

function checkString(value: string, schema: JsonSchema, path: string): void {
  const min = numericKeyword(schema, 'minLength', path);
  if (min !== null && value.length < min) {
    throw new SchemaViolation(path, `must be at least ${min} characters`);
  }
  const max = numericKeyword(schema, 'maxLength', path);
  if (max !== null && value.length > max) {
    throw new SchemaViolation(path, `must be at most ${max} characters`);
  }
}

function checkNumber(value: number, schema: JsonSchema, path: string): void {
  const min = numericKeyword(schema, 'minimum', path);
  if (min !== null && value < min) {
    throw new SchemaViolation(path, `must be >= ${min}`);
  }
  const max = numericKeyword(schema, 'maximum', path);
  if (max !== null && value > max) {
    throw new SchemaViolation(path, `must be <= ${max}`);
  }
}

function checkArray(
  value: readonly unknown[],
  schema: JsonSchema,
  path: string,
): void {
  const min = numericKeyword(schema, 'minItems', path);
  if (min !== null && value.length < min) {
    throw new SchemaViolation(path, `must hold at least ${min} items`);
  }
  const max = numericKeyword(schema, 'maxItems', path);
  if (max !== null && value.length > max) {
    throw new SchemaViolation(path, `must hold at most ${max} items`);
  }
  const items = keyword(schema, 'items');
  if (items === undefined) return;
  if (!isPlainObject(items)) {
    throw new SchemaViolation(path, 'schema items must be a schema object');
  }
  value.forEach((entry, index) => {
    check(entry, items as unknown as JsonSchema, `${path}[${index}]`);
  });
}

function checkObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
): void {
  const properties = keyword(schema, 'properties');
  if (properties !== undefined && !isPlainObject(properties)) {
    throw new SchemaViolation(path, 'schema properties must be an object');
  }
  const declared = (properties ?? {}) as unknown as Record<string, unknown>;
  const additional = keyword(schema, 'additionalProperties');
  if (additional !== undefined && typeof additional !== 'boolean') {
    throw new SchemaViolation(
      path,
      'schema additionalProperties must be a boolean',
    );
  }
  checkRequired(value, schema, path);
  for (const [name, entry] of Object.entries(value)) {
    // A present-but-`undefined` own property is absent on the wire, because a
    // result is serialized with `JSON.stringify`. Treat it as absent here too.
    if (entry === undefined) continue;
    const child = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (child === undefined) {
      if (additional === false) {
        throw new SchemaViolation(path, `unknown property '${name}'`);
      }
      continue;
    }
    if (!isPlainObject(child)) {
      throw new SchemaViolation(path, `schema for '${name}' must be an object`);
    }
    check(
      entry,
      child as unknown as JsonSchema,
      path === '' ? name : `${path}.${name}`,
    );
  }
}

function checkRequired(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
): void {
  const required = keyword(schema, 'required');
  if (required === undefined) return;
  if (!Array.isArray(required)) {
    throw new SchemaViolation(path, 'schema required must be an array');
  }
  for (const name of required as unknown as readonly JsonValue[]) {
    if (typeof name !== 'string') {
      throw new SchemaViolation(path, 'schema required must hold strings');
    }
    if (!Object.hasOwn(value, name) || value[name] === undefined) {
      throw new SchemaViolation(path, `missing required property '${name}'`);
    }
  }
}

function declaredTypes(schema: JsonSchema, path: string): string[] | null {
  const declared = keyword(schema, 'type');
  if (declared === undefined) return null;
  const names = (
    Array.isArray(declared) ? declared : [declared]
  ) as unknown as readonly JsonValue[];
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !TYPE_NAMES.has(name)) {
      throw new SchemaViolation(
        path,
        `schema declares unknown type ${describe(name)}`,
      );
    }
    out.push(name);
  }
  if (out.length === 0) {
    throw new SchemaViolation(path, 'schema type must name at least one type');
  }
  return out;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

/**
 * Read one schema keyword. A `JsonSchema` is declared as a total index
 * signature, so an absent keyword needs this explicit widening before it can be
 * compared with `undefined`.
 */
function keyword(schema: JsonSchema, name: string): JsonValue | undefined {
  return (schema as unknown as Record<string, JsonValue | undefined>)[name];
}

function numericKeyword(
  schema: JsonSchema,
  name: string,
  path: string,
): number | null {
  const value = keyword(schema, name);
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SchemaViolation(path, `schema ${name} must be a finite number`);
  }
  return value;
}

/**
 * Validate one registered `input`/`output` schema, recursively.
 *
 * The registry runs this over every definition it holds, so an unsupported
 * keyword, a malformed `properties`/`items`/`required`/`type`/`enum`, a
 * `required` name no property declares, or a contradictory numeric bound is a
 * process-start failure — not a surprise on the first invocation that happens
 * to reach that branch. Every branch is visited, including ones no payload in
 * the current catalog exercises.
 */
export function validateSchemaDefinition(schema: JsonSchema, path = ''): void {
  for (const name of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(name)) {
      throw new SchemaViolation(path, `schema uses unsupported keyword '${name}'`);
    }
  }
  declaredTypes(schema, path);
  defineDocumentation(schema, path);
  defineEnum(schema, path);
  defineBounds(schema, path);
  defineObject(schema, path);
  defineArray(schema, path);
}

function defineDocumentation(schema: JsonSchema, path: string): void {
  for (const name of ['description', 'title']) {
    const value = keyword(schema, name);
    if (value !== undefined && typeof value !== 'string') {
      throw new SchemaViolation(path, `schema ${name} must be a string`);
    }
  }
}

function defineEnum(schema: JsonSchema, path: string): void {
  const allowed = keyword(schema, 'enum');
  if (allowed === undefined) return;
  if (!Array.isArray(allowed)) {
    throw new SchemaViolation(path, 'schema enum must be an array');
  }
  if (allowed.length === 0) {
    // An empty enum admits nothing, so the property could never be supplied.
    throw new SchemaViolation(path, 'schema enum must allow at least one value');
  }
}

function defineBounds(schema: JsonSchema, path: string): void {
  const minLength = countKeyword(schema, 'minLength', path);
  const maxLength = countKeyword(schema, 'maxLength', path);
  assertOrderedBounds(minLength, maxLength, 'minLength', 'maxLength', path);
  const minItems = countKeyword(schema, 'minItems', path);
  const maxItems = countKeyword(schema, 'maxItems', path);
  assertOrderedBounds(minItems, maxItems, 'minItems', 'maxItems', path);
  const minimum = numericKeyword(schema, 'minimum', path);
  const maximum = numericKeyword(schema, 'maximum', path);
  assertOrderedBounds(minimum, maximum, 'minimum', 'maximum', path);
}

function defineObject(schema: JsonSchema, path: string): void {
  const additional = keyword(schema, 'additionalProperties');
  if (additional !== undefined && typeof additional !== 'boolean') {
    throw new SchemaViolation(
      path,
      'schema additionalProperties must be a boolean',
    );
  }
  const properties = keyword(schema, 'properties');
  if (properties !== undefined && !isPlainObject(properties)) {
    throw new SchemaViolation(path, 'schema properties must be an object');
  }
  const declared = (properties ?? {}) as unknown as Record<string, unknown>;
  for (const [name, child] of Object.entries(declared)) {
    if (!isPlainObject(child)) {
      throw new SchemaViolation(path, `schema for '${name}' must be an object`);
    }
    validateSchemaDefinition(
      child as unknown as JsonSchema,
      path === '' ? name : `${path}.${name}`,
    );
  }
  const required = keyword(schema, 'required');
  if (required === undefined) return;
  if (!Array.isArray(required)) {
    throw new SchemaViolation(path, 'schema required must be an array');
  }
  for (const name of required as unknown as readonly JsonValue[]) {
    if (typeof name !== 'string') {
      throw new SchemaViolation(path, 'schema required must hold strings');
    }
    // A required name no property declares can never be satisfied under a
    // closed object, and is silently unchecked under an open one.
    if (!Object.hasOwn(declared, name)) {
      throw new SchemaViolation(
        path,
        `schema requires '${name}' but declares no such property`,
      );
    }
  }
}

function defineArray(schema: JsonSchema, path: string): void {
  const items = keyword(schema, 'items');
  if (items === undefined) return;
  if (!isPlainObject(items)) {
    throw new SchemaViolation(path, 'schema items must be a schema object');
  }
  validateSchemaDefinition(items as unknown as JsonSchema, `${path}[]`);
}

/** A size keyword: a count, so a non-negative integer. */
function countKeyword(
  schema: JsonSchema,
  name: string,
  path: string,
): number | null {
  const value = numericKeyword(schema, name, path);
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new SchemaViolation(
      path,
      `schema ${name} must be a non-negative integer`,
    );
  }
  return value;
}

function assertOrderedBounds(
  min: number | null,
  max: number | null,
  minName: string,
  maxName: string,
  path: string,
): void {
  if (min === null || max === null) return;
  if (min > max) {
    throw new SchemaViolation(
      path,
      `schema ${minName} ${min} exceeds ${maxName} ${max}`,
    );
  }
}
