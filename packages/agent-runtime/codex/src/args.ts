/**
 * Build the CLI-arg model passed to the codex app-server child from the
 * dispatcher's structured `agents[]` entry config (`sandbox_mode`,
 * `extra_args`).
 *
 * `approvalPolicy` is always `'never'` (issue #2 "trust model": the dreamux
 * MVP only ships with a fail-fast approval handler, so no other policy is
 * safe to run) — it is not read from config.
 *
 * The provider config reader validates sandbox mode; this module only encodes it.
 */

export interface ParsedCodexArgs {
  approvalPolicy: string;
  sandboxMode: string;
  extraArgs: string[];
}

/**
 * Build the codex CLI-arg model from the structured codex config block
 * (the dispatcher's `agents[]` entry config).
 */
export function codexArgsFromConfig(config: {
  sandbox_mode: string;
  extra_args: string[];
}): ParsedCodexArgs {
  return {
    approvalPolicy: 'never',
    sandboxMode: config.sandbox_mode,
    extraArgs: [...config.extra_args],
  };
}

export function codexArgsToCli(parsed: ParsedCodexArgs): string[] {
  // codex >= 0.134 dropped --approval-policy and --sandbox at the
  // app-server level; the remaining mechanism is `-c key=value` config
  // overrides for both. Pass approval_policy first, then sandbox_mode,
  // then the dispatcher's extra args — letting extra_args contain a same-key
  // `-c` override that wins (codex parses last write wins).
  return [
    '-c',
    `approval_policy=${parsed.approvalPolicy}`,
    '-c',
    `sandbox_mode=${parsed.sandboxMode}`,
    ...parsed.extraArgs,
  ];
}
