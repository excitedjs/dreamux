/**
 * The single Core-owned capability snapshot for an Agent Runtime provider.
 *
 * `getCapabilities()` returns a provider-owned, mutable object, so Core reads it
 * exactly once per loaded implementation and keeps the validated, frozen result.
 * Both consumers — the loader's contract check and the catalog's public
 * projection — go through {@link agentRuntimeCapabilitySnapshot}, so a provider
 * cannot pass a valid object at load and return a different or invalid one when
 * the catalog later asks.
 */
import {
  canonicalJsonValue,
  isPlainObject,
  JsonValueError,
} from '../platform/json-value.js';
import type { AgentRuntimeProvider, JsonValue } from '@excitedjs/dreamux-types';

/** Core's independent bounds on a provider's declared capabilities. */
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const PUBLIC_CONFIG_BOUNDS = {
  maxDepth: 4,
  maxEntries: 32,
  maxBytes: 4096,
} as const;

/**
 * A provider's declared capabilities after Core validated and froze them.
 *
 * Core never freezes the provider's own return object: mutating a value the
 * provider still owns would be an observable side effect of Core reading it.
 */
export interface AgentRuntimePublicCapabilities {
  readonly tags: readonly string[];
  readonly publicConfig: Readonly<Record<string, JsonValue>> | null;
}

export class InvalidAgentRuntimeCapabilitiesError extends Error {
  constructor(
    readonly providerRef: string,
    /** The violation alone, without the ref prefix, for callers that add one. */
    readonly detail: string,
  ) {
    super(
      `agent runtime provider ${JSON.stringify(providerRef)} declared invalid capabilities: ${detail}`,
    );
    this.name = 'InvalidAgentRuntimeCapabilitiesError';
  }
}

/**
 * One snapshot per implementation object, taken the first time Core reads it.
 *
 * The key is the implementation identity rather than a registration id, so the
 * loader (which has no catalog) and the catalog (which has no loader) share the
 * same entry, and a garbage-collected implementation takes its snapshot with it.
 */
const snapshots = new WeakMap<object, AgentRuntimePublicCapabilities>();

/**
 * Return the frozen capability snapshot for `implementation`, taking it on the
 * first call and reusing it forever after.
 */
export function agentRuntimeCapabilitySnapshot(
  implementation: AgentRuntimeProvider<unknown>,
  ref: string,
): AgentRuntimePublicCapabilities {
  const cached = snapshots.get(implementation);
  if (cached !== undefined) return cached;
  let declared: unknown;
  try {
    declared = implementation.getCapabilities();
  } catch (error) {
    throw new InvalidAgentRuntimeCapabilitiesError(
      ref,
      `getCapabilities threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const snapshot = normalizeCapabilities(declared, ref);
  snapshots.set(implementation, snapshot);
  return snapshot;
}

function normalizeCapabilities(
  declared: unknown,
  ref: string,
): AgentRuntimePublicCapabilities {
  if (!isPlainObject(declared)) {
    throw new InvalidAgentRuntimeCapabilitiesError(
      ref,
      'getCapabilities must return an object',
    );
  }
  return Object.freeze({
    tags: normalizeTags(declared['tags'], ref),
    publicConfig: normalizePublicConfig(declared['publicConfig'], ref),
  });
}

function normalizeTags(value: unknown, ref: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InvalidAgentRuntimeCapabilitiesError(ref, 'tags must be an array');
  }
  if (value.length > MAX_TAGS) {
    throw new InvalidAgentRuntimeCapabilitiesError(
      ref,
      `tags may hold at most ${MAX_TAGS} entries`,
    );
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_TAG_LENGTH
    ) {
      throw new InvalidAgentRuntimeCapabilitiesError(
        ref,
        `each tag must be a non-empty string of at most ${MAX_TAG_LENGTH} characters`,
      );
    }
    // Declaration order is the provider's; duplicates are simply collapsed.
    if (seen.has(entry)) continue;
    seen.add(entry);
    tags.push(entry);
  }
  return Object.freeze(tags);
}

function normalizePublicConfig(
  value: unknown,
  ref: string,
): Readonly<Record<string, JsonValue>> | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new InvalidAgentRuntimeCapabilitiesError(
      ref,
      'publicConfig must be an object when present',
    );
  }
  try {
    return canonicalJsonValue(value, PUBLIC_CONFIG_BOUNDS) as Readonly<
      Record<string, JsonValue>
    >;
  } catch (error) {
    if (error instanceof JsonValueError) {
      throw new InvalidAgentRuntimeCapabilitiesError(
        ref,
        `publicConfig ${error.message}`,
      );
    }
    throw error;
  }
}
