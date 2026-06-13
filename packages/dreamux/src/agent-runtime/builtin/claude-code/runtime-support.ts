/**
 * Host-side adapters the core Claude Code adapter uses to build the neutral
 * `AgentRuntimeCreateContext` for `@excitedjs/agent-runtime-claude-code` (issue
 * #209 slice 4). These own the Dreamux host contracts the runtime package must
 * not reconstruct: the per-dispatcher path context (the generated MCP config dir
 * in the dispatcher state dir, the resident child's stderr in the central
 * claude-code log tree, completion spill in the cache tree) and the
 * dispatcher-store-backed neutral state sink.
 *
 * The dispatcher launcher passes no `paths`/`state` in its host create context,
 * so the adapter falls back to these; the teammate launcher passes its own
 * per-teammate path context, which the adapter uses verbatim.
 */
import type { DispatcherStore } from '../../../state/dispatcher-store.js';
import { dispatcherCompletionSpillDir } from '../../../platform/paths.js';
import {
  dispatcherClaudeCodeDir,
  dispatcherClaudeCodeStreamLogPath,
} from './paths.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeStateStore,
} from '../../types.js';

/**
 * The default per-dispatcher path context for a Claude Code runtime. The
 * runtime writes its generated MCP config to `<dispatcherDir>/mcp.json`, so
 * `dispatcherDir` resolves to the dispatcher's `claude-code` state subdir —
 * keeping the generated `mcp.json` byte-identical to the pre-split
 * `dispatcherClaudeCodeMcpConfigPath`. The resident child has no stdout log
 * (its stdout is the in-process data plane), so both stdout/stderr map to the
 * single stream stderr log.
 */
export const defaultClaudeCodeRuntimePaths: AgentRuntimePathContext = {
  dispatcherDir: dispatcherClaudeCodeDir,
  stdoutLogPath: dispatcherClaudeCodeStreamLogPath,
  stderrLogPath: dispatcherClaudeCodeStreamLogPath,
  completionSpillDir: dispatcherCompletionSpillDir,
};

/** Adapt the host dispatcher store to the neutral state sink the runtime writes. */
export function claudeCodeRowStateStore(
  dispatchers: DispatcherStore,
): AgentRuntimeStateStore {
  return {
    setStatus: (id, status, extras) => dispatchers.setStatus(id, status, extras),
    setThreadId: (id, threadId) => dispatchers.setThreadId(id, threadId),
    recordLostThread: (id, lostThreadId, newThreadId, error) =>
      dispatchers.recordLostThread(id, lostThreadId, newThreadId, error),
  };
}
