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

import { chmod, writeFile } from 'node:fs/promises';
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
  source: string;
  id: string;
  result: string | null;
}

/** Sanitize a name into a safe single path segment. */
function safeSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Spill file for a teammate completion result that overflows the inline budget.
 * The host writes the full result here and inlines only this path into the
 * dispatcher or TeamLeader turn, so a large result never floods the target
 * agent's context.
 * `spillDir` is the owning dispatcher's completion spill dir, supplied by the
 * caller so a TeamLeader delivery target still spills under its operator
 * dispatcher, not its composite runtime id. `source` and `id` are sanitized for
 * filename safety; the id is unique per completion (teammate name + turn id).
 */
export function teamMateCompletionOutputPath(
  spillDir: string,
  source: string,
  id: string,
): string {
  return join(spillDir, `teammate-${safeSegment(source)}-${safeSegment(id)}.output`);
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
  const path = teamMateCompletionOutputPath(
    spillDir,
    completion.source,
    completion.id,
  );
  // Owner-only spill dir: the cache may hold full teammate output. Use the
  // shared helper so a pre-existing permissive dir is tightened and a symlink /
  // foreign-uid dir is rejected (issue #182 — same invariant as the run tree),
  // then a 0600 file + explicit chmod (writeFile's `mode` honors the umask).
  await ensureOwnerOnlyDir(spillDir);
  await writeFile(path, result, { mode: 0o600 });
  await chmod(path, 0o600);
  return { kind: 'spilled', path };
}
