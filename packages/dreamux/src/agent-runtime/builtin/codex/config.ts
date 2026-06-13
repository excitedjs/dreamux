/**
 * Re-export shim: Codex runtime config (schema/defaults/reader/accessor) now
 * lives in `@excitedjs/agent-runtime-codex` (issue #209 slice 3). Imported via
 * the package's light `./config` subpath so the cold-start config path never
 * pulls in the Codex runtime engine (ws/supervisor).
 */
export {
  type DispatcherCodexConfig,
  readDispatcherCodexConfig,
  defaultDispatcherCodexConfig,
  dispatcherCodexConfig,
  DEFAULT_CODEX_BIN,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  ALLOWED_APPROVAL_POLICIES,
  ALLOWED_SANDBOX_MODES,
} from '@excitedjs/agent-runtime-codex/config';
