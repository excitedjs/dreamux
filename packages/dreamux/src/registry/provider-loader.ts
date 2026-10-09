/**
 * Generic provider package loader skeleton (issue #209).
 *
 * Dreamux core owns provider loading. This module is the kind-agnostic skeleton
 * shared by the `agentRuntime` and `channel` external loaders: it resolves the
 * package name for a ref, dynamically imports the module, selects the factory
 * export, invokes it, registers Core's own descriptor together with the loaded
 * implementation, and formats fail-loud load/contract errors consistently.
 *
 * Registration identity is Core's: the descriptor comes from the configured ref
 * this skeleton parsed, never from the loaded provider object. That descriptor
 * stays inside the skeleton — each kind's spec projects the factory context its
 * own published contract promises.
 *
 * Kind-specific contract assertions stay with each kind's loader (see
 * `../agent-runtime/external-provider.ts` and
 * `../channel/external-channel-provider.ts`). A `builtin:` ref never resolves
 * to a package name here: every built-in ships as an always-loaded plugin and
 * registers its descriptor and implementation together before this skeleton
 * runs, so a `builtin:` ref reaching {@link loadProviderPackages} unregistered
 * names an id no loaded plugin contributes and fails loud immediately, as a
 * refused ref (`UnknownBuiltinProviderPackageError`) rather than a load
 * failure; only an `npm:` ref resolves to a package and flows through import +
 * factory.
 */

import { errorMessage as errMessage } from '@excitedjs/dreamux-utils';
import { UnknownBuiltinProviderPackageError } from './builtins.js';
import { parseProviderRef, type ProviderRef } from './provider-ref.js';
import type {
  ProviderDescriptor,
  ProviderImplementation,
  ProviderKind,
  ProviderRegistry,
} from './registry.js';

export type ProviderModule = Record<string, unknown> & {
  default?: unknown;
};

/**
 * A provider package's factory export.
 *
 * The skeleton is deliberately generic over the context: what a factory sees is
 * that kind's published contract, not a skeleton-wide shape. Core keeps its
 * registration descriptor internally and hands each kind only what
 * {@link ProviderPackageLoaderSpec.factoryContext} builds.
 */
export type ProviderFactory<TProvider, TFactoryContext> = (
  context: TFactoryContext,
) => TProvider | Promise<TProvider>;

/** Context handed to a kind-specific contract assertion. */
export interface ProviderContractContext {
  ref: string;
  descriptor: ProviderDescriptor;
  /** Throw the kind-specific contract error with a consistent prefix. */
  fail(message: string): never;
}

/**
 * Per-kind hooks the generic skeleton needs: what its factory export receives,
 * how to format errors, and how to assert the loaded value satisfies that
 * kind's provider contract.
 */
export interface ProviderPackageLoaderSpec<TProvider, TFactoryContext> {
  kind: ProviderKind;
  /**
   * Build the context this kind's factory export is called with.
   *
   * Core's registration descriptor stays internal to the skeleton; a kind whose
   * published factory contract is ref-only (the Agent Runtime contract) must
   * project exactly `{ ref }` here, so the descriptor cannot leak into a
   * factory that has nothing to echo back.
   */
  factoryContext(input: {
    ref: string;
    descriptor: ProviderDescriptor;
  }): TFactoryContext;
  createLoadError(
    ref: string,
    message: string,
    options?: { cause?: unknown },
  ): Error;
  createContractError(ref: string, message: string): Error;
  assertProvider(
    value: unknown,
    context: ProviderContractContext,
  ): asserts value is TProvider;
}

export interface LoadProviderPackagesOptions {
  registry: ProviderRegistry;
  refs: Iterable<string>;
}

