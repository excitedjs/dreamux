import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type {
  AgentRuntimeProvider,
  ChannelProvider,
} from '@excitedjs/dreamux-types';
import {
  describeType,
  isPlainObject,
} from '@excitedjs/dreamux-utils';

import {
  InvalidProviderRefError,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
  formatProviderRef,
  parseProviderRef,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';

export function resolveConfigProvider(
  rawProvider: string,
  expectedKind: ProviderDescriptor['kind'],
  file: string,
  prefix: string,
  providerRegistry: ProviderRegistry,
): { ref: string; descriptor: ProviderDescriptor } {
  try {
    const descriptor = providerRegistry.resolve(rawProvider);
    if (descriptor.kind !== expectedKind) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' is a ${descriptor.kind} provider, expected ${expectedKind}`,
      );
    }
    return { ref: formatProviderRef(descriptor.ref), descriptor };
  } catch (err) {
    if (err instanceof InvalidProviderRefError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider is invalid: ${err.message}`,
      );
    }
    if (err instanceof ReservedExternalProviderError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' was not loaded as an external ${expectedKind} provider.\n` +
          err.message,
      );
    }
    if (err instanceof UnknownBuiltinProviderError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider references unknown builtin provider '${err.id}'`,
      );
    }
    throw err;
  }
}

/**
 * Every well-formed `agents[].provider` ref the loader should resolve. Malformed
 * refs are dropped here; normal config validation reports them with context.
 */
export function agentProviderRefs(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  return providerRefsFrom(raw['agents'], (agent) => agent['provider']);
}

export function channelProviderRefs(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const dispatchers = raw['dispatchers'];
  if (!Array.isArray(dispatchers)) return [];
  const out: string[] = [];
  for (const dispatcher of dispatchers) {
    if (!isPlainObject(dispatcher)) continue;
    out.push(
      ...providerRefsFrom(dispatcher['channels'], (channel) => channel['provider']),
    );
  }
  return out;
}

function providerRefsFrom(
  entries: unknown,
  pick: (entry: Record<string, unknown>) => unknown,
): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const provider = pick(entry);
    if (typeof provider !== 'string') continue;
    try {
      out.push(parseProviderRef(provider).raw);
    } catch {
      // The normal config validation path reports malformed refs with context.
    }
  }
  return out;
}

export function asAgentRuntimeProvider(
  value: unknown,
): AgentRuntimeProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<AgentRuntimeProvider>;
  if (
    typeof candidate.ref !== 'string' ||
    candidate.descriptor === undefined ||
    typeof candidate.getCapabilities !== 'function' ||
    typeof candidate.createRuntime !== 'function'
  ) {
    return null;
  }
  return value as AgentRuntimeProvider;
}

export function asChannelProvider(value: unknown): ChannelProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ChannelProvider>;
  if (
    typeof candidate.ref !== 'string' ||
    candidate.descriptor === undefined ||
    typeof candidate.createSession !== 'function'
  ) {
    return null;
  }
  return value as ChannelProvider;
}

export function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  file: string,
  prefix = '',
): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be a boolean (got ${describeType(v)})`,
  );
}

export function redactConfigSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) redactConfigSecrets(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretConfigKey(key)) {
      value[key] = '<redacted>';
      continue;
    }
    redactConfigSecrets(child);
  }
}

function isSecretConfigKey(key: string): boolean {
  return /(?:secret|password|passwd|token|authorization|cookie|credential|api[_-]?key|private[_-]?key|client[_-]?secret)/i.test(
    key,
  );
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return path;
  return path;
}
