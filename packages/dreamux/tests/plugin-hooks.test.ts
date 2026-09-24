/**
 * The register interceptors core installs on every hook it hands to plugins
 * carry the isolation rules of the plugin contract: a failing tap loses only
 * its own changes, never stops the taps after it, and is attributed to the
 * plugin that owns it. Hooks run through plain `hook.call` / `hook.promise`.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DreamuxLogger, LaunchDraft } from '@excitedjs/dreamux-types';
import { AsyncSeriesHook, SyncHook } from 'tapable';

import {
  composeLaunchDraft,
  isolatedTaps,
  launchDraftTaps,
  loadPhaseTaps,
  runAsPlugin,
  tapOwners,
} from '../src/plugin/hooks.js';
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

function launchHook(log: DreamuxLogger, name?: string): AsyncSeriesHook<[LaunchDraft]> {
  return launchDraftTaps(new AsyncSeriesHook<[LaunchDraft]>(['draft'], name), log);
}

describe('isolatedTaps (dispatcher, team)', () => {
  it('logs a throwing tap with its owner and still runs the taps after it', () => {
    const { log, errors } = recordingLog();
    const hook = isolatedTaps(new SyncHook<[string[]]>(['seen'], 'team'), log);
    runAsPlugin('alpha', () => hook.tap('first', (seen) => seen.push('alpha')));
    runAsPlugin('broken', () =>
      hook.tap('any name', () => {
        throw new Error('boom');
      }),
    );
    runAsPlugin('omega', () => hook.tap('last', (seen) => seen.push('omega')));
    const seen: string[] = [];

    hook.call(seen);

    expect(seen).toEqual(['alpha', 'omega']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ plugin: 'broken', tap: 'any name', hook: 'team' });
  });

  it('runs interceptors a plugin adds', () => {
    const hook = isolatedTaps(new SyncHook<[string[]]>(['seen']), recordingLog().log);
    const calls: string[][] = [];
    hook.intercept({ call: (seen: string[]) => calls.push([...seen]) });
    hook.tap('alpha', (seen) => seen.push('alpha'));

    hook.call([]);

    expect(calls).toEqual([[]]);
  });

  it('owns a tap registered inside another tap, after an await, by the outer tap\'s plugin', async () => {
    const { log, errors } = recordingLog();
    const outer = isolatedTaps(
      new AsyncSeriesHook<[{ requestId: string | null }]>(['ctx'], 'created'),
      log,
    );
    const inner = isolatedTaps(new SyncHook<[]>([], 'inner'), log);
    runAsPlugin('acme', () =>
      outer.tapPromise('outer', async () => {
        await Promise.resolve();
        inner.tap('nested', () => {
          throw new Error('nested boom');
        });
      }),
    );

    await outer.promise({ requestId: null });
    inner.call();

    expect(tapOwners(outer)).toEqual(['acme']);
    expect(tapOwners(inner)).toEqual(['acme']);
    expect(errors.map((e) => e.fields['plugin'])).toEqual(['acme']);
  });

  it('returns owners for every tap on one hook, in registration order, including a null owner', () => {
    const hook = isolatedTaps(new SyncHook<[]>([], 'team'), recordingLog().log);
    runAsPlugin('alpha', () => hook.tap('first', () => {}));
    hook.tap('second', () => {});
    runAsPlugin('beta', () => hook.tap('third', () => {}));

    expect(tapOwners(hook)).toEqual(['alpha', null, 'beta']);
  });
});

describe('loadPhaseTaps (plugin.for(name))', () => {
  it('fails loading, blaming the owning plugin and naming the api owner', () => {
    const hook = loadPhaseTaps(new SyncHook<[unknown]>(['api']), 'feishu');
    runAsPlugin('acme', () =>
      hook.tap('register tools', () => {
        throw new Error('bad register');
      }),
    );
    let caught: unknown;
    try {
      hook.call({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as PluginLoadError).plugin).toBe('acme');
    expect((caught as PluginLoadError).phase).toBe('api');
    expect((caught as Error).message).toContain('plugin "feishu" api: bad register');
  });

  it('falls back to the tap\'s own name when an owner-less tap fails loading', () => {
    const hook = loadPhaseTaps(new SyncHook<[unknown]>(['api']), 'feishu');
    hook.tap('mystery', () => {
      throw new Error('bad register');
    });
    let caught: unknown;
    try {
      hook.call({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as PluginLoadError).plugin).toBe('mystery');
  });
});

describe('isolatedTaps (created)', () => {
  it('logs a rejection and runs every other tap, promise and callback style', async () => {
    const { log, errors } = recordingLog();
    const hook = isolatedTaps(
      new AsyncSeriesHook<[{ requestId: string | null }]>(['ctx'], 'created'),
      log,
    );
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

    await hook.promise({ requestId: 'req-1' });

    expect(seen).toEqual(['alpha:req-1', 'omega:req-1']);
    expect(errors.map((e) => e.fields['tap'])).toEqual(['broken']);
  });

  it('logs plugin: null for a tap registered outside any plugin context', async () => {
    const { log, errors } = recordingLog();
    const hook = isolatedTaps(
      new AsyncSeriesHook<[{ requestId: string | null }]>(['ctx'], 'created'),
      log,
    );
    hook.tapPromise('lonely', async () => {
      throw new Error('boom');
    });

    await hook.promise({ requestId: null });

    expect(errors[0]?.fields).toMatchObject({ plugin: null, tap: 'lonely', hook: 'created' });
  });

  it('catches a tapAsync failure reported through done(err) and still runs the other tap', async () => {
    const { log, errors } = recordingLog();
    const hook = isolatedTaps(
      new AsyncSeriesHook<[{ requestId: string | null }]>(['ctx'], 'created'),
      log,
    );
    const seen: string[] = [];
    hook.tapAsync('broken', (_ctx, done) => {
      done(new Error('async boom'));
    });
    hook.tapAsync('omega', ({ requestId }, done) => {
      seen.push(`omega:${requestId}`);
      done();
    });

    await hook.promise({ requestId: 'req-1' });

    expect(seen).toEqual(['omega:req-1']);
    expect(errors.map((e) => e.fields['tap'])).toEqual(['broken']);
  });
});

describe('composeLaunchDraft', () => {
  it('drops a failing tap\'s pushes and keeps the others in tap order', async () => {
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeLaunch');
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

    const draft = await composeLaunchDraft(hook, []);

    expect(draft.instructions).toEqual(['from alpha', 'from omega']);
    expect(draft.skillSources).toEqual([]);
    expect(errors.map((e) => e.fields['tap'])).toEqual(['broken']);
  });

  it('catches a tapAsync failure on a launch hook without losing the other tap\'s contribution', async () => {
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeLaunch');
    runAsPlugin('broken', () =>
      hook.tapAsync('broken-tap', (draft, done) => {
        draft.instructions.push('half written');
        done(new Error('async boom'));
      }),
    );
    hook.tapPromise('alpha', async (draft) => {
      draft.instructions.push('from alpha');
    });

    const draft = await composeLaunchDraft(hook, []);

    expect(draft.instructions).toEqual(['from alpha']);
    expect(errors.map((e) => e.fields['tap'])).toEqual(['broken-tap']);
    expect(errors[0]?.fields['plugin']).toBe('broken');
  });

  it('isolates a plain sync .tap() tap on a launch hook the same way as promise/async taps', async () => {
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeLaunch');
    hook.tap('alpha', (draft) => {
      draft.instructions.push('from alpha');
    });
    hook.tap('broken', (draft) => {
      draft.instructions.push('half written');
      throw new Error('sync boom');
    });
    hook.tap('omega', (draft) => {
      draft.instructions.push('from omega');
    });

    const draft = await composeLaunchDraft(hook, []);

    expect(draft.instructions).toEqual(['from alpha', 'from omega']);
    expect(errors.map((e) => e.fields['tap'])).toEqual(['broken']);
  });

  it('runs a plugin-added interceptor when a launch hook fires through composeLaunchDraft', async () => {
    const hook = launchHook(recordingLog().log);
    const calls: number[] = [];
    hook.intercept({ call: () => calls.push(1) });

    await composeLaunchDraft(hook, []);

    expect(calls).toHaveLength(1);
  });

  it('hands each tap its own empty draft, never another tap\'s additions', async () => {
    const hook = launchHook(recordingLog().log);
    const seenByOmega: string[] = [];
    hook.tapPromise('alpha', async (draft) => {
      draft.instructions.push('from alpha');
    });
    hook.tapPromise('omega', async (draft) => {
      seenByOmega.push(...draft.instructions);
    });

    await composeLaunchDraft(hook, []);

    expect(seenByOmega).toEqual([]);
  });

  it('accepts a plugin skill root after the required roots', async () => {
    const required = await skillRoot('core-skill');
    const plugin = await skillRoot('plugin-skill');
    const hook = launchHook(recordingLog().log);
    hook.tapPromise('alpha', async (draft) => {
      draft.skillSources.push({ name: 'alpha', path: plugin, source: 'alpha' });
      draft.instructions.push('from alpha');
    });

    const draft = await composeLaunchDraft(hook, [
      { name: 'core', path: required, source: 'dreamux-core' },
    ]);

    expect(draft.skillSources).toEqual([{ name: 'alpha', path: plugin, source: 'alpha' }]);
    expect(draft.instructions).toEqual(['from alpha']);
  });

  it('drops the whole tap when its skill root collides with a required skill', async () => {
    const required = await skillRoot('core-skill');
    const shadowing = await skillRoot('core-skill');
    const clean = await skillRoot('other-skill');
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeLaunch');
    hook.tapPromise('shadow', async (draft) => {
      draft.skillSources.push({ name: 'shadow', path: shadowing, source: 'shadow' });
      draft.instructions.push('from shadow');
    });
    hook.tapPromise('alpha', async (draft) => {
      draft.skillSources.push({ name: 'alpha', path: clean, source: 'alpha' });
      draft.instructions.push('from alpha');
    });

    const draft = await composeLaunchDraft(hook, [
      { name: 'core', path: required, source: 'dreamux-core' },
    ]);

    expect(draft.instructions).toEqual(['from alpha']);
    expect(draft.skillSources.map((s) => s.path)).toEqual([clean]);
    expect(errors.map((e) => e.fields['tap'])).toEqual(['shadow']);
  });

  it('does not blame a plugin for an unreadable required root', async () => {
    const plugin = await skillRoot('plugin-skill');
    const missing = join(await skillRoot(), 'deleted');
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeTeamLeaderLaunch');
    hook.tapPromise('alpha', async (draft) => {
      draft.skillSources.push({ name: 'alpha', path: plugin, source: 'alpha' });
      draft.instructions.push('from alpha');
    });

    const draft = await composeLaunchDraft(hook, [
      { name: 'identity', path: missing, source: 'team' },
    ]);

    expect(draft.instructions).toEqual(['from alpha']);
    expect(draft.skillSources).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fields['path']).toBe(missing);
    expect(errors[0]!.fields['plugin']).toBeUndefined();
  });

  it('checks the required roots once per launch, not once per tap', async () => {
    const missing = join(await skillRoot(), 'deleted');
    const pluginA = await skillRoot('skill-a');
    const pluginB = await skillRoot('skill-b');
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeLaunch');
    hook.tapPromise('alpha', async (draft) => {
      draft.skillSources.push({ name: 'alpha', path: pluginA, source: 'alpha' });
      draft.instructions.push('from alpha');
    });
    hook.tapPromise('beta', async (draft) => {
      draft.skillSources.push({ name: 'beta', path: pluginB, source: 'beta' });
      draft.instructions.push('from beta');
    });

    const draft = await composeLaunchDraft(hook, [
      { name: 'identity', path: missing, source: 'team' },
    ]);

    expect(draft.instructions).toEqual(['from alpha', 'from beta']);
    expect(draft.skillSources).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fields['path']).toBe(missing);
  });

  it('never checks the required roots when no tap adds a skill root', async () => {
    const missing = join(await skillRoot(), 'deleted');
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeLaunch');
    hook.tapPromise('alpha', async (draft) => {
      draft.instructions.push('from alpha');
    });

    const draft = await composeLaunchDraft(hook, [
      { name: 'identity', path: missing, source: 'team' },
    ]);

    expect(draft.instructions).toEqual(['from alpha']);
    expect(errors).toHaveLength(0);
  });

  it('drops a later tap whose skill root collides with an earlier plugin\'s already-merged root', async () => {
    const alphaRoot = await skillRoot('foo');
    const betaRoot = await skillRoot('foo');
    const { log, errors } = recordingLog();
    const hook = launchHook(log, 'beforeLaunch');
    runAsPlugin('alpha', () =>
      hook.tapPromise('alpha-tap', async (draft) => {
        draft.skillSources.push({ name: 'alpha', path: alphaRoot, source: 'alpha' });
        draft.instructions.push('from alpha');
      }),
    );
    runAsPlugin('beta', () =>
      hook.tapPromise('beta-tap', async (draft) => {
        draft.skillSources.push({ name: 'beta', path: betaRoot, source: 'beta' });
        draft.instructions.push('from beta');
      }),
    );

    const draft = await composeLaunchDraft(hook, []);

    expect(draft.instructions).toEqual(['from alpha']);
    expect(draft.skillSources).toEqual([{ name: 'alpha', path: alphaRoot, source: 'alpha' }]);
    expect(errors.map((e) => e.fields['tap'])).toEqual(['beta-tap']);
    expect(errors[0]?.fields['plugin']).toBe('beta');
  });
});
