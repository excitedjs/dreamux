/**
 * Host-side adapters the core Codex adapter uses to build the neutral
 * `AgentRuntimeCreateContext` for `@excitedjs/agent-runtime-codex` (issue #209
 * slice 3). These own the Dreamux host contracts the runtime package must not
 * reconstruct: the per-dispatcher path context (logs in the central log tree,
 * completion spill in the cache tree) and the dispatcher-store-backed neutral
 * state sink.
 */
import type { DispatcherStore } from '../../../state/dispatcher-store.js';
import {
  dispatcherCompletionSpillDir,
  dispatcherDir,
} from '../../../platform/paths.js';
import {
  dispatcherCodexAppServerErrorLogPath,
  dispatcherCodexAppServerLogPath,
} from './paths.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeStateStore,
} from '../../types.js';

/**
 * The default per-dispatcher path context for a Codex runtime: state in the
 * dispatcher dir, stdout/stderr in the central codex-app-server log tree, and
 * completion spill in the cache tree.
 */
export const defaultCodexRuntimePaths: AgentRuntimePathContext = {
  dispatcherDir,
  stdoutLogPath: dispatcherCodexAppServerLogPath,
  stderrLogPath: dispatcherCodexAppServerErrorLogPath,
  completionSpillDir: dispatcherCompletionSpillDir,
};

/** Adapt the host dispatcher store to the neutral state sink the runtime writes. */
export function codexRowStateStore(
  dispatchers: DispatcherStore,
): AgentRuntimeStateStore {
  return {
    setStatus: (id, status, extras) => dispatchers.setStatus(id, status, extras),
    setThreadId: (id, threadId) => dispatchers.setThreadId(id, threadId),
    recordLostThread: (id, lostThreadId, newThreadId, error) =>
      dispatchers.recordLostThread(id, lostThreadId, newThreadId, error),
  };
}
