import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';

/**
 * Final codex binary path for one runtime. The `CODEX_HOST_CODEX_BIN`
 * environment variable is a deliberate host-level override that takes precedence
 * over the configured `runtime.config.bin`; otherwise the configured bin
 * (default `"codex"`) is used. `env` defaults to the live process environment
 * for the runtime spawn path; doctor passes the installed service unit's
 * environment so it checks what the service will run.
 *
 * Lives in its own module so both the provider (spawn path) and the diagnostic
 * (doctor path) import it without forming an import cycle.
 */
export function resolveCodexBinPath(
  configBin: string,
  env: DreamuxEnvironment = process.env,
): string {
  const fromEnv = env['CODEX_HOST_CODEX_BIN'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return configBin;
}
