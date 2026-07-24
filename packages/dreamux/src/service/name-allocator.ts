import { randomBytes, randomInt } from 'node:crypto';

import type { AgentEntityRole } from './agent-entity/types.js';

/**
 * Concrete name allocation shared by Teams and agent entities.
 *
 * Model-supplied names are base slugs, never durable addresses:
 *
 *   Team:              `${slug}-${suffix}`
 *   ordinary TeamMate: `${slug}-${suffix}`
 *   Team member:       `tm-${slug}-${suffix}`
 *   TeamLeader:        `tl-${team_slug}-${suffix}`
 *
 * Suffixes contain 4-8 lowercase base36 characters. Callers enforce
 * never-reuse by checking every persisted name in their own collection,
 * including closed records.
 */

export const CONCRETE_NAME_MAX = 64;
export const NAME_SUFFIX_MIN_LENGTH = 4;
export const NAME_SUFFIX_MAX_LENGTH = 8;
const DEFAULT_MAX_ATTEMPTS = 16;
const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type ConcreteNameKind = AgentEntityRole | 'team';

/** Random generator hook so tests can force collisions deterministically. */
export type SuffixGenerator = () => string;

/**
 * Sanitize a model-supplied base into the name charset: lowercased, restricted
 * to the shared Team/TeamMate charset, and guaranteed to start alphanumeric.
 */
export function slugifyName(base: string): string {
  const lowered = base.toLowerCase();
  let slug = lowered.replace(/[^a-z0-9._-]+/g, '-');
  slug = slug.replace(/^[^a-z0-9]+/, '');
  slug = slug.replace(/[-._]+$/, '');
  return slug === '' ? 'tm' : slug;
}

/** A CSPRNG-backed lowercase base36 suffix whose length is uniformly 4-8. */
export function generateNameSuffix(): string {
  const length = randomInt(
    NAME_SUFFIX_MIN_LENGTH,
    NAME_SUFFIX_MAX_LENGTH + 1,
  );
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE36[bytes[i]! % 36];
  }
  return out;
}

function kindPrefix(kind: ConcreteNameKind): string {
  if (kind === 'team_leader') return 'tl-';
  if (kind === 'team_member') return 'tm-';
  return '';
}

/** Build one concrete-name candidate while preserving the 64-char limit. */
export function buildConcreteName(input: {
  kind: ConcreteNameKind;
  base: string;
  teamSlug?: string;
  suffix: string;
}): string {
  const prefix = kindPrefix(input.kind);
  const rawSlug = slugifyName(
    input.kind === 'team_leader' ? (input.teamSlug ?? input.base) : input.base,
  );
  const reserved = prefix.length + 1 + input.suffix.length;
  const maxSlug = Math.max(1, CONCRETE_NAME_MAX - reserved);
  let slug = rawSlug.slice(0, maxSlug).replace(/[-._]+$/, '');
  if (slug === '') slug = 'tm';
  return `${prefix}${slug}-${input.suffix}`;
}

/** Allocate the first free concrete name, retrying random suffix collisions. */
export function allocateConcreteName(input: {
  kind: ConcreteNameKind;
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
      kind: input.kind,
      base: input.base,
      ...(input.teamSlug !== undefined ? { teamSlug: input.teamSlug } : {}),
      suffix: generate(),
    });
    if (!input.exists(candidate)) return candidate;
  }
  throw new Error(
    `could not allocate a unique ${input.kind} name after ${maxAttempts} attempts ` +
      `(base ${JSON.stringify(input.base)})`,
  );
}
