import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_RESTART_ANNOUNCE,
  DEFAULT_RESTART_INTENT_TTL_MS,
  notifyResumedRestart,
  RestartIntentConsumer,
  writeRestartIntent,
} from '../src/daemon/restart-intent.js';

describe('restart intent marker', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dreamux-restart-intent-'));
    path = join(dir, 'restart-intent.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads a marker, then consumes per target exactly once', async () => {
    await writeRestartIntent({
      targets: ['flow', 'ops'],
      announce: 'Restart completed.',
      now: 1_000,
      path,
    });
    expect(existsSync(path)).toBe(true);

    const consumer = await RestartIntentConsumer.load({ now: 2_000, path });
    // Loading deletes the file (single reader).
    expect(existsSync(path)).toBe(false);

    expect(consumer.claim('flow', 2_000)).toBe('Restart completed.');
    // Second claim for the same target returns null.
    expect(consumer.claim('flow', 2_000)).toBeNull();
    expect(consumer.claim('ops', 2_000)).toBe('Restart completed.');
    // Untargeted dispatcher never claims.
    expect(consumer.claim('other', 2_000)).toBeNull();
  });

  it('defaults the announce text and dedupes/trims targets', async () => {
    await writeRestartIntent({
      targets: ['flow', ' flow ', '', 'ops'],
      now: 0,
      path,
    });
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      announce: string;
      targets: string[];
    };
    expect(file.announce).toBe(DEFAULT_RESTART_ANNOUNCE);
    expect(file.targets).toEqual(['flow', 'ops']);
  });

  it('ignores a marker past its TTL at load time', async () => {
    await writeRestartIntent({ targets: ['flow'], now: 0, path });
    const consumer = await RestartIntentConsumer.load({
      now: DEFAULT_RESTART_INTENT_TTL_MS + 1,
      path,
    });
    expect(existsSync(path)).toBe(false);
    expect(consumer.claim('flow', DEFAULT_RESTART_INTENT_TTL_MS + 1)).toBeNull();
  });

  it('re-checks the TTL at claim time for late starters', async () => {
    await writeRestartIntent({ targets: ['flow'], ttlMs: 100, now: 0, path });
    const consumer = await RestartIntentConsumer.load({ now: 50, path });
    // Within TTL at load, but claimed after expiry.
    expect(consumer.claim('flow', 200)).toBeNull();
  });

  it('keeps the marker when the restart command succeeds', async () => {
    let ran = false;
    await notifyResumedRestart({
      targets: ['flow'],
      now: 0,
      path,
      runControl: async () => {
        ran = true;
      },
    });
    expect(ran).toBe(true);
    // The server still needs to load+consume it after the restart.
    expect(existsSync(path)).toBe(true);
  });

  it('rolls the marker back when the restart command fails synchronously', async () => {
    await expect(
      notifyResumedRestart({
        targets: ['flow'],
        now: 0,
        path,
        runControl: async () => {
          throw new Error('systemctl --user restart failed');
        },
      }),
    ).rejects.toThrow('systemctl --user restart failed');
    // No stale marker → a later ordinary serve start cannot falsely consume it.
    expect(existsSync(path)).toBe(false);
  });

  it('yields an empty consumer for a missing or malformed marker', async () => {
    expect(
      (await RestartIntentConsumer.load({ now: 0, path })).claim('flow', 0),
    ).toBeNull();

    writeFileSync(path, 'not json', { mode: 0o600 });
    const consumer = await RestartIntentConsumer.load({ now: 0, path });
    expect(existsSync(path)).toBe(false);
    expect(consumer.claim('flow', 0)).toBeNull();
  });
});
