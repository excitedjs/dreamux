/**
 * Codex home/config paths (issue #209 cleanup — relocated from Dreamux core).
 *
 * These resolve Codex's OWN global home (`~/.codex`) and config file. They are
 * codex-engine-specific and homedir-only: they carry no `~/.dreamux` knowledge,
 * so they belong to this package, not to Dreamux core. Dreamux does NOT create a
 * dispatcher-private `CODEX_HOME` for the MVP — every runtime follows the
 * operator's global Codex home — so the per-runtime accessors accept an id only
 * for call-site symmetry and ignore it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The operator's global Codex home (`~/.codex`). */
export function operatorCodexHome(): string {
  return join(homedir(), '.codex');
}

/** A runtime's Codex home — the operator's global home (no dispatcher-private home). */
export function dispatcherCodexHome(id: string): string {
  void id;
  return operatorCodexHome();
}

/** A runtime's Codex `config.toml` path, under its (operator-global) Codex home. */
export function dispatcherCodexConfigPath(id: string): string {
  return join(dispatcherCodexHome(id), 'config.toml');
}
