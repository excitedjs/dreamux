import { delimiter, join } from 'node:path';

import { pathExists } from './fs-errors.js';

// ---------------------------------------------------------------------------
// Managed-service PATH builder
//
// The managed Dreamux service runs under a minimal environment that does NOT
// inherit the operator's interactive shell PATH. Provider-owned bare binaries
// (a `local-agent` installed into $HOME/.local/bin, a Homebrew-installed tool, an
// nvm/pyenv shim, ...) therefore must be explicitly placed on the service PATH
// and searched during the daemon-install preflight so the launched service
// resolves them.
//
// `buildServicePath` is the single source of truth for that PATH. It lives in
// platform/ (the neutral service PATH builder) so onboard/service.ts only
// orchestrates the managed-service environment and never owns the home/PATH
// contract itself.
//
// Order (deduplicated while preserving first occurrence):
//   1. Stable Dreamux-owned dirs (selected Node bin dir, resolved provider bin
//      dirs, dreamux bin dir). These lead so the service always resolves the
//      exact binaries the orchestrator pinned, regardless of the session PATH.
//   2. The captured interactive-session PATH, in its original order. This is
//      the full PATH the operator ran `dreamux onboard` / `daemon install`
//      under, so binaries installed by nvm / pyenv / Homebrew / etc. resolve.
//   3. Fresh-install fallback dirs (XDG_BIN_HOME when set, $HOME/.local/bin,
//      and the portable platform system dirs). These cover a bare environment
//      that has no interactive session PATH yet.
//
// Invariants:
//   - Every helper takes its inputs explicitly ({ platform, homeDir, env }).
//     They never read process.env, process.platform, or os.homedir() -- the
//     caller passes those values. This keeps the contract testable and prevents
//     the ambient environment from silently changing the service PATH.
//   - XDG_BIN_HOME is read from the passed env only. It is a widely-followed
//     convention among some installers (e.g. language-ecosystem tools) but is
//     NOT part of the formal XDG Base Directory specification; we honor it when
//     the caller supplies it and also keep the conventional $HOME/.local/bin.
//   - Results are ordered and de-duplicated. Earlier entries win. User-local and
//     portable system dirs are deterministic fallbacks. Optional Homebrew
//     prefixes are added only after an async presence probe at the orchestration
//     boundary, then captured for the whole install.
//   - No shell profile is read or written, brew --prefix is never executed, and
//     the interactive shell PATH is never mutated.
// ---------------------------------------------------------------------------

