import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';

import type { CommandRunner } from '../onboard/types.js';

/**
 * Minimum Node version the managed-service environment requires. The launchd
 * plist and systemd user unit persist a stable Node binary; selection (see
 * {@link selectServiceNodeBin}) refuses candidates below this version.
 */
export const MIN_SERVICE_NODE_VERSION = '22.7.0';

/**
 * Parse a `node --version` (or `v<major>.<minor>.<patch>`) string and decide
 * whether it satisfies {@link MIN_SERVICE_NODE_VERSION}. Pure and side-effect
 * free so selection and the launch doctor share one comparison.
 */
export function nodeVersionSatisfies(raw: string): boolean {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major > 22) return true;
  return major === 22 && minor >= 7;
}

/**
 * Filesystem probes for service-Node selection and doctor drift check.
 * Injectable so tests can model symlinks, candidate existence, and
 * version-manager layouts without touching the real filesystem.
 */
export interface ServiceNodeProbe {
  realpath: (path: string) => Promise<string>;
  isExecutable: (path: string) => Promise<boolean>;
}

export const defaultServiceNodeProbe: ServiceNodeProbe = {
  realpath: (path) => realpath(path),
  isExecutable: (path) => isExecutable(path),
};

// Markers matched (case-insensitively) against a Node binary's resolved path.
// Each keeps a leading `/.<name>/` or segment anchor so a user dir like
// `/home/volta/` never matches `/.volta/`. macOS fnm installs under
// `~/Library/Application Support/fnm/`; dreamux supports launchd so cover it.
const VERSION_MANAGER_MARKERS: Array<{ manager: string; markers: string[] }> = [
  { manager: 'nvm', markers: ['/.nvm/versions/node/'] },
  {
    manager: 'fnm',
    markers: [
      '/.fnm/',
      'fnm_multishells',
      '/.local/share/fnm/',
      '/library/application support/fnm/',
    ],
  },
  { manager: 'asdf', markers: ['/.asdf/installs/nodejs/', '/.asdf/shims/'] },
  { manager: 'volta', markers: ['/.volta/'] },
];

/** Pure marker match on a single path; returns the manager name or null. */
export function versionManagerOfPath(path: string): string | null {
  const needle = path.toLowerCase();
  for (const entry of VERSION_MANAGER_MARKERS) {
    if (entry.markers.some((marker) => needle.includes(marker))) {
      return entry.manager;
    }
  }
  return null;
}

/**
 * Single async/injectable predicate selection and doctor share. Resolves
 * symlinks first so a `/usr/local/bin/node` shim into nvm/fnm/asdf is caught;
 * falls back to the raw path when realpath fails.
 */
export async function detectServiceNodeVersionManager(
  nodeBin: string,
  probe: ServiceNodeProbe = defaultServiceNodeProbe,
): Promise<string | null> {
  const raw = versionManagerOfPath(nodeBin);
  if (raw !== null) return raw;
  let resolved: string;
  try {
    resolved = await probe.realpath(nodeBin);
  } catch {
    return null;
  }
  return versionManagerOfPath(resolved);
}

/**
 * Platform-aware stable Node candidates. macOS covers Homebrew (Apple Silicon
 * and Intel prefixes); Linux covers standard system locations.
 */
export function stableNodeCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin/node',
      '/opt/homebrew/opt/node/bin/node',
      '/opt/homebrew/opt/node@24/bin/node',
      '/opt/homebrew/opt/node@22/bin/node',
      '/usr/local/bin/node',
      '/usr/local/opt/node/bin/node',
      '/usr/local/opt/node@24/bin/node',
      '/usr/local/opt/node@22/bin/node',
      '/usr/bin/node',
    ];
  }
  return ['/usr/local/bin/node', '/usr/bin/node', '/bin/node'];
}

export interface SelectServiceNodeOptions {
  platform: NodeJS.Platform;
  currentNodeBin: string;
  runner: CommandRunner;
  probe?: ServiceNodeProbe;
}

/**
 * Choose the Node binary persisted into the managed-service environment.
 * Prefers a stable system Node (exists, not version-manager-bound, satisfies
 * MIN_SERVICE_NODE_VERSION); falls back to the current Node otherwise.
 */
export async function selectServiceNodeBin(
  options: SelectServiceNodeOptions,
): Promise<string> {
  const probe = options.probe ?? defaultServiceNodeProbe;
  for (const candidate of stableNodeCandidates(options.platform)) {
    if (!(await probe.isExecutable(candidate))) continue;
    if ((await detectServiceNodeVersionManager(candidate, probe)) !== null) {
      continue;
    }
    let version: string;
    try {
      version = await options.runner.capture(candidate, ['--version']);
    } catch {
      continue;
    }
    if (!nodeVersionSatisfies(version)) continue;
    // Persist the candidate path itself (a stable symlink), never its realpath,
    // so a Homebrew symlink keeps the volatile Cellar path out of the service.
    return candidate;
  }
  return stabilizeHomebrewCellarNode(
    options.currentNodeBin,
    options.platform,
    probe,
  );
}

const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'];

interface HomebrewCellarMatch {
  prefix: string;
  major: string | null;
}

function matchHomebrewCellar(path: string): HomebrewCellarMatch | null {
  for (const prefix of HOMEBREW_PREFIXES) {
    const cellar = `${prefix}/Cellar/node`;
    if (!path.startsWith(`${cellar}/`) && !path.startsWith(`${cellar}@`)) {
      continue;
    }
    const major = path.slice(cellar.length).match(/^@(\d+)\//);
    return { prefix, major: major === null ? null : major[1] };
  }
  return null;
}

/**
 * Homebrew Cellar (`<prefix>/Cellar/node[@major]/<version>/bin/node`) is a
 * version-pinned path unfit for a persistent service. Best-effort remap to the
 * matching stable Homebrew symlink; no match returns the input unchanged and
 * never throws. darwin-only.
 */
export async function stabilizeHomebrewCellarNode(
  nodeBin: string,
  platform: NodeJS.Platform,
  probe: ServiceNodeProbe = defaultServiceNodeProbe,
): Promise<string> {
  if (platform !== 'darwin') return nodeBin;
  let resolved: string;
  try {
    resolved = await probe.realpath(nodeBin);
  } catch {
    resolved = nodeBin;
  }
  const cellar = matchHomebrewCellar(nodeBin) ?? matchHomebrewCellar(resolved);
  if (cellar === null) return nodeBin;

  const links: string[] = [];
  if (cellar.major !== null) {
    links.push(`${cellar.prefix}/opt/node@${cellar.major}/bin/node`);
  }
  links.push(`${cellar.prefix}/opt/node/bin/node`, `${cellar.prefix}/bin/node`);

  for (const link of links) {
    if (!(await probe.isExecutable(link))) continue;
    try {
      if ((await probe.realpath(link)) === resolved) return link;
    } catch {
      // ignore and try the next candidate symlink
    }
  }
  return nodeBin;
}

/** True when `path` is executable by the current process; never throws. */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
