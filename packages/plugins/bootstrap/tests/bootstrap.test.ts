/**
 * The bootstrap plugin against stand-in Dispatcher and Team objects that carry
 * real tapable hooks, the way core hands them to a plugin.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Dispatcher,
  DreamuxLogger,
  LaunchDraft,
  ServerHost,
  Team,
} from '@excitedjs/dreamux-types';
import { AsyncSeriesHook, HookMap, SyncHook } from 'tapable';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import createBootstrapPlugin from '../src/index.js';
import { BOOTSTRAP_GUIDE } from '../src/guide.js';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as DreamuxLogger;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dreamux-bootstrap-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function fakeDispatcher(dispatcherCwd: string | null): Dispatcher {
  return {
    id: 'flow',
    cwd: dispatcherCwd,
    hooks: Object.freeze({
      beforeLaunch: new AsyncSeriesHook<[LaunchDraft]>(['draft']),
      team: new SyncHook<[Team, { readonly origin: 'create' | 'rebuild' }]>(['team', 'ctx']),
    }),
  };
}

function fakeTeam(): Team {
  return {
    id: 'alpha',
    name: 'alpha',
    workspace: join(cwd, 'alpha'),
    hooks: Object.freeze({
      beforeTeamLeaderLaunch: new AsyncSeriesHook<[LaunchDraft]>(['draft']),
      created: new AsyncSeriesHook<[{ readonly requestId: string | null }]>(['ctx']),
    }),
  };
}

/** Run the plugin's `server` and announce `dispatcher` to it. */
function announce(dispatcher: Dispatcher): void {
  const dispatcherHook = new SyncHook<[Dispatcher]>(['dispatcher']);
  const host: ServerHost = {
    config: undefined,
    logger: silentLog,
    hooks: Object.freeze({
      dispatcher: dispatcherHook,
      plugin: new HookMap(() => new SyncHook<[unknown]>(['api'])) as unknown as ServerHost['hooks']['plugin'],
    }),
  };
  createBootstrapPlugin().server?.(host);
  dispatcherHook.call(dispatcher);
}

async function launch(hook: AsyncSeriesHook<[LaunchDraft]>): Promise<LaunchDraft> {
  const draft: LaunchDraft = { instructions: [], skillSources: [] };
  await hook.promise(draft);
  return draft;
}

async function writeProfile(files: { identity?: string; user?: string }): Promise<void> {
  const dir = join(cwd, '.workspace');
  await mkdir(dir, { recursive: true });
  if (files.identity !== undefined) await writeFile(join(dir, 'identity.md'), files.identity);
  if (files.user !== undefined) await writeFile(join(dir, 'user.md'), files.user);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe('bootstrap plugin', () => {
  it('writes the guide and gives it to the Dispatcher while a profile file is missing', async () => {
    await writeProfile({ identity: 'I am the assistant.' });
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);

    const draft = await launch(dispatcher.hooks.beforeLaunch);

    expect(draft.instructions).toEqual([BOOTSTRAP_GUIDE]);
    expect(await readFile(join(cwd, '.workspace', 'bootstrap.md'), 'utf8')).toBe(BOOTSTRAP_GUIDE);
  });

  it('creates .workspace when nothing created it yet', async () => {
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);

    await launch(dispatcher.hooks.beforeLaunch);

    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(true);
  });

  it('removes the guide and injects both files once both exist', async () => {
    await writeProfile({ identity: 'I am the assistant.', user: 'The user ships things.' });
    await writeFile(join(cwd, '.workspace', 'bootstrap.md'), BOOTSTRAP_GUIDE);
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);

    const draft = await launch(dispatcher.hooks.beforeLaunch);

    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(false);
    expect(draft.instructions).toHaveLength(1);
    expect(draft.instructions[0]).toContain('I am the assistant.');
    expect(draft.instructions[0]).toContain('The user ships things.');
    expect(draft.instructions[0]).not.toContain(BOOTSTRAP_GUIDE);
  });

  it('gives a TeamLeader the profile only when both files exist, and never the guide', async () => {
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);
    const team = fakeTeam();
    dispatcher.hooks.team.call(team, { origin: 'create' });

    await writeProfile({ identity: 'I am the assistant.' });
    expect((await launch(team.hooks.beforeTeamLeaderLaunch)).instructions).toEqual([]);

    await writeProfile({ user: 'The user ships things.' });
    const draft = await launch(team.hooks.beforeTeamLeaderLaunch);
    expect(draft.instructions).toHaveLength(1);
    expect(draft.instructions[0]).toContain('The user ships things.');
    expect(team.hooks.created.taps).toEqual([]);
  });

  it('taps nothing for a Dispatcher without a cwd', () => {
    const dispatcher = fakeDispatcher(null);
    announce(dispatcher);

    expect(dispatcher.hooks.beforeLaunch.taps).toEqual([]);
    expect(dispatcher.hooks.team.taps).toEqual([]);
  });
});
