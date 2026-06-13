import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeProviderCatalog,
  ExternalAgentRuntimeProviderContractError,
  ExternalAgentRuntimeProviderLoadError,
  UnsupportedAgentRuntimeProviderError,
  WrongProviderKindError,
  createBuiltinAgentRuntimeProviderCatalog,
  createCodexAgentRuntimeProvider,
  loadExternalAgentRuntimeProviders,
  type AgentRuntime,
  type AgentRuntimeCapabilities,
  type AgentRuntimeCreateContext,
  type AgentRuntimeLastResult,
  type AgentRuntimeProvider,
  type AgentRuntimeProviderConfigReadContext,
  type AgentRuntimeSystemInput,
  type AgentRuntimeTurnResult,
  type ExternalAgentRuntimeProviderFactory,
} from '../src/agent-runtime/index.js';
import type { InboundTurnInput } from '../src/agent-runtime/turn.js';
import {
  UnknownBuiltinProviderError,
  createBuiltinProviderRegistry,
} from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const EXTERNAL_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'thirdPartySession' },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: true },
  context: { supported: true },
  systemPrompt: { mode: 'append' },
  teammateCompletion: [],
};

function builtinCatalog(): AgentRuntimeProviderCatalog {
  return createBuiltinAgentRuntimeProviderCatalog({
    registry: createBuiltinProviderRegistry(),
    codex: {},
  });
}

class FakeExternalRuntime implements AgentRuntime {
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  readonly submitted: InboundTurnInput[] = [];

  constructor(readonly providerRef: string) {}

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    return { status: 'submitted', turnId: 'turn-external' };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  getStatus(): ReturnType<AgentRuntime['getStatus']> {
    return this.status;
  }

  getThreadId(): string | null {
    return 'external-session';
  }

  wasThreadResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: 'external last' };
  }

  async getContext(): Promise<{ usedTokens: number; windowTokens: number }> {
    return { usedTokens: 7, windowTokens: 100 };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return EXTERNAL_CAPABILITIES;
  }
}

