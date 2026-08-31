/**
 * Fail-loud validation of one MCP tool catalog.
 *
 * Every Agent-facing catalog now crosses a process boundary as plain JSON: a
 * delegate in the server describes its tools, and the stdio shim registers what
 * it is handed. That makes catalog validation a property of the transport, not
 * of any one domain — so it lives here, in front of the official SDK, and both
 * sides of that boundary use it.
 *
 * The authoritative run is in the server, when Core freezes a generation's
 * catalog: it happens before the runtime that would advertise the catalog is
 * constructed, so a malformed one fails a launch loudly, in the process that
 * can name the delegate that produced it. It runs on Core's own canonical copy
 * of the delegate's answer, never on the delegate's live objects, so what was
 * proven is what gets stored. The shim runs the same rules again on what it
 * received, because bytes off a socket are not the object Core validated.
 *
 * The rules are deliberately structural. This module never learns a tool name,
 * reads a description, or interprets a schema: it proves that the descriptor
 * list is a non-empty array of plain, JSON-representable objects with unique
 * names, that each schema compiles through the same SDK adapter registration
 * uses, and that annotations and icons carry only the keys MCP defines.
 */
import {
  validateMcpJsonSchema,
  type McpToolMetadata,
} from './server.js';

/**
 * A tool descriptor after validation. `inputSchema`/`outputSchema` stay opaque
 * JSON Schema objects — proven well-formed, never interpreted.
 */
export interface ValidatedMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolMetadata['annotations'];
  icons?: McpToolMetadata['icons'];
}

const ALLOWED_TOOL_KEYS = new Set([
  'name',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'annotations',
  'icons',
]);

const ALLOWED_ANNOTATION_KEYS = new Set([
  'title',
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
]);

const ALLOWED_ICON_KEYS = new Set(['src', 'mimeType', 'sizes', 'theme']);

/**
 * Validate one catalog, or throw. `label` names the catalog in every message so
 * an operator reading a failed shim start knows which server produced it.
 *
 * An empty catalog is a failure, not an empty server: a delegate with nothing
 * to advertise is dropped before it is ever minted a token, so an empty list
 * reaching this point means something after that decision lost its tools.
 */
export function validateMcpToolCatalog(
  tools: readonly unknown[],
  label: string,
): ValidatedMcpTool[] {
  if (!Array.isArray(tools)) {
    throw new Error(`${label} must be an array`);
  }
  if (tools.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  assertJsonCompatible(tools, label, new Set<object>());
  const seen = new Set<string>();
  return tools.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} descriptor at index ${index} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_TOOL_KEYS.has(key)) {
        throw new Error(
          `${label} descriptor at index ${index} has unknown property '${key}'`,
        );
      }
    }
    const name = obj['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(
        `${label} descriptor at index ${index} must have a non-empty name`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`${label} descriptor name '${name}' is duplicated`);
    }
    seen.add(name);
    const inputSchema = requireSchemaObject(obj['inputSchema'], `${name}.inputSchema`);
    const outputSchema =
      obj['outputSchema'] === undefined
        ? undefined
        : requireSchemaObject(obj['outputSchema'], `${name}.outputSchema`);
    const annotations = validateAnnotations(obj['annotations'], name);
    const icons = validateIcons(obj['icons'], name);
    const description = obj['description'];
    const title = obj['title'];
    if (title !== undefined && (typeof title !== 'string' || title === '')) {
      throw new Error(`${name}.title must be a non-empty string when present`);
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new Error(`${name}.description must be a string when present`);
    }
    return {
      name,
      title: title ?? name,
      description: description ?? name,
      inputSchema,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
      ...(icons !== undefined ? { icons } : {}),
    };
  });
}

function requireSchemaObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON Schema object`);
  }
  const schema = value as Record<string, unknown>;
  validateMcpJsonSchema(schema, label);
  return schema;
}

function validateAnnotations(
  value: unknown,
  name: string,
): McpToolMetadata['annotations'] {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name}.annotations must be an object`);
  }
  const annotations = value as Record<string, unknown>;
  for (const [key, annotation] of Object.entries(annotations)) {
    if (!ALLOWED_ANNOTATION_KEYS.has(key)) {
      throw new Error(`${name}.annotations has unknown property '${key}'`);
    }
    if (key === 'title') {
      if (typeof annotation !== 'string' || annotation === '') {
        throw new Error(`${name}.annotations.title must be a non-empty string`);
      }
    } else if (typeof annotation !== 'boolean') {
      throw new Error(`${name}.annotations.${key} must be a boolean`);
    }
  }
  return annotations as McpToolMetadata['annotations'];
}

function validateIcons(value: unknown, name: string): McpToolMetadata['icons'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${name}.icons must be an array`);
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${name}.icons[${index}] must be an object`);
    }
    const icon = entry as Record<string, unknown>;
    for (const key of Object.keys(icon)) {
      if (!ALLOWED_ICON_KEYS.has(key)) {
        throw new Error(`${name}.icons[${index}] has unknown property '${key}'`);
      }
    }
    if (typeof icon['src'] !== 'string' || icon['src'] === '') {
      throw new Error(`${name}.icons[${index}].src must be a non-empty string`);
    }
    if (
      icon['mimeType'] !== undefined &&
      (typeof icon['mimeType'] !== 'string' || icon['mimeType'] === '')
    ) {
      throw new Error(
        `${name}.icons[${index}].mimeType must be a non-empty string`,
      );
    }
    if (
      icon['sizes'] !== undefined &&
      (!Array.isArray(icon['sizes']) ||
        icon['sizes'].some((size) => typeof size !== 'string' || size === ''))
    ) {
      throw new Error(
        `${name}.icons[${index}].sizes must be an array of non-empty strings`,
      );
    }
    if (
      icon['theme'] !== undefined &&
      icon['theme'] !== 'light' &&
      icon['theme'] !== 'dark'
    ) {
      throw new Error(`${name}.icons[${index}].theme must be 'light' or 'dark'`);
    }
    return icon as NonNullable<McpToolMetadata['icons']>[number];
  });
}

/**
 * Prove a value survives a JSON round trip unchanged. A catalog that arrived
 * over the wire already did, but the delegate side builds one in memory, and a
 * `undefined`, function, `NaN`, cycle, or class instance in it would either be
 * dropped on serialization or throw at an unhelpful place.
 */
function assertJsonCompatible(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} contains a non-JSON ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} contains a circular reference`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== Array.prototype &&
    prototype !== null
  ) {
    throw new Error(`${path} contains a non-plain object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonCompatible(entry, `${path}[${index}]`, ancestors),
    );
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonCompatible(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}
