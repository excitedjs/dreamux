import type { DispatcherStore } from '../../../state/dispatcher-store.js';
import { dispatcherDir } from '../../../platform/paths.js';
import { dispatcherProcessEnv } from '../../../platform/package-bin.js';
import {
  dispatcherCodexAppServerErrorLogPath,
  dispatcherCodexAppServerLogPath,
} from './paths.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeStateStore,
  CompletionEnvelope,
} from '../../types.js';

/**
 * Process env for a Codex app-server child. Starts from the neutral package-bin
 * env (PATH with the package bins prepended) and strips `CODEX_HOME` so the
 * child follows the operator's global `~/.codex` instead of any inherited
 * override — a Codex-specific concern that must not live in the runtime-neutral
 * `platform/package-bin` builder (issue #143 de-leak).
 */
export function codexProcessEnv(
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = dispatcherProcessEnv(globalThis.process.env, extraEnv);
  delete env['CODEX_HOME'];
  return env;
}

/** Frame a TeamMate completion as the text of a delivered Codex turn. */
export function formatCodexTeamMateCompletion(
  completion: CompletionEnvelope,
): string {
  return [
    `<teammate_session_completion source="${completion.source}" ` +
      `id="${completion.id}" status="${completion.status}">`,
    completion.result,
    '</teammate_session_completion>',
  ].join('\n');
}

export const defaultCodexRuntimePaths: AgentRuntimePathContext = {
  dispatcherDir,
  stdoutLogPath: dispatcherCodexAppServerLogPath,
  stderrLogPath: dispatcherCodexAppServerErrorLogPath,
};

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
