import { constants } from 'node:fs';
import { access, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/** Async existence probe — the fs/promises replacement for `existsSync`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

import { build as buildPlist } from 'plist';
import { expandHome } from '../runtime/config.js';
import { logsRoot, stateRoot } from '../runtime/paths.js';

import {
  ensureDirectory,
  ensureTextFile,
  writeTextFile,
} from './ledger.js';
import type {
  CommandRunner,
  OnboardFileLedger,
  ServicePlatform,
} from './types.js';

export const LAUNCHD_LABEL = 'dev.excited.dreamux';
export const SYSTEMD_UNIT = 'dreamux.service';
export const MIN_SERVICE_NODE_VERSION = '22.7.0';
export const SERVICE_PATH_DEFAULTS = ['/usr/local/bin', '/usr/bin', '/bin'];

export interface ServiceInstallAnswers {
  configDir: string;
  codexBin: string;
  dreamuxBin: string;
  nodeBin: string;
  startService: boolean;
  dryRun: boolean;
}

export interface ServiceInstallOptions {
  answers: ServiceInstallAnswers;
  ledger: OnboardFileLedger;
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
}

export interface ServiceInstallResult {
  platform: ServicePlatform;
  unitPath: string;
  registered: boolean;
  started: boolean;
  /**
   * systemd `--user` only: whether `loginctl enable-linger` succeeded so the
   * service starts at boot without an interactive login. null when not
   * applicable (launchd, or a dry run). Failure is non-fatal and surfaced via
   * `warnings`.
   */
  lingerEnabled: boolean | null;
  /** Non-fatal operator-facing warnings (e.g. linger could not be enabled). */
  warnings: string[];
}

export function serviceUnitPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir(),
): { platform: ServicePlatform; path: string } {
  if (platform === 'darwin') {
    return {
      platform: 'launchd',
      path: join(homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
    };
  }
  if (platform === 'linux') {
    return {
      platform: 'systemd',
      path: join(homeDir, '.config', 'systemd', 'user', SYSTEMD_UNIT),
    };
  }
  throw new Error(
    `dreamux onboard supports user-level services on macOS and Linux only (got ${platform})`,
  );
}

export async function installUserService(
  options: ServiceInstallOptions,
): Promise<ServiceInstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const unit = serviceUnitPath(options.platform, homeDir);
  const logDir = logsRoot();
  const stdoutLog = join(logDir, 'daemon.stdout.log');
  const stderrLog = join(logDir, 'daemon.stderr.log');
  await ensureDirectory(logDir, options.ledger, 'daemon log directory', {
    dryRun: options.answers.dryRun,
  });
  await ensureTextFile(stdoutLog, '', options.ledger, 'daemon stdout log', {
    mode: 0o600,
    dryRun: options.answers.dryRun,
  });
  await ensureTextFile(stderrLog, '', options.ledger, 'daemon stderr log', {
    mode: 0o600,
    dryRun: options.answers.dryRun,
  });

  const content =
    unit.platform === 'launchd'
      ? renderLaunchdPlist(options.answers, stdoutLog, stderrLog)
      : renderSystemdUnit(options.answers, stdoutLog, stderrLog);
  const unitStatus = await writeTextFile(
    unit.path,
    content,
    options.ledger,
    `${unit.platform} unit`,
    {
      mode: 0o600,
      dryRun: options.answers.dryRun,
    },
  );

  let lingerEnabled: boolean | null = null;
  const warnings: string[] = [];
  if (unit.platform === 'launchd') {
    await registerLaunchd(unit.path, unitStatus, options);
  } else {
    const systemd = await registerSystemd(unit.path, options);
    lingerEnabled = systemd.lingerEnabled;
    warnings.push(...systemd.warnings);
  }

  return {
    platform: unit.platform,
    unitPath: unit.path,
    registered: true,
    started: options.answers.startService,
    lingerEnabled,
    warnings,
  };
}

export function renderLaunchdPlist(
  answers: ServiceInstallAnswers,
  stdoutLog: string,
  stderrLog: string,
): string {
  return buildPlist({
    Label: LAUNCHD_LABEL,
    ProgramArguments: [answers.dreamuxBin, 'serve'],
    RunAtLoad: true,
    KeepAlive: true,
    WorkingDirectory: stateRoot(),
    EnvironmentVariables: managedServiceEnvironment(answers),
    StandardOutPath: stdoutLog,
    StandardErrorPath: stderrLog,
  });
}

