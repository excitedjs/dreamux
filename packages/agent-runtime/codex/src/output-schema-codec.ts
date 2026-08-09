import { createHash } from 'node:crypto';

import { unsupportedFeatureError } from '@excitedjs/dreamux-utils';

type SupportedType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

type JsonPrimitive = null | boolean | number | string;

type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

type RestorationPlan =
  | { kind: 'value' }
  | {
      kind: 'array';
      acceptsNull: boolean;
      items: RestorationPlan;
    }
  | {
      kind: 'object';
      acceptsNull: boolean;
      properties: Record<
        string,
        { omitNull: boolean; plan: RestorationPlan }
      >;
    };

interface CompiledSchema {
  wireSchema: Record<string, unknown>;
  plan: RestorationPlan;
  acceptsNull: boolean;
}

export interface CodexOutputSchemaCodec {
  wireSchema: Record<string, unknown>;
  fingerprint: string;
  restore(text: string): string;
}

const SUPPORTED_TYPES = new Set<SupportedType>([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

const COMMON_KEYWORDS = new Set(['type', 'description', 'enum']);
const OBJECT_KEYWORDS = new Set([
  ...COMMON_KEYWORDS,
  'properties',
  'required',
  'additionalProperties',
]);
const ARRAY_KEYWORDS = new Set([...COMMON_KEYWORDS, 'items']);
const NUMERIC_KEYWORDS = new Set([
  ...COMMON_KEYWORDS,
  'minimum',
  'maximum',
]);

export function compileCodexOutputSchema(
  schema: Record<string, unknown>,
): CodexOutputSchemaCodec {
  const root = schemaRecord(schema, '$');
  const rootType = schemaType(root['type'], '$.type');
  if (rootType.type !== 'object' || rootType.nullable) {
    fail('$.type', 'root schema must have type "object"');
  }
  const compiled = compileSchema(schema, '$', false);
  const fingerprint = createHash('sha256')
    .update(canonicalJson({
      wireSchema: compiled.wireSchema as JsonValue,
      restorationPlan: compiled.plan as unknown as JsonValue,
    }))
    .digest('hex');
  return {
    wireSchema: compiled.wireSchema,
    fingerprint,
    restore(text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        throw new Error(
          `codex outputSchema restoration at $: invalid JSON: ${errorMessage(error)}`,
        );
      }
      return JSON.stringify(restoreValue(parsed, compiled.plan, '$'));
    },
  };
}

function compileSchema(
  value: unknown,
  path: string,
  optional: boolean,
): CompiledSchema {
  const schema = schemaRecord(value, path);
  const { type, nullable } = schemaType(schema['type'], `${path}.type`);
  const enumValues = schemaEnum(schema['enum'], `${path}.enum`);
  if (enumValues !== undefined) {
    validateEnumTypes(enumValues, type, nullable, `${path}.enum`);
  }
  const acceptsNull = type === 'null' ||
    (nullable && (enumValues === undefined || enumValues.includes(null)));
  if (optional && acceptsNull) {
    fail(path, 'optional property already accepts null');
  }

  const allowed = type === 'object'
    ? OBJECT_KEYWORDS
    : type === 'array'
      ? ARRAY_KEYWORDS
      : type === 'number' || type === 'integer'
        ? NUMERIC_KEYWORDS
        : COMMON_KEYWORDS;
  rejectUnknownKeywords(schema, allowed, path);

  const wireSchema: Record<string, unknown> = {
    type: type === 'null'
      ? type
      : optional || nullable
        ? [type, 'null']
        : type,
  };
  if (schema['description'] !== undefined) {
    if (typeof schema['description'] !== 'string') {
      fail(`${path}.description`, 'description must be a string');
    }
    wireSchema['description'] = schema['description'];
  }
  if (enumValues !== undefined) {
    const wireEnum = optional && !enumValues.includes(null)
      ? [...enumValues, null]
      : enumValues;
    wireSchema['enum'] = canonicalEnum(wireEnum);
  }

  if (type === 'object') {
    return compileObject(schema, path, wireSchema, acceptsNull);
  }
  if (type === 'array') {
    return compileArray(schema, path, wireSchema, acceptsNull);
  }
  if (type === 'number' || type === 'integer') {
    compileNumericBounds(schema, path, wireSchema);
  }
  return { wireSchema, plan: { kind: 'value' }, acceptsNull };
}

function compileObject(
  schema: Record<string, unknown>,
  path: string,
  wireSchema: Record<string, unknown>,
  acceptsNull: boolean,
): CompiledSchema {
  if (schema['additionalProperties'] !== false) {
    fail(
      `${path}.additionalProperties`,
      'object schemas must set additionalProperties to false',
    );
  }
  const properties = schemaRecord(schema['properties'], `${path}.properties`);
  const required = requiredProperties(
    schema['required'],
    properties,
    `${path}.required`,
  );
  const propertyEntries: Array<[string, Record<string, unknown>]> = [];
  const planEntries: Array<
    [string, { omitNull: boolean; plan: RestorationPlan }]
  > = [];
  const names = Object.keys(properties).sort();
  for (const name of names) {
    const propertyPath = schemaPropertyPath(path, name);
    const optional = !required.has(name);
    const compiled = compileSchema(properties[name], propertyPath, optional);
    propertyEntries.push([name, compiled.wireSchema]);
    planEntries.push([
      name,
      { omitNull: optional && !compiled.acceptsNull, plan: compiled.plan },
    ]);
  }
  wireSchema['properties'] = Object.fromEntries(propertyEntries);
  wireSchema['required'] = names;
  wireSchema['additionalProperties'] = false;
  return {
    wireSchema,
    plan: {
      kind: 'object',
      acceptsNull,
      properties: Object.fromEntries(planEntries),
    },
    acceptsNull,
  };
}

function compileArray(
  schema: Record<string, unknown>,
  path: string,
  wireSchema: Record<string, unknown>,
  acceptsNull: boolean,
): CompiledSchema {
  if (Array.isArray(schema['items'])) {
    fail(`${path}.items`, 'tuple arrays are not supported');
  }
  if (schema['items'] === undefined) {
    fail(`${path}.items`, 'array schemas require one items schema');
  }
  const items = compileSchema(schema['items'], `${path}.items`, false);
  wireSchema['items'] = items.wireSchema;
  return {
    wireSchema,
    plan: { kind: 'array', acceptsNull, items: items.plan },
    acceptsNull,
  };
}

function compileNumericBounds(
  schema: Record<string, unknown>,
  path: string,
  wireSchema: Record<string, unknown>,
): void {
  for (const keyword of ['minimum', 'maximum'] as const) {
    const value = schema[keyword];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${path}.${keyword}`, `${keyword} must be a finite number`);
    }
    wireSchema[keyword] = value;
  }
  if (
    typeof wireSchema['minimum'] === 'number' &&
    typeof wireSchema['maximum'] === 'number' &&
    wireSchema['minimum'] > wireSchema['maximum']
  ) {
    fail(path, 'minimum must not exceed maximum');
  }
}

function schemaType(
  value: unknown,
  path: string,
): { type: SupportedType; nullable: boolean } {
  if (typeof value === 'string') {
    if (!SUPPORTED_TYPES.has(value as SupportedType)) {
      fail(path, `unsupported type ${JSON.stringify(value)}`);
    }
    return { type: value as SupportedType, nullable: value === 'null' };
  }
  if (!Array.isArray(value)) {
    fail(path, 'type must be one supported type or [T, "null"]');
  }
  if (
    value.length !== 2 ||
    new Set(value).size !== 2 ||
    !value.includes('null')
  ) {
    fail(path, 'only nullable [T, "null"] unions are supported');
  }
  const nonNull = value.find((entry) => entry !== 'null');
  if (
    typeof nonNull !== 'string' ||
    nonNull === 'null' ||
    !SUPPORTED_TYPES.has(nonNull as SupportedType)
  ) {
    fail(path, 'only nullable [T, "null"] unions are supported');
  }
  return { type: nonNull as SupportedType, nullable: true };
}

function schemaEnum(value: unknown, path: string): JsonPrimitive[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'enum must be a non-empty array of primitive JSON values');
  }
  const values = value.map((entry, index) => {
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'boolean'
    ) return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    fail(`${path}[${index}]`, 'enum entries must be primitive JSON values');
  });
  const canonical = values.map(canonicalJson);
  if (new Set(canonical).size !== values.length) {
    fail(path, 'enum values must be unique');
  }
  return values;
}

function validateEnumTypes(
  values: JsonPrimitive[],
  type: SupportedType,
  nullable: boolean,
  path: string,
): void {
  if (type === 'object' || type === 'array') {
    fail(path, 'enum is supported only on primitive schemas');
  }
  for (const [index, value] of values.entries()) {
    if (value === null && nullable) continue;
    const valid = type === 'null'
      ? value === null
      : type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : typeof value === type;
    if (!valid) {
      fail(
        `${path}[${index}]`,
        `enum value does not match declared type ${JSON.stringify(type)}`,
      );
    }
  }
}

function requiredProperties(
  value: unknown,
  properties: Record<string, unknown>,
  path: string,
): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) fail(path, 'required must be an array of strings');
  const required = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      fail(`${path}[${index}]`, 'required entries must be strings');
    }
    if (!Object.hasOwn(properties, entry)) {
      fail(`${path}[${index}]`, `unknown required property ${JSON.stringify(entry)}`);
    }
    if (required.has(entry)) {
      fail(`${path}[${index}]`, `duplicate required property ${JSON.stringify(entry)}`);
    }
    required.add(entry);
  }
  return required;
}

function rejectUnknownKeywords(
  schema: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const keyword of Object.keys(schema)) {
    if (!allowed.has(keyword)) {
      fail(`${path}.${keyword}`, `unsupported keyword ${JSON.stringify(keyword)}`);
    }
  }
}

function restoreValue(
  value: unknown,
  plan: RestorationPlan,
  path: string,
): unknown {
  if (plan.kind === 'value') return value;
  if (value === null && plan.acceptsNull) return null;
  if (plan.kind === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`codex outputSchema restoration at ${path}: expected array`);
    }
    return value.map((entry, index) =>
      restoreValue(entry, plan.items, `${path}[${index}]`));
  }
  if (!isRecord(value)) {
    throw new Error(`codex outputSchema restoration at ${path}: expected object`);
  }
  const restored = { ...value };
  for (const [name, property] of Object.entries(plan.properties)) {
    if (!Object.hasOwn(restored, name)) continue;
    if (property.omitNull && restored[name] === null) {
      delete restored[name];
      continue;
    }
    restored[name] = restoreValue(
      restored[name],
      property.plan,
      valuePropertyPath(path, name),
    );
  }
  return restored;
}

function canonicalEnum(values: JsonPrimitive[]): JsonPrimitive[] {
  return [...values].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function schemaRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'schema must be a plain object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function schemaPropertyPath(path: string, name: string): string {
  return `${path}.properties${pathSegment(name)}`;
}

function valuePropertyPath(path: string, name: string): string {
  return `${path}${pathSegment(name)}`;
}

function pathSegment(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `.${name}`
    : `[${JSON.stringify(name)}]`;
}

function fail(path: string, reason: string): never {
  throw unsupportedFeatureError(
    'outputSchema',
    `codex outputSchema at ${path}: ${reason}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
