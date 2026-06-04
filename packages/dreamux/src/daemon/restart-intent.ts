/**
 * Restart-notice marker — the one-shot signal that turns a plain service
 * restart into "after you come back up, tell these resumed dispatchers the
 * restart finished".
 *
 * Contract (issue #78):
 *   - `dreamux daemon restart --notify-resumed --dispatcher <id>` writes the
 *     marker to dreamux state *before* it asks the service manager to restart.
 *     Writing first means the marker survives even when the calling CLI is a
 *     child of the Codex process group that the restart reaps (the dispatcher
 *     self-update case): the caller may be killed before `systemctl` returns,
 *     so it must not depend on observing an exit code.
 *   - The freshly started server loads the marker exactly once, deletes it
 *     immediately (snapshot-in-memory semantics), then hands the announce text
 *     to each named dispatcher as it comes up resumed. Deleting on load is what
 *     stops a later cold boot / crash auto-heal from replaying the notice.
 *   - A TTL bounds staleness: a marker older than its TTL is ignored (and the
 *     file removed). The TTL is re-checked at claim time too, so a dispatcher
 *     that only starts long after boot (e.g. via a later admin `dispatcher
 *     start`) does not claim a stale notice.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { restartIntentPath } from '../runtime/paths.js';

/** Default English notice injected into a resumed dispatcher after restart. */
export const DEFAULT_RESTART_ANNOUNCE = 'Restart completed.';

/**
 * How long a restart marker stays valid. A `daemon restart` is a service
 * restart (seconds), not a machine reboot, so ten minutes is comfortably
 * longer than any healthy restart+resume while still bounding a stale marker
 * left behind by a crash mid-restart.
 */
export const DEFAULT_RESTART_INTENT_TTL_MS = 10 * 60_000;

export interface RestartIntentFile {
  version: 1;
  created_at_ms: number;
  ttl_ms: number;
  announce: string;
  targets: string[];
}

export interface WriteRestartIntentOptions {
  targets: string[];
  announce?: string;
  ttlMs?: number;
  /** Wall clock at write time (callers pass Date.now()). */
  now: number;
  /** Override the marker path (tests). */
  path?: string;
}

/**
 * Persist the restart marker. Must be called *before* triggering the service
 * manager restart so the marker is durable if the caller is killed.
 */
export function writeRestartIntent(options: WriteRestartIntentOptions): string {
  const path = options.path ?? restartIntentPath();
  const file: RestartIntentFile = {
    version: 1,
    created_at_ms: options.now,
    ttl_ms: options.ttlMs ?? DEFAULT_RESTART_INTENT_TTL_MS,
    announce:
      options.announce !== undefined && options.announce.trim() !== ''
        ? options.announce
        : DEFAULT_RESTART_ANNOUNCE,
    targets: dedupeNonEmpty(options.targets),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * Best-effort removal of the restart marker. Used to roll back a marker after
 * the restart command itself fails synchronously while this process is still
 * alive — leaving it would let the next ordinary `serve` start (within the TTL)
 * falsely consume it and inject a notice for a restart that never happened. The
 * self-update path where the caller is reaped before reaching here keeps the
 * marker (durability), which is the intended behaviour (issue #78).
 */
export function clearRestartIntent(path: string = restartIntentPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}

export interface NotifyResumedRestartOptions {
  targets: string[];
  announce?: string;
  now: number;
  /** Triggers the actual service-manager restart. */
  runControl: () => Promise<void>;
  path?: string;
}

/**
 * Drop the restart marker, then trigger the restart. The marker is written
 * first so it survives a self-update restart that reaps the caller. If the
 * restart command instead fails synchronously (caller still alive), roll the
 * marker back so a later ordinary `serve` start cannot falsely consume it
 * within the TTL. See issue #78.
 */
export async function notifyResumedRestart(
  options: NotifyResumedRestartOptions,
): Promise<void> {
  const path = writeRestartIntent({
    targets: options.targets,
    ...(options.announce !== undefined ? { announce: options.announce } : {}),
    now: options.now,
    ...(options.path !== undefined ? { path: options.path } : {}),
  });
  try {
    await options.runControl();
  } catch (err) {
    clearRestartIntent(path);
    throw err;
  }
}

/**
 * In-memory snapshot of the restart marker. Constructed once at server start;
 * `claim` hands out the announce text per target exactly once.
 */
export class RestartIntentConsumer {
  private readonly announce: string;
  private readonly expiresAtMs: number;
  private readonly remaining: Set<string>;

  private constructor(
    announce: string,
    expiresAtMs: number,
    remaining: Set<string>,
  ) {
    this.announce = announce;
    this.expiresAtMs = expiresAtMs;
    this.remaining = remaining;
  }

  /**
   * Read the marker (if any), delete it from disk, and return a consumer. A
   * missing / malformed / expired marker yields an empty consumer (and the
   * stale file is removed). This is the only reader of the marker file.
   */
  static load(options: { now: number; path?: string } = { now: 0 }): RestartIntentConsumer {
    const path = options.path ?? restartIntentPath();
    const empty = new RestartIntentConsumer('', 0, new Set());
    if (!existsSync(path)) return empty;
    let parsed: RestartIntentFile | null = null;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as RestartIntentFile;
    } catch {
      parsed = null;
    }
    // Single reader: drop the file regardless of validity so it never replays.
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
    if (parsed === null || parsed.version !== 1) return empty;
    const expiresAtMs = parsed.created_at_ms + parsed.ttl_ms;
    if (options.now > expiresAtMs) return empty;
    const announce =
      typeof parsed.announce === 'string' && parsed.announce.trim() !== ''
        ? parsed.announce
        : DEFAULT_RESTART_ANNOUNCE;
    return new RestartIntentConsumer(
      announce,
      expiresAtMs,
      new Set(dedupeNonEmpty(parsed.targets ?? [])),
    );
  }

  /**
   * Claim the notice for one dispatcher. Returns the announce text the first
   * time a still-valid target is seen, then null forever after (single
   * consume). Re-checks the TTL so a late starter cannot claim a stale notice.
   */
  claim(dispatcherId: string, now: number): string | null {
    if (!this.remaining.has(dispatcherId)) return null;
    if (now > this.expiresAtMs) {
      this.remaining.delete(dispatcherId);
      return null;
    }
    this.remaining.delete(dispatcherId);
    return this.announce;
  }
}

function dedupeNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
