import { access, constants } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(dirname(HERE));
const PACKAGE_BIN_DIR = join(PACKAGE_ROOT, 'bin');
const DREAMUX_BIN = join(PACKAGE_BIN_DIR, 'dreamux');

export function dreamuxBinPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env['DREAMUX_BIN'];
  return fromEnv !== undefined && fromEnv !== ''
    ? resolve(fromEnv)
    : DREAMUX_BIN;
}

export function dispatcherProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...extraEnv,
  };
  return {
    ...mergedEnv,
    PATH: prependPath(packageBinDirs(mergedEnv), mergedEnv['PATH']),
  };
}

/**
 * Resolve an executable to an absolute path the same way a shell would, using
 * the supplied `PATH` — async (the `n/no-sync` gate bans the sync `fs` calls a
 * `which` shim would use). A `bin` that already contains a path separator is
 * checked directly; a bare name is searched across `env.PATH` entries. Returns
 * the first executable match, or `null` when nothing resolves.
 *
 * This proves *resolvability* (an executable file exists on PATH), the exact
 * signal behind a `spawn <bin> ENOENT` and an empty `command -v <bin>`. It does
 * NOT prove a successful start (auth, arch, or a broken binary can still fail),
 * so callers keep the spawn-time failure as the backstop.
 */
export async function resolveExecutableOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (bin === '') return null;
  const candidates =
    bin.includes(sep) || bin.includes('/')
      ? [isAbsolute(bin) ? bin : resolve(bin)]
      : (env['PATH'] ?? '').split(':').flatMap((dir) => (dir === '' ? [] : [join(dir, bin)]));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable / not present here — keep searching the remaining PATH
      // entries; a fully unresolved bin returns null below.
    }
  }
  return null;
}

function packageBinDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [PACKAGE_BIN_DIR];
  dirs.push(dirname(dreamuxBinPath(env)));
  return dirs;
}

function prependPath(prefixes: string[], existing: string | undefined): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of [...prefixes, ...(existing ?? '').split(':')]) {
    if (part === '' || seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
  }
  return parts.join(':');
}
