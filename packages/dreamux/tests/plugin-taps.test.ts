/**
 * The tap runner is the only module that executes plugin callbacks, so the
 * isolation rules of the plugin contract live here: a failing tap loses only
 * its own changes and never stops the taps after it.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DreamuxLogger, LaunchDraft } from '@excitedjs/dreamux-types';
import { AsyncSeriesHook, SyncHook } from 'tapable';

import {
  callLoadPhaseTaps,
  callTapsIsolated,
  composeLaunchDraft,
  runTapsIsolated,
} from '../src/plugin/taps.js';
import { PluginLoadError } from '../src/plugin/loader.js';

interface LoggedError {
  fields: Record<string, unknown>;
  message: string;
}

function recordingLog(): { log: DreamuxLogger; errors: LoggedError[] } {
  const errors: LoggedError[] = [];
  const log = {
    error: (fields: Record<string, unknown>, message: string) =>
      errors.push({ fields, message }),
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as DreamuxLogger;
  return { log, errors };
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A skill root holding one child skill directory per name. */
async function skillRoot(...skills: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-plugin-skills-'));
  roots.push(root);
  for (const skill of skills) await mkdir(join(root, skill));
  return realpath(root);
}

describe('callTapsIsolated (dispatcher, team)', () => {
  it('logs a throwing tap with its name and still runs the taps after it', () => {
    const hook = new SyncHook<[string[]]>(['seen'], 'team');
    hook.tap('alpha', (seen) => seen.push('alpha'));
    hook.tap('broken', () => {
      throw new Error('boom');
    });
    hook.tap('omega', (seen) => seen.push('omega'));
    const { log, errors } = recordingLog();
    const seen: string[] = [];

    callTapsIsolated(hook, [seen], log);

    expect(seen).toEqual(['alpha', 'omega']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ plugin: 'broken', hook: 'team' });
  });
});

describe('callLoadPhaseTaps (plugin.for(name))', () => {
  it('fails loading, blaming the tapping plugin and naming the api owner', () => {
    const hook = new SyncHook<[unknown]>(['api']);
    hook.tap('acme', () => {
      throw new Error('bad register');
    });
    let caught: unknown;
    try {
      callLoadPhaseTaps(hook, [{}], 'feishu');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as PluginLoadError).plugin).toBe('acme');
    expect((caught as PluginLoadError).phase).toBe('api');
    expect((caught as Error).message).toContain('plugin "feishu" api: bad register');
  });
});

describe('runTapsIsolated (created)', () => {
  it('logs a rejection and runs every other tap, promise and callback style', async () => {
    const hook = new AsyncSeriesHook<[{ requestId: string | null }]>(['ctx'], 'created');
    const seen: string[] = [];
    hook.tapPromise('alpha', async ({ requestId }) => {
      seen.push(`alpha:${requestId}`);
    });
    hook.tapPromise('broken', async () => {
      throw new Error('boom');
    });
    hook.tapAsync('omega', ({ requestId }, done) => {
      seen.push(`omega:${requestId}`);
      done();
    });
    const { log, errors } = recordingLog();

    await runTapsIsolated(hook, [{ requestId: 'req-1' }], log);

    expect(seen).toEqual(['alpha:req-1', 'omega:req-1']);
    expect(errors.map((e) => e.fields['plugin'])).toEqual(['broken']);
  });
});

describe('composeLaunchDraft', () => {
  it('drops a failing tap\'s pushes and keeps the others in tap order', async () => {
    const hook = new AsyncSeriesHook<[LaunchDraft]>(['draft'], 'beforeLaunch');
    hook.tapPromise('alpha', async (draft) => {
      draft.instructions.push('from alpha');
    });
    hook.tapPromise('broken', async (draft) => {
      draft.instructions.push('half written');
      throw new Error('read failed');
    });
    hook.tapAsync('omega', (draft, done) => {
      draft.instructions.push('from omega');
      done();
    });
    const { log, errors } = recordingLog();

    const draft = await composeLaunchDraft(hook, { requiredSkillSources: [], log });

    expect(draft.instructions).toEqual(['from alpha', 'from omega']);
    expect(draft.skillSources).toEqual([]);
    expect(errors.map((e) => e.fields['plugin'])).toEqual(['broken']);
  });

  it('hands each tap its own empty draft, never another tap\'s additions', async () => {
    const hook = new AsyncSeriesHook<[LaunchDraft]>(['draft']);
    const seenByOmega: string[] = [];
    hook.tapPromise('alpha', async (draft) => {
      draft.instructions.push('from alpha');
    });
    hook.tapPromise('omega', async (draft) => {
      seenByOmega.push(...draft.instructions);
    });

    await composeLaunchDraft(hook, { requiredSkillSources: [], log: recordingLog().log });

    expect(seenByOmega).toEqual([]);
  });

  it('accepts a plugin skill root after the required roots', async () => {
    const required = await skillRoot('core-skill');
    const plugin = await skillRoot('plugin-skill');
    const hook = new AsyncSeriesHook<[LaunchDraft]>(['draft']);
    hook.tapPromise('alpha', async (draft) => {
      draft.skillSources.push({ name: 'alpha', path: plugin, source: 'alpha' });
      draft.instructions.push('from alpha');
    });

    const draft = await composeLaunchDraft(hook, {
      requiredSkillSources: [{ name: 'core', path: required, source: 'dreamux-core' }],
      log: recordingLog().log,
    });

    expect(draft.skillSources).toEqual([{ name: 'alpha', path: plugin, source: 'alpha' }]);
    expect(draft.instructions).toEqual(['from alpha']);
  });

  it('drops the whole tap when its skill root collides with a required skill', async () => {
    const required = await skillRoot('core-skill');
    const shadowing = await skillRoot('core-skill');
    const clean = await skillRoot('other-skill');
    const hook = new AsyncSeriesHook<[LaunchDraft]>(['draft'], 'beforeLaunch');
    hook.tapPromise('shadow', async (draft) => {
      draft.skillSources.push({ name: 'shadow', path: shadowing, source: 'shadow' });
      draft.instructions.push('from shadow');
    });
    hook.tapPromise('alpha', async (draft) => {
      draft.skillSources.push({ name: 'alpha', path: clean, source: 'alpha' });
      draft.instructions.push('from alpha');
    });
    const { log, errors } = recordingLog();

    const draft = await composeLaunchDraft(hook, {
      requiredSkillSources: [{ name: 'core', path: required, source: 'dreamux-core' }],
      log,
    });

    expect(draft.instructions).toEqual(['from alpha']);
    expect(draft.skillSources.map((s) => s.path)).toEqual([clean]);
    expect(errors.map((e) => e.fields['plugin'])).toEqual(['shadow']);
  });
});
