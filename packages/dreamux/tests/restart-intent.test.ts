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

  it('yields an empty consumer for a missing marker without warning', async () => {
    const warnings: string[] = [];
    const consumer = await RestartIntentConsumer.load({
      now: 0,
      path,
      warn: (m) => warnings.push(m),
    });
    expect(consumer.claim('flow', 0)).toBeNull();
    // Missing marker is the common case (no restart notice requested): quiet.
    expect(warnings).toEqual([]);
  });

  it('warns and drops a malformed marker (issue #98: not silent)', async () => {
    writeFileSync(path, 'not json', { mode: 0o600 });
    const warnings: string[] = [];
    const consumer = await RestartIntentConsumer.load({
      now: 0,
      path,
      warn: (m) => warnings.push(m),
    });
    expect(existsSync(path)).toBe(false);
    expect(consumer.claim('flow', 0)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not valid JSON/);
  });

  it('warns and drops a marker with an unknown version', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        created_at_ms: 0,
        ttl_ms: DEFAULT_RESTART_INTENT_TTL_MS,
        announce: 'x',
        targets: ['flow'],
      }),
      { mode: 0o600 },
    );
    const warnings: string[] = [];
    const consumer = await RestartIntentConsumer.load({
      now: 0,
      path,
      warn: (m) => warnings.push(m),
    });
    expect(existsSync(path)).toBe(false);
    expect(consumer.claim('flow', 0)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unsupported version/);
  });

  it('warns and drops a v1 marker whose targets is not a string array', async () => {
    // A non-array targets would otherwise crash dedupeNonEmpty at server start.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        created_at_ms: 0,
        ttl_ms: DEFAULT_RESTART_INTENT_TTL_MS,
        announce: 'x',
        targets: { flow: true },
      }),
      { mode: 0o600 },
    );
    const warnings: string[] = [];
    const consumer = await RestartIntentConsumer.load({
      now: 0,
      path,
      warn: (m) => warnings.push(m),
    });
    expect(existsSync(path)).toBe(false);
    expect(consumer.claim('flow', 0)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/malformed fields/);
  });

  it('warns and drops a v1 marker with non-numeric created_at_ms/ttl_ms', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        created_at_ms: 'soon',
        ttl_ms: null,
        announce: 'x',
        targets: ['flow'],
      }),
      { mode: 0o600 },
    );
    const warnings: string[] = [];
    const consumer = await RestartIntentConsumer.load({
      now: 0,
      path,
      warn: (m) => warnings.push(m),
    });
    expect(existsSync(path)).toBe(false);
    expect(consumer.claim('flow', 0)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/malformed fields/);
  });
});
