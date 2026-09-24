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
import { BOOTSTRAP_GUIDE, renderProfile } from '../src/guide.js';

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

function fakeDispatcher(dispatcherCwd: string): Dispatcher {
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

  it('writes the guide and gives it to the Dispatcher while the other profile file is missing', async () => {
    await writeProfile({ user: 'The user ships things.' });
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);

    const draft = await launch(dispatcher.hooks.beforeLaunch);

    expect(draft.instructions).toEqual([BOOTSTRAP_GUIDE]);
    expect(await readFile(join(cwd, '.workspace', 'bootstrap.md'), 'utf8')).toBe(BOOTSTRAP_GUIDE);
  });

  it('creates .workspace when nothing created it yet', async () => {
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);

    const draft = await launch(dispatcher.hooks.beforeLaunch);

    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(true);
    expect(draft.instructions).toEqual([BOOTSTRAP_GUIDE]);
    expect(await readFile(join(cwd, '.workspace', 'bootstrap.md'), 'utf8')).toBe(BOOTSTRAP_GUIDE);
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

  it('injects both files without ever writing bootstrap.md when both existed from the start', async () => {
    // The operator hand-writes both profile files before the Dispatcher's
    // first-ever launch: bootstrap.md was never created, so the rm(force)
    // no-op path (not the "remove an existing guide" path) is what runs.
    await writeProfile({ identity: 'I am the assistant.', user: 'The user ships things.' });
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);

    const draft = await launch(dispatcher.hooks.beforeLaunch);

    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(false);
    expect(draft.instructions).toEqual([renderProfile(join(cwd, '.workspace'), {
      identity: 'I am the assistant.',
      user: 'The user ships things.',
    })]);
  });

  it('rejects the Dispatcher beforeLaunch hook when a profile file read fails for a reason other than ENOENT', async () => {
    // Replace identity.md with a directory of that name so readFile fails
    // with EISDIR, not ENOENT: the non-ENOENT branch that propagates.
    await mkdir(join(cwd, '.workspace', 'identity.md'), { recursive: true });
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);
    const draft: LaunchDraft = { instructions: [], skillSources: [] };

    await expect(dispatcher.hooks.beforeLaunch.promise(draft)).rejects.toThrow();

    // The throw happens inside readProfile, before either write branch runs.
    expect(draft.instructions).toEqual([]);
    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(false);
  });

  it('rejects the TeamLeader beforeTeamLeaderLaunch hook when a profile file read fails for a reason other than ENOENT', async () => {
    await mkdir(join(cwd, '.workspace', 'identity.md'), { recursive: true });
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);
    const team = fakeTeam();
    dispatcher.hooks.team.call(team, { origin: 'create' });
    const draft: LaunchDraft = { instructions: [], skillSources: [] };

    await expect(team.hooks.beforeTeamLeaderLaunch.promise(draft)).rejects.toThrow();

    expect(draft.instructions).toEqual([]);
  });

  it('gives a TeamLeader the profile only when both files exist, and never the guide', async () => {
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);
    const team = fakeTeam();
    dispatcher.hooks.team.call(team, { origin: 'create' });

    await writeProfile({ identity: 'I am the assistant.' });
    expect((await launch(team.hooks.beforeTeamLeaderLaunch)).instructions).toEqual([]);
    // An incomplete profile touches no filesystem: the TeamLeader branch has
    // no `else`, unlike the Dispatcher branch which writes the guide.
    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(false);

    await writeProfile({ user: 'The user ships things.' });
    const draft = await launch(team.hooks.beforeTeamLeaderLaunch);
    expect(draft.instructions).toHaveLength(1);
    expect(draft.instructions[0]).toContain('The user ships things.');
    expect(team.hooks.created.taps).toEqual([]);
  });

  it('re-reads the profile files fresh on every beforeLaunch call, with no in-memory caching', async () => {
    const dispatcher = fakeDispatcher(cwd);
    announce(dispatcher);

    const first = await launch(dispatcher.hooks.beforeLaunch);
    expect(first.instructions).toEqual([BOOTSTRAP_GUIDE]);
    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(true);

    await writeProfile({ identity: 'I am the assistant.', user: 'The user ships things.' });
    const second = await launch(dispatcher.hooks.beforeLaunch);

    expect(second.instructions).toEqual([renderProfile(join(cwd, '.workspace'), {
      identity: 'I am the assistant.',
      user: 'The user ships things.',
    })]);
    expect(await exists(join(cwd, '.workspace', 'bootstrap.md'))).toBe(false);
  });

  it('returns a plugin object with only a name and a server hook: no contribute, config, or api', () => {
    const plugin = createBootstrapPlugin();

    expect(plugin.name).toBe('bootstrap');
    expect(plugin.contribute).toBeUndefined();
    expect(plugin.config).toBeUndefined();
    expect(plugin.api).toBeUndefined();
    expect(typeof plugin.server).toBe('function');
  });
});

describe('renderProfile', () => {
  it('renders the exact pinned shape, trimming each field', () => {
    const dir = join('some', 'dir');

    const rendered = renderProfile(dir, {
      identity: ' padded \n',
      user: '\nother\n ',
    });

    expect(rendered).toBe([
      '# Profile',
      '',
      `These files come from ${dir}. \`identity.md\` describes who you are; \`user.md\` describes the user you work for.`,
      '',
      '## identity.md',
      '',
      'padded',
      '',
      '## user.md',
      '',
      'other',
    ].join('\n'));
  });
});
