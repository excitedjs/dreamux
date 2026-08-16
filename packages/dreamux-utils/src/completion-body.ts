/**
 * Neutral completion-body resolution shared by host-side completion targets.
 *
 * A teammate completion is delivered back to the dispatcher as turn text. When
 * the result is short it is inlined verbatim; when it overflows the inline
 * budget the full result is spilled to an owner-only 0600 file under the
 * host-supplied spill directory and only the path is inlined, so a large result
 * never floods the dispatcher's context window.
 *
 * The spill directory is supplied by the host-side caller, so this module owns
 * no Dreamux layout contract — only the safe filename shape inside that
 * directory.
 */

import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureOwnerOnlyDir } from './os.js';

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

export interface CompletionBodyInput {
  result: string | null;
}
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
 * FULL result to a 0600 file (async fs only — no sync IO, repo rule #85) under
 * the caller-supplied `spillDir` and returns the path; the caller inlines only
 * that path. `spillDir` is supplied by the caller, so this module stays
 * runtime-neutral and never names a dispatcher id.
 */
export async function resolveCompletionBody(
  completion: CompletionBodyInput,
  spillDir: string,
): Promise<ResolvedCompletionBody> {
  const result = completion.result ?? '';
  const budget = completionInlineBudget();
  if (result.length <= budget) {
    return { kind: 'inline', text: result };
  }
  // Owner-only spill dir: the cache may hold full teammate output. Use the
  // shared helper so a pre-existing permissive dir is tightened and a symlink /
  // foreign-uid dir is rejected (issue #182 — same invariant as the run tree),
  // then a 0600 file + explicit chmod (writeFile's `mode` honors the umask).
  await ensureOwnerOnlyDir(spillDir);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // The storage key is deliberately opaque. Business labels and provider
    // identifiers never become filenames or surrogate Turn identifiers.
    const path = join(spillDir, `completion-${randomUUID()}.output`);
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(result, 'utf8');
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      return { kind: 'spilled', path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('failed to allocate an exclusive completion spill file');
}
