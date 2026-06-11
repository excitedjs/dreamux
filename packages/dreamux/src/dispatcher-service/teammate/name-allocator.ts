import { randomBytes } from 'node:crypto';

import type { TeamMateRole } from './types.js';

/**
 * Concrete TeamMate name allocation (issue #188).
 *
 * The agent-supplied `name` is a short BASE SLUG / display hint, not the final
 * durable address. The service allocates a concrete, unique, never-reused name:
 *
 *   ordinary TeamMate: `${slug}-${suffix}`
 *   Team member:       `tm-${slug}-${suffix}`
 *   TeamLeader:        `tl-${team_slug}-${suffix}`
 *
 * `suffix` is 8 lowercase base36 chars; the slug portion is truncated so the
 * whole name fits the existing 64-char TeamMate-name limit. Uniqueness is
 * enforced against ALL persisted identities (including closed ones), so a
 * concrete name is never reused; on collision the suffix is regenerated and
 * retried, then fails loudly.
 */

export const TEAMMATE_NAME_MAX = 64;
export const NAME_SUFFIX_LENGTH = 8;
const DEFAULT_MAX_ATTEMPTS = 16;
const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random generator hook so tests can force collisions deterministically. */
export type SuffixGenerator = () => string;

/**
 * Sanitize an agent-supplied base into a slug: lowercased, restricted to the
 * TeamMate-name charset, guaranteed to start with an alphanumeric, with a
 * non-empty fallback so a junk/empty base never yields an empty slug.
 */
export function slugifyName(base: string): string {
  const lowered = base.toLowerCase();
  let slug = lowered.replace(/[^a-z0-9._-]+/g, '-');
  slug = slug.replace(/^[^a-z0-9]+/, ''); // must start alnum
  slug = slug.replace(/[-._]+$/, ''); // no trailing separators
  return slug === '' ? 'tm' : slug;
}

/** Eight lowercase base36 characters from a CSPRNG. */
export function generateNameSuffix(): string {
  const bytes = randomBytes(NAME_SUFFIX_LENGTH);
  let out = '';
  for (let i = 0; i < NAME_SUFFIX_LENGTH; i += 1) {
    out += BASE36[bytes[i]! % 36];
  }
  return out;
}

function rolePrefix(role: TeamMateRole): string {
  if (role === 'team_leader') return 'tl-';
  if (role === 'team_member') return 'tm-';
  return '';
}

/**
 * Build one concrete-name candidate for a (role, base/team_slug, suffix). The
 * slug is truncated so `${prefix}${slug}-${suffix}` is at most 64 chars.
 */
export function buildConcreteName(input: {
  role: TeamMateRole;
  base: string;
  teamSlug?: string;
  suffix: string;
}): string {
  const prefix = rolePrefix(input.role);
  const rawSlug = slugifyName(
    input.role === 'team_leader' ? (input.teamSlug ?? input.base) : input.base,
  );
  const reserved = prefix.length + 1 + input.suffix.length; // '-' before suffix
  const maxSlug = Math.max(1, TEAMMATE_NAME_MAX - reserved);
  let slug = rawSlug.slice(0, maxSlug).replace(/[-._]+$/, '');
  if (slug === '') slug = 'tm';
  return `${prefix}${slug}-${input.suffix}`;
}

/**
 * Allocate a concrete name, regenerating the suffix on collision (a name is
 * "taken" if `exists` returns true — callers pass a predicate over ALL
 * persisted identities, closed included). Fails loudly when the attempt budget
 * is exhausted rather than returning a possibly-colliding name.
 */
export function allocateConcreteName(input: {
  role: TeamMateRole;
  base: string;
  teamSlug?: string;
  exists: (name: string) => boolean;
  generateSuffix?: SuffixGenerator;
  maxAttempts?: number;
}): string {
  const generate = input.generateSuffix ?? generateNameSuffix;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = buildConcreteName({
      role: input.role,
      base: input.base,
      ...(input.teamSlug !== undefined ? { teamSlug: input.teamSlug } : {}),
      suffix: generate(),
    });
    if (!input.exists(candidate)) return candidate;
  }
  throw new Error(
    `could not allocate a unique TeamMate name after ${maxAttempts} attempts ` +
      `(base ${JSON.stringify(input.base)}, role ${input.role})`,
  );
}
