/**
 * Claude Code spawn-env and config-home-path resolution.
 *
 * The Claude Code child process spawns with the ambient process env (what a
 * vanilla `claude` invocation would see) plus this provider's own
 * `config.extra_env`. Claude Code itself resolves its config/session home
 * from that same merged env — an explicit `CLAUDE_CONFIG_DIR` override, else
 * `$HOME/.claude` — so both the runtime spawn path and anything that needs to
 * know which config home a runtime will actually use (the activity reader)
 * share one derivation here. It is claude-code-specific and carries no
 * `~/.dreamux` knowledge, so it belongs to this package, not to Dreamux core.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';

/** The process env a Claude Code child spawns with. */
export function claudeSpawnEnv(
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...globalThis.process.env, ...extraEnv };
}

/**
 * The Claude config home directory that applies for a given env and runtime
 * cwd: an explicit `CLAUDE_CONFIG_DIR` override (resolved against
 * `runtimeCwd` when relative), else `$HOME/.claude` (falling back to the
 * running process's own home directory if the env carries no `HOME`). Pure
 * and non-throwing — it only says what path applies; a caller that needs a
 * missing-`HOME` failure mode (the activity reader) layers its own error
 * semantics on top.
 */
export function resolveClaudeConfigHomeDir(
  env: DreamuxEnvironment,
  runtimeCwd: string,
): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  if (configured !== undefined && configured !== '') {
    return isAbsolute(configured)
      ? configured
      : resolve(runtimeCwd, configured);
  }
  const home = env['HOME'];
  return join(home !== undefined && home !== '' ? home : homedir(), '.claude');
}
