/**
 * Provider-catalog builders for the live Codex gate (issue #63 restoration,
 * Stage 9 node `live-codex-gate`).
 *
 * `Server` never talks to a concrete provider class: every dispatcher runtime
 * and channel session is reached through the neutral
 * `AgentRuntimeProviderCatalog` / `ChannelProviderCatalog` seam, resolved from
 * a `ProviderRegistry`. Production builds that registry from `loadConfig()`;
 * these two builders do the same thing by hand for a test — register ONE
 * builtin implementation (the real Codex provider, or the real Feishu
 * provider with its bot connection swapped for a test double) on a fresh
 * `createBuiltinProviderRegistry()` — so `Server` still drives the real
 * provider code, not a test-only stand-in for the seam itself.
 *
 * This file is owned by the `live-codex-gate` node alone (see the task's file
 * ownership list); it duplicates the small registration idiom other nodes'
 * fixtures use rather than importing a sibling test helper, so no other node's
 * file needs to change for this one to exist.
 */
import { AgentRuntimeProviderCatalog } from '../../src/agent-runtime/index.js';
import { ChannelProviderCatalog } from '../../src/channel/catalog.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  createBuiltinProviderRegistry,
} from '../../src/registry/index.js';
import {
  createCodexAgentRuntimeProvider,
  type CodexAgentRuntimeProviderOptions,
} from '@excitedjs/agent-runtime-codex';
import {
  createFeishuChannelProvider,
  type FeishuBot,
  type FeishuChannelConfig,
} from '@excitedjs/feishu-channel';

/**
 * A real `builtin:codex` `AgentRuntimeProviderCatalog` whose provider is
 * built with the given test/host seams (`codexClientFactory`,
 * `codexHomeDoctor`, ...). Omitting `codexProcessFactory` keeps the REAL
 * `codex` binary spawn path — that is what makes a test built from this
 * catalog a *live* Codex gate rather than a fake-transport unit test.
 */
export function codexAgentRuntimeCatalog(
  options: CodexAgentRuntimeProviderOptions = {},
): AgentRuntimeProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve(BUILTIN_CODEX_PROVIDER_REF);
  registry.registerImplementation(
    descriptor.id,
    createCodexAgentRuntimeProvider(options),
  );
  return new AgentRuntimeProviderCatalog({ registry });
}

/**
 * A real `builtin:feishu` `ChannelProviderCatalog` whose `FeishuBot` is
 * whatever `botFactory` builds instead of a live Lark long connection. The
 * factory receives the validated channel config so a multi-channel test can
 * key a distinct bot per app identity.
 */
export function feishuChannelCatalog(
  botFactory: (config: FeishuChannelConfig) => FeishuBot,
): ChannelProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve(BUILTIN_FEISHU_PROVIDER_REF);
  registry.registerImplementation(
    descriptor.id,
    createFeishuChannelProvider({ botFactory }),
  );
  return new ChannelProviderCatalog({ registry });
}
