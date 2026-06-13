/**
 * Re-export shim: the Claude Code resident-session supervisor (and the
 * stream-json session types) now live in the published
 * `@excitedjs/agent-runtime-claude-code` package (issue #209 slice 4). Core and
 * tests keep importing them from this path; the implementation is owned by the
 * package.
 */
export {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeCodeSessionFactory,
  type ClaudeCodeSessionSpec,
  type TurnOutcome,
  type TurnSubmitOptions,
} from '@excitedjs/agent-runtime-claude-code';
