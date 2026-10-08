/**
 * Package-root default: neutral provider factory for configured npm providers.
 * The named plugin factory contributes the builtin provider and plugin APIs.
 * This package never imports Dreamux Core.
 */

export { default as createCodexPlugin } from './plugin.js';

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

import type { AgentRuntimeProviderFactory } from '@excitedjs/dreamux-types';
import type { DispatcherCodexConfig } from './config.js';
import { createCodexAgentRuntimeProvider } from './provider.js';

const providerFactory: AgentRuntimeProviderFactory<
  DispatcherCodexConfig
> = () => createCodexAgentRuntimeProvider();
export default providerFactory;
