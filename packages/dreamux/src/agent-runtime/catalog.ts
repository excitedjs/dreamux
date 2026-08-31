import {
  formatProviderRef,
  ReservedExternalProviderError,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  agentRuntimeCapabilitySnapshot,
  type AgentRuntimePublicCapabilities,
} from './capabilities.js';
import type {
  AgentRuntimeProvider,
  RegisteredProvider,
} from '@excitedjs/dreamux-types';

/**
 * One registered Agent Runtime provider: Core's authoritative descriptor paired
 * with the implementation the loader produced and the capability snapshot Core
 * validated. A provider implementation never carries its own registration
 * identity, so every caller that needs the id, ref, or kind reads it from this
 * wrapper.
 */
export interface RegisteredAgentRuntimeProvider
  extends RegisteredProvider<AgentRuntimeProvider<unknown>> {
  readonly capabilities: AgentRuntimePublicCapabilities;
}

export class UnsupportedAgentRuntimeProviderError extends Error {
  constructor(
    readonly providerRef: string,
    readonly reason: string,
  ) {
    super(`agent runtime provider ${JSON.stringify(providerRef)} is not supported: ${reason}`);
    this.name = 'UnsupportedAgentRuntimeProviderError';
  }
}

export class WrongProviderKindError extends Error {
  constructor(readonly descriptor: ProviderDescriptor) {
    super(
      `provider ${JSON.stringify(formatProviderRef(descriptor.ref))} is a ` +
        `${descriptor.kind} provider, expected agentRuntime`,
    );
    this.name = 'WrongProviderKindError';
  }
}

export interface AgentRuntimeProviderCatalogOptions {
  registry: ProviderRegistry;
}

export class AgentRuntimeProviderCatalog {
  private readonly registry: ProviderRegistry;

  constructor(options: AgentRuntimeProviderCatalogOptions) {
    this.registry = options.registry;
  }

  list(): RegisteredAgentRuntimeProvider[] {
    return this.registry
      .listByKind('agentRuntime')
      .map((descriptor) => this.registeredProviderFor(descriptor))
      .filter(
        (provider): provider is RegisteredAgentRuntimeProvider =>
          provider !== null,
      );
  }

  resolve(ref: string): RegisteredAgentRuntimeProvider {
    let descriptor: ProviderDescriptor;
    try {
      descriptor = this.registry.resolve(ref);
    } catch (err) {
      if (err instanceof ReservedExternalProviderError) {
        throw new UnsupportedAgentRuntimeProviderError(ref, err.message);
      }
      throw err;
    }
    if (descriptor.kind !== 'agentRuntime') {
      throw new WrongProviderKindError(descriptor);
    }
    const canonicalRef = formatProviderRef(descriptor.ref);
    const provider = this.registeredProviderFor(descriptor);
    if (provider === null) {
      throw new UnsupportedAgentRuntimeProviderError(
        canonicalRef,
        'the provider is registered but has no runtime implementation wired in this phase',
      );
    }
    return provider;
  }

  private registeredProviderFor(
    descriptor: ProviderDescriptor,
  ): RegisteredAgentRuntimeProvider | null {
    const implementation = asAgentRuntimeProvider(
      this.registry.getImplementation(descriptor.id),
    );
    if (implementation === null) return null;
    return {
      descriptor,
      implementation,
      capabilities: this.capabilitiesFor(descriptor, implementation),
    };
  }

  /**
   * The one snapshot for this implementation. The loader already took it while
   * asserting the contract, so this normally returns that exact object; a
   * directly registered implementation (no loader involved) takes it here on
   * first read. Either way `getCapabilities()` is called once per
   * implementation, and the catalog never trusts a second call.
   */
  private capabilitiesFor(
    descriptor: ProviderDescriptor,
    implementation: AgentRuntimeProvider<unknown>,
  ): AgentRuntimePublicCapabilities {
    return agentRuntimeCapabilitySnapshot(
      implementation,
      formatProviderRef(descriptor.ref),
    );
  }
}

/**
 * Structural check for a loaded Agent Runtime implementation. It asserts the
 * facade methods only: registration identity lives on the {@link
 * RegisteredProvider} wrapper, so there is no `ref`/`descriptor` member to test.
 */
export function asAgentRuntimeProvider(
  value: unknown,
): AgentRuntimeProvider<unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<AgentRuntimeProvider<unknown>>;
  if (
    typeof candidate.getCapabilities !== 'function' ||
    typeof candidate.readRecentActivity !== 'function' ||
    typeof candidate.createRuntime !== 'function'
  ) {
    return null;
  }
  return value as AgentRuntimeProvider<unknown>;
}
