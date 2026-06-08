/**
 * Provider registry for the issue #135 architecture realignment.
 *
 * The registry is process-local and server-owned. It validates provider refs and
 * resolves them to provider descriptors; executable providers own their runtime
 * capabilities directly. External `npm:` agentRuntime refs are registered by
 * the async loader before config validation resolves them.
 */

import {
  formatProviderRef,
  type ProviderRef,
  isBuiltinRef,
  parseProviderRef,
} from './provider-ref.js';

/** Kinds of provider the registry can hold. */
export type ProviderKind = 'channel' | 'agentRuntime';

/** A registered provider descriptor. Capabilities live on provider instances. */
export interface ProviderDescriptor {
  /** Stable registry id; builtin providers use their builtin id. */
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

/** Thrown when registering the same canonical provider ref twice. */
export class DuplicateProviderRefError extends Error {
  constructor(readonly ref: string) {
    super(`provider ref ${JSON.stringify(ref)} is already registered`);
    this.name = 'DuplicateProviderRefError';
  }
}

/** Thrown when registering a runnable implementation for the same provider twice. */
export class DuplicateProviderImplementationError extends Error {
  constructor(readonly id: string) {
    super(`provider ${JSON.stringify(id)} already has a runnable implementation`);
    this.name = 'DuplicateProviderImplementationError';
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
 * Thrown when an external (`npm:`) ref is selected before the async
 * agentRuntime loader has registered it.
 */
export class ReservedExternalProviderError extends Error {
  constructor(readonly ref: string) {
    super(
      `external provider ref ${JSON.stringify(ref)} is not loaded; load the ` +
        'agentRuntime provider before resolving config',
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
  private readonly providersByRef = new Map<string, ProviderDescriptor>();
  private readonly implementations = new Map<string, unknown>();

  /**
   * Register a provider. Throws {@link DuplicateProviderError} on a repeated id.
   */
  register(descriptor: ProviderDescriptor): void {
    if (this.providers.has(descriptor.id)) {
      throw new DuplicateProviderError(descriptor.id);
    }
    const canonicalRef = formatProviderRef(descriptor.ref);
    if (this.providersByRef.has(canonicalRef)) {
      throw new DuplicateProviderRefError(canonicalRef);
    }
    this.providers.set(descriptor.id, descriptor);
    this.providersByRef.set(canonicalRef, descriptor);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ProviderDescriptor | undefined {
    return this.providers.get(id);
  }

  hasRef(ref: string | ProviderRef): boolean {
    const parsed = typeof ref === 'string' ? parseProviderRef(ref) : ref;
    return this.providersByRef.has(formatProviderRef(parsed));
  }

  registerImplementation(providerId: string, implementation: unknown): void {
    if (!this.providers.has(providerId)) {
      throw new UnknownBuiltinProviderError(providerId);
    }
    if (this.implementations.has(providerId)) {
      throw new DuplicateProviderImplementationError(providerId);
    }
    this.implementations.set(providerId, implementation);
  }

  getImplementation(providerId: string): unknown | undefined {
    return this.implementations.get(providerId);
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
   * - `npm:` refs resolve only after the async agentRuntime loader registers
   *   their descriptor; otherwise they throw
   *   {@link ReservedExternalProviderError}.
   *
   * A malformed string ref throws `InvalidProviderRefError` from
   * {@link parseProviderRef}.
   */
  resolve(ref: string | ProviderRef): ProviderDescriptor {
    const parsed = typeof ref === 'string' ? parseProviderRef(ref) : ref;
    const descriptor = isBuiltinRef(parsed)
      ? this.providers.get(parsed.id)
      : this.providersByRef.get(formatProviderRef(parsed));
    if (descriptor === undefined) {
      if (!isBuiltinRef(parsed)) {
        throw new ReservedExternalProviderError(parsed.raw);
      }
      throw new UnknownBuiltinProviderError(parsed.id);
    }
    return descriptor;
  }
}
