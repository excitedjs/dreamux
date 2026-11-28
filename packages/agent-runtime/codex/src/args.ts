/**
 * Build the CLI arguments passed to the codex app-server child from the
 * agent's structured `agents[].config` entry (`model`, `effort`, `extra_args`).
 *
 * `approval_policy` is always `'never'` (Dreamux runs unattended and installs a
 * fail-fast approval handler). Sandbox policy is intentionally not passed so
 * native Codex configuration (`~/.codex/config.toml`) or explicit `extra_args`
 * governs it.
 */

import type { DispatcherCodexConfig } from './config.js';

export function codexCliArgs(
  config: Pick<DispatcherCodexConfig, 'model' | 'effort' | 'extra_args'>,
): string[] {
  // codex >= 0.134 accepts `-c key=value` config overrides parsed as TOML.
  // Emit approval_policy, then optional model and model_reasoning_effort, then
  // extra_args so explicit extra_args overrides win (codex parses last write
  // wins). JSON.stringify produces valid TOML basic strings.
  const args = ['-c', 'approval_policy=never'];
  if (config.model !== null) {
    args.push('-c', `model=${JSON.stringify(config.model)}`);
  }
  if (config.effort !== null) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`);
  }
  args.push(...config.extra_args);
  return args;
}
