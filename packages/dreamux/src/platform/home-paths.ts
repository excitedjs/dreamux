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
import { isAbsolute } from 'node:path';

import { canonicalPath } from './paths.js';

/**
 * Resolve this host's home prefixes, longest first.
 *
 * The canonical name costs a `realpath`, so Server calls this once before it
 * constructs any conversation projection. The result is a value, not global
 * state. Resolution never throws: a missing home returns no prefixes, while a
 * canonicalization failure leaves the valid lexical name standing alone.
 */
export async function resolveHomePathPrefixes(): Promise<readonly string[]> {
  const lexical = lexicalHomePath();
  if (lexical === '') return [];
  try {
    const canonical = normalizePathPrefix(await canonicalPath(lexical));
    return orderedPathPrefixes([lexical, canonical]);
  } catch {
    return orderedPathPrefixes([lexical]);
  }
}

function lexicalHomePath(): string {
  try {
    const home = normalizePathPrefix(homedir());
    return isAbsolute(home) ? home : '';
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
