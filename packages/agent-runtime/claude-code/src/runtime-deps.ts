import type {
  AgentRuntimeActivitySink,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateSink,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { DispatcherClaudeCodeConfig } from './config.js';

/** Neutral host capabilities required by one resident Claude Code runtime. */
export interface ClaudeCodeRuntimeDeps {
  config: DispatcherClaudeCodeConfig;
  cwd: string;
  state: AgentRuntimeStateSink;
  paths: AgentRuntimePathContext;
  mcpServers: readonly AgentRuntimeMcpServer[];
  systemPromptAppend?: readonly string[] | undefined;
  skillSources?: readonly AgentRuntimeSkillSource[];
  disableFeatures?: readonly string[];
  /**
   * The session-bound output schema, applied at spawn via `--json-schema`. It is
   * fixed for the life of this runtime; no submission can change it.
   */
  outputSchema?: Record<string, unknown> | undefined;
  logger: DreamuxLogger;
  activitySink: AgentRuntimeActivitySink;
}