export function renderSystemdUnit(
  answers: ServiceInstallAnswers,
  stdoutLog: string,
  stderrLog: string,
): string {
  return `[Unit]
Description=dreamux dispatcher daemon

[Service]
Type=simple
ExecStart=${systemdEscapeArg(answers.dreamuxBin)} serve
WorkingDirectory=${systemdEscapeArg(stateRoot())}
${Object.entries(managedServiceEnvironment(answers))
  .map(([key, value]) => `Environment=${key}=${systemdEscapeEnv(value)}`)
  .join('\n')}
Restart=on-failure
RestartSec=2s
StandardOutput=append:${stdoutLog}
StandardError=append:${stderrLog}

[Install]
WantedBy=default.target
`;
}

export function managedServiceEnvironment(
  answers: ServiceInstallAnswers,
): Record<string, string> {
  const env: Record<string, string> = {
    DREAMUX_CONFIG_DIR: answers.configDir,
    HOME: homedir(),
    CODEX_HOST_CODEX_BIN: answers.codexBin,
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
    const version = await runner.capture(answers.nodeBin, ['--version'], { env });
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

  if (!(await runner.check(answers.codexBin, ['--help'], { env }))) {
    errors.push(
      `managed service cannot execute Codex CLI at ${answers.codexBin}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function resolveServiceExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
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
 * Filesystem probes the service-Node selection and the doctor drift check both
 * depend on. Injectable so tests can model symlinks, candidate existence, and
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
// Each marker keeps a leading `/.<name>/` or explicit segment anchor so a user
// directory such as `/home/volta/` never matches the `/.volta/` marker. macOS
// fnm installs under `~/Library/Application Support/fnm/`; dreamux supports
// launchd, so that path must be covered.
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
 * The single async/injectable predicate selection and doctor share. Resolves
 * symlinks first so a `/usr/local/bin/node` shim pointing into nvm/fnm/asdf is
 * caught; falls back to the raw path when realpath fails (e.g. broken link).
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
 * Platform-aware stable Node candidates, decoupled from SERVICE_PATH_DEFAULTS
 * (which only renders the service PATH). macOS covers Homebrew (Apple Silicon
 * and Intel prefixes); Linux covers the standard system locations.
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
 * MIN_SERVICE_NODE_VERSION); falls back to the current Node otherwise. The
 * fallback reproduces the original fragility when onboarding itself runs under
 * a version-manager Node — that case is the doctor drift advisory's job to
 * surface, not this function's.
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
 * Homebrew Cellar (`<prefix>/Cellar/node[@major]/<version>/bin/node`) is NOT a
 * version manager, but it is a version-pinned path unfit for a persistent
 * service. When the fallback Node is a Cellar path, best-effort remap it to the
 * matching stable Homebrew symlink. The realpath-equality guard disambiguates
 * `node` vs `node@<major>`; no match returns the input unchanged and never
 * throws, so a stabilization miss cannot fail onboarding. darwin-only.
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

function managedServicePath(answers: ServiceInstallAnswers): string {
  const dirs = [
    dirname(answers.nodeBin),
    ...absoluteDir(answers.codexBin),
    ...absoluteDir(answers.dreamuxBin),
    ...SERVICE_PATH_DEFAULTS,
  ];
  return uniqueNonEmpty(dirs).join(delimiter);
}

function absoluteDir(path: string): string[] {
  return isAbsolute(path) ? [dirname(path)] : [];
}

function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function assertExecutable(path: string, label: string): Promise<void> {
  if (await isExecutable(path)) return;
  throw new Error(`managed service executable is not runnable: ${label}`);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function registerLaunchd(
  unitPath: string,
  unitStatus: 'created' | 'modified' | 'unchanged',
  options: ServiceInstallOptions,
): Promise<void> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error('launchd user service registration requires a numeric uid');
  }
  const serviceTarget = `gui/${uid}/${LAUNCHD_LABEL}`;
  const loaded = await options.runner.check(
    'launchctl',
    ['print', serviceTarget],
    { dryRun: options.answers.dryRun },
  );
  if (!loaded) {
    await options.runner.run(
      'launchctl',
      ['bootstrap', `gui/${uid}`, unitPath],
      { dryRun: options.answers.dryRun },
    );
  } else if (unitStatus !== 'unchanged') {
    await options.runner.run('launchctl', ['bootout', serviceTarget], {
      dryRun: options.answers.dryRun,
    });
    await options.runner.run(
      'launchctl',
      ['bootstrap', `gui/${uid}`, unitPath],
      { dryRun: options.answers.dryRun },
    );
  }
  if (options.answers.startService) {
    await options.runner.run(
      'launchctl',
      ['kickstart', '-k', serviceTarget],
      { dryRun: options.answers.dryRun },
    );
  }
}

async function registerSystemd(
  unitPath: string,
  options: ServiceInstallOptions,
): Promise<{ lingerEnabled: boolean | null; warnings: string[] }> {
  await options.runner.run('systemctl', ['--user', 'daemon-reload'], {
    dryRun: options.answers.dryRun,
  });
  const enableArgs = options.answers.startService
    ? ['--user', 'enable', '--now', SYSTEMD_UNIT]
    : ['--user', 'enable', SYSTEMD_UNIT];
  await options.runner.run('systemctl', enableArgs, {
    dryRun: options.answers.dryRun,
  });
  options.ledger.record(unitPath, 'unchanged', 'systemd user service registered');

  // `systemctl --user enable` only schedules the service for an *active login
  // session*. On a headless box with no graphical/SSH login the service never
  // starts at boot. `loginctl enable-linger` is what makes a user service boot
  // without a login — without it, "enabled" silently fails to autostart on
  // reboot. Best-effort: a strict polkit / non-root setup may deny it, but that
  // must not fail onboard / daemon install (issue #78).
  const { lingerEnabled, warnings } = await enableSystemdLinger(options);
  return { lingerEnabled, warnings };
}

/**
 * Enable systemd user lingering for the calling user, best-effort. Returns the
 * outcome plus any operator-facing warning. Skipped (null) on a dry run.
 */
export async function enableSystemdLinger(
  options: Pick<ServiceInstallOptions, 'runner'> & {
    answers: Pick<ServiceInstallAnswers, 'dryRun'>;
  },
): Promise<{ lingerEnabled: boolean | null; warnings: string[] }> {
  if (options.answers.dryRun) return { lingerEnabled: null, warnings: [] };
  const ok = await options.runner.check('loginctl', ['enable-linger']);
  if (ok) return { lingerEnabled: true, warnings: [] };
  return {
    lingerEnabled: false,
    warnings: [
      'could not enable systemd lingering (loginctl enable-linger); the service ' +
        'will not start at boot until you log in. Enable it manually with: ' +
        'loginctl enable-linger',
    ],
  };
}

export interface ServiceRemoveOptions {
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  dryRun?: boolean;
}

export interface ServiceRemoveResult {
  platform: ServicePlatform;
  unitPath: string;
  /** Whether the unit file existed and was removed. */
  removed: boolean;
}

/**
 * Unregister and remove the user-level service unit only. Shared by the
 * top-level `dreamux uninstall` (which then also removes config/state/logs) and
 * `dreamux daemon uninstall` (which removes *nothing else*). Best-effort on the
 * service-manager calls — the unit-file removal is authoritative.
 */
export async function removeUserService(
  options: ServiceRemoveOptions,
): Promise<ServiceRemoveResult> {
  const homeDir = options.homeDir ?? homedir();
  const unit = serviceUnitPath(options.platform, homeDir);
  const dryRun = options.dryRun ?? false;

  if (unit.platform === 'launchd') {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) {
      throw new Error('launchd user service uninstall requires a numeric uid');
    }
    const serviceTarget = `gui/${uid}/${LAUNCHD_LABEL}`;
    const loaded = await options.runner.check('launchctl', ['print', serviceTarget], {
      dryRun,
    });
    if (loaded) {
      await runServiceBestEffort(options.runner, 'launchctl', ['bootout', serviceTarget], dryRun);
    }
  } else {
    await runServiceBestEffort(
      options.runner,
      'systemctl',
      ['--user', 'disable', '--now', SYSTEMD_UNIT],
      dryRun,
    );
  }

  const existed = await pathExists(unit.path);
  if (existed && !dryRun) await rm(unit.path, { force: true });

  if (unit.platform === 'systemd') {
    await runServiceBestEffort(options.runner, 'systemctl', ['--user', 'daemon-reload'], dryRun);
  }

  return { platform: unit.platform, unitPath: unit.path, removed: existed };
}

async function runServiceBestEffort(
  runner: CommandRunner,
  command: string,
  args: string[],
  dryRun: boolean,
): Promise<void> {
  try {
    await runner.run(command, args, { dryRun });
  } catch {
    /* The unit may already be absent or stopped; file removal is authoritative. */
  }
}

function systemdEscapeArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function systemdEscapeEnv(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(' ', '\\x20');
}
