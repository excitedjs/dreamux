/**
 * `@excitedjs/agent-runtime-claude-code` — the built-in Claude Code Agent
 * Runtime provider for Dreamux (alias `builtin:claude-code`). Implements the
 * `@excitedjs/dreamux-types` `AgentRuntimeProvider` contract; never imports
 * `@excitedjs/dreamux` core.
 */

export {
  default,
  createClaudeCodeAgentRuntimeProvider,
  dispatcherClaudeCodeConfig,
  CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES,
  type ClaudeCodeAgentRuntimeProviderOptions,
} from './provider.js';

// The concrete runtime class is an implementation detail: the package's public
// surface is the provider factory, and Core only ever holds the neutral
// `start`/`submit`/`stop` handle `createRuntime` returns. The deps type stays
// exported because provider options reference it.
export type { ClaudeCodeRuntimeDeps } from './runtime-deps.js';

export {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeCodeSessionFactory,
  type ClaudeCodeSessionSpec,
  type TurnOutcome,
  type TurnSubmitOptions,
} from './supervisor.js';

export {
  ClaudeCodeStreamRpc,
  type ClaudeCodeStreamRpcOptions,
} from './rpc.js';

export {
  LineBuffer,
  TurnAggregator,
  assistantText,
  parseLine,
  buildUserMessage,
  buildRemoteControlEnable,
  buildCanUseToolAllow,
  buildControlAck,
} from './stream.js';

export type {
  JsonObject,
  ParsedLine,
  ResultEnvelope,
} from './types.js';

export {
  claudeCodeMcpConfig,
  stringifyClaudeCodeMcpConfig,
  type ClaudeCodeMcpConfig,
} from './mcp-config.js';

export {
  claudeCodeResidentArgs,
  claudeCodeSkillAddDirArgs,
  type ClaudeCodeResidentArgsInput,
} from './args.js';

export {
  type DispatcherClaudeCodeConfig,
  readDispatcherClaudeCodeConfig,
  defaultDispatcherClaudeCodeConfig,
  DEFAULT_CLAUDE_CODE_BIN,
  DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS,
  ALLOWED_CLAUDE_CODE_PERMISSION_MODES,
} from './config.js';

export { BUILTIN_CLAUDE_CODE_PROVIDER_REF } from './provider-ref.js';

// The claude-code diagnostic surface now lives in this package (issue #209 cleanup).
export { claudeCodeAgentRuntimeDiagnostic } from './diagnostic.js';
