/**
 * The built-in bootstrap plugin (`builtin:bootstrap`, opt-in through
 * `plugins[]`).
 *
 * The Dispatcher cwd's `.workspace/` holds two user-owned profile files,
 * `identity.md` and `user.md`. While either is missing, the Dispatcher Agent
 * gets a guide (also written to `.workspace/bootstrap.md`) to create them with
 * the user; once both exist, the Dispatcher and every TeamLeader get them
 * rendered into their launch prompt and the guide file is removed. TeamMates
 * get nothing: no TeamMate launch hook exists.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DreamuxPlugin } from '@excitedjs/dreamux-types';

import { BOOTSTRAP_GUIDE, renderProfile } from './guide.js';

interface Profile {
  identity: string | null;
  user: string | null;
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    // A missing file is the normal "not created yet" branch; any other error
    // propagates and core skips this tap's changes.
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
}

async function readProfile(dir: string): Promise<Profile> {
  return {
    identity: await readOptional(join(dir, 'identity.md')),
    user: await readOptional(join(dir, 'user.md')),
  };
}

function complete(p: Profile): p is { identity: string; user: string } {
  return p.identity !== null && p.user !== null;
}

export default function createBootstrapPlugin(): DreamuxPlugin {
  return {
    name: 'bootstrap',
    server(host) {
      host.hooks.dispatcher.tap('bootstrap', (dispatcher) => {
        const dir = join(dispatcher.cwd, '.workspace');

        dispatcher.hooks.beforeLaunch.tapPromise('bootstrap', async (draft) => {
          const profile = await readProfile(dir);
          if (complete(profile)) {
            await rm(join(dir, 'bootstrap.md'), { force: true });
            draft.instructions.push(renderProfile(dir, profile));
            return;
          }
          // `.workspace/` does not exist until something first creates it
          // (core creates it with the first managed worktree).
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'bootstrap.md'), BOOTSTRAP_GUIDE);
          // Only the Dispatcher sees the guide; TeamLeaders get nothing until
          // both files exist.
          draft.instructions.push(BOOTSTRAP_GUIDE);
        });

        dispatcher.hooks.team.tap('bootstrap', (team) => {
          team.hooks.beforeTeamLeaderLaunch.tapPromise('bootstrap', async (draft) => {
            const profile = await readProfile(dir);
            if (complete(profile)) draft.instructions.push(renderProfile(dir, profile));
          });
        });
      });
    },
  };
}
