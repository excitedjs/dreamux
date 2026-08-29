/**
 * External `channel` provider loader (issue #209).
 *
 * The `channel` specialization of the generic provider package loader
 * (`../registry/provider-loader.ts`). It mirrors the `agentRuntime` loader: the
 * shared skeleton owns dynamic import, export selection, factory invocation,
 * duplicate handling, descriptor registration, and fail-loud formatting, while
 * the assertions here enforce the `ChannelProvider<unknown>` contract.
 *
 * A channel provider must expose a channel session factory and may expose the
 * optional config, onboard, and diagnostic capabilities. `builtin:feishu`
 * resolves to
 * `@excitedjs/feishu-channel` through the same loading path once the alias is
 * resolved; a missing built-in channel package fails loud with the named ref.
 */
import {
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  assertLoadedProviderObject,
  isRecord,
  loadProviderPackages,
  type ProviderContractContext,
  type ProviderFactory,
  type ProviderModule,
  type ProviderModuleImporter,
  type ProviderPackageLoaderSpec,
} from '../registry/provider-loader.js';
import type { ChannelProvider } from '@excitedjs/dreamux-types';

/**
 * The context a channel factory export is called with.
 *
 * Core's seed descriptor travels with the ref because the channel loader
 * registers under it. The provider itself echoes nothing back: like the Agent
 * Runtime contract, it has no `ref`/`descriptor` member.
 */
export interface ExternalChannelProviderFactoryContext {
  /** Canonical provider ref from config, for example `builtin:feishu`. */
  ref: string;
  /** Descriptor the provider must expose back to Dreamux. */
  descriptor: ProviderDescriptor;
}

export type ExternalChannelProviderFactory = ProviderFactory<
  ChannelProvider<unknown>,
  ExternalChannelProviderFactoryContext
>;

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

const CHANNEL_LOADER_SPEC: ProviderPackageLoaderSpec<
  ChannelProvider<unknown>,
  ExternalChannelProviderFactoryContext
> = {
  kind: 'channel',
  factoryContext: ({ ref, descriptor }) => ({ ref, descriptor }),
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
): asserts value is ChannelProvider<unknown> {
  assertLoadedProviderObject(value, context);
  const candidate = value as Partial<ChannelProvider<unknown>>;
  if (typeof candidate.createSession !== 'function') {
    context.fail('provider.createSession must be a function');
  }
  assertOptionalConfig(candidate.config, context);
  assertOptionalOnboard(candidate.onboard, context);
  assertOptionalDiagnostic(candidate.diagnostic, context);
}

function assertOptionalConfig(
  value: unknown,
  context: ProviderContractContext,
): void {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value['read'] !== 'function') {
    context.fail(
      'provider.config.read must be a function when config is present',
    );
  }
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
