/**
 * Codex version gate. Dreamux depends on the app-server protocol surface used
 * by the built-in runtime: `thread/start`, `thread/resume`, `turn/start`,
 * `turn/interrupt`, and thread-level instruction overrides
 * (`baseInstructions` / `developerInstructions`).
 * Doctor surfaces unsupported Codex builds loudly rather than letting prompt
 * customization or turn delivery degrade silently at runtime.
 *
 * Pure version logic lives here in the package; the host-coupled diagnostic surface
 * (codex home + path validation) lives in Dreamux core and imports these.
 */

/** Minimum codex version dreamux requires. */
export const MIN_CODEX_VERSION = '0.137.0';

/** Parse a `major.minor.patch` triple out of a `codex --version` line. */
export function parseCodexVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric (not string) component-wise compare against {@link MIN_CODEX_VERSION}. */
export function codexVersionSatisfies(raw: string): boolean {
  const got = parseCodexVersion(raw);
  if (got === null) return false;
  const min = parseCodexVersion(MIN_CODEX_VERSION)!;
  for (let i = 0; i < 3; i += 1) {
    if (got[i]! > min[i]!) return true;
    if (got[i]! < min[i]!) return false;
  }
  return true;
}
