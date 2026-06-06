import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeProviderCatalog,
  UnsupportedAgentRuntimeProviderError,
  WrongProviderKindError,
  createBuiltinAgentRuntimeProviderCatalog,
} from '../src/agent-runtime/index.js';
import {
  UnknownBuiltinProviderError,
  createBuiltinRegistry,
} from '../src/registry/index.js';
import { DispatcherStore } from '../src/runtime/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

function builtinCatalog(): AgentRuntimeProviderCatalog {
  return createBuiltinAgentRuntimeProviderCatalog({
    codex: { resolveBinPath: (bin) => bin },
  });
}

describe('AgentRuntimeProviderCatalog', () => {
  it('resolves builtin:codex through the registry-backed provider catalog', () => {
    const provider = builtinCatalog().resolve('builtin:codex');

    expect(provider.ref).toBe('builtin:codex');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.delivery.teammateCompletion.map((shape) => shape.kind)).toEqual([
      'codexInboxTurn',
    ]);
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
    // Distinct delivery shape from Codex — proves the abstraction is not
    // Codex-only.
    expect(provider.delivery.teammateCompletion.map((shape) => shape.kind)).toEqual([
      'claudeCodeTaskNotification',
    ]);
  });

  it('rejects non-runtime builtins through the runtime catalog', () => {
    expect(() => builtinCatalog().resolve('builtin:feishu')).toThrow(
      WrongProviderKindError,
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
    const catalog = new AgentRuntimeProviderCatalog({
      registry: createBuiltinRegistry(),
      providers: [builtinCatalog().resolve('builtin:codex')],
    });

    expect(catalog.list().map((provider) => provider.ref)).toEqual([
      'builtin:codex',
    ]);
  });
});
