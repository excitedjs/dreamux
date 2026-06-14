import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { DreamuxConfig } from '../src/config/config.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { dispatcherStatusPath, resetRuntimeConfig } from '../src/platform/paths.js';
import { testDispatcherConfig } from './helpers/config.js';

function configWith(id = 'flow'): DreamuxConfig {
  return {
    dispatchers: [
      testDispatcherConfig({
        id,
        feishu: { app_id: 'app-x', app_secret: 'secret' },
      }),
    ],
  };
}

function writeRawStatus(id: string, raw: unknown): void {
  const path = dispatcherStatusPath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
}

describe('dispatcher status hydration (issue #98: warn + rebuild)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-store-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('restores a valid v1 status file without warning', async () => {
    writeRawStatus('flow', {
      version: 1,
      dispatcher_id: 'flow',
      thread_id: 'thread-x',
      status: 'ready',
      updated_at: 123,
      last_started_at: 100,
      last_ready_at: 110,
      last_error: null,
      last_lost_thread_id: null,
    });
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    const row = store.get('flow');
    expect(row?.thread_id).toBe('thread-x');
    expect(row?.status).toBe('ready');
    expect(warnings).toEqual([]);
  });

  it('rebuilds (declared) without warning when no status file exists', async () => {
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    const row = store.get('flow');
    expect(row?.status).toBe('declared');
    expect(row?.thread_id).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('warns and rebuilds on an unknown version, not silently discarding', async () => {
    writeRawStatus('flow', {
      version: 2,
      dispatcher_id: 'flow',
      thread_id: 'thread-x',
      status: 'ready',
      updated_at: 123,
    });
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    const row = store.get('flow');
    expect(row?.status).toBe('declared');
    expect(row?.thread_id).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unsupported version/);
    expect(warnings[0]).toMatch(/thread_id will not be resumed/);
  });

  it('warns and rebuilds on malformed JSON', async () => {
    const path = dispatcherStatusPath('flow');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json', { mode: 0o600 });
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    expect(store.get('flow')?.status).toBe('declared');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not valid JSON/);
  });

  it('warns and rebuilds when the status file is JSON null', async () => {
    // `null` parses as valid JSON; reading raw.version off it would otherwise
    // throw and hard-fatal hydrate() instead of warn + rebuild.
    const path = dispatcherStatusPath('flow');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'null', { mode: 0o600 });
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    expect(store.get('flow')?.status).toBe('declared');
    expect(store.get('flow')?.thread_id).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/top-level must be an object/);
  });

  it('warns and rebuilds when the status file is a non-object JSON value', async () => {
    writeRawStatus('flow', 123);
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    expect(store.get('flow')?.status).toBe('declared');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/top-level must be an object/);
  });

  it('warns and rebuilds on a dispatcher id mismatch', async () => {
    writeRawStatus('flow', {
      version: 1,
      dispatcher_id: 'other',
      thread_id: 'thread-x',
      status: 'ready',
      updated_at: 123,
    });
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    expect(store.get('flow')?.thread_id).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/dispatcher id mismatch/);
  });

  it('warns and rebuilds when v1/id match but key fields are malformed', async () => {
    // A numeric thread_id / bad status / non-finite updated_at must not be
    // silently coerced (that would drop a resumable thread or change status).
    for (const bad of [
      { thread_id: 123 },
      { status: 'bogus' },
      { updated_at: 'nope' },
      { last_started_at: 'soon' },
    ]) {
      writeRawStatus('flow', {
        version: 1,
        dispatcher_id: 'flow',
        thread_id: 'thread-x',
        status: 'ready',
        updated_at: 123,
        last_started_at: 100,
        last_ready_at: null,
        last_error: null,
        last_lost_thread_id: null,
        ...bad,
      });
      const store = new DispatcherStore(configWith());
      const warnings: string[] = [];
      await store.hydrate((m) => warnings.push(m));

      const row = store.get('flow');
      expect(row?.status).toBe('declared');
      expect(row?.thread_id).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/malformed v1 fields/);
    }
  });

  it('treats an absent nullable field as a benign null (no warn)', async () => {
    // Omitted diagnostic fields default to null; a valid thread still resumes.
    writeRawStatus('flow', {
      version: 1,
      dispatcher_id: 'flow',
      thread_id: 'thread-x',
      status: 'ready',
      updated_at: 123,
    });
    const store = new DispatcherStore(configWith());
    const warnings: string[] = [];
    await store.hydrate((m) => warnings.push(m));

    const row = store.get('flow');
    expect(row?.thread_id).toBe('thread-x');
    expect(row?.last_started_at).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe('dispatcher store feishu channel resolution (multi-channel config)', () => {
  it('populates the bot app id from the single feishu channel (builtin:feishu alias stable)', () => {
    const store = new DispatcherStore({
      dispatchers: [
        testDispatcherConfig({
          id: 'flow',
          feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
        }),
      ],
    });
    expect(store.get('flow')?.bot_app_id).toBe('app-flow');
  });

  it('seeds the PRIMARY (first) channel bot app id on a multi-feishu dispatcher (#209 live multi-channel)', () => {
    // Live multi-channel routing runs one bot per channel; the state row carries
    // the dispatcher's primary (first) channel identity, and the store's per-row
    // bot_app_id uniqueness keys on that primary id. A secondary channel's bot is
    // out of scope for that uniqueness check.
    let store: DispatcherStore | undefined;
    expect(() => {
      store = new DispatcherStore({
        dispatchers: [
          testDispatcherConfig({
            id: 'flow',
            channels: [
              {
                id: 'primary',
                provider: 'builtin:feishu',
                config: { app_id: 'app-a', app_secret: 'secret-a' },
              },
              {
                id: 'secondary',
                provider: 'builtin:feishu',
                config: { app_id: 'app-b', app_secret: 'secret-b' },
              },
            ],
          }),
        ],
      });
    }).not.toThrow();
    expect(store?.get('flow')?.bot_app_id).toBe('app-a');
  });
});
