/**
 * `@excitedjs/agent-runtime-codex` — the built-in Codex plugin for Dreamux
 * (`builtin:codex`). Its default export is the Dreamux plugin factory: the
 * plugin contributes the Codex `AgentRuntimeProvider`, which implements the
 * `@excitedjs/dreamux-types` contract. `createCodexAgentRuntimeProvider` is
 * the named export for constructing the bare provider directly (embedders,
 * tests). This package never imports `@excitedjs/dreamux` core.
 */

export { default } from './plugin.js';

export {
  createCodexAgentRuntimeProvider,
  type CodexAgentRuntimeProviderOptions,
} from './provider.js';

export {
  type DispatcherCodexConfig,
  readDispatcherCodexConfig,
  defaultDispatcherCodexConfig,
  DEFAULT_CODEX_BIN,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MODE,
  ALLOWED_SANDBOX_MODES,
} from './config.js';
