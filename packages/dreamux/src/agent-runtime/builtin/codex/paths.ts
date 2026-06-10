/**
 * Codex-runtime artifact paths. These are the Codex app-server's own
 * bookkeeping files (control dir, Unix socket, stdout/stderr logs) plus the
 * Codex home and config. They were relocated out of the shared `platform/paths`
 * layer (issue #143 de-leak) so the shared layer stays runtime-neutral; every
 * string here is byte-identical to its former `platform/paths.ts` output.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  BUNDLED_SKILL_NAMES,
  dispatcherPathSegment,
  logsRoot,
  teamMateNameSegment,
  type BundledSkillName,
} from '../../../platform/paths.js';
import { allocateRuntimeSocketPath } from '../../../platform/runtime-sockets.js';

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

/**
 * Allocate a fresh listen socket for one Codex app-server start (issue #182).
 *
 * The socket is a pure rendezvous endpoint — dreamux starts
 * `codex app-server --listen unix://<path>` and connects with
 * `ws+unix://<path>` immediately; resume/checkpoint state never depends on the
 * path. So the path is short, random, and re-allocated on every start, under a
 * private runtime root (`$XDG_RUNTIME_DIR/dreamux/sockets/` or
 * `~/.dreamux/run/sockets/` — never shared tmp, never the durable state tree).
 * It must not be persisted into identity, history, ledger, checkpoint, or
 * status records; the supervisor owns mkdir, stale-socket removal before bind,
 * and removal on reap.
 */
export function allocateCodexSocketPath(id: string): string {
  return allocateRuntimeSocketPath(`dispatcher '${id}' Codex socket path`);
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
