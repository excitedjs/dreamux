import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeProviderCatalog,
  UnsupportedAgentRuntimeProviderError,
  createBuiltinAgentRuntimeProviderCatalog,
  createCodexAgentRuntimeProvider,
} from '../src/agent-runtime/index.js';
import {
  UnknownBuiltinProviderError,
  createBuiltinProviderRegistry,
} from '../src/registry/index.js';
import { DispatcherStore } from '../src/runtime/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

function builtinCatalog(): AgentRuntimeProviderCatalog {
  return createBuiltinAgentRuntimeProviderCatalog({
    registry: createBuiltinProviderRegistry(),
    codex: { resolveBinPath: (bin) => bin },
  });
}

describe('AgentRuntimeProviderCatalog', () => {
  it('resolves builtin:codex through the registry-backed provider catalog', () => {
    const provider = builtinCatalog().resolve('builtin:codex');

    expect(provider.ref).toBe('builtin:codex');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.getCapabilities().last.supported).toBe(true);
    expect(provider.getCapabilities().context.supported).toBe(false);
    expect(
      provider.getCapabilities().teammateCompletion.map((shape) => shape.kind),
    ).toEqual(['codexInboxTurn']);
  });

  it('creates a Codex-backed AgentRuntime without starting it', () => {
    const dispatcher = testDispatcherConfig({ id: 'flow' });
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const row = store.get('flow');
    expect(row).not.toBeNull();

    const runtime = builtinCatalog().resolve('builtin:codex').createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      mcpServers: [],
      log: () => {
        /* test sink */
      },
    });

    expect(runtime.providerRef).toBe('builtin:codex');
    expect(runtime.getStatus()).toBe('declared');
  });

  it('resolves builtin:claude-code with the task-notification delivery shape', () => {
    const provider = builtinCatalog().resolve('builtin:claude-code');

    expect(provider.ref).toBe('builtin:claude-code');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.getCapabilities().last.supported).toBe(true);
    expect(provider.getCapabilities().context.supported).toBe(false);
    // Distinct delivery shape from Codex — proves the abstraction is not
    // Codex-only.
    expect(
      provider.getCapabilities().teammateCompletion.map((shape) => shape.kind),
    ).toEqual(['claudeCodeTaskNotification']);
  });

  it('does not expose the built-in Feishu channel through the runtime catalog', () => {
    expect(() => builtinCatalog().resolve('builtin:feishu')).toThrow(
      UnknownBuiltinProviderError,
    );
  });

  it('rejects unknown builtins before runtime construction', () => {
    expect(() => builtinCatalog().resolve('builtin:does-not-exist')).toThrow(
      UnknownBuiltinProviderError,
    );
  });

  it('reserves external refs without loading or executing them', () => {
    expect(() => builtinCatalog().resolve('npm:@example/dreamux-runtime')).toThrow(
      UnsupportedAgentRuntimeProviderError,
    );
    expect(() =>
      builtinCatalog().resolve('npm:@example/dreamux-runtime#provider'),
    ).toThrow(UnsupportedAgentRuntimeProviderError);
  });

  it('supports registry injection for future provider composition tests', () => {
    const registry = createBuiltinProviderRegistry();
    const descriptor = registry.resolve('builtin:codex');
    registry.registerImplementation(
      descriptor.id,
      createCodexAgentRuntimeProvider({
        descriptor,
        resolveBinPath: (bin) => bin,
      }),
    );
    const catalog = new AgentRuntimeProviderCatalog({ registry });

    expect(catalog.list().map((provider) => provider.ref)).toEqual([
      'builtin:codex',
    ]);
  });
});
