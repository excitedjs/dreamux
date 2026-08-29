/**
 * Channel-provider catalog (issue #209 cleanup).
 *
 * The channel-kind twin of `agent-runtime/catalog.ts`: a registry-backed lookup
 * that resolves a `dispatchers[].channels[].provider` ref to its neutral
 * `ChannelProvider`. Core drives every channel session through this one
 * neutral seam — it never names a concrete channel class (e.g. a provider's
 * own session) and is unaware of which package implements a `builtin:` vs an
 * external `npm:` channel provider.
 */
import {
  formatProviderRef,
  ReservedExternalProviderError,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import type { ChannelProvider } from '@excitedjs/dreamux-types';

export class UnsupportedChannelProviderError extends Error {
  constructor(
    readonly providerRef: string,
    readonly reason: string,
  ) {
    super(`channel provider ${JSON.stringify(providerRef)} is not supported: ${reason}`);
    this.name = 'UnsupportedChannelProviderError';
  }
}

export class WrongChannelProviderKindError extends Error {
  constructor(readonly descriptor: ProviderDescriptor) {
    super(
      `provider ${JSON.stringify(formatProviderRef(descriptor.ref))} is a ` +
        `${descriptor.kind} provider, expected channel`,
    );
    this.name = 'WrongChannelProviderKindError';
  }
}

export interface ChannelProviderCatalogOptions {
  registry: ProviderRegistry;
}

export class ChannelProviderCatalog {
  private readonly registry: ProviderRegistry;

  constructor(options: ChannelProviderCatalogOptions) {
    this.registry = options.registry;
  }

  list(): ChannelProvider<unknown>[] {
    return this.registry
      .listByKind('channel')
      .map((descriptor) => this.channelProviderForDescriptor(descriptor))
      .filter((provider): provider is ChannelProvider<unknown> => provider !== null);
  }

  resolve(ref: string): ChannelProvider<unknown> {
    let descriptor: ProviderDescriptor;
    try {
      descriptor = this.registry.resolve(ref);
    } catch (err) {
      if (err instanceof ReservedExternalProviderError) {
        throw new UnsupportedChannelProviderError(ref, err.message);
      }
      throw err;
    }
    if (descriptor.kind !== 'channel') {
      throw new WrongChannelProviderKindError(descriptor);
    }
    const canonicalRef = formatProviderRef(descriptor.ref);
    const provider = this.channelProviderForDescriptor(descriptor);
    if (provider === null) {
      throw new UnsupportedChannelProviderError(
        canonicalRef,
        'the provider is registered but has no channel implementation wired in this phase',
      );
    }
    return provider;
  }

  private channelProviderForDescriptor(
    descriptor: ProviderDescriptor,
  ): ChannelProvider<unknown> | null {
    return asChannelProvider(this.registry.getImplementation(descriptor.id));
  }
}

/**
 * Structural check for a loaded channel implementation. It asserts the session
 * factory only: registration identity lives on the registry wrapper, so a
 * provider has no `ref`/`descriptor` member to test.
 */
export function asChannelProvider(
  value: unknown,
): ChannelProvider<unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ChannelProvider<unknown>>;
  if (typeof candidate.createSession !== 'function') return null;
  return value as ChannelProvider<unknown>;
}