function externalFactory(options: {
  created?: AgentRuntimeCreateContext[];
  configs?: AgentRuntimeProviderConfigReadContext[];
} = {}): ExternalAgentRuntimeProviderFactory {
  return ({ ref, descriptor }) => {
    const provider: AgentRuntimeProvider = {
      ref,
      descriptor,
      getCapabilities: () => EXTERNAL_CAPABILITIES,
      readConfig(rawConfig, context) {
        options.configs?.push(context);
        return {
          ...rawConfig,
          read_by_provider: true,
        };
      },
      createRuntime(context) {
        options.created?.push(context);
        return new FakeExternalRuntime(ref);
      },
    };
    return provider;
  };
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
      cwd: '/tmp/dreamux-test-cwd',
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
    expect(provider.getCapabilities().steer.supported).toBe(true);
    expect(provider.getCapabilities().last.supported).toBe(true);
    expect(provider.getCapabilities().context.supported).toBe(false);
    // Distinct delivery shape from Codex — proves the abstraction is not
    // Codex-only.
    expect(
      provider.getCapabilities().teammateCompletion.map((shape) => shape.kind),
    ).toEqual(['claudeCodePlainTurn']);
  });

  it('does not expose the built-in Feishu channel through the runtime catalog', () => {
    // Since the multi-channel config slice (#209) `builtin:feishu` IS a registry
    // descriptor, but a `channel` one — the runtime catalog rejects it as a wrong
    // kind, so it still cannot be driven as an agent runtime.
    expect(() => builtinCatalog().resolve('builtin:feishu')).toThrow(
      WrongProviderKindError,
    );
  });

  it('rejects unknown builtins before runtime construction', () => {
    expect(() => builtinCatalog().resolve('builtin:does-not-exist')).toThrow(
      UnknownBuiltinProviderError,
    );
  });

  it('fails loud on unloaded external refs', () => {
    expect(() => builtinCatalog().resolve('npm:@example/dreamux-runtime')).toThrow(
      UnsupportedAgentRuntimeProviderError,
    );
    expect(() =>
      builtinCatalog().resolve('npm:@example/dreamux-runtime#provider'),
    ).toThrow(UnsupportedAgentRuntimeProviderError);
  });

  it('loads external npm providers into the same runtime catalog', async () => {
    const registry = createBuiltinProviderRegistry();
    const created: AgentRuntimeCreateContext[] = [];
    const factory = externalFactory({ created });
    await loadExternalAgentRuntimeProviders({
      registry,
      refs: [
        'npm:@example/dreamux-runtime',
        'npm:@example/dreamux-runtime#named',
      ],
      importModule: async (packageName) => {
        expect(packageName).toBe('@example/dreamux-runtime');
        return { default: factory, named: factory };
      },
    });

    const catalog = createBuiltinAgentRuntimeProviderCatalog({
      registry,
      codex: {},
    });
    expect(catalog.list().map((provider) => provider.ref).sort()).toEqual([
      'builtin:claude-code',
      'builtin:codex',
      'npm:@example/dreamux-runtime',
      'npm:@example/dreamux-runtime#named',
    ]);

    const provider = catalog.resolve('npm:@example/dreamux-runtime#named');
    expect(provider.getCapabilities().resume).toEqual({
      supported: true,
      checkpoint: 'thirdPartySession',
    });
    const dispatcher = testDispatcherConfig({ id: 'flow' });
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const runtime = provider.createRuntime({
      row: store.get('flow')!,
      dispatcher,
      dispatchers: store,
      cwd: '/tmp/dreamux-test-cwd',
      mcpServers: [],
      log: () => undefined,
    });

    expect(runtime.providerRef).toBe('npm:@example/dreamux-runtime#named');
    expect(created).toHaveLength(1);
  });

  it('loads a package implementation for a pre-registered builtin descriptor', async () => {
    // The builtin registry pre-registers builtin:codex / builtin:claude-code
    // descriptors without implementations. The loader skip must be
    // implementation-aware: a descriptor that exists but has no implementation
    // must still flow through import + factory + implementation registration,
    // so the slice-3 Codex/Claude extraction can switch builtins onto this
    // loader without no-op'ing. (PR #212 P1.)
    const registry = createBuiltinProviderRegistry();
    const codexDescriptor = registry.resolve('builtin:codex');
    expect(registry.getImplementation(codexDescriptor.id)).toBeUndefined();

    let importCount = 0;
    await loadExternalAgentRuntimeProviders({
      registry,
      refs: ['builtin:codex'],
      importModule: async (packageName) => {
        importCount += 1;
        expect(packageName).toBe('@excitedjs/agent-runtime-codex');
        return { default: externalFactory() };
      },
    });

    expect(importCount).toBe(1);
    // The existing builtin descriptor is reused (not duplicated), and now has an
    // implementation registered against it.
    expect(registry.resolve('builtin:codex')).toBe(codexDescriptor);
    expect(registry.getImplementation(codexDescriptor.id)).toBeDefined();

    // A second load is a true no-op now that the implementation exists.
    await loadExternalAgentRuntimeProviders({
      registry,
      refs: ['builtin:codex'],
      importModule: async () => {
        importCount += 1;
        return { default: externalFactory() };
      },
    });
    expect(importCount).toBe(1);
  });

  it('reports external package import failures with the provider ref', async () => {
    await expect(
      loadExternalAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/missing-runtime'],
        importModule: async () => {
          throw new Error('package not found');
        },
      }),
    ).rejects.toThrow(ExternalAgentRuntimeProviderLoadError);
    await expect(
      loadExternalAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/missing-runtime'],
        importModule: async () => {
          throw new Error('package not found');
        },
      }),
    ).rejects.toThrow(/npm:@example\/missing-runtime/);
  });

  it('rejects external modules that do not export a provider factory', async () => {
    await expect(
      loadExternalAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/dreamux-runtime#missing'],
        importModule: async () => ({ default: externalFactory() }),
      }),
    ).rejects.toThrow(ExternalAgentRuntimeProviderContractError);
  });

  it('rejects external providers with incomplete capabilities', async () => {
    await expect(
      loadExternalAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/dreamux-runtime'],
        importModule: async () => ({
          default: ({ ref, descriptor }) => ({
            ref,
            descriptor,
            getCapabilities: () => ({
              resume: { supported: false },
            }),
            createRuntime: () => new FakeExternalRuntime(ref),
          }),
        }),
      }),
    ).rejects.toThrow(/capabilities\.steer\.supported/);
  });

  it('supports registry injection for future provider composition tests', () => {
    const registry = createBuiltinProviderRegistry();
    const descriptor = registry.resolve('builtin:codex');
    registry.registerImplementation(
      descriptor.id,
      createCodexAgentRuntimeProvider({
        descriptor,
      }),
    );
    const catalog = new AgentRuntimeProviderCatalog({ registry });

    expect(catalog.list().map((provider) => provider.ref)).toEqual([
      'builtin:codex',
    ]);
  });
});
