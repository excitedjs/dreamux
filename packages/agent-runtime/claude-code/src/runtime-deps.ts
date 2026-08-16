import type {
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { DispatcherClaudeCodeConfig } from './config.js';
import type { ClaudeCodeSessionFactory } from './supervisor.js';

/** Neutral host capabilities required by one resident Claude Code runtime. */
export interface ClaudeCodeRuntimeDeps {
  config: DispatcherClaudeCodeConfig;
  cwd: string;
  state: AgentRuntimeStateCallbacks;
  paths: AgentRuntimePathContext;
  mcpServers: readonly AgentRuntimeMcpServer[];
  sessionFactory: ClaudeCodeSessionFactory;
  resolveBinPath: (bin: string) => string;
  injectEnv?: Record<string, string>;
  systemPromptAppend?: readonly string[];
  skillSources?: readonly AgentRuntimeSkillSource[];
  disableFeatures?: readonly string[];
  outputSchema?: Record<string, unknown>;
  logger?: DreamuxLogger;
}
