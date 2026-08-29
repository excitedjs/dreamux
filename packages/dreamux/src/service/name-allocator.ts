import { randomBytes, randomInt } from 'node:crypto';

/**
 * Concrete name allocation shared by Teams and agent entities.
 *
 * Model-supplied names are base slugs, never durable addresses:
 *
 *   Team:                    `${slug}-${suffix}`
 *   Dispatcher-scoped mate:  `${slug}-${suffix}`
 *   Team-scoped TeamMate:    `tm-${slug}-${suffix}`
 *   TeamLeader:              `tl-${team_slug}-${suffix}`
 *
 * Every generated suffix contains 4-8 lowercase base36 characters. Callers
 * enforce uniqueness in the authoritative collection that owns each namespace.
 */

export const CONCRETE_NAME_MAX = 64;
export const NAME_SUFFIX_MIN_LENGTH = 4;
export const NAME_SUFFIX_MAX_LENGTH = 8;
/**
 * How many random suffixes one allocation tries before giving up. Shared by the
 * synchronous and asynchronous allocators so both agree on when a collision
 * streak is a real failure rather than bad luck.
 */
export const NAME_ALLOCATION_MAX_ATTEMPTS = 16;
const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Which namespace a name is being minted into. The caller states it from the
 * owner it is allocating for; it is not read back from any persisted record.
 * The prefixes are durable on-disk addresses, so the `tm-`/`tl-` shapes stay
 * byte-identical to every name already allocated.
 */
export type ConcreteNameKind =
  | 'team'
  | 'team-leader'
  | 'team-teammate'
  | 'dispatcher-teammate';

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

/** A CSPRNG-backed lowercase base36 suffix with a 4-8 character length. */
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
  if (kind === 'team-leader') return 'tl-';
  if (kind === 'team-teammate') return 'tm-';
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
    input.kind === 'team-leader' ? (input.teamSlug ?? input.base) : input.base,
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
      `${input.maxAttempts ?? NAME_ALLOCATION_MAX_ATTEMPTS} attempts ` +
      `(base ${JSON.stringify(input.base)})`,
  );
}

/**
 * Allocate the first candidate the namespace owner accepts, asynchronously.
 *
 * The callback decides one candidate at a time and may do the real work — a
 * free-name probe, or the exclusive publication that actually takes the name.
 * Returning `false` means "this candidate is not available, offer another"; a
 * failure the caller must not paper over is thrown, not swallowed.
 */
export async function allocateConcreteNameAsync(input: {
  kind: ConcreteNameKind;
  base: string;
  teamSlug?: string;
  accept: (name: string) => Promise<boolean>;
  generateSuffix?: SuffixGenerator;
  maxAttempts?: number;
}): Promise<string> {
  for (const candidate of concreteNameCandidates(input)) {
    if (await input.accept(candidate)) return candidate;
  }
  throw new Error(
    `could not allocate a unique ${input.kind} name after ` +
      `${input.maxAttempts ?? NAME_ALLOCATION_MAX_ATTEMPTS} attempts ` +
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
  const generate = input.generateSuffix ?? generateNameSuffix;
  const maxAttempts = input.maxAttempts ?? NAME_ALLOCATION_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    yield buildConcreteName({
      kind: input.kind,
      base: input.base,
      ...(input.teamSlug !== undefined ? { teamSlug: input.teamSlug } : {}),
      suffix: generate(),
    });
  }
}
