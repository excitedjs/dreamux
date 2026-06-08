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
  assertUnixSocketPathBudget,
  codexAppServerLogDir,
  dispatcherDir,
  dispatcherPathSegment,
  teamMateNameSegment,
} from '../../../platform/paths.js';

/** Codex app-server control directory — the per-dispatcher state root. */
export function dispatcherAppServerControlDir(id: string): string {
  return dispatcherDir(id);
}

/**
 * Codex app-server Unix socket inside the given per-dispatcher runtime root.
 * The runtime derives its socket from the neutral `dispatcherDir` accessor; this
 * helper applies the socket-path byte budget assertion.
 */
export function codexSocketPathIn(dir: string, id: string): string {
  return assertUnixSocketPathBudget(
    join(dir, 'codex.sock'),
    `dispatcher '${id}' Codex socket path`,
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
