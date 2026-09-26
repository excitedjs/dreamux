/**
 * Provider registry for the issue #135 architecture realignment.
 *
 * The registry is process-local and server-owned. It validates provider refs and
 * resolves them to provider descriptors; executable providers own their runtime
 * capabilities directly. External `npm:` refs are registered by the async
 * provider loaders before config validation resolves them.
 */

import {
  formatProviderRef,
  type ProviderRef,
  isBuiltinRef,
  parseProviderRef,
} from './provider-ref.js';
import type {
  AgentRuntimeProvider,
  ChannelProvider,
  ProviderDescriptor,
  ProviderKind,
} from '@excitedjs/dreamux-types';

/**
 * A runnable provider implementation: the shape `register()` accepts for its
 * `implementation` argument. Either neutral contract is valid regardless of
 * `descriptor.kind` — the registry does not itself correlate the two, so this
 * is a union, not a `descriptor.kind`-keyed mapping; a completely wrong
 * implementation object (not a provider at all) is a compile error at the
 * `register()` call site instead of only surfacing later at
 * `getImplementation()`'s manual cast. Kind/contract agreement for the two
 * package-loader call sites is enforced by each kind's `assertProvider`
 * (`agent-runtime/external-provider.ts`, `channel/external-channel-provider.ts`)
 * before `register()` runs; for the plugin-contribution call site
 * (`registerBuiltinProvider`, called from `plugin/loader.ts`'s `contribute()`)
 * there is no `assertProvider` step, so the typed `ContributeHost` closures in
 * `plugin/loader.ts` (`channelProviders.contribute` / `agentRuntimeProviders.contribute`)
 * are the only place that pairing is checked.
 */
export type ProviderImplementation =
  AgentRuntimeProvider<unknown> | ChannelProvider<unknown>;

/**
 * Provider kind and descriptor structural shapes are published by
 * `@excitedjs/dreamux-types`; re-exported here so the many in-repo imports from
 * `../registry/index.js` stay stable (issue #209). The registry runtime stays
 * in this package.
 */
// eslint-disable-next-line no-restricted-syntax -- neutral-contract type re-export documented above, so in-repo imports from ../registry/index.js keep resolving these names (issue #209)
export type {
  ProviderDescriptor,
  ProviderKind,
} from '@excitedjs/dreamux-types';

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
    super(
      `provider ${JSON.stringify(id)} already has a runnable implementation`,
    );
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
 * Thrown when an external (`npm:`) ref is selected before the async provider
 * loader for that kind has registered it.
 */
export class ReservedExternalProviderError extends Error {
  constructor(readonly ref: string) {
    super(
      `external provider ref ${JSON.stringify(ref)} is not loaded; load the ` +
        'provider package before resolving config',
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
   * Register a provider descriptor, optionally together with its runnable
   * implementation.
   *
   * Throws {@link DuplicateProviderError} / {@link DuplicateProviderRefError}
   * on a repeated id/ref — unless `descriptor` is the exact object already
   * registered under its id, in which case this call only adds
   * `implementation`. That reuse is how a pre-registered builtin descriptor
   * (`createBuiltinProviderRegistry`, registered with no `implementation`
   * before its package loads) is later completed with the implementation its
   * package loader resolves, without re-registering — the two are the same
   * object by construction (`registry/provider-loader.ts`'s `seedDescriptor`
   * reuses the looked-up descriptor rather than building a new one), so this
   * is never mistaken for a second, conflicting registration under the same id.
   *
   * Throws {@link DuplicateProviderImplementationError} if `implementation` is
   * given for a provider id that already has one.
   */
  register(
    descriptor: ProviderDescriptor,
    implementation?: ProviderImplementation,
  ): void {
    const existing = this.providers.get(descriptor.id);
    if (existing === undefined) {
      const canonicalRef = formatProviderRef(descriptor.ref);
      if (this.providersByRef.has(canonicalRef)) {
        throw new DuplicateProviderRefError(canonicalRef);
      }
      this.providers.set(descriptor.id, descriptor);
      this.providersByRef.set(canonicalRef, descriptor);
    } else if (existing !== descriptor) {
      throw new DuplicateProviderError(descriptor.id);
    }
    if (implementation !== undefined) {
      if (this.implementations.has(descriptor.id)) {
        throw new DuplicateProviderImplementationError(descriptor.id);
      }
      this.implementations.set(descriptor.id, implementation);
    }
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
   * - `npm:` refs resolve only after the async provider loader registers their
   *   descriptor; otherwise they throw {@link ReservedExternalProviderError}.
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
