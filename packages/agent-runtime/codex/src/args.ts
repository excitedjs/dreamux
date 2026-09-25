/**
 * Parse `dispatchers.codex_args_json` into the CLI-arg array passed to
 * the codex app-server child.
 *
 * Canonical shape:
 *   {
 *     "sandboxMode":    "workspace-write",  // from the dispatcher's agents[] entry config
 *     "extraArgs":      ["--model", "..."]  // from that entry's config.extra_args
 *   }
 *
 * This JSON is encoded per dispatcher from its `agents[dispatcher.agentRuntime]`
 * entry's config (every field carries a dispatcher-local default), so it is
 * the sole source of truth. The optional `defaults` param
 * remains a thin seam; with the top-level `codex` block removed there is no
 * global layer, and a caller normally passes nothing.
 *
 * Precedence for each field (highest wins):
 *   1. dispatchers.codex_args_json (this JSON)
 *   2. `defaults` (optional caller seam)
 *   3. hardcoded fallbacks (`'workspace-write'`, `[]`)
 *
 * `approvalPolicy` is always `'never'` (issue #2 "trust model": the dreamux
 * MVP only ships with a fail-fast approval handler, so no other policy is
 * safe to run) — it is not read from config.
 *
 * `sandboxMode` is validated against the codex 0.134 enum so a typo doesn't
 * reach the daemon (where the only feedback is a fatal early exit).
 */

const ALLOWED_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export interface ParsedCodexArgs {
  approvalPolicy: string;
  sandboxMode: string;
  extraArgs: string[];
}

export interface CodexArgsDefaults {
  sandboxMode?: string;
  extraArgs?: string[];
}

export function parseCodexArgs(
  json: string,
  defaults: CodexArgsDefaults = {},
): ParsedCodexArgs {
  let raw: unknown;
  try {
    raw = json.trim() === '' ? {} : JSON.parse(json);
  } catch (e) {
    throw new Error(
      `codex_args_json is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('codex_args_json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const sandboxMode =
    typeof obj['sandboxMode'] === 'string'
      ? (obj['sandboxMode'] as string)
      : (defaults.sandboxMode ?? 'workspace-write');
  const perDispatcherExtra = Array.isArray(obj['extraArgs'])
    ? (obj['extraArgs'] as unknown[]).map((x) => String(x))
    : [];
  // Any caller-provided default extraArgs go first; the dispatcher's own
  // extraArgs are appended. codex's CLI is order-sensitive for `-c key=value`
  // overrides — last write wins — so the dispatcher value overrides a same-key
  // default.
  const extraArgs = [
    ...(defaults.extraArgs ?? []),
    ...perDispatcherExtra,
  ];

  return validateCodexArgs({ approvalPolicy: 'never', sandboxMode, extraArgs });
}

/**
 * Build the codex CLI-arg model directly from the structured codex config
 * block (the dispatcher's `agents[]` entry config), without round-tripping
 * through JSON.
 * Behavior-equivalent to encoding that block and calling {@link parseCodexArgs}:
 * the same trusted-local invariants are enforced.
 */
export function codexArgsFromConfig(config: {
  sandbox_mode: string;
  extra_args: string[];
}): ParsedCodexArgs {
  return validateCodexArgs({
    approvalPolicy: 'never',
    sandboxMode: config.sandbox_mode,
    extraArgs: [...config.extra_args],
  });
}

function validateCodexArgs(parsed: ParsedCodexArgs): ParsedCodexArgs {
  if (!ALLOWED_SANDBOX_MODES.has(parsed.sandboxMode)) {
    throw new Error(
      `dispatcher startup refused: sandboxMode='${parsed.sandboxMode}' is not one of ` +
        `${Array.from(ALLOWED_SANDBOX_MODES).join(' | ')} (codex 0.134 enum).`,
    );
  }
  return parsed;
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
