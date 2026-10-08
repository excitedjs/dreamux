import * as fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransactionalStore } from '@excitedjs/dreamux-utils';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { TeamStore } from '../src/service/team/store.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';

// Observe actual record reads without replacing filesystem behavior.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'team-lifetime-'));
  roots.push(root);
  const store = new TeamStore({ root, dispatcherId: 'test' });
  const path = join(root, 'team', 'record.json');
  const input = {
    dispatcher_id: 'test',
    team_id: 'team',
    name: 'Team',
    repo_cwd: root,
    source_repo: null,
    runtime_cwd: root,
    leader_name: 'leader',
    leader_agent_runtime: 'runtime',
    leader_identity_prompt: null,
    leader_skill_sources: [],
    worktree: reuseCwdWorktree(root),
    status: 'running' as const,
    intent: null,
    closed_at: null,
    close_note: null,
    create_request_id: null,
    create_payload_hash: null,
  };
  async function edit(name: string) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...record, name }));
  }
  return { root, store, path, input, edit };
}

describe('Team record lifetime', () => {
  it('lists valid Teams without reading inert or invalid inventory names and still rejects direct invalid lookups', async () => {
    const f = await fixture();
    const owner = await f.store.acquire('team');
    await owner.create({ ...f.input, status: 'closed' });
    await owner.release();
    const foreign = [
      'ledger',
      'LeDgEr',
      'dispatcher',
      '.tmp',
      'backup old',
      'x'.repeat(65),
    ];
    for (const name of [...foreign, 'malformed']) {
      await mkdir(join(f.root, name));
      await writeFile(join(f.root, name, 'record.json'), 'inert bytes');
    }
    await writeFile(join(f.root, 'foreign-file'), 'inert file');
    const before = (await readdir(f.root)).sort();
    const reads = vi.mocked(fs.readFile);
    reads.mockClear();
    expect((await f.store.list()).map((record) => record.team_id)).toEqual([
      'team',
    ]);
    const readPaths = reads.mock.calls.map(([path]) => String(path));
    expect(readPaths).toContain(f.path);
    expect(readPaths).toContain(join(f.root, 'malformed', 'record.json'));
    for (const name of foreign) {
      expect(readPaths).not.toContain(join(f.root, name, 'record.json'));
      await expect(f.store.get(name)).rejects.toThrow();
      await expect(f.store.acquire(name)).rejects.toThrow();
      expect(await readFile(join(f.root, name, 'record.json'), 'utf8')).toBe(
        'inert bytes',
      );
    }
    expect((await readdir(f.root)).sort()).toEqual(before);
    expect(await readFile(join(f.root, 'foreign-file'), 'utf8')).toBe(
      'inert file',
    );
  });

  it('treats a missing collection as empty but propagates an actual inventory IO failure', async () => {
    const f = await fixture();
    const path = join(f.root, 'inventory');
    const store = new TeamStore({ root: path, dispatcherId: 'test' });
    expect(await store.list()).toEqual([]);
    await writeFile(path, 'not a directory');
    await expect(store.list()).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await readFile(path, 'utf8')).toBe('not a directory');
  });

  it('cold history does not retain completed records and observes edits, deletion and damage', async () => {
    const f = await fixture();
    const owner = await f.store.acquire('team');
    await owner.create({ ...f.input, status: 'closed' });
    await owner.release();
    expect((await f.store.list())[0]?.name).toBe('Team');
    await f.edit('Edited');
    expect((await f.store.get('team'))?.name).toBe('Edited');
    await writeFile(f.path, '{damaged');
    expect(await f.store.list()).toEqual([]);
    await rm(f.path);
    expect(await f.store.get('team')).toBeNull();
  });

  it('retains active records across settled readers and host release', async () => {
    const f = await fixture();
    const owner = await f.store.acquire('team');
    await owner.create(f.input);
    await owner.release();
    await f.edit('Foreign edit');
    expect((await f.store.get('team'))?.name).toBe('Team');
    const reopened = await f.store.acquire('team');
    await reopened.update({ status: 'closed' });
    await reopened.release();
    await f.edit('Retired edit');
    expect((await f.store.get('team'))?.name).toBe('Retired edit');
  });

  it('concurrent acquisitions share publication and terminal closed merges', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      f.store.acquire('team'),
      f.store.acquire('team'),
    ]);
    expect(first.current).toBeNull();
    const publications = await Promise.all([
      first.create(f.input),
      second.create(f.input),
    ]);
    expect(publications.filter(Boolean)).toHaveLength(1);
    await Promise.all([
      first.update({ status: 'closed' }),
      second.update({ status: 'running', closeNote: 'late' }),
    ]);
    expect(first.current).toBe(second.current);
    expect(first.current).toMatchObject({
      status: 'closed',
      close_note: 'late',
    });
    await first.release();
    await f.edit('Still owned');
    expect((await f.store.get('team'))?.name).toBe('Team');
    await second.release();
    expect((await f.store.get('team'))?.name).toBe('Still owned');
  });

  it('detached cleanup retains the owner after its service closes', async () => {
    const f = await fixture();
    const service = await f.store.acquire('team');
    await service.create(f.input);
    const cleanup = service.retain();
    await service.update({ status: 'closed' });
    await service.release();
    await f.edit('Foreign edit during cleanup');
    expect((await f.store.get('team'))?.name).toBe('Team');
    await cleanup.release();
    expect((await f.store.get('team'))?.name).toBe(
      'Foreign edit during cleanup',
    );
  });

  it('unfinished cleanup survives a settled failed attempt until ordinary recovery finishes', async () => {
    const f = await fixture();
    const owner = await f.store.acquire('team');
    await owner.create({
      ...f.input,
      status: 'closed',
      worktree: { ...f.input.worktree, cleanup_state: 'cleanup-pending' },
    });
    await owner.release();
    await f.edit('Foreign edit');
    const recovery = await f.store.acquire('team');
    expect(recovery.current?.name).toBe('Team');
    await recovery.update({
      worktree: { ...f.input.worktree, cleanup_state: 'deleted' },
    });
    await recovery.release();
    await f.edit('Retired');
    expect((await f.store.get('team'))?.name).toBe('Retired');
  });

  it('release drains late queued writes and an acquisition during drain keeps authority', async () => {
    const f = await fixture();
    const owner = await f.store.acquire('team');
    await owner.create(f.input);
    await owner.update({ status: 'closed' });
    const closed = owner.current;
    const entered = deferred<void>();
    const unblock = deferred<void>();
    const update = TransactionalStore.prototype.update;
    vi.spyOn(TransactionalStore.prototype, 'update').mockImplementationOnce(
      function (this: TransactionalStore<unknown>, change, afterCommit) {
        return update.call(
          this,
          async (current) => {
            const next = await change(current);
            entered.resolve();
            await unblock.promise;
            return next;
          },
          afterCommit,
        );
      },
    );
    const late = owner.update({ status: 'running', closeNote: 'late write' });
    await entered.promise;
    expect(owner.current).toBe(closed);
    expect(JSON.parse(await readFile(f.path, 'utf8')).status).toBe('closed');
    let released = false;
    const releasing = owner.release().then(() => {
      released = true;
    });
    let reader: Awaited<ReturnType<TeamStore['acquire']>> | undefined;
    try {
      // No other holder exists yet: removing drain would retire this entry.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(released).toBe(false);
      reader = await f.store.acquire('team');
      expect(reader.current).toBe(closed);
      expect(reader.current).toBe(owner.current);
      expect(released).toBe(false);
    } finally {
      unblock.resolve();
      await Promise.all([late, releasing]);
    }
    expect(reader!.current).toBe(owner.current);
    expect(reader!.current).toMatchObject({
      status: 'closed',
      close_note: 'late write',
    });
    await f.edit('Foreign edit');
    expect((await f.store.get('team'))?.name).toBe('Team');
    await reader!.release();
    expect((await f.store.get('team'))?.name).toBe('Foreign edit');
  });

  it.each(['running', 'closed'] as const)(
    'reads the committed %s record without waiting for its retained owner write queue',
    async (status) => {
      const f = await fixture();
      const owner = await f.store.acquire('team');
      await owner.create({ ...f.input, status });
      const committed = owner.current;
      const entered = deferred<void>();
      const unblock = deferred<void>();
      const update = TransactionalStore.prototype.update;
      vi.spyOn(TransactionalStore.prototype, 'update').mockImplementationOnce(
        function (this: TransactionalStore<unknown>, change, afterCommit) {
          return update.call(
            this,
            async (current) => {
              const next = await change(current);
              entered.resolve();
              await unblock.promise;
              return next;
            },
            afterCommit,
          );
        },
      );
      const write = owner.update({ closeNote: 'queued after snapshot' });
      await entered.promise;
      const reads: unknown[] = [];
      const lookup = f.store.get('team').then((record) => {
        reads.push(record);
      });
      const listed = deferred<void>();
      const get = f.store.get.bind(f.store);
      vi.spyOn(f.store, 'get').mockImplementationOnce((teamId) => {
        const result = get(teamId);
        listed.resolve();
        return result;
      });
      const reading = Promise.all([
        lookup,
        f.store.list().then((records) => {
          reads.push(records[0]);
        }),
      ]);
      try {
        // The actual directory IO has finished and list has entered get.
        await listed.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(reads).toHaveLength(2);
        expect(reads.every((record) => record === committed)).toBe(true);
        expect(owner.current).toBe(committed);
        expect(
          JSON.parse(await readFile(f.path, 'utf8')).close_note,
        ).toBeNull();
      } finally {
        unblock.resolve();
        await Promise.all([write, reading]);
        await owner.release();
      }
      expect((await f.store.get('team'))?.close_note).toBe(
        'queued after snapshot',
      );
    },
  );

  it('keeps a later writer counted after an older release captured its drain tail', async () => {
    const f = await fixture();
    const first = await f.store.acquire('team');
    await first.create({ ...f.input, status: 'closed' });
    const firstEntered = deferred<void>();
    const firstUnblock = deferred<void>();
    const secondEntered = deferred<void>();
    const secondUnblock = deferred<void>();
    const update = TransactionalStore.prototype.update;
    const updates = vi.spyOn(TransactionalStore.prototype, 'update');
    for (const [entered, unblock] of [
      [firstEntered, firstUnblock],
      [secondEntered, secondUnblock],
    ] as const) {
      updates.mockImplementationOnce(function (
        this: TransactionalStore<unknown>,
        change,
        afterCommit,
      ) {
        return update.call(
          this,
          async (current) => {
            const next = await change(current);
            entered.resolve();
            await unblock.promise;
            return next;
          },
          afterCommit,
        );
      });
    }
    const firstWrite = first.update({ closeNote: 'older tail' });
    await firstEntered.promise;
    const firstRelease = first.release();
    const second = await f.store.acquire('team');
    const secondWrite = second.update({ closeNote: 'newer tail' });
    let secondReleased = false;
    const secondRelease = second.release().then(() => {
      secondReleased = true;
    });
    let observer: Awaited<ReturnType<TeamStore['acquire']>> | undefined;
    try {
      firstUnblock.resolve();
      await Promise.all([firstWrite, firstRelease, secondEntered.promise]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondReleased).toBe(false);
      await f.edit('Foreign edit while newer write is blocked');
      observer = await f.store.acquire('team');
      expect(observer.current).toBe(second.current);
      expect(observer.current).toMatchObject({
        name: 'Team',
        close_note: 'older tail',
      });
    } finally {
      firstUnblock.resolve();
      secondUnblock.resolve();
      await Promise.all([firstWrite, firstRelease, secondWrite, secondRelease]);
      await observer?.release();
    }
    expect((await f.store.get('team'))?.close_note).toBe('newer tail');
    await f.edit('Retired after both tails');
    expect((await f.store.get('team'))?.name).toBe('Retired after both tails');
  });

  it('invalid residue reserves no name and acquisition is initialized without a prior scan', async () => {
    const f = await fixture();
    const owner = await f.store.acquire('team');
    expect(owner.current).toBeNull();
    await owner.create(f.input);
    await owner.update({ status: 'closed' });
    await owner.release();
    await writeFile(f.path, JSON.stringify({ version: 0 }));
    const replacement = await f.store.acquire('team');
    expect(await replacement.create(f.input)).not.toBeNull();
    await replacement.release();
  });
});
