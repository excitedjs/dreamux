import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pluginRoot } from '../platform/paths.js';
import type { ProviderRef } from '@excitedjs/dreamux-types';
import {
  NPM_PACKAGE_RULE,
  parseProviderRef,
} from '../registry/provider-ref.js';

/**
 * The one way the package of an `npm:` ref is found and imported: from the
 * plugin directory, wherever Dreamux itself is installed. `plugin/loader.ts`
 * and `registry/provider-loader.ts` both come here, so the daemon,
 * `dreamux doctor`, and every plugin command find a package in the same
 * place. A `builtin:` ref is a package of Dreamux's own install and is
 * imported by name, not through here.
 *
 * The entry is resolved as `require` resolves it and then imported. A
 * package that declares both an `import` and a `require` entry is therefore
 * loaded through its `require` one; Node has no stable way to resolve the
 * `import` one from another directory, and every Dreamux package is
 * ESM-only.
 */

/** The package of an `npm:` ref is not resolvable from the plugin directory. */
export class NpmPackageMissingError extends Error {
  constructor(readonly packageName: string) {
    super(
      `package ${JSON.stringify(packageName)} is not in the Dreamux plugin directory; ` +
        `run: dreamux plugin add ${packageName}`,
    );
    this.name = 'NpmPackageMissingError';
  }
}

/** The entry file of an installed package; see the module note for how. */
export function resolveNpmPackageEntry(packageName: string): string {
  // Created per call: `pluginRoot()` reads `DREAMUX_ROOT` when it runs.
  const require = createRequire(join(pluginRoot(), 'package.json'));
  try {
    return require.resolve(packageName);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      throw new NpmPackageMissingError(packageName);
    }
    throw err;
  }
}

export function hasNpmPackage(packageName: string): boolean {
  try {
    resolveNpmPackageEntry(packageName);
    return true;
  } catch (err) {
    if (err instanceof NpmPackageMissingError) return false;
    throw err;
  }
}

export async function importNpmPackage(
  packageName: string,
): Promise<Record<string, unknown>> {
  const entry = resolveNpmPackageEntry(packageName);
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}

/**
 * The npm package name a plugin command was given, or an error saying what
 * was expected. A version range, a `file:` path, or a `#export` suffix is not
 * a package name: the commands install, look up, and register the name alone.
 */
export function npmPackageName(input: string): string {
  let ref: ProviderRef;
  try {
    ref = parseProviderRef(`npm:${input}`);
  } catch {
    throw notAName(input);
  }
  if (ref.source !== 'npm' || ref.export !== null) throw notAName(input);
  return ref.package;
}

function notAName(input: string): Error {
  return new Error(
    `expected ${NPM_PACKAGE_RULE}, got ${JSON.stringify(input)}`,
  );
}
