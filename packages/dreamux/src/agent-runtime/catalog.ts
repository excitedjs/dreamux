import {
  formatProviderRef,
  ReservedExternalProviderError,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import { createCodexAgentRuntimeProvider } from './builtin/codex/provider.js';
import type { CodexAgentRuntimeProviderOptions } from './builtin/codex/provider.js';
import { createClaudeCodeAgentRuntimeProvider } from './builtin/claude-code/runtime.js';
import type { ClaudeCodeAgentRuntimeProviderOptions } from './builtin/claude-code/runtime.js';
import type { AgentRuntimeProvider } from './types.js';

export class UnsupportedAgentRuntimeProviderError extends Error {
  constructor(
    readonly providerRef: string,
    readonly reason: string,
  ) {
    super(`agent runtime provider ${JSON.stringify(providerRef)} is not supported: ${reason}`);
    this.name = 'UnsupportedAgentRuntimeProviderError';
  }
}

export class WrongProviderKindError extends Error {
  constructor(readonly descriptor: ProviderDescriptor) {
    super(
      `provider ${JSON.stringify(formatProviderRef(descriptor.ref))} is a ` +
        `${descriptor.kind} provider, expected agentRuntime`,
    );
    this.name = 'WrongProviderKindError';
  }
}

export interface AgentRuntimeProviderCatalogOptions {
  registry: ProviderRegistry;
}

export class AgentRuntimeProviderCatalog {
  private readonly registry: ProviderRegistry;

  constructor(options: AgentRuntimeProviderCatalogOptions) {
    this.registry = options.registry;
  }

  list(): AgentRuntimeProvider[] {
    return this.registry
      .listByKind('agentRuntime')
      .map((descriptor) => this.runtimeProviderForDescriptor(descriptor))
      .filter((provider): provider is AgentRuntimeProvider => provider !== null);
  }

  resolve(ref: string): AgentRuntimeProvider {
    let descriptor: ProviderDescriptor;
    try {
      descriptor = this.registry.resolve(ref);
    } catch (err) {
      if (err instanceof ReservedExternalProviderError) {
        throw new UnsupportedAgentRuntimeProviderError(ref, err.message);
      }
      throw err;
    }
    if (descriptor.kind !== 'agentRuntime') {
      throw new WrongProviderKindError(descriptor);
    }
    const canonicalRef = formatProviderRef(descriptor.ref);
    const provider = this.runtimeProviderForDescriptor(descriptor);
    if (provider === null) {
      throw new UnsupportedAgentRuntimeProviderError(
        canonicalRef,
        'the provider is registered but has no runtime implementation wired in this phase',
      );
    }
    return provider;
  }

  private runtimeProviderForDescriptor(
    descriptor: ProviderDescriptor,
  ): AgentRuntimeProvider | null {
    const implementation = this.registry.getImplementation(descriptor.id);
    return asAgentRuntimeProvider(implementation);
  }
}

export interface RegisterBuiltinAgentRuntimeProvidersOptions {
  registry: ProviderRegistry;
  codex?: Omit<CodexAgentRuntimeProviderOptions, 'descriptor'>;
  claudeCode?: Omit<ClaudeCodeAgentRuntimeProviderOptions, 'descriptor'>;
}

/**
 * Register the builtin agentRuntime provider implementations into `registry`.
 *
 * Idempotent per builtin id: a provider already carrying a runnable
 * implementation is left untouched (the registry throws on a duplicate
 * implementation). This lets two callers register the builtins safely — the
 * server registers them eagerly with its process factories, and config then
 * calls this again (with no factories) only to make `readConfig` /
 * `getCapabilities` available at load; the second call no-ops on the
 * already-registered builtins, so the server's factory-bearing registration
 * always wins.
 */
export function registerBuiltinAgentRuntimeProviders(
  options: RegisterBuiltinAgentRuntimeProvidersOptions,
): void {
  const { registry } = options;
  const codexDescriptor = registry.resolve('builtin:codex');
  if (registry.getImplementation(codexDescriptor.id) === undefined) {
    registry.registerImplementation(
      codexDescriptor.id,
      createCodexAgentRuntimeProvider({
        ...(options.codex ?? {}),
        descriptor: codexDescriptor,
      }),
    );
  }
  const claudeCodeDescriptor = registry.resolve('builtin:claude-code');
  if (registry.getImplementation(claudeCodeDescriptor.id) === undefined) {
    registry.registerImplementation(
      claudeCodeDescriptor.id,
      createClaudeCodeAgentRuntimeProvider({
        ...(options.claudeCode ?? {}),
        descriptor: claudeCodeDescriptor,
      }),
    );
  }
}

export interface BuiltinAgentRuntimeProviderCatalogOptions {
  registry: ProviderRegistry;
  codex: Omit<CodexAgentRuntimeProviderOptions, 'descriptor'>;
  claudeCode?: Omit<ClaudeCodeAgentRuntimeProviderOptions, 'descriptor'>;
}

export function createBuiltinAgentRuntimeProviderCatalog(
  options: BuiltinAgentRuntimeProviderCatalogOptions,
): AgentRuntimeProviderCatalog {
  registerBuiltinAgentRuntimeProviders({
    registry: options.registry,
    codex: options.codex,
    ...(options.claudeCode !== undefined ? { claudeCode: options.claudeCode } : {}),
  });
  return new AgentRuntimeProviderCatalog({ registry: options.registry });
}

function asAgentRuntimeProvider(value: unknown): AgentRuntimeProvider | null {
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
