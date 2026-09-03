import type {
  AgentRuntimeActivitySink,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateSink,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { CodexOutputSchemaCodec } from './output-schema-codec.js';
import type { CodexWsClient } from './rpc.js';
import type { CodexProcess, CodexProcessOptions } from './supervisor.js';

/**
 * How this package constructs one resident Codex runtime.
 *
 * Package-internal, and only that: `createRuntime` assembles it from the
 * neutral create context plus the provider's own options, and `CodexRuntime`
 * consumes it. It is not part of the package's public surface and it is not
 * the provider's options type — a host configures this provider through
 * `CodexAgentRuntimeProviderOptions`, which names none of these fields.
 */
export interface CodexRuntimeDeps {
  cwd: string;
  systemPromptReplace?: string;
  systemPromptAppend?: readonly string[];
  state: AgentRuntimeStateSink;
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