/**
 * Load every package-backed provider ref in `refs` into the registry using the
 * kind-specific `spec`. Builtin (`builtin:`) and external (`npm:`) refs both
 * flow through here; refs are de-duplicated by canonical form. A ref already
 * registered (by an earlier pass, or as an always-loaded built-in) is
 * skipped — `ProviderRegistry.register()` always registers a descriptor
 * together with its implementation, so presence of one means presence of
 * both. A ref registered under the wrong kind (a `channel` ref that turns out
 * to be an `agentRuntime` provider) is skipped here too and is caught instead
 * by `config/config.ts`'s `resolveConfigProvider`, which checks every
 * resolved descriptor's kind against the field that referenced it.
 *
 * `TProvider extends ProviderImplementation` so the loaded value can reach
 * `ProviderRegistry.register()` typed; the skeleton stays kind-agnostic
 * otherwise — it never branches on which of the two contracts `TProvider` is.
 */
export async function loadProviderPackages<
  TProvider extends ProviderImplementation,
  TFactoryContext,
>(
  options: LoadProviderPackagesOptions,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): Promise<void> {
  for (const ref of uniqueLoadableRefs(options.refs)) {
    if (options.registry.hasRef(ref.raw)) continue;
    await loadOneProviderPackage(options.registry, ref, spec);
  }
}

async function loadOneProviderPackage<
  TProvider extends ProviderImplementation,
  TFactoryContext,
>(
  registry: ProviderRegistry,
  ref: ProviderRef,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): Promise<void> {
  const packageName = resolvePackageName(ref);
  const module = await importProviderModule(ref, packageName, spec);
  const factory = selectFactoryExport(ref, module, spec);
  // The registered descriptor is Core's own: parsed from the configured ref,
  // never read back off the loaded implementation.
  const descriptor: ProviderDescriptor = {
    id: seedDescriptorId(ref),
    kind: spec.kind,
    ref,
  };

  let provider: TProvider;
  try {
    provider = await factory(spec.factoryContext({ ref: ref.raw, descriptor }));
  } catch (err) {
    throw spec.createLoadError(
      ref.raw,
      `provider factory threw: ${errMessage(err)}`,
      { cause: err },
    );
  }

  spec.assertProvider(provider, {
    ref: ref.raw,
    descriptor,
    fail: (message) => {
      throw spec.createContractError(ref.raw, message);
    },
  });

  registry.register(descriptor, provider);
}

function resolvePackageName(ref: ProviderRef): string {
  if (ref.source === 'npm') return ref.package;
  // A `builtin:` ref only ever reaches here unregistered (see the module
  // comment): there is no package to resolve it to, only the named failure.
  // It is thrown as itself, not wrapped in the kind's load error: it is a
  // refused ref, not a failed load.
  throw new UnknownBuiltinProviderPackageError(ref.id);
}

async function importProviderModule<TProvider, TFactoryContext>(
  ref: ProviderRef,
  packageName: string,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): Promise<ProviderModule> {
  try {
    return await defaultImportModule(packageName);
  } catch (err) {
    throw spec.createLoadError(
      ref.raw,
      `could not import package ${JSON.stringify(packageName)}: ${errMessage(err)}`,
      { cause: err },
    );
  }
}

function selectFactoryExport<TProvider, TFactoryContext>(
  ref: ProviderRef,
  module: ProviderModule,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): ProviderFactory<TProvider, TFactoryContext> {
  const exportName = ref.source === 'npm' ? ref.export : null;
  const value = exportName === null ? module.default : module[exportName];
  if (typeof value !== 'function') {
    throw spec.createContractError(
      ref.raw,
      `expected ${exportName ?? 'default'} export to be a provider factory function for kind ${JSON.stringify(spec.kind)}`,
    );
  }
  return value as ProviderFactory<TProvider, TFactoryContext>;
}

function seedDescriptorId(ref: ProviderRef): string {
  return ref.source === 'builtin' ? ref.id : ref.raw;
}

function uniqueLoadableRefs(refs: Iterable<string>): ProviderRef[] {
  const out = new Map<string, ProviderRef>();
  for (const raw of refs) {
    const parsed = parseProviderRef(raw);
    out.set(parsed.raw, parsed);
  }
  return [...out.values()];
}

async function defaultImportModule(
  packageName: string,
): Promise<ProviderModule> {
  return import(packageName) as Promise<ProviderModule>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
