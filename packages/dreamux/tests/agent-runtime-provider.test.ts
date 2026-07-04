import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeProviderCatalog,
  ExternalAgentRuntimeProviderContractError,
  ExternalAgentRuntimeProviderLoadError,
  UnsupportedAgentRuntimeProviderError,
  WrongProviderKindError,
  loadAgentRuntimeProviders,
  type ExternalAgentRuntimeProviderFactory,
  type ExternalAgentRuntimeProviderFactoryContext,
} from '../src/agent-runtime/index.js';
import {
  createCodexAgentRuntimeProvider,
  dispatcherCodexConfig,
} from '@excitedjs/agent-runtime-codex';
import { createClaudeCodeAgentRuntimeProvider } from '@excitedjs/agent-runtime-claude-code';
import { codexAgentRuntimeCatalog } from './helpers/fake-agent-runtime.js';
import { dispatcherHostPaths } from '../src/agent-runtime/host-paths.js';
import { asAgentRuntimeDescriptor } from './helpers/provider.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeStateCallbacks,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import {
  UnknownBuiltinProviderError,
  createBuiltinProviderRegistry,
} from '../src/registry/index.js';
import { testDispatcherConfig } from './helpers/config.js';

const EXTERNAL_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true },
};

function builtinCatalog(): AgentRuntimeProviderCatalog {
  // The builtins flow through the same dynamic loader as npm refs; the test
  // helper seeds a fresh registry with the codex + claude-code implementations
  // and returns the catalog over it (mirrors `feishuChannelCatalog`).
  return codexAgentRuntimeCatalog();
}

