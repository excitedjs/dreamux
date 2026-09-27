/**
 * Managed-service launch environment: Node-binary selection for the pinned
 * service Node, and PATH/launch-environment orchestration (the env vars and
 * effective PATH persisted into the service unit, and the preflight that
 * confirms the service can actually launch under them).
 * `resolveManagedServiceAnswers` is the one install pipeline (fallback exec
 * dirs → provider binary resolution → stable Node selection) `daemon
 * install` and `dreamux onboard` both build a `ServiceInstallAnswers` from.
 */

import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import type { ProviderBinCheck } from '@excitedjs/dreamux-types';
import { errorMessage } from '@excitedjs/dreamux-utils';

import { expandHome, type DreamuxConfig } from '../config/config.js';
import type { CommandRunner } from '../platform/command-runner.js';
import {
  buildServicePath,
  dreamuxRoot,
  probeStandardExecDirs,
  withServicePath,
  type ExecDirProbe,
} from '../platform/paths.js';
import {
  providerBinChecksForConfig,
  type ProviderDiagnosticCatalogs,
} from '../provider-diagnostics.js';
import type { ServiceHost } from './host.js';
import type { ServiceInstallAnswers } from './install.js';

// ---------------------------------------------------------------------------
// Service-Node selection
// ---------------------------------------------------------------------------

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
  probe?: ServiceNodeProbe | undefined;
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

// ---------------------------------------------------------------------------
// PATH / launch-environment orchestration
// ---------------------------------------------------------------------------

export function managedServiceEnvironment(
  answers: ServiceInstallAnswers,
): Record<string, string> {
  const home = answers.homeDir ?? homedir();
  // Unit PATH: stable dirs → captured session PATH → fallbacks (see managedServicePath).
  const env: Record<string, string> = {
    DREAMUX_ROOT: dreamuxRoot(),
    HOME: home,
    DREAMUX_NODE_BIN: answers.nodeBin,
    PATH: managedServicePath(answers),
  };
  return env;
}

export interface ServiceLaunchValidationResult {
  ok: boolean;
  errors: string[];
}

