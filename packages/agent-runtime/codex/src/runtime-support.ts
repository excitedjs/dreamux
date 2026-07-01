import type { CompletionEnvelope } from '@excitedjs/dreamux-types';

import {
  resolveCompletionBody,
  type ResolvedCompletionBody,
} from '@excitedjs/dreamux-utils';

/**
 * Build the process env for a Codex app-server child. The neutral env boundary
 * (issue #209 cleanup) is `{ ...process.env, ...injectEnv, ...extraEnv }`:
 *   - `injectEnv` is the host's optional neutral env-injection seam from the
 *     create context (empty today); core owns what it injects.
 *   - `extraEnv` is THIS provider's own `config.extra_env`, merged last so a
 *     dispatcher can override an injected value.
 * The child inherits the operator's ambient `CODEX_HOME` like a vanilla
 * `codex` invocation — Dreamux creates no dispatcher-private Codex home (MVP),
 * so there is nothing to strip.
 */
export function codexProcessEnv(
  injectEnv: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...globalThis.process.env, ...injectEnv, ...extraEnv };
}

/**
 * Frame a TeamMate completion as recognizable notification text. Delivered as
 * the body of a developer-role history item (not a fake user turn), so codex
 * treats it as injected context rather than user intent.
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
 * it to history without starting a user turn.
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

export function buildCodexSystemPromptAppendItem(
  systemPromptAppend: string,
): Record<string, unknown> {
  return {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: systemPromptAppend,
      },
    ],
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
