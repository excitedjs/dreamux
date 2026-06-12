/**
 * Provider reference and descriptor shapes.
 *
 * Declaration-only structural contracts shared between Dreamux core and external
 * provider packages. Parsing, validation, and the in-process registry are
 * runtime concerns owned by `@excitedjs/dreamux`; this package exposes only the
 * shapes so providers can be authored without depending on the host.
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

/** Kinds of provider the registry can hold. */
export type ProviderKind = 'channel' | 'agentRuntime';

/** A registered provider descriptor. Capabilities live on provider instances. */
export interface ProviderDescriptor {
  /** Stable registry id; builtin providers use their builtin id. */
  id: string;
  kind: ProviderKind;
  ref: ProviderRef;
}
