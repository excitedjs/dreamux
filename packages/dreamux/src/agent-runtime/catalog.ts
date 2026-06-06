import {
  createBuiltinRegistry,
  formatProviderRef,
  ReservedExternalProviderError,
  type CapabilityRegistry,
  type ProviderDescriptor,
} from '../registry/index.js';
import { createCodexAgentRuntimeProvider } from './codex.js';
import type { CodexAgentRuntimeProviderOptions } from './codex.js';
import { createClaudeCodeAgentRuntimeProvider } from './claude-code.js';
import type { ClaudeCodeAgentRuntimeProviderOptions } from './claude-code.js';
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
  registry?: CapabilityRegistry;
  providers: readonly AgentRuntimeProvider[];
}

export class AgentRuntimeProviderCatalog {
  private readonly registry: CapabilityRegistry;
  private readonly providers = new Map<string, AgentRuntimeProvider>();

  constructor(options: AgentRuntimeProviderCatalogOptions) {
    this.registry = options.registry ?? createBuiltinRegistry();
    for (const provider of options.providers) {
      this.providers.set(provider.ref, provider);
    }
  }

  list(): AgentRuntimeProvider[] {
    return [...this.providers.values()];
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
    const provider = this.providers.get(canonicalRef);
    if (provider === undefined) {
      throw new UnsupportedAgentRuntimeProviderError(
        canonicalRef,
        'the provider is registered but has no runtime implementation wired in this phase',
      );
    }
    return provider;
  }
}

export interface BuiltinAgentRuntimeProviderCatalogOptions {
  registry?: CapabilityRegistry;
  codex: CodexAgentRuntimeProviderOptions;
  claudeCode?: ClaudeCodeAgentRuntimeProviderOptions;
}

export function createBuiltinAgentRuntimeProviderCatalog(
  options: BuiltinAgentRuntimeProviderCatalogOptions,
): AgentRuntimeProviderCatalog {
  return new AgentRuntimeProviderCatalog({
    providers: [
      createCodexAgentRuntimeProvider(options.codex),
      createClaudeCodeAgentRuntimeProvider(options.claudeCode ?? {}),
    ],
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
  });
}
