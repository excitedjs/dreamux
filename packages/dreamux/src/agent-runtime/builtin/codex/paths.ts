/**
 * Codex-runtime artifact paths. These are the Codex app-server's own
 * bookkeeping files (control dir, Unix socket, stdout/stderr logs) plus the
 * Codex home and config. They were relocated out of the shared `platform/paths`
 * layer (issue #143 de-leak) so the shared layer stays runtime-neutral; every
 * string here is byte-identical to its former `platform/paths.ts` output.
 */

import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';

import {
  BUNDLED_SKILL_NAMES,
  assertUnixSocketPathBudget,
  dispatcherDir,
  dispatcherPathSegment,
  logsRoot,
  teamMateNameSegment,
  unixSocketPathFitsBudget,
  type BundledSkillName,
} from '../../../platform/paths.js';

/**
 * Central Codex app-server log directory. Relocated out of `platform/paths`
 * (issue #143 de-leak) so the shared layer never names `codex-app-server`; the
 * string is byte-identical to its former `platform/paths.ts` output.
 */
export function codexAppServerLogDir(): string {
  return join(logsRoot(), 'codex-app-server');
}

/**
 * Workspace-local Codex skills dir (`<cwd>/.codex/skills`). Codex reads skills
 * from here; relocated out of `platform/paths` (issue #143 de-leak) so the
 * shared layer never names `.codex`. The bundled-skill wrappers below build on
 * it. Strings are byte-identical to their former `platform/paths.ts` output.
 */
export function dispatcherWorkspaceCodexSkillsDir(cwd: string): string {
  return join(cwd, '.codex', 'skills');
}

export function dispatcherWorkspaceSkillDir(
  cwd: string,
  skillName: BundledSkillName,
): string {
  return join(dispatcherWorkspaceCodexSkillsDir(cwd), skillName);
}

export function dispatcherWorkspaceSkillDirs(cwd: string): string[] {
  return BUNDLED_SKILL_NAMES.map((skillName) =>
    dispatcherWorkspaceSkillDir(cwd, skillName),
  );
}

export function dispatcherWorkspaceSkillPath(cwd: string): string {
  return join(dispatcherWorkspaceSkillDir(cwd, 'dispatcher'), 'SKILL.md');
}

/** Codex app-server control directory — the per-dispatcher state root. */
export function dispatcherAppServerControlDir(id: string): string {
  return dispatcherDir(id);
}

/**
 * Short private root for over-budget Codex socket fallbacks, or null when no
 * private root exists. The shared world-writable tmp roots are never used —
 * the global-bin decision record rejects `/tmp` app-server sockets (control
 * state must be private and owner-writable). `XDG_RUNTIME_DIR` is the
 * canonical private per-user runtime dir on Linux, but it is operator input,
 * so the shared-tmp rejection applies to it too; on macOS `os.tmpdir()` is
 * the per-user 0700 `$TMPDIR` confinement dir, which qualifies.
 */
export function codexSocketFallbackDir(): string | null {
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (xdg !== undefined && xdg.trim() !== '' && !isSharedTmp(xdg)) return xdg;
  const tmp = tmpdir();
  return isSharedTmp(tmp) ? null : tmp;
}

/**
 * Shared world-writable system tmp roots. `/private/tmp` and
 * `/private/var/tmp` are the macOS symlink-resolved spellings of `/tmp` and
 * `/var/tmp`, so a canonicalized path must not slip past the guard.
 */
const SHARED_TMP_ROOTS = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];

function isSharedTmp(path: string): boolean {
  const normalized = normalize(path);
  return SHARED_TMP_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}${sep}`),
  );
}

/**
 * Codex app-server Unix socket for the given per-dispatcher runtime root.
 *
 * The descriptive in-tree path (`<dir>/codex.sock`) is used whenever it fits
 * the `sun_path` byte budget. A deep runtime root (long $HOME, long dispatcher
 * or teammate names — e.g. the teammate tree
 * `state/<dispatcher>/teammate/runtime/<name>/`) can blow that budget; in that
 * case the socket falls back to a short *private* per-user runtime path (see
 * `codexSocketFallbackDir`) whose name is a digest of the descriptive path.
 * The fallback is a pure function of the runtime root, so it keeps the
 * contract the supervisor relies on:
 *  - unique: the digest covers the full state-root + dispatcher + teammate dir;
 *  - stable across restart/resume: same root → same socket path;
 *  - cleanup unchanged: the supervisor removes `socketPath` before bind and on
 *    stop, wherever it lives.
 * When no private fallback root exists the original fail-loud budget assertion
 * stands.
 */
export function codexSocketPathIn(dir: string, id: string): string {
  const descriptive = join(dir, 'codex.sock');
  if (unixSocketPathFitsBudget(descriptive)) return descriptive;
  const fallbackDir = codexSocketFallbackDir();
  if (fallbackDir === null) {
    return assertUnixSocketPathBudget(
      descriptive,
      `dispatcher '${id}' Codex socket path`,
    );
  }
  const digest = createHash('sha256').update(descriptive).digest('hex').slice(0, 16);
  return assertUnixSocketPathBudget(
    join(fallbackDir, `dreamux-codex-${digest}.sock`),
    `dispatcher '${id}' Codex socket fallback path`,
  );
}

export function dispatcherSocketPath(id: string): string {
  return codexSocketPathIn(dispatcherDir(id), id);
}

export function dispatcherCodexAppServerLogPath(id: string): string {
  return join(codexAppServerLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function dispatcherCodexAppServerErrorLogPath(id: string): string {
  return join(codexAppServerLogDir(), `${dispatcherPathSegment(id)}.stderr.log`);
}

/** Per-teammate Codex app-server stdout log, under the central codex log tree. */
export function teammateCodexAppServerLogPath(
  id: string,
  teammateName: string,
): string {
  return join(
    codexAppServerLogDir(),
    'teammate',
    dispatcherPathSegment(id),
    `${teamMateNameSegment(teammateName)}.log`,
  );
}

/** Per-teammate Codex app-server stderr log, under the central codex log tree. */
export function teammateCodexAppServerErrorLogPath(
  id: string,
  teammateName: string,
): string {
  return join(
    codexAppServerLogDir(),
    'teammate',
    dispatcherPathSegment(id),
    `${teamMateNameSegment(teammateName)}.stderr.log`,
  );
}

export function operatorCodexHome(): string {
  return join(homedir(), '.codex');
}

export function dispatcherCodexHome(id: string): string {
  void id;
  return operatorCodexHome();
}

export function dispatcherCodexConfigPath(id: string): string {
  return join(dispatcherCodexHome(id), 'config.toml');
}
