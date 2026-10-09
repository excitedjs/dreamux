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
 * stays inside the skeleton; every factory receives only its configured ref.
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
import { parseProviderRef } from './provider-ref.js';
import type {
  ProviderRef,
  ProviderDescriptor,
  ProviderKind,
  ProviderFactory,
  NpmProviderRef,
} from '@excitedjs/dreamux-types';
import type { ProviderImplementation, ProviderRegistry } from './registry.js';
import { UnknownBuiltinProviderPackageError } from './builtins.js';

export type ProviderModule = Record<string, unknown> & {
  default?: unknown;
};

/** Context handed to a kind-specific contract assertion. */
export interface ProviderContractContext {
  ref: string;
  /** Throw the kind-specific contract error with a consistent prefix. */
  fail(message: string): never;
}

/**
 * Per-kind hooks the generic skeleton needs: how to format errors and assert
 * that the loaded value satisfies that
 * kind's provider contract.
 */
export interface ProviderPackageLoaderSpec<TProvider> {
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
>(
  options: LoadProviderPackagesOptions,
  spec: ProviderPackageLoaderSpec<TProvider>,
): Promise<void> {
  for (const ref of uniqueLoadableRefs(options.refs)) {
    if (options.registry.hasRef(ref.raw)) continue;
    await loadOneProviderPackage(options.registry, ref, spec);
  }
}

async function loadOneProviderPackage<TProvider extends ProviderImplementation>(
  registry: ProviderRegistry,
  ref: ProviderRef,
  spec: ProviderPackageLoaderSpec<TProvider>,
): Promise<void> {
  if (ref.source === 'builtin') {
    throw new UnknownBuiltinProviderPackageError(ref.id);
  }
  const module = await importProviderModule(ref, ref.package, spec);
  const factory = selectFactoryExport(ref, module, spec);
  // The registered descriptor is Core's own: parsed from the configured ref,
  // never read back off the loaded implementation.
  const descriptor: ProviderDescriptor = {
    id: ref.raw,
    kind: spec.kind,
    ref,
  };

  let provider: TProvider;
  try {
    provider = await factory({ ref: ref.raw });
  } catch (err) {
    throw spec.createLoadError(
      ref.raw,
      `provider factory threw: ${errMessage(err)}`,
      { cause: err },
    );
  }

  spec.assertProvider(provider, {
    ref: ref.raw,
    fail: (message) => {
      throw spec.createContractError(ref.raw, message);
    },
  });

  registry.register(descriptor, provider);
}

async function importProviderModule<TProvider>(
  ref: ProviderRef,
  packageName: string,
  spec: ProviderPackageLoaderSpec<TProvider>,
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

function selectFactoryExport<TProvider>(
  ref: NpmProviderRef,
  module: ProviderModule,
  spec: ProviderPackageLoaderSpec<TProvider>,
): ProviderFactory<TProvider> {
  const exportName = ref.export;
  const value = exportName === null ? module.default : module[exportName];
  if (typeof value !== 'function') {
    throw spec.createContractError(
      ref.raw,
      `expected ${exportName ?? 'default'} export to be a provider factory function for kind ${JSON.stringify(spec.kind)}`,
    );
  }
  return value as ProviderFactory<TProvider>;
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

export function assertOptionalProviderCapabilities(
  value: { config?: unknown; onboard?: unknown; diagnostic?: unknown },
  context: ProviderContractContext,
): void {
  assertOptionalConfig(value.config, context);
  assertOptionalOnboard(value.onboard, context);
  assertOptionalDiagnostic(value.diagnostic, context);
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
    context.fail(
      'provider.onboard.collect must be a function when onboard is present',
    );
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
