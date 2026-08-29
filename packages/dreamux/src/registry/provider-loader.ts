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
 * `../channel/external-channel-provider.ts`). `builtin:*` refs resolve to their
 * package through {@link resolveBuiltinProviderPackage} and then use the same
 * loading path as package-backed `npm:` refs.
 */

import { errorMessage as errMessage } from '../platform/error-info.js';
import { resolveBuiltinProviderPackage } from './builtins.js';
import {
  parseProviderRef,
  type NpmProviderRef,
  type ProviderRef,
} from './provider-ref.js';
import type { ProviderDescriptor, ProviderKind } from './registry.js';
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
  importModule?: ProviderModuleImporter;
}

/**
 * Load every package-backed provider ref in `refs` into the registry using the
 * kind-specific `spec`. Builtin (`builtin:`) and external (`npm:`) refs both
 * flow through here; refs are de-duplicated by canonical form.
 *
 * The skip condition is implementation-aware, not descriptor-aware: a ref is
 * skipped only once its *implementation* is registered. A built-in descriptor
 * may already exist in the registry (the builtin descriptors are pre-registered)
 * while its package implementation has not been loaded yet — that ref must still
 * flow through import + factory + implementation registration. Skipping on
 * descriptor existence alone would silently leave pre-registered built-ins
 * without a loaded implementation (the slice-3 Codex/Claude extraction path).
 */
export async function loadProviderPackages<TProvider, TFactoryContext>(
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
 * implementation. A descriptor without an implementation (a pre-registered
 * built-in awaiting its package) returns false so the loader proceeds.
 */
function isImplementationLoaded(
  registry: ProviderRegistry,
  ref: ProviderRef,
): boolean {
  if (!registry.hasRef(ref.raw)) return false;
  const descriptor = registry.resolve(ref.raw);
  return registry.getImplementation(descriptor.id) !== undefined;
}

async function loadOneProviderPackage<TProvider, TFactoryContext>(
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
  const module = await importProviderModule(ref, packageName, importModule, spec);
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
  // ref, never read back off the loaded implementation. A pre-registered
  // built-in keeps its existing descriptor; only its implementation is loaded
  // from the package. Package-backed refs register both.
  if (existing === undefined) {
    registry.register(seedDescriptor);
  }
  registry.registerImplementation(seedDescriptor.id, provider);
}

function resolvePackageName<TProvider, TFactoryContext>(
  ref: ProviderRef,
  spec: ProviderPackageLoaderSpec<TProvider, TFactoryContext>,
): string {
  if (ref.source === 'npm') return ref.package;
  try {
    return resolveBuiltinProviderPackage(ref.id);
  } catch (err) {
    throw spec.createLoadError(ref.raw, errMessage(err), { cause: err });
  }
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

/**
 * Shared structural check: the loaded value is a provider object whose `ref`
 * matches the ref Dreamux asked the package to implement.
 */
export function assertLoadedProviderObject(
  value: unknown,
  context: ProviderContractContext,
): asserts value is { ref: string; descriptor?: unknown } {
  if (!isRecord(value)) {
    context.fail('factory must return a provider object');
  }
  if ((value as { ref?: unknown }).ref !== context.ref) {
    context.fail(`provider.ref must be ${JSON.stringify(context.ref)}`);
  }
}

/**
 * Shared structural check for `provider.descriptor`: present, correct kind,
 * seed id, and a ref matching the requested ref.
 */
export function assertProviderDescriptorShape(
  descriptor: unknown,
  expectedKind: ProviderKind,
  context: ProviderContractContext,
): asserts descriptor is ProviderDescriptor {
  if (descriptor === undefined) {
    context.fail('provider.descriptor is required');
  }
  const candidate = descriptor as Partial<ProviderDescriptor>;
  if (candidate.kind !== expectedKind) {
    context.fail(
      `provider.descriptor.kind must be ${JSON.stringify(expectedKind)} (got ${JSON.stringify(candidate.kind)})`,
    );
  }
  if (candidate.id !== context.descriptor.id) {
    context.fail(
      `provider.descriptor.id must be ${JSON.stringify(context.descriptor.id)}`,
    );
  }
  if (candidate.ref?.raw !== context.ref) {
    context.fail(`provider.descriptor.ref must be ${JSON.stringify(context.ref)}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { errMessage };

export type { NpmProviderRef };
