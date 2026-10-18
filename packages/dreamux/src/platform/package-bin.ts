import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(dirname(HERE));
const PACKAGE_BIN_DIR = join(PACKAGE_ROOT, 'bin');
const DREAMUX_BIN = join(PACKAGE_BIN_DIR, 'dreamux');

export function dreamuxBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DREAMUX_BIN'];
  return fromEnv !== undefined && fromEnv !== ''
    ? resolve(fromEnv)
    : DREAMUX_BIN;
}
