/**
 * Provider registry for the issue #135 architecture realignment.
 *
 * The registry is process-local and server-owned. It validates provider refs and
 * resolves them to provider descriptors; executable providers own their runtime
 * capabilities directly. External `npm:` refs remain reserved until the
 * agentRuntime loader is implemented.
 */

import {
  type ProviderRef,
  isBuiltinRef,
  parseProviderRef,
} from './provider-ref.js';

/** Kinds of provider the registry can hold. */
export type ProviderKind = 'channel' | 'agentRuntime';

/** A registered provider descriptor. Capabilities live on provider instances. */
export interface ProviderDescriptor {
  /** Resolved provider id (the builtin id for builtin refs). */
  id: string;
  kind: ProviderKind;
  ref: ProviderRef;
}

/** Thrown when registering a provider id that is already registered. */
export class DuplicateProviderError extends Error {
  constructor(readonly id: string) {
    super(`provider ${JSON.stringify(id)} is already registered`);
    this.name = 'DuplicateProviderError';
  }
}

/** Thrown when resolving a `builtin:` ref whose id is not registered. */
export class UnknownBuiltinProviderError extends Error {
  constructor(readonly id: string) {
    super(`unknown builtin provider ${JSON.stringify(id)}`);
    this.name = 'UnknownBuiltinProviderError';
  }
}

/**
 * Thrown when an external (`npm:`) ref is selected for resolution. Phase 1
 * reserves external refs as syntax but never loads or executes them.
 */
export class ReservedExternalProviderError extends Error {
  constructor(readonly ref: string) {
    super(
      `external provider ref ${JSON.stringify(ref)} is reserved but not ` +
        `loadable in this phase; only \`builtin:\` providers run today`,
    );
    this.name = 'ReservedExternalProviderError';
  }
}

/**
 * In-process registry of provider descriptors. Construct an empty one and
 * register providers, or use `createBuiltinProviderRegistry` for the builtins.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>();

  /**
   * Register a provider. Throws {@link DuplicateProviderError} on a repeated id.
   */
  register(descriptor: ProviderDescriptor): void {
    if (this.providers.has(descriptor.id)) {
      throw new DuplicateProviderError(descriptor.id);
    }
    this.providers.set(descriptor.id, descriptor);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ProviderDescriptor | undefined {
    return this.providers.get(id);
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()];
  }

  listByKind(kind: ProviderKind): ProviderDescriptor[] {
    return this.list().filter((descriptor) => descriptor.kind === kind);
  }

  /**
   * Resolve a provider ref (string or normalized) to its registered descriptor.
   *
   * - `builtin:<id>` resolves to the registered descriptor, or throws
   *   {@link UnknownBuiltinProviderError} if absent.
   * - `npm:` refs throw {@link ReservedExternalProviderError}: reserved syntax
   *   is parsed/validated but never loaded or executed in this phase.
   *
   * A malformed string ref throws `InvalidProviderRefError` from
   * {@link parseProviderRef}.
   */
  resolve(ref: string | ProviderRef): ProviderDescriptor {
    const parsed = typeof ref === 'string' ? parseProviderRef(ref) : ref;
    if (!isBuiltinRef(parsed)) {
      throw new ReservedExternalProviderError(parsed.raw);
    }
    const descriptor = this.providers.get(parsed.id);
    if (descriptor === undefined) {
      throw new UnknownBuiltinProviderError(parsed.id);
    }
    return descriptor;
  }
}
