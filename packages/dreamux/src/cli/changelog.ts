/**
 * `dreamux changelog` — offline, deterministic read of the *installed* package's
 * release notes.
 *
 * Per issue #98, the 0.x upgrade policy is fail-loud + rebuild rather than
 * accumulating automatic migrations. This command is the upgrade-time
 * information entry point: after installing a new package, an operator (or an
 * LLM following the `dreamux-maintenance` skill) reads the changelog shipped
 * inside that new package, handles any breaking changes / rebuilds, and only
 * then runs `dreamux daemon restart` / `onboard`.
 *
 * It reads the rush-generated `CHANGELOG.md` / `CHANGELOG.json` bundled in the
 * package. It never fetches over the network and never inspects a target
 * version: it reports the version that is currently installed.
 */

import { readFile } from 'node:fs/promises';

import {
  packagedChangelogJsonPath,
  packagedChangelogMarkdownPath,
} from '../platform/paths.js';

export interface ReadChangelogOptions {
  json?: boolean;
}

/**
 * Return the packaged changelog text. Markdown by default; the raw
 * `CHANGELOG.json` when `json` is set. Fails loud when the file is absent so a
 * broken package layout (changelog dropped from `package.json` `files`) is
 * obvious rather than silently printing nothing.
 */
export async function readPackagedChangelog(
  options: ReadChangelogOptions = {},
): Promise<string> {
  const path = options.json
    ? packagedChangelogJsonPath()
    : packagedChangelogMarkdownPath();
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `dreamux changelog is unavailable: ${path} is missing from the installed package.\n` +
          'This usually means the changelog file was dropped from the package `files` list; reinstall dreamux.',
      );
    }
    throw err;
  }
}
