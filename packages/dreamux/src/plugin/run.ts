import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join } from 'node:path';

import { isPlainObject } from '@excitedjs/dreamux-utils';

import { pluginRoot } from '../platform/paths.js';
import { NpmPackageMissingError, npmPackageName } from './resolve.js';

/**
 * `dreamux plugin run <name> [arguments…]`: the plugin's own command line.
 * Dreamux names no verb for a plugin. The package declares one command line
 * (`bin`, a string or a single entry) and Dreamux runs it with the arguments
 * as given, in the working directory and environment it was called from; what
 * it does, asks, and writes is the plugin's. The command needs the package
 * installed, not registered.
 */
export async function runPluginCommand(
  input: string,
  args: readonly string[],
): Promise<number> {
  const name = npmPackageName(input);
  const dir = join(pluginRoot(), 'node_modules', name);
  const script = commandLine((await readManifest(dir, name))['bin'], name);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, script), ...args], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? 128 + signalNumber(signal));
    });
  });
}

async function readManifest(
  dir: string,
  name: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(dir, 'package.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NpmPackageMissingError(name);
    }
    throw err;
  }
  const manifest: unknown = JSON.parse(text);
  if (!isPlainObject(manifest)) {
    throw new Error(`package ${name}: package.json is not an object`);
  }
  return manifest;
}

/**
 * The package's one command line. Dreamux does not choose between several:
 * a `bin` with more than one entry, or none, is refused.
 */
function commandLine(bin: unknown, name: string): string {
  if (typeof bin === 'string') return bin;
  const only = isPlainObject(bin) ? Object.values(bin) : [];
  if (only.length === 1 && typeof only[0] === 'string') return only[0];
  throw new Error(
    `package ${name} does not declare one command line: "bin" in its package.json must be a string or a single entry`,
  );
}

function signalNumber(signal: NodeJS.Signals | null): number {
  return signal === null ? 1 : (constants.signals[signal] ?? 1);
}
