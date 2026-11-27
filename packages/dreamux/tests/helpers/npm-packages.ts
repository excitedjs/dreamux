import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * npm packages a test stands in for, in the two forms the suites need.
 *
 * `writeNpmPackage` writes a real package under
 * `<root>/plugins/node_modules/<name>`, where `importNpmPackage` finds it, so
 * the real lookup and the real import run. `fakeNpmModules` is for suites
 * whose plugin modules are objects built in the test, functions included:
 * `vi.mock('../src/plugin/resolve.js', ...)` with `importFakeNpmPackage`
 * hands those to the loader in place of the import. This module must not
 * import `src/plugin/resolve.ts`: the mock factory loads it while that
 * module's mock is still being made.
 *
 * Vitest resolves `require.resolve` through its own resolver, which also
 * reaches packages of this repository's workspace. No suite can therefore
 * observe that plain Node refuses a package that is not in the plugin
 * directory; a suite names only packages that exist nowhere.
 */
export const fakeNpmModules = new Map<string, Record<string, unknown>>();

export async function importFakeNpmPackage(
  name: string,
): Promise<Record<string, unknown>> {
  const module = fakeNpmModules.get(name);
  // Any error here is the loader's import failure, as a missing package is.
  if (module === undefined) throw new Error(`no fake npm package ${name}`);
  return module;
}

/** Write an ESM package with `entrySource` as its `index.js`. */
export async function writeNpmPackage(
  root: string,
  name: string,
  entrySource: string,
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const dir = join(root, 'plugins', 'node_modules', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, type: 'module', main: 'index.js', ...manifest }),
  );
  await writeFile(join(dir, 'index.js'), entrySource);
  return dir;
}