export interface ExecDirOptions {
  /** Platform selecting the conventional system dirs (darwin / linux). */
  platform: NodeJS.Platform;
  /** Home directory resolving $HOME/.local/bin. */
  homeDir: string;
  /**
   * Environment to read conventions from (currently XDG_BIN_HOME). Passed
   * explicitly by the caller; these helpers never read process.env.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * The operator's user-local standard bin dirs, in priority order. When
 * XDG_BIN_HOME is set (in the passed env) and non-empty it is included first;
 * the conventional $HOME/.local/bin is always included. Both are kept so a
 * binary installed in either location resolves.
 */
export function userLocalBinDirs(options: ExecDirOptions): string[] {
  const dirs: string[] = [];
  const xdg = options.env['XDG_BIN_HOME'];
  if (typeof xdg === 'string' && xdg.trim() !== '') {
    dirs.push(xdg.trim());
  }
  dirs.push(join(options.homeDir, '.local', 'bin'));
  return dirs;
}

/**
 * Platform conventional system bin dirs (user-local dirs are NOT included here -
 * see {@link userLocalBinDirs}). These deterministic portable fallbacks do not
 * include optional Homebrew prefixes; {@link probeStandardExecDirs} adds the
 * platform candidate only when it exists.
 */
export function systemExecDirs(_platform: NodeJS.Platform): string[] {
  return ['/usr/local/bin', '/usr/bin', '/bin'];
}

/**
 * The full ordered, de-duplicated standard executable dirs for a platform: the
 * user-local bin dirs (see {@link userLocalBinDirs}) followed by the platform
 * conventional system dirs (see {@link systemExecDirs}). Used as the
 * fresh-install fallback dirs by {@link buildServicePath}.
 */
export function standardExecDirs(options: ExecDirOptions): string[] {
  return dedupeExecDirs([
    ...userLocalBinDirs(options),
    ...systemExecDirs(options.platform),
  ]);
}

export type ExecDirProbe = (path: string) => Promise<boolean>;

/**
 * Resolve the standard executable fallback list for one onboard/daemon-install
 * run. The portable fallbacks remain deterministic; the single platform
 * Homebrew candidate is added only when the async probe confirms it exists.
 *
 * Callers capture this result once and reuse it for provider resolution,
 * launch validation, and service rendering. That keeps the effective PATH
 * stable within one install even if the filesystem changes later.
 */
export async function probeStandardExecDirs(
  options: ExecDirOptions,
  probe: ExecDirProbe = pathExists,
): Promise<string[]> {
  const dirs = standardExecDirs(options);
  const homebrewDir = homebrewExecDir(options.platform);
  if (homebrewDir !== null && (await probe(homebrewDir))) {
    dirs.push(homebrewDir);
  }
  return dedupeExecDirs(dirs);
}

/**
 * Input for {@link buildServicePath} and {@link withServicePath}.
 */
export interface ServicePathInput {
  /**
   * Stable Dreamux-owned dirs that lead the PATH (selected Node bin dir,
   * resolved provider bin dirs, dreamux bin dir).
   */
  stableDirs: string[];
  /**
   * The captured interactive-session PATH (the full `env.PATH` string the
   * operator ran `dreamux onboard` / `daemon install` under). Its entries are
   * appended in original order after the stable dirs.
   */
  sessionPath: string;
  /**
   * Fresh-install fallback dirs (XDG_BIN_HOME / $HOME/.local/bin + portable
   * platform system dirs). Appended last so a bare environment still resolves.
   */
  fallbackDirs: string[];
}

/**
 * Build the managed-service PATH: stable Dreamux-owned dirs first, then the
 * captured session PATH in original order, then the fresh-install fallback
 * dirs. Deduplicated while preserving first occurrence. Never reads
 * process.env. This is the single source of truth for the service PATH order.
 */
export function buildServicePath(input: ServicePathInput): string {
  return dedupeExecDirs([
    ...input.stableDirs,
    ...input.sessionPath.split(delimiter),
    ...input.fallbackDirs,
  ]).join(delimiter);
}

/**
 * Return a copy of `env` with PATH set to {@link buildServicePath}. The
 * caller's env object (and process.env) is never mutated.
 */
export function withServicePath(
  env: NodeJS.ProcessEnv,
  input: ServicePathInput,
): NodeJS.ProcessEnv {
  return { ...env, PATH: buildServicePath(input) };
}

/**
 * Return a copy of `env` with PATH augmented so bare provider/agent binaries
 * resolve against the standard executable dirs during `dreamux onboard` and
 * `dreamux daemon install`. It places the captured session PATH (in original
 * order) ahead of the fresh-install fallback dirs (XDG_BIN_HOME /
 * $HOME/.local/bin + portable platform system dirs), matching the order
 * {@link buildServicePath} persists into the service unit -- so the
 * daemon-install preflight and the running service agree.
 *
 * Stable Dreamux-owned dirs (Node bin, provider bin dirs, dreamux bin) are NOT
 * included here: at resolve time the Node bin is not yet selected and the
 * dreamux bin dir is computed separately. Those are added when the service PATH
 * is rendered (see `managedServicePath` in onboard/service.ts). Pass
 * `extraDirs` to lead the PATH with explicit actual dirs (e.g. a resolved
 * provider bin dir).
 *
 * The caller's env (and process.env) is never mutated; platform/homeDir/env are
 * passed explicitly by the caller and these helpers never read process.env.
 * XDG_BIN_HOME is a widely-followed convention (NOT part of the formal XDG Base
 * Directory spec); it is honored alongside $HOME/.local/bin so binaries in
 * either location resolve.
 */
export function withStandardExecPath(
  env: NodeJS.ProcessEnv,
  options: ExecDirOptions & { extraDirs?: string[] },
): NodeJS.ProcessEnv {
  const sessionPath = env['PATH'] ?? '';
  const fallbackDirs = standardExecDirs(options);
  return withServicePath(env, {
    stableDirs: options.extraDirs ?? [],
    sessionPath,
    fallbackDirs,
  });
}

function homebrewExecDir(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return '/opt/homebrew/bin';
  if (platform === 'linux') return '/home/linuxbrew/.linuxbrew/bin';
  return null;
}

function dedupeExecDirs(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
