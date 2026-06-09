import {
  loadConfig,
  loadOrInitConfig,
  type ConfigPathOverrides,
  type LoadConfigResult,
} from '../config/config.js';
import { createBuiltinProviderRegistry } from '../registry/index.js';
import { registerBuiltinAgentRuntimeProviders } from './catalog.js';

/**
 * Build a provider registry with the builtin agentRuntime implementations
 * registered, reusing a caller-supplied registry when present (and registering
 * idempotently into it). Shared by both load helpers below.
 */
function registryWithBuiltins(overrides: ConfigPathOverrides) {
  const providerRegistry =
    overrides.providerRegistry ?? createBuiltinProviderRegistry();
  registerBuiltinAgentRuntimeProviders({ registry: providerRegistry });
  return providerRegistry;
}

/**
 * Load dreamux config with the builtin agentRuntime providers registered, so a
 * config that declares `builtin:codex` / `builtin:claude-code` agents parses
 * through each provider's `readConfig`.
 *
 * `config/config.ts` is a schema/parse leaf and deliberately does not know about
 * the runtime catalog — registering the builtins there inverted the layering and
 * formed the static import cycle that crashed #148. The composition lives here
 * instead: callers that do not already own a factory-bearing registry (doctor,
 * daemon, onboard) go through this helper. `cli/server.ts` composes its own
 * factory-bearing registry and calls `loadConfig` directly, so it does not need
 * this wrapper.
 *
 * Idempotent w.r.t. an already-populated registry: `registerBuiltinAgentRuntimeProviders`
 * skips a builtin id that already carries an implementation, so passing a
 * factory-bearing registry through `overrides.providerRegistry` is safe.
 *
 * This module must never be imported by `platform/paths.ts` or any
 * `agent-runtime/builtin/*` module — doing so would re-form the cycle.
 */
export async function loadConfigWithBuiltins(
  overrides: ConfigPathOverrides = {},
): Promise<LoadConfigResult> {
  return loadConfig({ ...overrides, providerRegistry: registryWithBuiltins(overrides) });
}

/**
 * Like {@link loadConfigWithBuiltins}, but for the load-or-write-default entry
 * point. Same composition: builtins registered by the caller layer, not by the
 * config leaf.
 */
export async function loadOrInitConfigWithBuiltins(
  overrides: ConfigPathOverrides = {},
): ReturnType<typeof loadOrInitConfig> {
  return loadOrInitConfig({
    ...overrides,
    providerRegistry: registryWithBuiltins(overrides),
  });
}
