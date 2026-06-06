/**
 * Capability Registry skeleton for the issue #110 plugin/provider architecture.
 *
 * The registry is process-local and server-owned. It records provider
 * descriptors and the capabilities they expose, and resolves provider refs to
 * descriptors, so core consumers read capabilities from one place instead of
 * constructing channel / runtime / MCP surfaces by hard-coded provider-specific
 * names. See
 * `.agents/decisions/provider-references-and-capability-registry.md`.
 *
 * Scope for this PR (issue #110 phase 1): typed registration + lookup only. It
 * does not take over the server startup path, does not build MCP surfaces, and
 * does not load, install, or execute external npm providers — external refs are
 * reserved syntax that resolve to a clear, typed error.
 */

import {
  type ProviderRef,
  isBuiltinRef,
  parseProviderRef,
} from './provider-ref.js';

/** Kinds of provider the registry can hold. */
export type ProviderKind = 'channel' | 'agentRuntime' | 'service';

/**
 * A capability a provider exposes. The skeleton records the descriptor metadata;
 * the executable surfaces (MCP servers, reply, runtime delivery hooks) are
 * attached by the per-provider PRs (#110 PR4/PR5/PR6+).
 */
export interface CapabilityDescriptor {
  /**
   * Capability id, namespaced by provider id to avoid collisions, e.g.
   * `feishu:reply`. Build with {@link capabilityId}.
   */
  id: string;
  /** Provider-defined capability kind, e.g. `mcpServer`, `reply`, `runtimeDelivery`. */
  kind: string;
}

/** A registered provider and the capabilities it declares. */
export interface ProviderDescriptor {
  /** Resolved provider id (the builtin id for builtin refs). */
  id: string;
  kind: ProviderKind;
  ref: ProviderRef;
  capabilities: CapabilityDescriptor[];
}

/** Namespace a capability name under its provider id. */
export function capabilityId(providerId: string, name: string): string {
  return `${providerId}:${name}`;
}

/** Thrown when registering a provider id that is already registered. */
export class DuplicateProviderError extends Error {
  constructor(readonly id: string) {
    super(`provider ${JSON.stringify(id)} is already registered`);
    this.name = 'DuplicateProviderError';
  }
}

/** Thrown when two capabilities within one provider share an id. */
export class DuplicateCapabilityError extends Error {
  constructor(
    readonly providerId: string,
    readonly capabilityId: string,
  ) {
    super(
      `provider ${JSON.stringify(providerId)} declares capability ` +
        `${JSON.stringify(capabilityId)} more than once`,
    );
    this.name = 'DuplicateCapabilityError';
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
 * register providers, or use {@link createBuiltinRegistry} for the phase-1
 * builtins.
 */
export class CapabilityRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>();

  /**
   * Register a provider. Throws {@link DuplicateProviderError} on a repeated id
   * and {@link DuplicateCapabilityError} on a repeated capability id within the
   * provider.
   */
  register(descriptor: ProviderDescriptor): void {
    if (this.providers.has(descriptor.id)) {
      throw new DuplicateProviderError(descriptor.id);
    }
    const seen = new Set<string>();
    for (const capability of descriptor.capabilities) {
      if (seen.has(capability.id)) {
        throw new DuplicateCapabilityError(descriptor.id, capability.id);
      }
      seen.add(capability.id);
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
