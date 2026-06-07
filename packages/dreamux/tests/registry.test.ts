import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PROVIDERS,
  DuplicateProviderError,
  ProviderRegistry,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
  createBuiltinProviderRegistry,
  type ProviderDescriptor,
} from '../src/registry/index.js';
import { InvalidProviderRefError, parseProviderRef } from '../src/registry/provider-ref.js';

function descriptor(
  id: string,
  kind: ProviderDescriptor['kind'] = 'channel',
): ProviderDescriptor {
  return { id, kind, ref: parseProviderRef(`builtin:${id}`) };
}

describe('ProviderRegistry — registration', () => {
  it('registers and looks up a provider', () => {
    const registry = new ProviderRegistry();
    registry.register(descriptor('feishu'));
    expect(registry.has('feishu')).toBe(true);
    expect(registry.get('feishu')?.kind).toBe('channel');
  });

  it('rejects a duplicate provider id', () => {
    const registry = new ProviderRegistry();
    registry.register(descriptor('feishu'));
    expect(() => registry.register(descriptor('feishu'))).toThrow(
      DuplicateProviderError,
    );
  });

  it('lists providers by kind', () => {
    const registry = new ProviderRegistry();
    registry.register(descriptor('feishu', 'channel'));
    registry.register(descriptor('codex', 'agentRuntime'));
    expect(registry.listByKind('agentRuntime').map((d) => d.id)).toEqual([
      'codex',
    ]);
    expect(registry.list()).toHaveLength(2);
  });
});

describe('ProviderRegistry — resolve', () => {
  it('resolves a registered builtin ref (string or object)', () => {
    const registry = createBuiltinProviderRegistry();
    expect(registry.resolve('builtin:feishu').id).toBe('feishu');
    expect(registry.resolve(parseProviderRef('builtin:codex')).kind).toBe(
      'agentRuntime',
    );
  });

  it('throws on an unknown builtin', () => {
    const registry = createBuiltinProviderRegistry();
    expect(() => registry.resolve('builtin:does-not-exist')).toThrow(
      UnknownBuiltinProviderError,
    );
  });

  it('refuses to resolve a reserved external npm ref', () => {
    const registry = createBuiltinProviderRegistry();
    expect(() => registry.resolve('npm:@example/dreamux-provider')).toThrow(
      ReservedExternalProviderError,
    );
    expect(() =>
      registry.resolve('npm:@example/dreamux-provider#named'),
    ).toThrow(ReservedExternalProviderError);
  });

  it('surfaces malformed refs through the parser', () => {
    const registry = createBuiltinProviderRegistry();
    expect(() => registry.resolve('not-a-ref')).toThrow(InvalidProviderRefError);
  });
});

describe('createBuiltinProviderRegistry', () => {
  it('registers exactly the confirmed builtins', () => {
    const registry = createBuiltinProviderRegistry();
    const ids = registry.list().map((d) => d.id).sort();
    expect(ids).toEqual(['claude-code', 'codex', 'feishu']);
    for (const spec of BUILTIN_PROVIDERS) {
      expect(registry.resolve(`builtin:${spec.id}`).kind).toBe(spec.kind);
    }
  });

  it('does not duplicate provider capabilities', () => {
    const registry = createBuiltinProviderRegistry();
    expect(registry.resolve('builtin:codex')).not.toHaveProperty(
      'capabilities',
    );
    expect(registry.resolve('builtin:feishu')).not.toHaveProperty(
      'capabilities',
    );
  });

  it('does not execute or expose external providers', () => {
    const registry = createBuiltinProviderRegistry();
    // Reserved external refs never become registered providers.
    expect(registry.has('@example/dreamux-provider')).toBe(false);
  });
});
