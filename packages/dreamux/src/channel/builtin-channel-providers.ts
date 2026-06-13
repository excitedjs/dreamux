/**
 * Builtin channel-provider registration (issue #209 multi-channel config slice).
 *
 * Mirrors `registerBuiltinAgentRuntimeProviders`: it registers the built-in
 * `ChannelProvider` implementations into the provider registry so config loading
 * can resolve a `dispatchers[].channels[].provider` ref to its provider and call
 * the provider's own `readConfig` for provider-specific validation. Core never
 * validates channel-provider-specific config itself.
 *
 * Today only `builtin:feishu` (the `@excitedjs/feishu-channel` package's
 * `ChannelProvider`) is registered. External `npm:` channel providers load
 * through the generic channel loader before config validation, exactly like
 * external agent runtimes.
 */
import { createFeishuChannelProvider } from '@excitedjs/feishu-channel';

import { BUILTIN_FEISHU_PROVIDER_REF } from '../registry/builtins.js';
import type { ProviderRegistry } from '../registry/index.js';

export interface RegisterBuiltinChannelProvidersOptions {
  registry: ProviderRegistry;
}

/**
 * Register the built-in channel-provider implementations. Idempotent w.r.t. an
 * already-registered impl (a second call no-ops), matching the agent-runtime
 * builtin registration so a caller that pre-registers its own seams still wins.
 */
export function registerBuiltinChannelProviders(
  options: RegisterBuiltinChannelProvidersOptions,
): void {
  const { registry } = options;
  const feishuDescriptor = registry.resolve(BUILTIN_FEISHU_PROVIDER_REF);
  if (registry.getImplementation(feishuDescriptor.id) === undefined) {
    registry.registerImplementation(
      feishuDescriptor.id,
      createFeishuChannelProvider(),
    );
  }
}
