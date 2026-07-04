/**
 * External `subscribeChannel` provider loader.
 *
 * Subscription providers share the generic provider package loader with channel
 * and runtime providers, but assert the one-way subscription contract.
 */
import { type ProviderRegistry } from '../registry/index.js';
import {
  assertLoadedProviderObject,
  assertProviderDescriptorShape,
  loadProviderPackages,
  type ProviderContractContext,
  type ProviderFactory,
  type ProviderModule,
  type ProviderModuleImporter,
  type ProviderPackageLoaderSpec,
} from '../registry/provider-loader.js';
import type { SubscribeChannelProvider } from '@excitedjs/dreamux-types';
export { asSubscribeChannelProvider } from './catalog.js';

export type ExternalSubscribeChannelProviderFactory =
  ProviderFactory<SubscribeChannelProvider>;

export type ExternalSubscribeChannelModule = ProviderModule;

export type ExternalSubscribeChannelModuleImporter = ProviderModuleImporter;

export class ExternalSubscribeChannelProviderLoadError extends Error {
  constructor(
    readonly providerRef: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `failed to load subscribeChannel provider ${JSON.stringify(providerRef)}: ${message}`,
      options,
    );
    this.name = 'ExternalSubscribeChannelProviderLoadError';
  }
}

export class ExternalSubscribeChannelProviderContractError extends Error {
  constructor(readonly providerRef: string, message: string) {
    super(`invalid subscribeChannel provider ${JSON.stringify(providerRef)}: ${message}`);
    this.name = 'ExternalSubscribeChannelProviderContractError';
  }
}

export interface LoadSubscribeChannelProvidersOptions {
  registry: ProviderRegistry;
  refs: Iterable<string>;
  importModule?: ExternalSubscribeChannelModuleImporter;
}

const SUBSCRIBE_CHANNEL_LOADER_SPEC: ProviderPackageLoaderSpec<SubscribeChannelProvider> = {
  kind: 'subscribeChannel',
  createLoadError: (ref, message, options) =>
    new ExternalSubscribeChannelProviderLoadError(ref, message, options),
  createContractError: (ref, message) =>
    new ExternalSubscribeChannelProviderContractError(ref, message),
  assertProvider: assertSubscribeChannelProvider,
};

export async function loadSubscribeChannelProviders(
  options: LoadSubscribeChannelProvidersOptions,
): Promise<void> {
  await loadProviderPackages(options, SUBSCRIBE_CHANNEL_LOADER_SPEC);
}

function assertSubscribeChannelProvider(
  value: unknown,
  context: ProviderContractContext,
): asserts value is SubscribeChannelProvider {
  assertLoadedProviderObject(value, context);
  const candidate = value as Partial<SubscribeChannelProvider>;
  assertProviderDescriptorShape(candidate.descriptor, 'subscribeChannel', context);
  if (candidate.readConfig !== undefined && typeof candidate.readConfig !== 'function') {
    context.fail('provider.readConfig must be a function when present');
  }
  if (typeof candidate.createSession !== 'function') {
    context.fail('provider.createSession must be a function');
  }
  if (candidate.tools !== undefined && typeof candidate.tools !== 'function') {
    context.fail('provider.tools must be a function when present');
  }
  if (candidate.handleTool !== undefined && typeof candidate.handleTool !== 'function') {
    context.fail('provider.handleTool must be a function when present');
  }
}
