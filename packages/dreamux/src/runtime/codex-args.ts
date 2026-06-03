/**
 * Parse `dispatchers.codex_args_json` into the CLI-arg array passed to
 * the codex app-server child, AND validate that the trusted-local
 * invariants from issue #2 §"信任模型" hold.
 *
 * Canonical shape:
 *   {
 *     "approvalPolicy": "never",            // overrides global default if set
 *     "sandboxMode":    "workspace-write",  // overrides global default if set
 *     "extraArgs":      ["--model", "..."]  // appended after global extra_args
 *   }
 *
 * Precedence for each field (highest wins):
 *   1. dispatchers.codex_args_json (this JSON)
 *   2. global defaults from ~/.dreamux/config.json (passed in as `defaults`)
 *   3. hardcoded fallbacks (`'never'`, `'workspace-write'`, `[]`)
 * Per the feat/global-config-dir work — see the global-config decision.
 *
 * `approvalPolicy` not in the trusted-local allowlist fails-fast at startup
 * (issue #2 §"实现陷阱"): dispatcher refuses to come up if the policy may
 * request approval AND no approval handler is wired.
 *
 * `sandboxMode` is similarly validated against the codex 0.134 enum so a
 * typo doesn't reach the daemon (where the only feedback is a fatal early
 * exit).
 */

const TRUSTED_LOCAL_APPROVAL_POLICIES = new Set([
  'never',
  'auto',
  'auto-approve',
  'on-failure',
]);

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
  approvalPolicy?: string;
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
  const approvalPolicy =
    typeof obj['approvalPolicy'] === 'string'
      ? (obj['approvalPolicy'] as string)
      : (defaults.approvalPolicy ?? 'never');
  const sandboxMode =
    typeof obj['sandboxMode'] === 'string'
      ? (obj['sandboxMode'] as string)
      : (defaults.sandboxMode ?? 'workspace-write');
  const perDispatcherExtra = Array.isArray(obj['extraArgs'])
    ? (obj['extraArgs'] as unknown[]).map((x) => String(x))
    : [];
  // Global extra_args go first; per-dispatcher extra_args are appended.
  // codex's CLI is order-sensitive for `-c key=value` overrides — the
  // last write wins — so per-dispatcher always overrides a same-key
  // global.
  const extraArgs = [
    ...(defaults.extraArgs ?? []),
    ...perDispatcherExtra,
  ];

  if (!TRUSTED_LOCAL_APPROVAL_POLICIES.has(approvalPolicy)) {
    throw new Error(
      `dispatcher startup refused: approvalPolicy='${approvalPolicy}' may request approval, ` +
        `but the dreamux MVP only ships with a fail-fast approval handler ` +
        `(issue #2 §"信任模型"). Configure approvalPolicy='never' or extend the trust model first.`,
    );
  }
  if (!ALLOWED_SANDBOX_MODES.has(sandboxMode)) {
    throw new Error(
      `dispatcher startup refused: sandboxMode='${sandboxMode}' is not one of ` +
        `${Array.from(ALLOWED_SANDBOX_MODES).join(' | ')} (codex 0.134 enum).`,
    );
  }

  return { approvalPolicy, sandboxMode, extraArgs };
}

export function codexArgsToCli(parsed: ParsedCodexArgs): string[] {
  // codex >= 0.134 dropped --approval-policy and --sandbox at the
  // app-server level; the remaining mechanism is `-c key=value` config
  // overrides for both. Pass approval_policy first, then sandbox_mode,
  // then per-dispatcher / global extra args — letting extra_args contain
  // a same-key `-c` override that wins (codex parses last write wins).
  return [
    '-c',
    `approval_policy=${parsed.approvalPolicy}`,
    '-c',
    `sandbox_mode=${parsed.sandboxMode}`,
    ...parsed.extraArgs,
  ];
}
