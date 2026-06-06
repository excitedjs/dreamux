/**
 * Channel provider resolution (issue #110 PR4).
 *
 * Maps a provider ref to its runnable {@link ChannelProvider} implementation.
 * The ref is first validated through the PR2 capability registry, so malformed
 * refs, reserved `npm:` refs, and unknown builtins fail loudly here and are
 * never loaded or executed — Phase 1 runs only wired builtin channel providers.
 * The registry stays a pure catalog; this module holds the `id -> factory` map.
 */

import { createBuiltinRegistry } from '../registry/index.js';
import { builtinFeishuChannelProvider } from './feishu-provider.js';
import type { ChannelProvider } from './provider.js';

/** Thrown when a ref resolves to a provider that is not a runnable channel. */
export class UnsupportedChannelProviderError extends Error {
  constructor(
    readonly ref: string,
    reason: string,
  ) {
    super(`channel provider ${JSON.stringify(ref)} ${reason}`);
    this.name = 'UnsupportedChannelProviderError';
  }
}

/** Builtin id -> channel provider factory. Only wired providers appear here. */
const CHANNEL_PROVIDER_FACTORIES: Record<string, () => ChannelProvider> = {
  feishu: builtinFeishuChannelProvider,
};

/**
 * Resolve a channel provider ref to its runnable implementation.
 *
 * Throws from the registry for malformed / reserved-external / unknown-builtin
 * refs, {@link UnsupportedChannelProviderError} when the ref resolves to a
 * non-channel provider or to a channel builtin that is not wired in this phase.
 */
export function resolveChannelProvider(ref: string): ChannelProvider {
  const descriptor = createBuiltinRegistry().resolve(ref);
  if (descriptor.kind !== 'channel') {
    throw new UnsupportedChannelProviderError(
      ref,
      `is a ${descriptor.kind} provider, not a channel`,
    );
  }
  const factory = CHANNEL_PROVIDER_FACTORIES[descriptor.id];
  if (factory === undefined) {
    throw new UnsupportedChannelProviderError(
      ref,
      'is a registered channel builtin but is not runnable in this phase',
    );
  }
  return factory();
}
