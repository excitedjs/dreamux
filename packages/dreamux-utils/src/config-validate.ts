/**
 * Neutral config validation primitives.
 *
 * Extracted from `config/config.ts` so that per-runtime config readers (each
 * builtin's `agent-runtime/builtin/<name>/config.ts`) can validate their own
 * config blocks without importing `config/config.ts` — importing the host
 * config module from a builtin would re-form the builtin -> config import
 * cycle. These helpers are runtime-agnostic: they only know about JSON shapes
 * and produce `dreamux config error in <file>: ...` messages.
 */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  file: string,
  prefix: string,
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    const name = `${prefix}${key}`;
    if (/^dispatchers\[\d+\]\.$/.test(prefix) && (key === 'feishu' || key === 'codex')) {
      throw new Error(
        `dreamux config error in ${file}: ${name} is not supported by the providerized config v2 schema.\n` +
          'Dreamux 0.x does not silently migrate operator-owned config. Rebuild this dispatcher with ' +
          'dispatchers[].channels[] for the channel and a named agents[] entry referenced via ' +
          'dispatchers[].agentRuntime for the runtime, then restart.',
      );
    }
    throw new Error(
      `dreamux config error in ${file}: ${name} is not supported by the providerized config v2 schema`,
    );
  }
}

function ensureString(v: unknown, key: string, file: string): string {
  if (typeof v !== 'string') {
    throw new Error(
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

export function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix = '',
): string {
  const value = requireString(obj, key, '', file, prefix);
  if (value.trim() !== '') return value;
  throw new Error(
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
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be a boolean (got ${describeType(v)})`,
  );
}

export function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  fallback: string[],
  file: string,
  prefix = '',
): string[] {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be an array of strings (got ${describeType(v)})`,
    );
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}${key}[${i}] must be a string (got ${describeType(item)})`,
      );
    }
    return item;
  });
}

export function requireStringRecord(
  obj: Record<string, unknown>,
  key: string,
  fallback: Record<string, string>,
  file: string,
  prefix = '',
): Record<string, string> {
  const v = obj[key];
  if (v === undefined) return { ...fallback };
  if (!isPlainObject(v)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be an object of strings (got ${describeType(v)})`,
    );
  }
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(v)) {
    if (typeof entryValue !== 'string') {
      throw new Error(
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
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be an integer (got ${describeType(v)})`,
  );
}

export function requirePositiveInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  file: string,
  prefix = '',
): number {
  const n = readInt(obj, key, file, prefix);
  if (n === null) return fallback;
  if (n <= 0) {
    throw new Error(
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
    throw new Error(
      `dreamux config error in ${file}: ${name} must be an object (got ${describeType(rawConfig)})`,
    );
  }
  return rawConfig;
}
