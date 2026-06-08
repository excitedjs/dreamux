import {
  formatProviderRef,
  parseProviderRef,
  type NpmProviderRef,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeProvider,
  CompletionDeliveryShape,
} from './types.js';

export interface ExternalAgentRuntimeProviderFactoryContext {
  /** Canonical provider ref from config, for example `npm:some-runtime#provider`. */
  ref: string;
  /** Descriptor the provider must expose back to Dreamux. */
  descriptor: ProviderDescriptor;
}

export type ExternalAgentRuntimeProviderFactory = (
  context: ExternalAgentRuntimeProviderFactoryContext,
) => AgentRuntimeProvider | Promise<AgentRuntimeProvider>;

export type ExternalAgentRuntimeModule = Record<string, unknown> & {
  default?: unknown;
};

export type ExternalAgentRuntimeModuleImporter = (
  packageName: string,
) => Promise<ExternalAgentRuntimeModule>;

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

export interface LoadExternalAgentRuntimeProvidersOptions {
  registry: ProviderRegistry;
  refs: Iterable<string>;
  importModule?: ExternalAgentRuntimeModuleImporter;
}

export async function loadExternalAgentRuntimeProviders(
  options: LoadExternalAgentRuntimeProvidersOptions,
): Promise<void> {
  const importModule = options.importModule ?? defaultImportModule;
  const refs = uniqueNpmRefs(options.refs);
  for (const ref of refs) {
    if (options.registry.hasRef(ref.raw)) continue;
    await loadOneExternalAgentRuntimeProvider({
      registry: options.registry,
      ref,
      importModule,
    });
  }
}

async function loadOneExternalAgentRuntimeProvider(options: {
  registry: ProviderRegistry;
  ref: NpmProviderRef;
  importModule: ExternalAgentRuntimeModuleImporter;
}): Promise<void> {
  const module = await importExternalModule(options.ref, options.importModule);
  const factory = externalFactoryExport(options.ref, module);
  const seedDescriptor: ProviderDescriptor = {
    id: options.ref.raw,
    kind: 'agentRuntime',
    ref: options.ref,
  };
  let provider: AgentRuntimeProvider;
  try {
    provider = await factory({
      ref: options.ref.raw,
      descriptor: seedDescriptor,
    });
  } catch (err) {
    throw new ExternalAgentRuntimeProviderLoadError(
      options.ref.raw,
      `provider factory threw: ${errMessage(err)}`,
      { cause: err },
    );
  }

  assertExternalAgentRuntimeProvider(options.ref.raw, provider);
  options.registry.register(provider.descriptor);
  options.registry.registerImplementation(provider.descriptor.id, provider);
}

async function importExternalModule(
  ref: NpmProviderRef,
  importModule: ExternalAgentRuntimeModuleImporter,
): Promise<ExternalAgentRuntimeModule> {
  try {
    return await importModule(ref.package);
  } catch (err) {
    throw new ExternalAgentRuntimeProviderLoadError(
      ref.raw,
      `could not import package ${JSON.stringify(ref.package)}: ${errMessage(err)}`,
      { cause: err },
    );
  }
}

function externalFactoryExport(
  ref: NpmProviderRef,
  module: ExternalAgentRuntimeModule,
): ExternalAgentRuntimeProviderFactory {
  const exportName = ref.export ?? 'default';
  const value = ref.export === null ? module.default : module[ref.export];
  if (typeof value !== 'function') {
    throw new ExternalAgentRuntimeProviderContractError(
      ref.raw,
      `expected ${exportName} export to be an agentRuntime provider factory`,
    );
  }
  return value as ExternalAgentRuntimeProviderFactory;
}

function assertExternalAgentRuntimeProvider(
  expectedRef: string,
  value: unknown,
): asserts value is AgentRuntimeProvider {
  if (typeof value !== 'object' || value === null) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'factory must return an AgentRuntimeProvider object',
    );
  }
  const candidate = value as Partial<AgentRuntimeProvider>;
  if (candidate.ref !== expectedRef) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      `provider.ref must be ${JSON.stringify(expectedRef)}`,
    );
  }
  assertDescriptor(expectedRef, candidate.descriptor);
  if (typeof candidate.getCapabilities !== 'function') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'provider.getCapabilities must be a function',
    );
  }
  if (typeof candidate.createRuntime !== 'function') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'provider.createRuntime must be a function',
    );
  }
  let capabilities: AgentRuntimeCapabilities;
  try {
    capabilities = candidate.getCapabilities();
  } catch (err) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      `provider.getCapabilities threw: ${errMessage(err)}`,
    );
  }
  assertCapabilities(expectedRef, capabilities);
}

