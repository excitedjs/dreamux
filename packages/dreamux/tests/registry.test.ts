import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PROVIDERS,
  CapabilityRegistry,
  DuplicateCapabilityError,
  DuplicateProviderError,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
  capabilityId,
  createBuiltinRegistry,
  type ProviderDescriptor,
} from '../src/registry/index.js';
import { InvalidProviderRefError, parseProviderRef } from '../src/registry/provider-ref.js';

function descriptor(id: string, kind: ProviderDescriptor['kind'] = 'channel'): ProviderDescriptor {
  return { id, kind, ref: parseProviderRef(`builtin:${id}`), capabilities: [] };
}

describe('CapabilityRegistry — registration', () => {
  it('registers and looks up a provider', () => {
    const registry = new CapabilityRegistry();
    registry.register(descriptor('feishu'));
    expect(registry.has('feishu')).toBe(true);
    expect(registry.get('feishu')?.kind).toBe('channel');
  });

  it('rejects a duplicate provider id', () => {
    const registry = new CapabilityRegistry();
    registry.register(descriptor('feishu'));
    expect(() => registry.register(descriptor('feishu'))).toThrow(DuplicateProviderError);
  });

  it('rejects duplicate capability ids within a provider', () => {
    const registry = new CapabilityRegistry();
    const dup: ProviderDescriptor = {
      id: 'feishu',
      kind: 'channel',
      ref: parseProviderRef('builtin:feishu'),
      capabilities: [
        { id: capabilityId('feishu', 'reply'), kind: 'reply' },
        { id: capabilityId('feishu', 'reply'), kind: 'reply' },
      ],
    };
    expect(() => registry.register(dup)).toThrow(DuplicateCapabilityError);
  });

  it('lists providers by kind', () => {
    const registry = new CapabilityRegistry();
    registry.register(descriptor('feishu', 'channel'));
    registry.register(descriptor('codex', 'agentRuntime'));
    expect(registry.listByKind('agentRuntime').map((d) => d.id)).toEqual(['codex']);
    expect(registry.list()).toHaveLength(2);
  });
});

describe('capabilityId', () => {
  it('namespaces a capability under its provider', () => {
    expect(capabilityId('feishu', 'mcpServer')).toBe('feishu:mcpServer');
  });
});

describe('CapabilityRegistry — resolve', () => {
  it('resolves a registered builtin ref (string or object)', () => {
    const registry = createBuiltinRegistry();
    expect(registry.resolve('builtin:feishu').id).toBe('feishu');
    expect(registry.resolve(parseProviderRef('builtin:codex')).kind).toBe('agentRuntime');
  });

  it('throws on an unknown builtin', () => {
    const registry = createBuiltinRegistry();
    expect(() => registry.resolve('builtin:does-not-exist')).toThrow(
      UnknownBuiltinProviderError,
    );
  });

  it('refuses to resolve a reserved external npm ref', () => {
    const registry = createBuiltinRegistry();
    expect(() => registry.resolve('npm:@example/dreamux-provider')).toThrow(
      ReservedExternalProviderError,
    );
    expect(() =>
      registry.resolve('npm:@example/dreamux-provider#named'),
    ).toThrow(ReservedExternalProviderError);
  });

  it('surfaces malformed refs through the parser', () => {
    const registry = createBuiltinRegistry();
    expect(() => registry.resolve('not-a-ref')).toThrow(InvalidProviderRefError);
  });
});

describe('createBuiltinRegistry', () => {
  it('registers exactly the confirmed phase-1 builtins', () => {
    const registry = createBuiltinRegistry();
    const ids = registry.list().map((d) => d.id).sort();
    expect(ids).toEqual(['claude-code', 'codex', 'feishu']);
    for (const spec of BUILTIN_PROVIDERS) {
      expect(registry.resolve(`builtin:${spec.id}`).kind).toBe(spec.kind);
    }
  });

  it('does not execute or expose external providers', () => {
    const registry = createBuiltinRegistry();
    // Reserved external refs never become registered providers.
    expect(registry.has('@example/dreamux-provider')).toBe(false);
  });
});
