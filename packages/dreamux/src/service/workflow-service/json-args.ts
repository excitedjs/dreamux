/** Validate one explicitly supplied Workflow args value as recursive JSON. */
export function validateWorkflowArgs(value: unknown): void {
  validateJsonValue(value, '$', new Set());
}

function validateJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(path, 'numbers must be finite');
    }
    return;
  }
  if (typeof value !== 'object') {
    fail(path, `unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) fail(path, 'cycles are not supported');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      validateJsonArray(value, path, ancestors);
      return;
    }
    if (!isPlainObject(value)) {
      fail(path, 'objects must have Object.prototype or null prototype');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        fail(path, 'object keys must be strings');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        fail(propertyPath(path, key), 'properties must be enumerable data values');
      }
      validateJsonValue(
        descriptor.value,
        propertyPath(path, key),
        ancestors,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateJsonArray(
  value: unknown[],
  path: string,
  ancestors: Set<object>,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.at(-1) !== 'length' ||
    keys.slice(0, -1).some((key, index) => key !== String(index))
  ) {
    fail(path, 'arrays must be dense and contain only indexed JSON values');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      fail(`${path}[${index}]`, 'array entries must be enumerable data values');
    }
    validateJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function fail(path: string, reason: string): never {
  throw new Error(`workflow args at ${path}: ${reason}`);
}
