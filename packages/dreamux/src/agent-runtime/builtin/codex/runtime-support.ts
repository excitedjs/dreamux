import type { DispatcherStore } from '../../../state/dispatcher-store.js';
import { dispatcherDir } from '../../../platform/paths.js';
import {
  dispatcherCodexAppServerErrorLogPath,
  dispatcherCodexAppServerLogPath,
} from './paths.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeStateStore,
  AgentRuntimeTurnInput,
  TeamMateCompletionEnvelope,
} from '../../types.js';

/** Frame a TeamMate completion as the text of a delivered Codex turn. */
export function formatCodexTeamMateCompletion(
  completion: TeamMateCompletionEnvelope,
): string {
  return [
    `<teammate_session_completion teammate="${completion.teammateName}" ` +
      `session_id="${completion.sessionId ?? ''}" status="${completion.status}">`,
    completion.finalText,
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

export function isSystemTurn(
  input: AgentRuntimeTurnInput,
): input is Extract<AgentRuntimeTurnInput, { kind: 'system' }> {
  return 'kind' in input && input.kind === 'system';
}
