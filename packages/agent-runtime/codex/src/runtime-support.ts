import type { CompletionEnvelope } from '@excitedjs/dreamux-types';

import {
  resolveCompletionBody,
  type ResolvedCompletionBody,
} from './internal/completion-body.js';

/**
 * Build the process env for a Codex app-server child. `buildBaseEnv` is supplied
 * by the host (it seeds `PATH` with the Dreamux package bins so the child can
 * reach the bundled MCP shims — a host packaging contract this package must not
 * reconstruct). This wrapper then strips `CODEX_HOME` so the child follows the
 * operator's global `~/.codex` instead of any inherited override — a
 * Codex-specific concern that must not live in the host's runtime-neutral env
 * builder (issue #143 de-leak). When no host builder is supplied (standalone /
 * tests) it falls back to the live process env.
 */
export function codexProcessEnv(
  buildBaseEnv:
    | ((extraEnv: Record<string, string>) => NodeJS.ProcessEnv)
    | undefined,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env =
    buildBaseEnv !== undefined
      ? buildBaseEnv(extraEnv)
      : { ...globalThis.process.env, ...extraEnv };
  delete env['CODEX_HOME'];
  return env;
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

/**
 * Minimal user-turn text that wakes the idle dispatcher after a completion is
 * injected. The injected developer item carries the actual result; this turn
 * only triggers the model to read the just-injected notification and act.
 */
export const CODEX_COMPLETION_TRIGGER_TEXT =
  'A TeamMate session you dispatched has settled. Its outcome was just delivered ' +
  'into your context as a <teammate_session_completion> item. Review it and take ' +
  'any needed follow-up; if nothing is needed, you may end this turn.';
