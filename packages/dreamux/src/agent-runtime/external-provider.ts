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
 * The assertions below check only the neutral Agent Runtime contract. They
 * deliberately assert no registration identity: a provider has no `ref` or
 * `descriptor` member to echo, because Core keeps the sole authoritative
 * descriptor beside the implementation it registered. Declared capabilities are
 * validated by taking Core's one snapshot of them (`./capabilities.ts`), the
 * same object the catalog later serves, rather than by inspecting a read that
 * would be thrown away.
 *
 * The `channel` kind reuses the same skeleton through a sibling loader; only the
 * contract assertions below are runtime-specific.
 */
import type {
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderFactory,
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
import {
  agentRuntimeCapabilitySnapshot,
  InvalidAgentRuntimeCapabilitiesError,
} from './capabilities.js';

export type ExternalAgentRuntimeProviderFactory =
  AgentRuntimeProviderFactory<unknown>;

export type ExternalAgentRuntimeModule = ProviderModule;

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
  constructor(
    readonly providerRef: string,
    message: string,
  ) {
    super(
      `invalid external agentRuntime provider ${JSON.stringify(providerRef)}: ${message}`,
    );
    this.name = 'ExternalAgentRuntimeProviderContractError';
  }
}

export interface LoadAgentRuntimeProvidersOptions {
  registry: ProviderRegistry;
  refs: Iterable<string>;
}

const AGENT_RUNTIME_LOADER_SPEC: ProviderPackageLoaderSpec<
  AgentRuntimeProvider<unknown>
> = {
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
): asserts value is AgentRuntimeProvider<unknown> {
  if (!isRecord(value)) {
    context.fail('factory must return a provider object');
  }
  const candidate = value as Partial<AgentRuntimeProvider<unknown>>;
  if (typeof candidate.getCapabilities !== 'function') {
    context.fail('provider.getCapabilities must be a function');
  }
  if (typeof candidate.readRecentActivity !== 'function') {
    context.fail('provider.readRecentActivity must be a function');
  }
  if (typeof candidate.createRuntime !== 'function') {
    context.fail('provider.createRuntime must be a function');
  }
  assertOptionalProviderCapabilities(candidate, context);
  // Take Core's one capability snapshot here rather than validating a throwaway
  // read: the catalog later reuses this exact snapshot, so a provider cannot
  // pass the contract with one object and serve the public projection another.
  try {
    // `candidate` is the object the registry will hold, so the snapshot is
    // keyed by the same identity the catalog resolves later.
    agentRuntimeCapabilitySnapshot(
      candidate as AgentRuntimeProvider<unknown>,
      context.ref,
    );
  } catch (err) {
    if (err instanceof InvalidAgentRuntimeCapabilitiesError) {
      context.fail(`provider.getCapabilities: ${err.detail}`);
    }
    throw err;
  }
  const createRuntime = candidate.createRuntime.bind(candidate);
  candidate.createRuntime = async (
    runtimeContext: AgentRuntimeCreateContext<unknown>,
  ) => {
    // `createRuntime` is async, so the handle can only be checked once it
    // settles; asserting the promise itself would check the wrong object.
    const runtime = await createRuntime(runtimeContext);
    assertRuntimeHandle(runtime, context);
    return runtime;
  };
}

/**
 * The live handle is start/submit/stop and nothing else: state reaches Core
 * through the leased sink it was created with, not through pull methods.
 */
function assertRuntimeHandle(
  value: unknown,
  context: ProviderContractContext,
): void {
  if (!isRecord(value)) {
    context.fail('createRuntime must return a runtime object');
  }
  for (const method of ['start', 'submit', 'stop']) {
    if (typeof value[method] !== 'function') {
      context.fail(`runtime.${method} must be a function`);
    }
  }
}
