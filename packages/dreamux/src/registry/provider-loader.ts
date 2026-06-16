/**
 * Generic provider package loader skeleton (issue #209).
 *
 * Dreamux core owns provider loading. This module is the kind-agnostic skeleton
 * shared by the `agentRuntime` and `channel` external loaders: it resolves the
 * package name for a ref, dynamically imports the module, selects the factory
 * export, invokes it, registers the resulting descriptor + implementation, and
 * formats fail-loud load/contract errors consistently.
 *
 * Kind-specific contract assertions stay with each kind's loader (see
 * `../agent-runtime/external-provider.ts` and
 * `../channel/external-channel-provider.ts`). `builtin:*` refs resolve to their
 * package through {@link resolveBuiltinProviderPackage} and then use the same
 * loading path as package-backed `npm:` refs.
 */

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

/** Context passed to a provider package's factory export. */
export interface ProviderFactoryContext {
  /** Canonical provider ref from config, for example `npm:some-pkg#provider`. */
  ref: string;
  /** Seed descriptor the provider must echo back to Dreamux. */
  descriptor: ProviderDescriptor;
}

export type ProviderFactory<TProvider> = (
  context: ProviderFactoryContext,
) => TProvider | Promise<TProvider>;

/** Context handed to a kind-specific contract assertion. */
export interface ProviderContractContext {
  ref: string;
  descriptor: ProviderDescriptor;
  /** Throw the kind-specific contract error with a consistent prefix. */
  fail(message: string): never;
}

/**
 * Per-kind hooks the generic skeleton needs: how to format errors and how to
 * assert the loaded value satisfies that kind's provider contract.
 */
export interface ProviderPackageLoaderSpec<
  TProvider extends { readonly descriptor: ProviderDescriptor },
> {
  kind: ProviderKind;
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
export async function loadProviderPackages<
  TProvider extends { readonly descriptor: ProviderDescriptor },
>(
  options: LoadProviderPackagesOptions,
  spec: ProviderPackageLoaderSpec<TProvider>,
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

async function loadOneProviderPackage<
  TProvider extends { readonly descriptor: ProviderDescriptor },
>(
  registry: ProviderRegistry,
  ref: ProviderRef,
  importModule: ProviderModuleImporter,
  spec: ProviderPackageLoaderSpec<TProvider>,
): Promise<void> {
  const existing = registry.hasRef(ref.raw)
    ? registry.resolve(ref.raw)
    : undefined;
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
    provider = await factory({ ref: ref.raw, descriptor: seedDescriptor });
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

  // A pre-registered built-in keeps its existing descriptor; only its
  // implementation is loaded from the package. Package-backed refs register
  // both the descriptor and the implementation.
  if (existing === undefined) {
    registry.register(provider.descriptor);
  }
  registry.registerImplementation(provider.descriptor.id, provider);
}

function resolvePackageName<
  TProvider extends { readonly descriptor: ProviderDescriptor },
>(ref: ProviderRef, spec: ProviderPackageLoaderSpec<TProvider>): string {
  if (ref.source === 'npm') return ref.package;
  try {
    return resolveBuiltinProviderPackage(ref.id);
  } catch (err) {
    throw spec.createLoadError(ref.raw, errMessage(err), { cause: err });
  }
}

async function importProviderModule<
  TProvider extends { readonly descriptor: ProviderDescriptor },
>(
  ref: ProviderRef,
  packageName: string,
  importModule: ProviderModuleImporter,
  spec: ProviderPackageLoaderSpec<TProvider>,
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

function selectFactoryExport<
  TProvider extends { readonly descriptor: ProviderDescriptor },
>(
  ref: ProviderRef,
  module: ProviderModule,
  spec: ProviderPackageLoaderSpec<TProvider>,
): ProviderFactory<TProvider> {
  const exportName = ref.source === 'npm' ? ref.export : null;
  const value = exportName === null ? module.default : module[exportName];
  if (typeof value !== 'function') {
    throw spec.createContractError(
      ref.raw,
      `expected ${exportName ?? 'default'} export to be a provider factory function for kind ${JSON.stringify(spec.kind)}`,
    );
  }
  return value as ProviderFactory<TProvider>;
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

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { NpmProviderRef };
