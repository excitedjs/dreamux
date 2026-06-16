import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertUnixSocketPathBudget,
  unixSocketPathFitsBudget,
} from '@excitedjs/dreamux-utils';

/**
 * Volatile rendezvous-socket allocation for the Codex app-server (issue #182,
 * relocated into this package by the issue #209 cleanup).
 *
 * A Codex socket is a pure per-start rendezvous endpoint: dreamux starts
 * `codex app-server --listen unix://<path>` and connects with `ws+unix://<path>`
 * immediately. Nothing resumes from a socket path, so every allocation is a
 * fresh short random name and the path is never persisted.
 *
 * Dreamux core no longer hands this package a socket-allocator FUNCTION. Instead
 * the neutral create/diagnostic context exposes the host's preference-ordered
 * candidate directories (`AgentRuntimePathContext.runtimeSocketDirs()`), and this
 * package owns the allocation policy: pick the first candidate whose full path
 * fits the Unix `sun_path` budget (via `@excitedjs/dreamux-utils`), else fail
 * loud. When the host supplies no candidate directories (the bare generic-loader
 * / standalone path) the package falls back to its own short root.
 */

function socketName(): string {
  return `${randomBytes(6).toString('base64url')}.sock`;
}

/**
 * Standalone default for the volatile socket path, used when no host candidate
 * directories are supplied (the bare generic-loader path or external standalone
 * use). This is the PACKAGE's own fallback root — `$XDG_RUNTIME_DIR` when set,
 * else the OS temp dir — deliberately NOT the Dreamux host socket contract. The
 * path is random per call and never persisted.
 */
export function defaultVolatileSocketPath(id: string): string {
  const root = globalThis.process.env['XDG_RUNTIME_DIR'] ?? tmpdir();
  return join(root, `arc-${sanitize(id)}-${randomUUID().slice(0, 8)}.sock`);
}

/**
 * Allocate a fresh Codex app-server socket path inside the first host candidate
 * directory whose full path fits the socket budget. Fails loud (naming `id`)
 * when even the last candidate is over budget. With no candidate directories it
 * uses {@link defaultVolatileSocketPath}.
 */
export function allocateCodexSocketPath(
  socketDirs: readonly string[],
  id: string,
): string {
  if (socketDirs.length === 0) return defaultVolatileSocketPath(id);
  const name = socketName();
  for (const dir of socketDirs) {
    const path = join(dir, name);
    if (unixSocketPathFitsBudget(path)) return path;
  }
  const fallback = socketDirs[socketDirs.length - 1] as string;
  return assertUnixSocketPathBudget(
    join(fallback, name),
    `dispatcher '${id}' Codex socket path`,
  );
}

/**
 * A representative, NON-throwing socket sample for the doctor: the first
 * candidate whose path fits, else the last candidate (which is then over budget,
 * so the home doctor can REPORT it as an error rather than throwing here). With
 * no candidate directories it uses {@link defaultVolatileSocketPath}.
 */
export function representativeCodexSocketPath(
  socketDirs: readonly string[],
  id: string,
): string {
  if (socketDirs.length === 0) return defaultVolatileSocketPath(id);
  const name = socketName();
  for (const dir of socketDirs) {
    const path = join(dir, name);
    if (unixSocketPathFitsBudget(path)) return path;
  }
  return join(socketDirs[socketDirs.length - 1] as string, name);
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