class FakeExternalRuntime implements AgentRuntime {
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];

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

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    this.textSubmitted.push(input);
    return { status: 'submitted', turnId: input.sourceId ?? 'turn-external-text' };
  }

  getStatus(): ReturnType<AgentRuntime['getStatus']> {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return { id: 'external-session' };
  }

  wasCheckpointResumed(): boolean {
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
      descriptor: asAgentRuntimeDescriptor(descriptor),
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
    expect(provider.getCapabilities()).toEqual({ resume: { supported: true } });
  });

  it('creates a Codex-backed AgentRuntime without starting it', () => {
    const dispatcher = testDispatcherConfig({ id: 'flow' });

    const runtime = builtinCatalog().resolve('builtin:codex').createRuntime({
      identity: { runtime_id: 'flow', checkpoint_id: null },
      config: dispatcherCodexConfig(dispatcher),
      cwd: '/tmp/dreamux-test-cwd',
      mcpServers: [],
      state: noopState(),
      paths: dispatcherHostPaths,
    });

    expect(runtime.providerRef).toBe('builtin:codex');
    expect(runtime.getStatus()).toBe('declared');
  });

  it('resolves builtin:claude-code with the same minimal runtime capability shape', () => {
    const provider = builtinCatalog().resolve('builtin:claude-code');

    expect(provider.ref).toBe('builtin:claude-code');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.getCapabilities()).toEqual({ resume: { supported: true } });
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
    await loadAgentRuntimeProviders({
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

    // Register the builtin codex + claude-code implementations into the SAME
    // registry the npm providers were just loaded into, then build the catalog
    // over it — the builtins are providers indistinguishable from the npm ones.
    const codexDescriptor = registry.resolve('builtin:codex');
    registry.registerImplementation(
      codexDescriptor.id,
      createCodexAgentRuntimeProvider({ descriptor: codexDescriptor }),
    );
    const claudeDescriptor = registry.resolve('builtin:claude-code');
    registry.registerImplementation(
      claudeDescriptor.id,
      createClaudeCodeAgentRuntimeProvider({ descriptor: claudeDescriptor }),
    );
    const catalog = new AgentRuntimeProviderCatalog({ registry });
    expect(catalog.list().map((provider) => provider.ref).sort()).toEqual([
      'builtin:claude-code',
      'builtin:codex',
      'npm:@example/dreamux-runtime',
      'npm:@example/dreamux-runtime#named',
    ]);

    const provider = catalog.resolve('npm:@example/dreamux-runtime#named');
    expect(provider.getCapabilities().resume).toEqual({
      supported: true,
    });
    const runtime = provider.createRuntime({
      identity: { runtime_id: 'flow', checkpoint_id: null },
      config: {},
      cwd: '/tmp/dreamux-test-cwd',
      mcpServers: [],
      state: noopState(),
      paths: dispatcherHostPaths,
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
    await loadAgentRuntimeProviders({
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
    await loadAgentRuntimeProviders({
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
      loadAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/missing-runtime'],
        importModule: async () => {
          throw new Error('package not found');
        },
      }),
    ).rejects.toThrow(ExternalAgentRuntimeProviderLoadError);
    await expect(
      loadAgentRuntimeProviders({
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
      loadAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/dreamux-runtime#missing'],
        importModule: async () => ({ default: externalFactory() }),
      }),
    ).rejects.toThrow(ExternalAgentRuntimeProviderContractError);
  });

  it('rejects external providers with malformed resume capabilities', async () => {
    await expect(
      loadAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['npm:@example/dreamux-runtime'],
        importModule: async () => ({
          default: ({
            ref,
            descriptor,
          }: ExternalAgentRuntimeProviderFactoryContext) => ({
            ref,
            descriptor,
            getCapabilities: () => ({
              resume: { supported: 'no' },
            }) as unknown as AgentRuntimeCapabilities,
            createRuntime: () => new FakeExternalRuntime(ref),
          }),
        }),
      }),
    ).rejects.toThrow(/capabilities\.resume\.supported/);
  });

  it('rejects malformed runtime handles before live use', async () => {
    const registry = createBuiltinProviderRegistry();
    await loadAgentRuntimeProviders({
      registry,
      refs: ['npm:@example/dreamux-runtime'],
      importModule: async () => ({
        default: ({
          ref,
          descriptor,
        }: ExternalAgentRuntimeProviderFactoryContext) => ({
          ref,
          descriptor,
          getCapabilities: () => EXTERNAL_CAPABILITIES,
          createRuntime: () =>
            Object.assign(new FakeExternalRuntime(ref), {
              channelInput: undefined,
            }),
        }),
      }),
    });
    const provider = new AgentRuntimeProviderCatalog({ registry }).resolve(
      'npm:@example/dreamux-runtime',
    );
    expect(() =>
      provider.createRuntime({
        identity: { runtime_id: 'flow', checkpoint_id: null },
        config: {},
        cwd: '/tmp/dreamux-test-cwd',
        mcpServers: [],
      }),
    ).toThrow(/runtime\.channelInput must be a function/);
  });

  it('accepts runtimes that implement the minimal runtime inboxes', async () => {
    const registry = createBuiltinProviderRegistry();
    await loadAgentRuntimeProviders({
      registry,
      refs: ['npm:@example/dreamux-runtime'],
      importModule: async () => ({
        default: ({
          ref,
          descriptor,
        }: ExternalAgentRuntimeProviderFactoryContext) => ({
          ref,
          descriptor,
          getCapabilities: () => EXTERNAL_CAPABILITIES,
          createRuntime: () => {
            const runtime = new FakeExternalRuntime(ref);
            return {
              providerRef: runtime.providerRef,
              start: () => runtime.start(),
              resume: () => runtime.resume(),
              stop: () => runtime.stop(),
              channelInput: (input: InboundTurnInput) => runtime.channelInput(input),
              completionInput: (input: AgentRuntimeTextInput) =>
                runtime.completionInput(input),
              getStatus: () => runtime.getStatus(),
              getCheckpoint: () => runtime.getCheckpoint(),
              wasCheckpointResumed: () => runtime.wasCheckpointResumed(),
              getLast: () => runtime.getLast(),
              getContext: () => runtime.getContext(),
              getCapabilities: () => runtime.getCapabilities(),
            };
          },
        }),
      }),
    });
    const provider = new AgentRuntimeProviderCatalog({ registry }).resolve(
      'npm:@example/dreamux-runtime',
    );

    expect(() =>
      provider.createRuntime({
        identity: { runtime_id: 'flow', checkpoint_id: null },
        config: {},
        cwd: '/tmp/dreamux-test-cwd',
        mcpServers: [],
      }),
    ).not.toThrow();
  });

  it('rejects providers that do not echo the seed descriptor id', async () => {
    await expect(
      loadAgentRuntimeProviders({
        registry: createBuiltinProviderRegistry(),
        refs: ['builtin:codex'],
        importModule: async () => ({
          default: ({
            ref,
            descriptor,
          }: ExternalAgentRuntimeProviderFactoryContext) => ({
            ref,
            descriptor: { ...descriptor, id: 'wrong-id' },
            getCapabilities: () => EXTERNAL_CAPABILITIES,
            createRuntime: () => new FakeExternalRuntime(ref),
          }),
        }),
      }),
    ).rejects.toThrow(/provider\.descriptor\.id must be "codex"/);
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

function noopState(): AgentRuntimeStateCallbacks {
  return {
    async setStatus() {},
    async setCheckpoint() {},
  };
}