export async function validateManagedServiceLaunch(
  answers: ServiceInstallAnswers,
  runner: CommandRunner,
): Promise<ServiceLaunchValidationResult> {
  const env = managedServiceEnvironment(answers);
  const errors: string[] = [];

  try {
    const version = await runner.capture(answers.nodeBin, ['--version'], {
      env,
    });
    if (!nodeVersionSatisfies(version)) {
      errors.push(
        `managed service Node must be >=${MIN_SERVICE_NODE_VERSION}: ${answers.nodeBin} reported ${version.trim() || '<empty>'}`,
      );
    }
  } catch (err) {
    errors.push(
      `managed service cannot execute Node at ${answers.nodeBin}: ${errorMessage(err)}`,
    );
  }

  if (!(await runner.check(answers.dreamuxBin, ['--help'], { env }))) {
    errors.push(
      `managed service cannot execute dreamux launcher at ${answers.dreamuxBin}`,
    );
  }

  for (const check of serviceProviderBinChecks(answers)) {
    if (!(await runner.check(check.bin, check.args, { env }))) {
      errors.push(
        `managed service cannot execute provider binary '${check.name}' at ${check.bin}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function resolveServiceExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const trimmed = command.trim();
  if (trimmed === '') {
    throw new Error('managed service executable path is empty');
  }
  if (trimmed.includes('/') || trimmed.startsWith('~')) {
    const candidate = resolve(expandHome(trimmed));
    await assertExecutable(candidate, command);
    return candidate;
  }

  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, trimmed);
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(
    `managed service cannot resolve executable '${command}' from PATH; pass an absolute path and rerun dreamux onboard`,
  );
}

/**
 * Builds the resolve-time effective PATH used to resolve bare provider/agent
 * binaries during `onboard`/`daemon install`. Captured session PATH leads, then
 * the caller's captured fresh-install fallback dirs.
 * Stable Dreamux-owned dirs are added at service render time (see
 * managedServicePath). Delegates to {@link withServicePath} in paths.ts. Never
 * mutates env.
 */
export function withUserLocalBinPath(
  env: NodeJS.ProcessEnv,
  fallbackDirs: string[],
): NodeJS.ProcessEnv {
  const sessionPath = env['PATH'] ?? '';
  return withServicePath(env, { stableDirs: [], sessionPath, fallbackDirs });
}

function configuredProviderBinChecks(
  config: DreamuxConfig,
  env: NodeJS.ProcessEnv,
  catalogs: ProviderDiagnosticCatalogs,
): ProviderBinCheck[] {
  return providerBinChecksForConfig({
    config,
    catalogs,
    env,
    scope: 'managedService',
  });
}

export interface ResolveManagedServiceAnswersInput {
  /** Loaded config to derive provider binary checks from; null under onboard's dry run, which never persists a config to read. */
  config: DreamuxConfig | null;
  catalogs: ProviderDiagnosticCatalogs | null;
  dreamuxBin: string;
  startService: boolean;
  dryRun: boolean;
  host: ServiceHost;
  env: NodeJS.ProcessEnv;
  /** Stable-Node selection probe (tests). */
  nodeProbe?: ServiceNodeProbe | undefined;
  /** Optional Homebrew-directory presence probe (tests). */
  execDirProbe?: ExecDirProbe | undefined;
}

/**
 * The one "resolve fallback exec dirs → resolve provider binary paths →
 * select a stable service Node" pipeline shared by `daemon install`
 * (`daemon/install.ts`'s `runDaemonInstall`) and `dreamux onboard`
 * (`onboard/run.ts`'s `runOnboard`). `config`/`catalogs` are nullable because
 * onboard's dry run never writes (and so never reads back) a real config;
 * `daemon install` always has one already on disk.
 */
export async function resolveManagedServiceAnswers(
  input: ResolveManagedServiceAnswersInput,
): Promise<ServiceInstallAnswers> {
  const fallbackDirs = await probeStandardExecDirs(
    { platform: input.host.platform, homeDir: input.host.homeDir, env: input.env },
    input.execDirProbe,
  );
  const resolveEnv = withUserLocalBinPath(input.env, fallbackDirs);
  const providerBinChecks =
    input.config === null || input.catalogs === null
      ? []
      : await Promise.all(
          configuredProviderBinChecks(
            input.config,
            input.env,
            input.catalogs,
          ).map(async (check) => ({
            ...check,
            bin: input.dryRun
              ? check.bin
              : await resolveServiceExecutable(check.bin, resolveEnv),
          })),
        );
  // Pin the managed service to a stable system Node (issue #83) rather than
  // the current process Node — otherwise running onboard/daemon install from
  // a version-manager Node would re-pin the service to that unstable Node.
  const nodeBin = input.dryRun
    ? process.execPath
    : await selectServiceNodeBin({
        platform: input.host.platform,
        currentNodeBin: process.execPath,
        runner: input.host.runner,
        probe: input.nodeProbe,
      });
  return {
    dreamuxBin: input.dreamuxBin,
    nodeBin,
    providerBinChecks,
    startService: input.startService,
    dryRun: input.dryRun,
    homeDir: input.host.homeDir,
    env: input.env,
    fallbackDirs,
  };
}

function managedServicePath(answers: ServiceInstallAnswers): string {
  // Service PATH order: stable Dreamux-owned dirs (Node bin, provider bin dirs,
  // dreamux bin) → captured session PATH (original order) → fresh-install
  // fallback dirs from paths.ts. De-duped via buildServicePath. Never reads
  // process.env; platform/homeDir/env passed explicitly.
  const stableDirs = [
    dirname(answers.nodeBin),
    ...serviceProviderBinChecks(answers).flatMap((check) =>
      absoluteDir(check.bin),
    ),
    ...absoluteDir(answers.dreamuxBin),
  ];
  const sessionPath = answers.env?.['PATH'] ?? '';
  return buildServicePath({
    stableDirs,
    sessionPath,
    fallbackDirs: answers.fallbackDirs,
  });
}

function serviceProviderBinChecks(
  answers: ServiceInstallAnswers,
): ProviderBinCheck[] {
  const checks = new Map<string, ProviderBinCheck>();
  for (const check of answers.providerBinChecks) {
    checks.set(`${check.name}\0${check.bin}\0${check.args.join('\0')}`, check);
  }
  return [...checks.values()];
}

function absoluteDir(path: string): string[] {
  return isAbsolute(path) ? [dirname(path)] : [];
}

async function assertExecutable(path: string, label: string): Promise<void> {
  if (await isExecutable(path)) return;
  throw new Error(`managed service executable is not runnable: ${label}`);
}
