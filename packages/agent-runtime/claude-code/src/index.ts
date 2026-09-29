/**
 * `@excitedjs/agent-runtime-claude-code` — the built-in Claude Code plugin for
 * Dreamux (`builtin:claude-code`). Its default export is the Dreamux plugin
 * factory: the plugin contributes the Claude Code `AgentRuntimeProvider`,
 * which implements the `@excitedjs/dreamux-types` contract.
 * `createClaudeCodeAgentRuntimeProvider` is the named export for constructing
 * the bare provider directly (embedders, tests). This package never imports
 * `@excitedjs/dreamux` core.
 */

export { default } from './plugin.js';

export {
  createClaudeCodeAgentRuntimeProvider,
  type ClaudeCodeAgentRuntimeProviderOptions,
} from './provider.js';

export {
  type DispatcherClaudeCodeConfig,
  readDispatcherClaudeCodeConfig,
  defaultDispatcherClaudeCodeConfig,
  DEFAULT_CLAUDE_CODE_BIN,
  DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS,
  ALLOWED_CLAUDE_CODE_PERMISSION_MODES,
} from './config.js';
