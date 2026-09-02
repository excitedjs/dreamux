import type {
  AgentRuntimeActivitySink,
  AgentRuntimeMcpServer,
  AgentRuntimeNativeTurnSink,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateSink,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { DispatcherClaudeCodeConfig } from './config.js';
import type { ClaudeCodeSessionFactory } from './supervisor.js';

/** Neutral host capabilities required by one resident Claude Code runtime. */
export interface ClaudeCodeRuntimeDeps {
  config: DispatcherClaudeCodeConfig;
  cwd: string;
  state: AgentRuntimeStateSink;
  paths: AgentRuntimePathContext;
  mcpServers: readonly AgentRuntimeMcpServer[];
  sessionFactory: ClaudeCodeSessionFactory;
  resolveBinPath: (bin: string) => string;
  injectEnv?: Record<string, string>;
  systemPromptAppend?: readonly string[];
  skillSources?: readonly AgentRuntimeSkillSource[];
  disableFeatures?: readonly string[];
  /**
   * The session-bound output schema, applied at spawn via `--json-schema`. It is
   * fixed for the life of this runtime; no submission can change it.
   */
  outputSchema?: Record<string, unknown>;
  generateSessionId?: () => string;
  logger?: DreamuxLogger;
  activitySink: AgentRuntimeActivitySink;
  nativeTurnSink: AgentRuntimeNativeTurnSink;
}
