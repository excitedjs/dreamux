import type { AgentRuntimeProviderFactory } from '@excitedjs/dreamux-types';

import type { AntigravityConfig } from './config.js';
import { createAntigravityAgentRuntimeProvider } from './provider.js';

export { createAntigravityAgentRuntimeProvider } from './provider.js';
export {
  DEFAULT_ANTIGRAVITY_BIN,
  DEFAULT_ANTIGRAVITY_TRANSPORT,
  defaultAntigravityConfig,
  readAntigravityConfig,
  type AntigravityConfig,
  type AntigravityTransport,
} from './config.js';

const providerFactory: AgentRuntimeProviderFactory<AntigravityConfig> = () =>
  createAntigravityAgentRuntimeProvider();
export default providerFactory;
