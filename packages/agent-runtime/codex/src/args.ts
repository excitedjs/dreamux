/**
 * Build the CLI arguments passed to the codex app-server child from the
 * agent's structured `agents[].config` entry (`model`, `effort`, `extra_args`).
 *
 * `approval_policy` is always `'never'` and `sandbox_mode` defaults to
 * `'danger-full-access'` ahead of `extra_args`, matching Codex CLI's
 * `--dangerously-bypass-approvals-and-sandbox` unattended posture alongside the
 * fail-fast approval handler. Operators who need a stricter sandbox can still
 * override it via `extra_args` (Codex parses `-c` last-write-wins).
 */

import type { DispatcherCodexConfig } from './config.js';

export function codexCliArgs(
  config: Pick<DispatcherCodexConfig, 'model' | 'effort' | 'extra_args'>,
): string[] {
  // codex >= 0.134 accepts `-c key=value` config overrides parsed as TOML.
  // Emit approval_policy and sandbox_mode, then optional model and
  // model_reasoning_effort, then extra_args so explicit extra_args overrides
  // win (codex parses last write wins). JSON.stringify produces valid TOML
  // basic strings.
  const args = [
    '-c',
    'approval_policy=never',
    '-c',
    'sandbox_mode=danger-full-access',
  ];
  if (config.model !== null) {
    args.push('-c', `model=${JSON.stringify(config.model)}`);
  }
  if (config.effort !== null) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`);
  }
  args.push(...config.extra_args);
  return args;
}
