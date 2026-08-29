import type {
  AgentRuntimeActivitySink,
  AgentRuntimePathContext,
  AgentRuntimeSessionRef,
  AgentRuntimeSkillSource,
  AgentRuntimeStateSink,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { CodexOutputSchemaCodec } from './output-schema-codec.js';
import type { CodexWsClient } from './rpc.js';
import type { CodexProcess, CodexProcessOptions } from './supervisor.js';

/** Neutral host capabilities required by one resident Codex runtime. */
export interface CodexRuntimeDeps {
  cwd: string;
  systemPromptReplace?: string;
  systemPromptAppend?: readonly string[];
  state: AgentRuntimeStateSink<AgentRuntimeSessionRef>;
  paths: AgentRuntimePathContext;
  /**
   * The session-bound output schema codec, compiled once at create time. It is
   * fixed for the life of this runtime; no submission can change it.
   */
  codec: CodexOutputSchemaCodec | null;
  allocateSocketPath: (id: string) => string;
  skillSources?: readonly AgentRuntimeSkillSource[];
  injectEnv?: Record<string, string>;
  codexBinPath?: string;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  codexHomeDoctor?: (info: {
    runtimeId: string;
    cwd: string;
  }) => void | Promise<void>;
  resolveExtraArgs?: () => string[];
  handshakeTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
  logger?: DreamuxLogger;
  activitySink: AgentRuntimeActivitySink;
}
