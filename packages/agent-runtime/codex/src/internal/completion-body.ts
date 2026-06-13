/**
 * Neutral completion-body resolution for the Codex runtime.
 *
 * A teammate completion is delivered back to the dispatcher as turn text. When
 * the result is short it is inlined verbatim; when it overflows the inline
 * budget the full result is spilled to an owner-only 0600 file under the
 * host-supplied spill directory and only the path is inlined, so a large result
 * never floods the dispatcher's context window.
 *
 * Vendored from the host's neutral `agent-runtime/completion-body.ts` so this
 * package never imports `@excitedjs/dreamux` core. The spill directory is
 * supplied by the host through the create context's path context, so this
 * module owns no Dreamux layout contract — only the safe filename shape inside
 * that directory.
 */

import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CompletionEnvelope } from '@excitedjs/dreamux-types';

import { ensureOwnerOnlyDir } from './os.js';

export const COMPLETION_INLINE_BUDGET_DEFAULT = 32_000;
export const COMPLETION_INLINE_BUDGET_MAX = 160_000;
const COMPLETION_INLINE_BUDGET_ENV = 'TASK_MAX_OUTPUT_LENGTH';

export type ResolvedCompletionBody =
  | { kind: 'inline'; text: string }
  | { kind: 'spilled'; path: string };

/** Sanitize a name into a safe single path segment. */
function safeSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Spill file for an overflowing completion result, inside `spillDir`. */
function completionOutputPath(
  spillDir: string,
  source: string,
  id: string,
): string {
  return join(spillDir, `teammate-${safeSegment(source)}-${safeSegment(id)}.output`);
}

/**
 * Resolve the effective inline budget from the environment: unset/blank or
 * non-positive falls back to the default; values above the upper bound are
 * clamped; a non-integer value falls back to the default.
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
 * FULL result to a 0600 file (async fs only) under the host-supplied
 * `spillDir`, then returns the path; the caller inlines only that path.
 */
export async function resolveCompletionBody(
  completion: CompletionEnvelope,
  spillDir: string,
): Promise<ResolvedCompletionBody> {
  const budget = completionInlineBudget();
  if (completion.result.length <= budget) {
    return { kind: 'inline', text: completion.result };
  }
  const path = completionOutputPath(spillDir, completion.source, completion.id);
  await ensureOwnerOnlyDir(spillDir);
  await writeFile(path, completion.result, { mode: 0o600 });
  await chmod(path, 0o600);
  return { kind: 'spilled', path };
}
