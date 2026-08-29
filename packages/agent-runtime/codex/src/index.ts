/**
 * `@excitedjs/agent-runtime-codex` — the built-in Codex Agent Runtime provider
 * for Dreamux (alias `builtin:codex`). Implements the
 * `@excitedjs/dreamux-types` `AgentRuntimeProvider` contract; never imports
 * `@excitedjs/dreamux` core.
 */

export {
  default,
  createCodexAgentRuntimeProvider,
  codexSystemPromptReplace,
  codexRuntimeArgsForMcpServers,
  dispatcherCodexConfig,
  CODEX_AGENT_RUNTIME_CAPABILITIES,
  type CodexAgentRuntimeProviderOptions,
} from './provider.js';

export { resolveCodexBinPath } from './bin.js';

// The concrete runtime class and the deps it is constructed from are both
// implementation details: the package's public surface is the provider factory
// and its options, and Core only ever holds the neutral `start`/`submit`/`stop`
// handle `createRuntime` returns.

export {
  CodexProcess,
  type CodexProcessOptions,
  type CodexProcessExit,
  type CodexProcessExitHandler,
} from './supervisor.js';

export {
  CodexWsClient,
  type CodexWsClientOptions,
  type NotificationHandler,
} from './rpc.js';

export type {
  ServerNotification,
  ServerRequest,
  ThreadStartResponse,
  TurnStartResponse,
} from './types.js';

export { performInitializeHandshake } from './handshake.js';

export { codexMcpServerArgs } from './mcp-config.js';

export {
  parseCodexArgs,
  codexArgsFromConfig,
  codexArgsToCli,
  type ParsedCodexArgs,
} from './args.js';

export {
  type DispatcherCodexConfig,
  readDispatcherCodexConfig,
  defaultDispatcherCodexConfig,
  DEFAULT_CODEX_BIN,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  ALLOWED_APPROVAL_POLICIES,
  ALLOWED_SANDBOX_MODES,
} from './config.js';

export {
  MIN_CODEX_VERSION,
  parseCodexVersion,
  codexVersionSatisfies,
} from './version.js';

export { BUILTIN_CODEX_PROVIDER_REF } from './provider-ref.js';

// The Codex diagnostic surface now lives in this package (issue #209 cleanup):
// the provider diagnostic, the Codex home/auth validation, and the Codex
// home/config path resolvers. Core's doctor + onboard consume these directly.
export { codexAgentRuntimeDiagnostic } from './diagnostic.js';

export {
  DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES,
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
  assertDispatcherCodexHomeReady,
  formatDispatcherCodexHomeErrors,
  type DispatcherCodexHomeDoctor,
  type DispatcherCodexHomeDoctorContext,
  type DispatcherCodexHomeDoctorResult,
} from './codex-home.js';

export {
  operatorCodexHome,
  dispatcherCodexHome,
  dispatcherCodexConfigPath,
} from './paths.js';
