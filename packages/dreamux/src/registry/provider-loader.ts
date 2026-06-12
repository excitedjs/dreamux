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
 * flow through here; already-registered refs are skipped, and refs are
 * de-duplicated by canonical form.
 */
export async function loadProviderPackages<
  TProvider extends { readonly descriptor: ProviderDescriptor },
>(
  options: LoadProviderPackagesOptions,
  spec: ProviderPackageLoaderSpec<TProvider>,
): Promise<void> {
  const importModule = options.importModule ?? defaultImportModule;
  for (const ref of uniqueLoadableRefs(options.refs)) {
    if (options.registry.hasRef(ref.raw)) continue;
    await loadOneProviderPackage(options.registry, ref, importModule, spec);
  }
}

async function loadOneProviderPackage<
  TProvider extends { readonly descriptor: ProviderDescriptor },
>(
  registry: ProviderRegistry,
  ref: ProviderRef,
  importModule: ProviderModuleImporter,
  spec: ProviderPackageLoaderSpec<TProvider>,
): Promise<void> {
  const packageName = resolvePackageName(ref, spec);
  const module = await importProviderModule(ref, packageName, importModule, spec);
  const factory = selectFactoryExport(ref, module, spec);
  const seedDescriptor: ProviderDescriptor = {
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

  registry.register(provider.descriptor);
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
      `expected ${exportName ?? 'default'} export to be a ${spec.kind} provider factory`,
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
 * non-empty id, and a ref matching the requested ref.
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
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    context.fail('provider.descriptor.id must be a non-empty string');
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
