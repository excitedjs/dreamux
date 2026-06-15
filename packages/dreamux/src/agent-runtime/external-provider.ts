/**
 * External `agentRuntime` provider loader (issue #209).
 *
 * This is the `agentRuntime` specialization of the generic provider package
 * loader (`../registry/provider-loader.ts`). It keeps the public surface in-repo
 * callers and tests import (`loadAgentRuntimeProviders`, the factory type, and
 * the two error classes) while delegating the kind-agnostic mechanics
 * — dynamic import, export selection, factory invocation, duplicate handling,
 * descriptor registration, and fail-loud formatting — to the shared skeleton.
 *
 * The `channel` kind reuses the same skeleton through a sibling loader; only the
 * contract assertions below are runtime-specific.
 */
import {
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  assertLoadedProviderObject,
  assertProviderDescriptorShape,
  errMessage,
  isRecord,
  loadProviderPackages,
  type ProviderContractContext,
  type ProviderFactory,
  type ProviderModule,
  type ProviderModuleImporter,
  type ProviderPackageLoaderSpec,
} from '../registry/provider-loader.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeProvider,
  CompletionDeliveryShape,
} from '@excitedjs/dreamux-types';

export interface ExternalAgentRuntimeProviderFactoryContext {
  /** Canonical provider ref from config, for example `npm:some-runtime#provider`. */
  ref: string;
  /** Descriptor the provider must expose back to Dreamux. */
  descriptor: ProviderDescriptor;
}

export type ExternalAgentRuntimeProviderFactory = ProviderFactory<AgentRuntimeProvider>;

export type ExternalAgentRuntimeModule = ProviderModule;

export type ExternalAgentRuntimeModuleImporter = ProviderModuleImporter;

export class ExternalAgentRuntimeProviderLoadError extends Error {
  constructor(
    readonly providerRef: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `failed to load external agentRuntime provider ${JSON.stringify(providerRef)}: ${message}`,
      options,
    );
    this.name = 'ExternalAgentRuntimeProviderLoadError';
  }
}

export class ExternalAgentRuntimeProviderContractError extends Error {
  constructor(readonly providerRef: string, message: string) {
    super(
      `invalid external agentRuntime provider ${JSON.stringify(providerRef)}: ${message}`,
    );
    this.name = 'ExternalAgentRuntimeProviderContractError';
  }
}

export interface LoadAgentRuntimeProvidersOptions {
  registry: ProviderRegistry;
  refs: Iterable<string>;
  importModule?: ExternalAgentRuntimeModuleImporter;
}

const AGENT_RUNTIME_LOADER_SPEC: ProviderPackageLoaderSpec<AgentRuntimeProvider> = {
  kind: 'agentRuntime',
  createLoadError: (ref, message, options) =>
    new ExternalAgentRuntimeProviderLoadError(ref, message, options),
  createContractError: (ref, message) =>
    new ExternalAgentRuntimeProviderContractError(ref, message),
  assertProvider: assertExternalAgentRuntimeProvider,
};

export async function loadAgentRuntimeProviders(
  options: LoadAgentRuntimeProvidersOptions,
): Promise<void> {
  await loadProviderPackages(options, AGENT_RUNTIME_LOADER_SPEC);
}

function assertExternalAgentRuntimeProvider(
  value: unknown,
  context: ProviderContractContext,
): asserts value is AgentRuntimeProvider {
  assertLoadedProviderObject(value, context);
  const candidate = value as Partial<AgentRuntimeProvider>;
  assertProviderDescriptorShape(candidate.descriptor, 'agentRuntime', context);
  if (typeof candidate.getCapabilities !== 'function') {
    context.fail('provider.getCapabilities must be a function');
  }
  if (typeof candidate.createRuntime !== 'function') {
    context.fail('provider.createRuntime must be a function');
  }
  let capabilities: AgentRuntimeCapabilities;
  try {
    capabilities = candidate.getCapabilities!();
  } catch (err) {
    context.fail(`provider.getCapabilities threw: ${errMessage(err)}`);
  }
  assertCapabilities(capabilities, context);
}

function assertCapabilities(
  value: unknown,
  context: ProviderContractContext,
): asserts value is AgentRuntimeCapabilities {
  if (!isRecord(value)) {
    context.fail('capabilities must be an object');
  }
  const capabilities = value as Partial<AgentRuntimeCapabilities>;
  assertResumeCapability(capabilities.resume, context);
  assertSupportedBoolean('steer', capabilities.steer, context);
  if (!isRecord(capabilities.events) || !isEventKind(capabilities.events['kind'])) {
    context.fail('capabilities.events.kind must be "push" or "synthesized"');
  }
  assertSupportedBoolean('last', capabilities.last, context);
  assertSupportedBoolean('context', capabilities.context, context);
  if (!Array.isArray(capabilities.teammateCompletion)) {
    context.fail('capabilities.teammateCompletion must be an array');
  }
  for (const shape of capabilities.teammateCompletion) {
    assertCompletionDeliveryShape(shape, context);
  }
}

function assertResumeCapability(
  value: unknown,
  context: ProviderContractContext,
): void {
  if (!isRecord(value) || typeof value['supported'] !== 'boolean') {
    context.fail('capabilities.resume.supported must be a boolean');
  }
  const resume = value as Record<string, unknown>;
  if (resume['supported'] === true) {
    if (typeof resume['checkpoint'] !== 'string' || resume['checkpoint'] === '') {
      context.fail(
        'capabilities.resume.checkpoint must be a non-empty string when resume is supported',
      );
    }
  }
}

function assertSupportedBoolean(
  name: string,
  value: unknown,
  context: ProviderContractContext,
): void {
  if (!isRecord(value) || typeof value['supported'] !== 'boolean') {
    context.fail(`capabilities.${name}.supported must be a boolean`);
  }
}

function assertCompletionDeliveryShape(
  value: unknown,
  context: ProviderContractContext,
): asserts value is CompletionDeliveryShape {
  if (!isRecord(value)) {
    context.fail('capabilities.teammateCompletion entries must be objects');
  }
  const shape = value as Record<string, unknown>;
  if (typeof shape['kind'] !== 'string' || shape['kind'] === '') {
    context.fail('capabilities.teammateCompletion entries must include a kind');
  }
  if (typeof shape['description'] !== 'string' || shape['description'] === '') {
    context.fail(
      'capabilities.teammateCompletion entries must include a description',
    );
  }
}

function isEventKind(
  value: unknown,
): value is AgentRuntimeCapabilities['events']['kind'] {
  return value === 'push' || value === 'synthesized';
}
