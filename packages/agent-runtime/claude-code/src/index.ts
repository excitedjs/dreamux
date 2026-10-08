/**
 * Package-root default: neutral provider factory for configured npm providers.
 * The named plugin factory contributes the builtin provider and plugin APIs.
 * This package never imports Dreamux Core.
 */

export { default as createClaudeCodePlugin } from './plugin.js';

export { createClaudeCodeAgentRuntimeProvider } from './provider.js';

export {
  ALLOWED_CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_BIN,
  DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS,
  defaultDispatcherClaudeCodeConfig,
  readDispatcherClaudeCodeConfig,
  type DispatcherClaudeCodeConfig,
} from './config.js';

import type { AgentRuntimeProviderFactory } from '@excitedjs/dreamux-types';
import type { DispatcherClaudeCodeConfig } from './config.js';
import { createClaudeCodeAgentRuntimeProvider } from './provider.js';

const providerFactory: AgentRuntimeProviderFactory<
  DispatcherClaudeCodeConfig
> = () => createClaudeCodeAgentRuntimeProvider();
export default providerFactory;
