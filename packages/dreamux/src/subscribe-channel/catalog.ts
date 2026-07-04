/**
 * Subscribe-channel provider catalog.
 *
 * The one-way subscription twin of ChannelProviderCatalog: core resolves a
 * configured subscription provider ref to its provider implementation, while
 * provider packages never assemble Dreamux MCP descriptors or admin args.
 */
import {
  formatProviderRef,
  ReservedExternalProviderError,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import type { SubscribeChannelProvider } from '@excitedjs/dreamux-types';

export class UnsupportedSubscribeChannelProviderError extends Error {
  constructor(
    readonly providerRef: string,
    readonly reason: string,
  ) {
    super(
      `subscribeChannel provider ${JSON.stringify(providerRef)} is not supported: ${reason}`,
    );
    this.name = 'UnsupportedSubscribeChannelProviderError';
  }
}

export class WrongSubscribeChannelProviderKindError extends Error {
  constructor(readonly descriptor: ProviderDescriptor) {
    super(
      `provider ${JSON.stringify(formatProviderRef(descriptor.ref))} is a ` +
        `${descriptor.kind} provider, expected subscribeChannel`,
    );
    this.name = 'WrongSubscribeChannelProviderKindError';
  }
}

export interface SubscribeChannelProviderCatalogOptions {
  registry: ProviderRegistry;
}

export class SubscribeChannelProviderCatalog {
  private readonly registry: ProviderRegistry;

  constructor(options: SubscribeChannelProviderCatalogOptions) {
    this.registry = options.registry;
  }

  resolve(ref: string): SubscribeChannelProvider {
    let descriptor: ProviderDescriptor;
    try {
      descriptor = this.registry.resolve(ref);
    } catch (err) {
      if (err instanceof ReservedExternalProviderError) {
        throw new UnsupportedSubscribeChannelProviderError(ref, err.message);
      }
      throw err;
    }
    if (descriptor.kind !== 'subscribeChannel') {
      throw new WrongSubscribeChannelProviderKindError(descriptor);
    }
    const canonicalRef = formatProviderRef(descriptor.ref);
    const provider = asSubscribeChannelProvider(
      this.registry.getImplementation(descriptor.id),
    );
    if (provider === null) {
      throw new UnsupportedSubscribeChannelProviderError(
        canonicalRef,
        'the provider is registered but has no subscribeChannel implementation wired',
      );
    }
    return provider;
  }
}

export function asSubscribeChannelProvider(
  value: unknown,
): SubscribeChannelProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<SubscribeChannelProvider>;
  if (
    typeof candidate.ref !== 'string' ||
    candidate.descriptor === undefined ||
    typeof candidate.createSession !== 'function'
  ) {
    return null;
  }
  return value as SubscribeChannelProvider;
}
