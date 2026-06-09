/**
 * Neutral completion-body resolution shared by every builtin runtime.
 *
 * A teammate completion is delivered back to the dispatcher as turn text. When
 * the result is short it is inlined verbatim; when it overflows the inline
 * budget the full result is spilled to a file and only the path is inlined, so a
 * large result never floods the dispatcher's context window.
 *
 * This module is runtime-neutral: both builtins import it WITHOUT importing each
 * other (the no-cross-builtin-import rule). It owns the spill decision; each
 * runtime owns how it frames the resolved body into its own delivery shape.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { teamMateCompletionOutputPath } from '../platform/paths.js';
import type { CompletionEnvelope } from './types.js';

/**
 * Inline character budget, mirroring claude-code's native task-output budget
 * (`getMaxTaskOutputLength`): default 32000 chars, `TASK_MAX_OUTPUT_LENGTH`
 * override, clamped to 160000. Counted in characters, not bytes.
 */
export const COMPLETION_INLINE_BUDGET_DEFAULT = 32_000;
export const COMPLETION_INLINE_BUDGET_MAX = 160_000;
const COMPLETION_INLINE_BUDGET_ENV = 'TASK_MAX_OUTPUT_LENGTH';

export type ResolvedCompletionBody =
  | { kind: 'inline'; text: string }
  | { kind: 'spilled'; path: string };

/**
 * Resolve the effective inline budget from the environment, in the spirit of
 * native `validateBoundedIntEnvVar`: unset/blank or non-positive falls back to
 * the default; values above the upper bound are clamped (not rejected). Stricter
 * than native's lenient `parseInt`, a value that is not a plain decimal integer
 * (e.g. `32k` or `123abc`) falls back to the default rather than being partially
 * parsed.
 */
export function completionInlineBudget(
  env: NodeJS.ProcessEnv = globalThis.process.env,
): number {
  const raw = env[COMPLETION_INLINE_BUDGET_ENV]?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) {
    return COMPLETION_INLINE_BUDGET_DEFAULT;
  }
  const parsed = Number(raw);
  if (parsed <= 0) {
    return COMPLETION_INLINE_BUDGET_DEFAULT;
  }
  return Math.min(parsed, COMPLETION_INLINE_BUDGET_MAX);
}

/**
 * Decide whether a completion result is inlined or spilled. Spilling writes the
 * FULL result to a 0600 file (async fs only — no sync IO, repo rule #85) and
 * returns the path; the caller inlines only that path.
 */
export async function resolveCompletionBody(
  completion: CompletionEnvelope,
): Promise<ResolvedCompletionBody> {
  const budget = completionInlineBudget();
  if (completion.result.length <= budget) {
    return { kind: 'inline', text: completion.result };
  }
  const path = teamMateCompletionOutputPath(completion.source, completion.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, completion.result, { mode: 0o600 });
  // Explicit chmod: writeFile's `mode` is subject to the process umask, so a
  // restrictive 0600 is not guaranteed by the open flags alone.
  await chmod(path, 0o600);
  return { kind: 'spilled', path };
}