function assertDescriptor(
  expectedRef: string,
  descriptor: ProviderDescriptor | undefined,
): asserts descriptor is ProviderDescriptor {
  if (descriptor === undefined) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'provider.descriptor is required',
    );
  }
  if (descriptor.kind !== 'agentRuntime') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      `provider.descriptor.kind must be "agentRuntime" (got ${JSON.stringify(descriptor.kind)})`,
    );
  }
  if (typeof descriptor.id !== 'string' || descriptor.id.trim() === '') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'provider.descriptor.id must be a non-empty string',
    );
  }
  if (formatProviderRef(descriptor.ref) !== expectedRef) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      `provider.descriptor.ref must be ${JSON.stringify(expectedRef)}`,
    );
  }
}

function assertCapabilities(
  expectedRef: string,
  value: unknown,
): asserts value is AgentRuntimeCapabilities {
  if (!isRecord(value)) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'capabilities must be an object',
    );
  }
  const capabilities = value as Partial<AgentRuntimeCapabilities>;
  assertResumeCapability(expectedRef, capabilities.resume);
  assertSupportedBoolean(expectedRef, 'steer', capabilities.steer);
  if (!isRecord(capabilities.events) || !isEventKind(capabilities.events['kind'])) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'capabilities.events.kind must be "push" or "synthesized"',
    );
  }
  assertSupportedBoolean(expectedRef, 'last', capabilities.last);
  assertSupportedBoolean(expectedRef, 'context', capabilities.context);
  if (!Array.isArray(capabilities.teammateCompletion)) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'capabilities.teammateCompletion must be an array',
    );
  }
  for (const shape of capabilities.teammateCompletion) {
    assertCompletionDeliveryShape(expectedRef, shape);
  }
}

function assertResumeCapability(expectedRef: string, value: unknown): void {
  if (!isRecord(value) || typeof value['supported'] !== 'boolean') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'capabilities.resume.supported must be a boolean',
    );
  }
  if (value['supported'] === true) {
    if (typeof value['checkpoint'] !== 'string' || value['checkpoint'] === '') {
      throw new ExternalAgentRuntimeProviderContractError(
        expectedRef,
        'capabilities.resume.checkpoint must be a non-empty string when resume is supported',
      );
    }
  }
}

function assertSupportedBoolean(
  expectedRef: string,
  name: string,
  value: unknown,
): void {
  if (!isRecord(value) || typeof value['supported'] !== 'boolean') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      `capabilities.${name}.supported must be a boolean`,
    );
  }
}

function assertCompletionDeliveryShape(
  expectedRef: string,
  value: unknown,
): asserts value is CompletionDeliveryShape {
  if (!isRecord(value)) {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'capabilities.teammateCompletion entries must be objects',
    );
  }
  if (typeof value['kind'] !== 'string' || value['kind'] === '') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'capabilities.teammateCompletion entries must include a kind',
    );
  }
  if (typeof value['description'] !== 'string' || value['description'] === '') {
    throw new ExternalAgentRuntimeProviderContractError(
      expectedRef,
      'capabilities.teammateCompletion entries must include a description',
    );
  }
}

function uniqueNpmRefs(refs: Iterable<string>): NpmProviderRef[] {
  const out = new Map<string, NpmProviderRef>();
  for (const raw of refs) {
    const parsed = parseProviderRef(raw);
    if (parsed.source === 'npm') out.set(parsed.raw, parsed);
  }
  return [...out.values()];
}

async function defaultImportModule(
  packageName: string,
): Promise<ExternalAgentRuntimeModule> {
  return import(packageName) as Promise<ExternalAgentRuntimeModule>;
}

function isEventKind(
  value: unknown,
): value is AgentRuntimeCapabilities['events']['kind'] {
  return value === 'push' || value === 'synthesized';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
