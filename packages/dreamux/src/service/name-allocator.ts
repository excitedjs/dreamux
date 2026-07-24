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
 * Team suffixes contain 4-8 lowercase base36 characters. Agent-entity suffixes
 * retain their established fixed 8-character contract. Callers enforce
 * never-reuse in the authoritative collection that owns each namespace.
 */

export const CONCRETE_NAME_MAX = 64;
export const TEAM_NAME_SUFFIX_MIN_LENGTH = 4;
export const TEAM_NAME_SUFFIX_MAX_LENGTH = 8;
export const AGENT_NAME_SUFFIX_LENGTH = 8;
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

/** A CSPRNG-backed lowercase base36 suffix with the kind-specific length. */
export function generateNameSuffix(kind: ConcreteNameKind): string {
  const length = kind === 'team'
    ? randomInt(
        TEAM_NAME_SUFFIX_MIN_LENGTH,
        TEAM_NAME_SUFFIX_MAX_LENGTH + 1,
      )
    : AGENT_NAME_SUFFIX_LENGTH;
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
  for (const candidate of concreteNameCandidates(input)) {
    if (!input.exists(candidate)) return candidate;
  }
  throw new Error(
    `could not allocate a unique ${input.kind} name after ` +
      `${input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS} attempts ` +
      `(base ${JSON.stringify(input.base)})`,
  );
}

/**
 * Allocate and durably claim the first candidate accepted by the namespace
 * owner. Unlike the synchronous allocator, the claim callback is the
 * serialization point: it must atomically reject names claimed elsewhere.
 */
export async function claimConcreteName(input: {
  kind: ConcreteNameKind;
  base: string;
  teamSlug?: string;
  claim: (name: string) => Promise<boolean>;
  generateSuffix?: SuffixGenerator;
  maxAttempts?: number;
}): Promise<string> {
  for (const candidate of concreteNameCandidates(input)) {
    if (await input.claim(candidate)) return candidate;
  }
  throw new Error(
    `could not claim a unique ${input.kind} name after ` +
      `${input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS} attempts ` +
      `(base ${JSON.stringify(input.base)})`,
  );
}

function* concreteNameCandidates(input: {
  kind: ConcreteNameKind;
  base: string;
  teamSlug?: string;
  generateSuffix?: SuffixGenerator;
  maxAttempts?: number;
}): Generator<string> {
  const generate =
    input.generateSuffix ?? (() => generateNameSuffix(input.kind));
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    yield buildConcreteName({
      kind: input.kind,
      base: input.base,
      ...(input.teamSlug !== undefined ? { teamSlug: input.teamSlug } : {}),
      suffix: generate(),
    });
  }
}
