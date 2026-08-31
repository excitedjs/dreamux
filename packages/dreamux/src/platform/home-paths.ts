/**
 * Which path prefixes name *this host's* home directory.
 *
 * Anything that rewrites operator paths out of published text needs to know
 * which paths actually belong to this host. A string that merely looks like a
 * home path — a quoted example, another machine's layout in a pasted log — is
 * not this operator's, and blanking it destroys legible content for no privacy
 * gain. So this is a question about host identity, not a path this host builds,
 * which is why it lives beside `paths.ts` rather than inside it.
 *
 * One home can be reached under two names, the lexical `$HOME` and its canonical
 * target, so both are offered and the longest match wins.
 */
import { homedir } from 'node:os';

import { canonicalPath } from './paths.js';

let resolvedHomePathPrefixes: readonly string[] | null = null;

/**
 * This host's home prefixes, longest first.
 *
 * The canonical name costs a `realpath`, so it is resolved once by
 * {@link resolveHomePathPrefixes} during server start rather than on any hot
 * path. Until then only the lexical name is known: a caller under-rewrites
 * rather than claiming a home this process has not confirmed.
 */
export function homePathPrefixes(): readonly string[] {
  return resolvedHomePathPrefixes ?? orderedPathPrefixes([lexicalHomePath()]);
}

/**
 * Resolve the canonical home once, off the hot path. Idempotent, and never
 * throws: an unresolvable home leaves the lexical name standing alone.
 */
export async function resolveHomePathPrefixes(): Promise<readonly string[]> {
  const lexical = lexicalHomePath();
  const canonical =
    lexical === '' ? '' : normalizePathPrefix(await canonicalPath(lexical));
  resolvedHomePathPrefixes = orderedPathPrefixes([lexical, canonical]);
  return resolvedHomePathPrefixes;
}

/** Test hook: forget the resolved home so the next resolve reads the environment. */
export function resetHomePathPrefixes(): void {
  resolvedHomePathPrefixes = null;
}

function lexicalHomePath(): string {
  try {
    return normalizePathPrefix(homedir());
  } catch {
    return '';
  }
}

/**
 * A trailing separator is stripped so `/home/me/` and `/home/me` are one
 * prefix — and so a home of `/` normalizes to the empty string and is dropped
 * rather than matching every absolute path in sight.
 */
function normalizePathPrefix(path: string): string {
  return path.replace(/[\\/]+$/u, '');
}

function orderedPathPrefixes(prefixes: readonly string[]): readonly string[] {
  return [...new Set(prefixes)]
    .filter((prefix) => prefix !== '')
    .sort((left, right) => right.length - left.length);
}
