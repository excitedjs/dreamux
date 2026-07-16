/**
 * External `channel` provider loader (issue #209).
 *
 * The `channel` specialization of the generic provider package loader
 * (`../registry/provider-loader.ts`). It mirrors the `agentRuntime` loader: the
 * shared skeleton owns dynamic import, export selection, factory invocation,
 * duplicate handling, descriptor registration, and fail-loud formatting, while
 * the assertions here enforce the `ChannelProvider` contract.
 *
 * A channel provider must expose a `channel` descriptor, an optional config
 * reader, and a channel session factory. `builtin:feishu` resolves to
 * `@excitedjs/feishu-channel` through the same loading path once the alias is
 * resolved; a missing built-in channel package fails loud with the named ref.
 */
import {
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  assertLoadedProviderObject,
  assertProviderDescriptorShape,
  isRecord,
  loadProviderPackages,
  type ProviderContractContext,
  type ProviderFactory,
  type ProviderModule,
  type ProviderModuleImporter,
  type ProviderPackageLoaderSpec,
} from '../registry/provider-loader.js';
import type {
  ChannelProvider,
  ChannelTaskHostCapability,
} from '@excitedjs/dreamux-types';

const TASK_HOST_CAPABILITIES = new Set<ChannelTaskHostCapability>([
  'durable_task_submission_v1',
  'host_event_stream_v1',
  'durable_container_manifest_v1',
  'resource_lifecycle_v1',
  'logical_repository_binding_v1',
]);

export interface ExternalChannelProviderFactoryContext {
  /** Canonical provider ref from config, for example `builtin:feishu`. */
  ref: string;
  /** Descriptor the provider must expose back to Dreamux. */
  descriptor: ProviderDescriptor;
}

export type ExternalChannelProviderFactory = ProviderFactory<ChannelProvider>;

export type ExternalChannelModule = ProviderModule;

export type ExternalChannelModuleImporter = ProviderModuleImporter;

export class ExternalChannelProviderLoadError extends Error {
  constructor(
    readonly providerRef: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `failed to load channel provider ${JSON.stringify(providerRef)}: ${message}`,
      options,
    );
    this.name = 'ExternalChannelProviderLoadError';
  }
}

export class ExternalChannelProviderContractError extends Error {
  constructor(readonly providerRef: string, message: string) {
    super(`invalid channel provider ${JSON.stringify(providerRef)}: ${message}`);
    this.name = 'ExternalChannelProviderContractError';
  }
}

export interface LoadChannelProvidersOptions {
  registry: ProviderRegistry;
  refs: Iterable<string>;
  importModule?: ExternalChannelModuleImporter;
}

const CHANNEL_LOADER_SPEC: ProviderPackageLoaderSpec<ChannelProvider> = {
  kind: 'channel',
  createLoadError: (ref, message, options) =>
    new ExternalChannelProviderLoadError(ref, message, options),
  createContractError: (ref, message) =>
    new ExternalChannelProviderContractError(ref, message),
  assertProvider: assertChannelProvider,
};

export async function loadChannelProviders(
  options: LoadChannelProvidersOptions,
): Promise<void> {
  await loadProviderPackages(options, CHANNEL_LOADER_SPEC);
}

function assertChannelProvider(
  value: unknown,
  context: ProviderContractContext,
): asserts value is ChannelProvider {
  assertLoadedProviderObject(value, context);
  const candidate = value as Partial<ChannelProvider>;
  assertProviderDescriptorShape(candidate.descriptor, 'channel', context);
  if (candidate.readConfig !== undefined && typeof candidate.readConfig !== 'function') {
    context.fail('provider.readConfig must be a function when present');
  }
  if (typeof candidate.createSession !== 'function') {
    context.fail('provider.createSession must be a function');
  }
  if (
    candidate.taskChannel !== undefined &&
    !validTaskChannelCapability(candidate.taskChannel)
  ) {
    context.fail(
      "provider.taskChannel must declare task_channel_host_v1 with supported schema_versions and capabilities",
    );
  }
  if (
    candidate.resolveRepositoryBinding !== undefined &&
    typeof candidate.resolveRepositoryBinding !== 'function'
  ) {
    context.fail('provider.resolveRepositoryBinding must be a function when present');
  }
  if (
    candidate.taskChannel?.capabilities.includes(
      'logical_repository_binding_v1',
    ) === true &&
    candidate.resolveRepositoryBinding === undefined
  ) {
    context.fail(
      'provider.resolveRepositoryBinding is required when logical_repository_binding_v1 is declared',
    );
  }
  assertOptionalOnboard(candidate.onboard, context);
  assertOptionalDiagnostic(candidate.diagnostic, context);
}

function validTaskChannelCapability(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value['protocol'] !== 'task_channel_host_v1' ||
    !Array.isArray(value['schema_versions']) ||
    value['schema_versions'].length === 0 ||
    value['schema_versions'].some((entry) => entry !== 1) ||
    new Set(value['schema_versions']).size !== value['schema_versions'].length ||
    !Array.isArray(value['capabilities']) ||
    value['capabilities'].length === 0 ||
    value['capabilities'].some(
      (entry) => typeof entry !== 'string' ||
        !TASK_HOST_CAPABILITIES.has(entry as ChannelTaskHostCapability),
    ) ||
    new Set(value['capabilities']).size !== value['capabilities'].length
  ) {
    return false;
  }
  return value['capabilities'].includes('durable_task_submission_v1') &&
    value['capabilities'].includes('host_event_stream_v1') &&
    value['capabilities'].includes('durable_container_manifest_v1') &&
    value['capabilities'].includes('resource_lifecycle_v1');
}

function assertOptionalOnboard(
  value: unknown,
  context: ProviderContractContext,
): void {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value['collect'] !== 'function') {
    context.fail('provider.onboard.collect must be a function when onboard is present');
  }
}

function assertOptionalDiagnostic(
  value: unknown,
  context: ProviderContractContext,
): void {
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    typeof value['binChecks'] !== 'function' ||
    typeof value['runDiagnostic'] !== 'function'
  ) {
    context.fail(
      'provider.diagnostic must expose binChecks and runDiagnostic functions when present',
    );
  }
}
