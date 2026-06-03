import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(dirname(HERE));
const PACKAGE_BIN_DIR = join(PACKAGE_ROOT, 'bin');

export function dispatcherProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PATH: prependPath(packageBinDirs(baseEnv), baseEnv['PATH']),
  };
  delete env['CODEX_HOME'];
  return env;
}

function packageBinDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [PACKAGE_BIN_DIR];
  const dreamuxBin = env['DREAMUX_BIN'];
  if (dreamuxBin !== undefined && dreamuxBin !== '') {
    dirs.push(dirname(dreamuxBin));
  }
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
