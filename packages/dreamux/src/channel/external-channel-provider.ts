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
 * optional config, onboard, and diagnostic capabilities. Like the Agent Runtime
 * contract, it asserts no registration identity: a provider has no `ref` or
 * `descriptor` member to echo, and its factory receives only the published
 * ref-only `ProviderFactoryContext`. `builtin:feishu` never actually reaches
 * this loader: the always-loaded Feishu plugin registers its descriptor and
 * implementation together, before this loader ever runs. A `builtin:` channel
 * ref that reaches here anyway names an id no loaded plugin contributes and
 * fails loud with the named ref.
 *
 * Unsettled for external providers: a channel provider's registration id is now
 * a segment of the model-facing MCP server name — `channel-<id>` on Claude
 * Code, `channel_<id>` on Codex. Builtin ids satisfy
 * `BUILTIN_PROVIDER_ID_PATTERN` (`/^[a-z][a-z0-9-]*$/`) and are total for that
 * use, but the shared loader seeds an `npm:` provider's id from the raw ref
 * (`npm:pkg#export`), which no engine has been shown to accept as a name
 * segment. No external channel provider exists yet and the id is a registry
 * key, so there is deliberately no sanitizer and no id change here: the first
 * external channel provider is what settles the id shape.
 */
import type {
  ChannelProvider,
  ChannelProviderFactory,
} from '@excitedjs/dreamux-types';
import type { ProviderRegistry } from '../registry/registry.js';
import {
  isRecord,
  assertOptionalProviderCapabilities,
  loadProviderPackages,
  type ProviderContractContext,
  type ProviderModule,
  type ProviderPackageLoaderSpec,
} from '../registry/provider-loader.js';

export type ExternalChannelProviderFactory = ChannelProviderFactory<unknown>;

export type ExternalChannelModule = ProviderModule;

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
  constructor(
    readonly providerRef: string,
    message: string,
  ) {
    super(
      `invalid channel provider ${JSON.stringify(providerRef)}: ${message}`,
    );
    this.name = 'ExternalChannelProviderContractError';
  }
}

export interface LoadChannelProvidersOptions {
  registry: ProviderRegistry;
  refs: Iterable<string>;
}

const CHANNEL_LOADER_SPEC: ProviderPackageLoaderSpec<ChannelProvider<unknown>> =
  {
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
): asserts value is ChannelProvider<unknown> {
  if (!isRecord(value)) {
    context.fail('factory must return a provider object');
  }
  const candidate = value as Partial<ChannelProvider<unknown>>;
  if (typeof candidate.createSession !== 'function') {
    context.fail('provider.createSession must be a function');
  }
  assertOptionalProviderCapabilities(candidate, context);
}
