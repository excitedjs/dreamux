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
 * names an id no loaded plugin contributes and fails loud immediately; only
 * an `npm:` ref resolves to a package and flows through import + factory.
 */

import { errorMessage as errMessage } from '@excitedjs/dreamux-utils';
import { UnknownBuiltinProviderPackageError } from './builtins.js';
import { parseProviderRef, type ProviderRef } from './provider-ref.js';
import type {
  ProviderDescriptor,
  ProviderImplementation,
  ProviderKind,
} from './registry.js';
import type { ProviderRegistry } from './registry.js';

export type ProviderModule = Record<string, unknown> & {
  default?: unknown;
};

export type ProviderModuleImporter = (
  packageName: string,
) => Promise<ProviderModule>;

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
  importModule?: ProviderModuleImporter | undefined;
}

/**
 * Load every package-backed provider ref in `refs` into the registry using the
 * kind-specific `spec`. Builtin (`builtin:`) and external (`npm:`) refs both
 * flow through here; refs are de-duplicated by canonical form.
 *
 * The skip condition is implementation-aware, not descriptor-aware: a ref is
 * skipped only once its *implementation* is registered. Every built-in
 * (`codex`, `claude-code`, `feishu`) registers descriptor and implementation
 * together from its plugin's `contribute()`, so this skeleton never sees one
 * of their refs with a descriptor but no implementation — but a caller is
 * free to pre-register a bare descriptor ahead of time (`ProviderRegistry.register`
 * accepts one with no `implementation`), and skipping on descriptor existence
 * alone would then silently leave it without a loaded implementation.
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
  const importModule = options.importModule ?? defaultImportModule;
  for (const ref of uniqueLoadableRefs(options.refs)) {
    if (isImplementationLoaded(options.registry, ref)) continue;
    await loadOneProviderPackage(options.registry, ref, importModule, spec);
  }
}

/**
 * True when `ref` already has both a registered descriptor and a registered
 * implementation. A descriptor registered without an implementation returns
 * false so the loader proceeds to load and register one.
 */
function isImplementationLoaded(
  registry: ProviderRegistry,
  ref: ProviderRef,
): boolean {
  if (!registry.hasRef(ref.raw)) return false;
  const descriptor = registry.resolve(ref.raw);
  return registry.getImplementation(descriptor.id) !== undefined;
}

async function loadOneProviderPackage<
  TProvider extends ProviderImplementation,
  TFactoryContext,
>(
  registry: ProviderRegistry,
  ref: ProviderRef,
  importModule: ProviderModuleImporter,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): Promise<void> {
  const existing = registry.hasRef(ref.raw)
    ? registry.resolve(ref.raw)
    : undefined;
  // Core owns the kind of a registered ref. A provider no longer echoes a
  // descriptor back, so this is the only place a ref listed under the wrong
  // kind (a channel ref configured as an agentRuntime, say) can fail loud.
  if (existing !== undefined && existing.kind !== spec.kind) {
    throw spec.createContractError(
      ref.raw,
      `provider ref is registered as kind ${JSON.stringify(existing.kind)}, expected ${JSON.stringify(spec.kind)}`,
    );
  }
  const packageName = resolvePackageName(ref, spec);
  const module = await importProviderModule(
    ref,
    packageName,
    importModule,
    spec,
  );
  const factory = selectFactoryExport(ref, module, spec);
  const seedDescriptor: ProviderDescriptor = existing ?? {
    id: seedDescriptorId(ref),
    kind: spec.kind,
    ref,
  };

  let provider: TProvider;
  try {
    provider = await factory(
      spec.factoryContext({ ref: ref.raw, descriptor: seedDescriptor }),
    );
  } catch (err) {
    throw spec.createLoadError(
      ref.raw,
      `provider factory threw: ${errMessage(err)}`,
      { cause: err },
    );
  }

  spec.assertProvider(provider, {
    ref: ref.raw,
    descriptor: seedDescriptor,
    fail: (message) => {
      throw spec.createContractError(ref.raw, message);
    },
  });

  // The registered descriptor is Core's own: it is parsed from the configured
  // ref, never read back off the loaded implementation. `seedDescriptor` is
  // `existing` itself when a caller pre-registered a bare descriptor for this
  // ref (same object, not a copy), so `register()` recognizes the completion
  // and only adds the implementation instead of registering the descriptor a
  // second time — no in-repo caller does this today (see `registry.ts`'s
  // `register()` doc comment), so in practice every ref registers both in
  // this one call.
  registry.register(seedDescriptor, provider);
}

function resolvePackageName<TProvider, TFactoryContext>(
  ref: ProviderRef,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): string {
  if (ref.source === 'npm') return ref.package;
  // A `builtin:` ref only ever reaches here unregistered (see the module
  // comment): there is no package to resolve it to, only the named failure.
  const err = new UnknownBuiltinProviderPackageError(ref.id);
  throw spec.createLoadError(ref.raw, errMessage(err), { cause: err });
}

async function importProviderModule<TProvider, TFactoryContext>(
  ref: ProviderRef,
  packageName: string,
  importModule: ProviderModuleImporter,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): Promise<ProviderModule> {
  try {
    return await importModule(packageName);
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
