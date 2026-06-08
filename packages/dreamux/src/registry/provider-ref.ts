/**
 * Provider reference parsing for the issue #110 plugin/provider architecture.
 *
 * A provider reference is the public, explicit identifier the operator writes
 * in config to select a Channel or Agent Runtime provider. The grammar is
 * recorded in
 * `.agents/decisions/provider-references-and-capability-registry.md`:
 *
 *   builtin:<id>
 *   npm:<package-spec>
 *   npm:<package-spec>#<export-name>
 *
 * This module owns the string shorthand <-> normalized object mapping so that
 * config validation and future manifests never re-parse refs with ad hoc string
 * handling after startup. It is pure: no IO, no dynamic import. Resolution and
 * dynamic loading stay in the registry / runtime loader layer.
 */

/** Where a provider's implementation comes from. */
export type ProviderRefSource = 'builtin' | 'npm';

/** A bundled, first-party provider selected by id, e.g. `builtin:codex`. */
export interface BuiltinProviderRef {
  source: 'builtin';
  /** Bundled provider id, e.g. `codex` or `claude-code`. */
  id: string;
  /** The original, canonical string form. */
  raw: string;
}

/**
 * An external provider selected by npm package, optionally narrowed to a named
 * export.
 */
export interface NpmProviderRef {
  source: 'npm';
  /** npm package name, e.g. `@example/dreamux-provider` or `some-provider`. */
  package: string;
  /** Named export within the package, or null for the package default. */
  export: string | null;
  /** The original, canonical string form. */
  raw: string;
}

export type ProviderRef = BuiltinProviderRef | NpmProviderRef;

/** Bundled provider id: lowercase, starts with a letter, kebab-friendly. */
export const BUILTIN_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const BUILTIN_PROVIDER_ID_RULE =
  'lowercase, starting with a letter, containing only letters, digits, or dashes';

/**
 * npm package name: optional `@scope/` prefix then a name segment. Mirrors the
 * common npm naming surface (lowercase, digits, `-`, `.`, `_`) without trying to
 * re-implement the full npm spec.
 */
const NPM_NAME_SEGMENT = '[a-z0-9][a-z0-9._-]*';
export const NPM_PACKAGE_PATTERN = new RegExp(
  `^(?:@${NPM_NAME_SEGMENT}/)?${NPM_NAME_SEGMENT}$`,
);

export const NPM_PACKAGE_RULE =
  'an npm package name, optionally scoped (e.g. `@scope/name` or `name`)';

/** Export name: a JavaScript identifier. */
export const PROVIDER_EXPORT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const PROVIDER_EXPORT_RULE =
  'a JavaScript identifier (the named export to load from the package)';

/** Thrown when a provider ref string is malformed. */
export class InvalidProviderRefError extends Error {
  constructor(
    readonly ref: string,
    reason: string,
  ) {
    super(`invalid provider ref ${JSON.stringify(ref)}: ${reason}`);
    this.name = 'InvalidProviderRefError';
  }
}

/**
 * Parse and validate a provider ref string into its normalized object form.
 * Throws {@link InvalidProviderRefError} on any malformed input.
 */
export function parseProviderRef(ref: string): ProviderRef {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new InvalidProviderRefError(String(ref), 'ref must be a non-empty string');
  }

  const schemeEnd = ref.indexOf(':');
  if (schemeEnd <= 0) {
    throw new InvalidProviderRefError(
      ref,
      'ref must be in `<source>:<spec>` form (e.g. `builtin:codex`)',
    );
  }

  const source = ref.slice(0, schemeEnd);
  const spec = ref.slice(schemeEnd + 1);

  switch (source) {
    case 'builtin':
      return parseBuiltinRef(ref, spec);
    case 'npm':
      return parseNpmRef(ref, spec);
    default:
      throw new InvalidProviderRefError(
        ref,
        `unknown provider source ${JSON.stringify(source)} (expected \`builtin\` or \`npm\`)`,
      );
  }
}

function parseBuiltinRef(ref: string, spec: string): BuiltinProviderRef {
  if (spec.includes('#')) {
    throw new InvalidProviderRefError(ref, 'builtin refs do not take an `#export`');
  }
  if (!BUILTIN_PROVIDER_ID_PATTERN.test(spec)) {
    throw new InvalidProviderRefError(
      ref,
      `builtin id must be ${BUILTIN_PROVIDER_ID_RULE}`,
    );
  }
  return { source: 'builtin', id: spec, raw: `builtin:${spec}` };
}

function parseNpmRef(ref: string, spec: string): NpmProviderRef {
  const hashIndex = spec.indexOf('#');
  const pkg = hashIndex === -1 ? spec : spec.slice(0, hashIndex);
  const exportName = hashIndex === -1 ? null : spec.slice(hashIndex + 1);

  if (!NPM_PACKAGE_PATTERN.test(pkg)) {
    throw new InvalidProviderRefError(ref, `package must be ${NPM_PACKAGE_RULE}`);
  }
  if (exportName !== null && !PROVIDER_EXPORT_PATTERN.test(exportName)) {
    throw new InvalidProviderRefError(ref, `export must be ${PROVIDER_EXPORT_RULE}`);
  }

  const raw = exportName === null ? `npm:${pkg}` : `npm:${pkg}#${exportName}`;
  return { source: 'npm', package: pkg, export: exportName, raw };
}

/** Render a normalized provider ref back to its canonical string form. */
export function formatProviderRef(ref: ProviderRef): string {
  return ref.raw;
}

/**
 * True when a ref selects a bundled provider.
 */
export function isBuiltinRef(ref: ProviderRef): ref is BuiltinProviderRef {
  return ref.source === 'builtin';
}
