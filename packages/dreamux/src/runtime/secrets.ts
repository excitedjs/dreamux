/**
 * Resolve `bot_secret_ref` into the actual app secret.
 *
 * Issue #2 §"开放问题 Q9": P0 supports `env:VAR_NAME` only. Future references
 * (keyring, 1Password, vault) are out of scope.
 */
export function resolveBotSecret(ref: string): string {
  if (!ref.startsWith('env:')) {
    throw new Error(
      `unsupported bot_secret_ref scheme: ${ref}. P0 only supports env:<VAR>.`,
    );
  }
  const varName = ref.slice('env:'.length);
  const value = process.env[varName];
  if (value === undefined || value === '') {
    throw new Error(
      `bot secret env var '${varName}' is not set (referenced by bot_secret_ref=${ref})`,
    );
  }
  return value;
}
