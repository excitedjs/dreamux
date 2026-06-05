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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
export async function writeRestartIntent(
  options: WriteRestartIntentOptions,
): Promise<string> {
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
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
export async function clearRestartIntent(
  path: string = restartIntentPath(),
): Promise<void> {
  try {
    await rm(path, { force: true });
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
  const path = await writeRestartIntent({
    targets: options.targets,
    ...(options.announce !== undefined ? { announce: options.announce } : {}),
    now: options.now,
    ...(options.path !== undefined ? { path: options.path } : {}),
  });
  try {
    await options.runControl();
  } catch (err) {
    await clearRestartIntent(path);
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
   * missing or expired marker yields an empty consumer quietly. A malformed or
   * unknown-version marker also yields an empty consumer, but is reported via
   * `warn` (issue #98): a bad marker is dropped, not silently ignored, because a
   * restart notice the operator explicitly requested would otherwise vanish
   * without a trace. The file is removed regardless of validity (single reader,
   * never replays). This is the only reader of the marker file.
   */
  static async load(
    options: { now: number; path?: string; warn?: (message: string) => void } = {
      now: 0,
    },
  ): Promise<RestartIntentConsumer> {
    const path = options.path ?? restartIntentPath();
    const warn = options.warn ?? ((message) => console.warn(message));
    const empty = new RestartIntentConsumer('', 0, new Set());

    let text: string | null = null;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn(
          `restart marker ${path} could not be read ` +
            `(${err instanceof Error ? err.message : String(err)}); dropping it.`,
        );
      }
    }
    // Single reader: drop the file regardless of validity so it never replays.
    try {
      await rm(path, { force: true });
    } catch {
      /* best effort */
    }
    if (text === null) return empty;

    let parsed: RestartIntentFile | null = null;
    try {
      parsed = JSON.parse(text) as RestartIntentFile;
    } catch (err) {
      warn(
        `restart marker ${path} is not valid JSON ` +
          `(${err instanceof Error ? err.message : String(err)}); dropped it. ` +
          'A requested restart notice will not be delivered.',
      );
      return empty;
    }
    if (parsed === null || parsed.version !== 1) {
      const found =
        parsed === null || parsed.version === undefined
          ? 'missing'
          : JSON.stringify(parsed.version);
      warn(
        `restart marker ${path} ignored: unsupported version ` +
          `(found ${found}, expected 1); dropped it. ` +
          'A requested restart notice will not be delivered.',
      );
      return empty;
    }
    // A correctly-versioned marker can still carry malformed fields. Treat that
    // like any other corrupt marker: warn + drop, never throw or misread. A
    // non-array `targets` would otherwise crash `dedupeNonEmpty`, and a
    // non-numeric `created_at_ms`/`ttl_ms` would produce a NaN expiry.
    if (
      !Number.isFinite(parsed.created_at_ms) ||
      !Number.isFinite(parsed.ttl_ms) ||
      !Array.isArray(parsed.targets) ||
      !parsed.targets.every((target) => typeof target === 'string')
    ) {
      warn(
        `restart marker ${path} ignored: malformed fields ` +
          '(created_at_ms/ttl_ms must be finite numbers, targets a string array); ' +
          'dropped it. A requested restart notice will not be delivered.',
      );
      return empty;
    }
    const expiresAtMs = parsed.created_at_ms + parsed.ttl_ms;
    if (options.now > expiresAtMs) return empty;
    const announce =
      typeof parsed.announce === 'string' && parsed.announce.trim() !== ''
        ? parsed.announce
        : DEFAULT_RESTART_ANNOUNCE;
    return new RestartIntentConsumer(
      announce,
      expiresAtMs,
      new Set(dedupeNonEmpty(parsed.targets)),
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
