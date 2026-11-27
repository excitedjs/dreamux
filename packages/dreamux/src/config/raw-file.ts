import { readFile, writeFile } from 'node:fs/promises';

import { pathExists } from '../platform/fs-errors.js';
import { assertConfigFileMode } from './config.js';

/**
 * `config.json` as the plain object it is, for the commands that change one
 * part of it and leave every other key as written (`plugin add`,
 * `plugin remove`). `readConfigFile` reads the file through the same
 * function, so the existence, mode, and parse checks are written once.
 *
 * The write is the encoding the daemon's Config Service and `dreamux
 * onboard` use: two-space indentation and a trailing newline, owner-only
 * mode. On a file that exists the mode is already set and is kept.
 */
export async function readConfigJson(file: string): Promise<unknown> {
  if (!(await pathExists(file))) {
    throw new Error(
      `dreamux config is missing at ${file}.\n` +
        'Run `dreamux onboard` to create it before starting the server.',
    );
  }
  await assertConfigFileMode(file);
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        `Fix the JSON syntax in ${file}, then restart. Run \`dreamux onboard\` if you need to recreate the config.`,
    );
  }
}

export async function writeConfigJson(
  file: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, {
    mode: 0o600,
  });
}
