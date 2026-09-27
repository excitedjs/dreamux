/**
 * Codex spawn-env and home-path resolution.
 *
 * The Codex app-server child spawns with the ambient process env (what a
 * vanilla `codex` invocation would see) plus this provider's own
 * `config.extra_env`. Codex itself resolves its home from that same merged
 * env — an explicit `CODEX_HOME` override, else `$HOME/.codex` — so both the
 * runtime spawn path and anything that needs to know which Codex home a
 * runtime will actually use (the activity reader, the pre-start doctor) share
 * one derivation here. It is codex-engine-specific and carries no
 * `~/.dreamux` knowledge, so it belongs to this package, not to Dreamux core.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';

/** The process env a Codex app-server child spawns with. */
export function codexSpawnEnv(
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...globalThis.process.env, ...extraEnv };
}

/**
 * The Codex home that applies for a given env: an explicit `CODEX_HOME`
 * override, else `$HOME/.codex` (falling back to the running process's own
 * home directory if the env carries no `HOME`). Pure and non-throwing — it
 * only says what path applies; a caller that needs existence/validity checks
 * (the activity reader, the doctor) layers its own error semantics on top.
 */
export function resolveCodexHomeDir(env: DreamuxEnvironment): string {
  const configured = env['CODEX_HOME'];
  if (configured !== undefined) return configured;
  const home = env['HOME'];
  return join(home !== undefined && home !== '' ? home : homedir(), '.codex');
}
