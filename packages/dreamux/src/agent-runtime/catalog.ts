import {
  formatProviderRef,
  ReservedExternalProviderError,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import type { AgentRuntimeProvider } from '@excitedjs/dreamux-types';

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

  list(): AgentRuntimeProvider[] {
    return this.registry
      .listByKind('agentRuntime')
      .map((descriptor) => this.runtimeProviderForDescriptor(descriptor))
      .filter((provider): provider is AgentRuntimeProvider => provider !== null);
  }

  resolve(ref: string): AgentRuntimeProvider {
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
    const provider = this.runtimeProviderForDescriptor(descriptor);
    if (provider === null) {
      throw new UnsupportedAgentRuntimeProviderError(
        canonicalRef,
        'the provider is registered but has no runtime implementation wired in this phase',
      );
    }
    return provider;
  }

  private runtimeProviderForDescriptor(
    descriptor: ProviderDescriptor,
  ): AgentRuntimeProvider | null {
    const implementation = this.registry.getImplementation(descriptor.id);
    return asAgentRuntimeProvider(implementation);
  }
}

function asAgentRuntimeProvider(value: unknown): AgentRuntimeProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<AgentRuntimeProvider>;
  if (
    typeof candidate.ref !== 'string' ||
    candidate.descriptor === undefined ||
    typeof candidate.getCapabilities !== 'function' ||
    typeof candidate.createRuntime !== 'function'
  ) {
    return null;
  }
  return value as AgentRuntimeProvider;
}
