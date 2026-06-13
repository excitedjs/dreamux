/**
 * Re-export shim: Claude Code runtime config (schema/defaults/reader/accessor)
 * now lives in `@excitedjs/agent-runtime-claude-code` (issue #209 slice 4).
 * Imported via the package's light `./config` subpath so the cold-start config
 * path never pulls in the Claude Code runtime engine.
 */
export {
  type DispatcherClaudeCodeConfig,
  readDispatcherClaudeCodeConfig,
  defaultDispatcherClaudeCodeConfig,
  dispatcherClaudeCodeConfig,
  DEFAULT_CLAUDE_CODE_BIN,
  DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS,
  ALLOWED_CLAUDE_CODE_PERMISSION_MODES,
} from '@excitedjs/agent-runtime-claude-code/config';
