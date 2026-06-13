import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Standalone default for the volatile rendezvous-socket path, used when no host
 * socket allocator is injected (e.g. the bare generic-loader path or external
 * standalone use).
 *
 * This is the PACKAGE's own fallback root — `$XDG_RUNTIME_DIR` when set, else the
 * OS temp dir — and is deliberately NOT the Dreamux host socket contract. The
 * Dreamux host injects its own allocator (its shared runtime-socket root) through
 * the provider adapter, so this fallback never duplicates or drifts that
 * contract; it only keeps a loader-constructed runtime runnable on its own. The
 * path is random per call and never persisted.
 */
export function defaultVolatileSocketPath(id: string): string {
  const root = globalThis.process.env['XDG_RUNTIME_DIR'] ?? tmpdir();
  return join(root, `arc-${sanitize(id)}-${randomUUID().slice(0, 8)}.sock`);
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
