import { dirname, join, resolve } from 'node:path';
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
  const env: NodeJS.ProcessEnv = {
    ...mergedEnv,
    PATH: prependPath(packageBinDirs(mergedEnv), mergedEnv['PATH']),
  };
  delete env['CODEX_HOME'];
  return env;
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
