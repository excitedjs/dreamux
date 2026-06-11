import type { DispatcherStore } from '../../../state/dispatcher-store.js';
import {
  dispatcherCompletionSpillDir,
  dispatcherDir,
} from '../../../platform/paths.js';
import { dispatcherProcessEnv } from '../../../platform/package-bin.js';
import {
  dispatcherCodexAppServerErrorLogPath,
  dispatcherCodexAppServerLogPath,
} from './paths.js';
import {
  resolveCompletionBody,
  type ResolvedCompletionBody,
} from '../../completion-body.js';
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

/**
 * Frame a TeamMate completion as recognizable notification text. Delivered as
 * the body of a developer-role history item (not a fake user turn), so codex
 * treats it as injected context rather than user intent. The
 * `<teammate_session_completion>` wrapper + developer role are deliberate — a
 * neutral tag codex will not interpret as its native subagent system.
 *
 * Pure: the spill decision is made upstream and the resolved body is passed in,
 * so this function performs no IO.
 */
function frameCodexCompletion(
  completion: CompletionEnvelope,
  body: ResolvedCompletionBody,
): string {
  const inner =
    body.kind === 'inline'
      ? body.text
      : `The output is too long, so the full result was saved to a file: ${body.path}`;
  return [
    `<teammate_session_completion source="${completion.source}" ` +
      `id="${completion.id}" status="${completion.status}">`,
    inner,
    '</teammate_session_completion>',
  ].join('\n');
}

/**
 * Build the raw Responses API item injected into the dispatcher thread's
 * model-visible history via `thread/inject_items`. A `message` item with role
 * `developer` carries the completion as system-injected context — codex appends
 * it to history without starting a user turn (codex_thread.rs
 * `inject_response_items`). The shape matches codex's `ResponseItem::Message`
 * (`type: "message"`, `role`, `content`) with a `ContentItem::InputText`
 * (`type: "input_text"`); `id` / `phase` are omitted (codex `skip_serializing`).
 *
 * Role `developer` (not codex's own user-role `<subagent_notification>`) is
 * deliberate: that tag is wired to codex's real subagent system, whereas a
 * neutral developer message is model-visible text codex will not try to
 * interpret as engine-internal state.
 */
export async function buildCodexCompletionItem(
  completion: CompletionEnvelope,
  spillDir: string,
): Promise<Record<string, unknown>> {
  const body = await resolveCompletionBody(completion, spillDir);
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: frameCodexCompletion(completion, body) }],
  };
}

/**
 * Minimal user-turn text that wakes the idle dispatcher after a completion is
 * injected. The injected developer item carries the actual result; this turn
 * only triggers the model to read the just-injected notification and act.
 */
export const CODEX_COMPLETION_TRIGGER_TEXT =
  'A TeamMate session you dispatched has settled. Its outcome was just delivered ' +
  'into your context as a <teammate_session_completion> item. Review it and take ' +
  'any needed follow-up; if nothing is needed, you may end this turn.';

export const defaultCodexRuntimePaths: AgentRuntimePathContext = {
  dispatcherDir,
  stdoutLogPath: dispatcherCodexAppServerLogPath,
  stderrLogPath: dispatcherCodexAppServerErrorLogPath,
  completionSpillDir: dispatcherCompletionSpillDir,
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
