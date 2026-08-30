import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentEntityCollectionStore } from '../src/service/agent-entity/identity-store.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import { closeMembersForDissolve } from '../src/service/teammate-collection/dissolve-members.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { makeTempDir, silentLog } from './helpers/dissolve-harness.js';

/**
 * COVERAGE CELL D (team-dissolve), the member half: `closeMembersForDissolve`
 * is the whole of "close every member of a dissolving Team" — a Team's own
 * cached, live members go through their own `TeammateService.close()`; every
 * other (cold, record-only) member is normalized straight to `closed` in its
 * own identity file, because this process never materialized it and there is
 * nothing running anywhere to stop. Already-closed identities are left alone.
 *
 * The function has no dispatcher-facing counterpart: `TeammateOps` (the
 * surface a Dispatcher gets) has no bulk-dissolve verb, and the concrete
 * `TeammateCollection` refuses the bulk operations outright when it is not
 * scoped to a Team.
 */

const DISPATCHER = 'dispatcher-1';
const TEAM = 'alpha';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function newStore(): Promise<AgentEntityCollectionStore> {
  const root = await makeTempDir('dreamux-dissolve-members-');
  roots.push(root);
  return new AgentEntityCollectionStore({
    root,
    dispatcherId: DISPATCHER,
    log: silentLog,
  } as unknown as ConstructorParameters<typeof AgentEntityCollectionStore>[0]);
}

async function seedIdentity(
  store: AgentEntityCollectionStore,
  name: string,
  overrides: { status?: AgentEntityIdentity['status'] } = {},
): Promise<AgentEntityIdentity> {
  const created = await store.entity(name).create({
    name,
    teamId: TEAM,
    agentRuntime: 'fake-runtime',
    sourceCwd: '/repo',
    sourceRepo: null,
    cwd: '/repo',
    runtimeCwd: '/repo',
    worktree: reuseCwdWorktree('/repo'),
    intent: null,
    identityPrompt: null,
    status: overrides.status ?? 'running',
  });
  if (overrides.status === 'closed') {
    // `create` does not accept a closed status directly in every build of the
    // identity layer's create-time validation; go through `update` for the
    // already-closed fixture so the store's own write path stamps it.
    return store.entity(name).update(created, {
      status: 'closed',
      closedAt: Date.now() - 60_000,
      closeNote: 'closed before this dissolve',
    });
  }
  return created;
}

function fakeHeldMember(
  name: string,
  close: (input: { note: string }) => Promise<void> = async () => {},
): TeammateService {
  return {
    name,
    close: vi.fn(close),
  } as unknown as TeammateService;
}

describe('closeMembersForDissolve: live members close through their own entity', () => {
  it('closes every held member via its own TeammateService.close, not the record path', async () => {
    const store = await newStore();
    await seedIdentity(store, 'held-1');
    const held = fakeHeldMember('held-1');
    const rosterIdentity = await store.entity('held-1').read() as AgentEntityIdentity;
    const entitySpy = vi.spyOn(store, 'entity');

    await closeMembersForDissolve({
      teamId: TEAM,
      note: 'dissolve',
      held: [held],
      roster: [rosterIdentity],
      store,
    });

    expect(held.close).toHaveBeenCalledWith({ note: 'dissolve' });
    // The record pass never reaches a held member — its own entity already
    // owns closing it, through its own runtime stop and turn settlement.
    expect(entitySpy.mock.calls.map((call) => call[0])).not.toContain('held-1');
  });
});

describe('closeMembersForDissolve: cold (record-only) members are normalized directly', () => {
  it('writes every other open roster identity straight to closed, with no Service constructed for it', async () => {
    const store = await newStore();
    await seedIdentity(store, 'cold-1');
    await seedIdentity(store, 'cold-2', { status: 'degraded' });

    await closeMembersForDissolve({
      teamId: TEAM,
      note: 'team dissolved',
      held: [],
      roster: [
        await store.entity('cold-1').read() as AgentEntityIdentity,
        await store.entity('cold-2').read() as AgentEntityIdentity,
      ],
      store,
    });

    const cold1 = await store.entity('cold-1').read();
    const cold2 = await store.entity('cold-2').read();
    expect(cold1?.status).toBe('closed');
    expect(cold1?.close_note).toBe('team dissolved');
    expect(cold1?.closed_at).not.toBeNull();
    expect(cold2?.status).toBe('closed');
    expect(cold2?.close_note).toBe('team dissolved');
    // One dissolve, one moment: every cold record it normalizes shares the
    // exact same closed timestamp, because the closing note is stamped once
    // for the whole pass rather than re-read per identity.
    expect(cold2?.closed_at).toBe(cold1?.closed_at);
  });

  it('leaves an already-closed identity completely untouched', async () => {
    const store = await newStore();
    const before = await seedIdentity(store, 'already-closed', { status: 'closed' });
    const entitySpy = vi.spyOn(store, 'entity');

    await closeMembersForDissolve({
      teamId: TEAM,
      note: 'team dissolved',
      held: [],
      roster: [before],
      store,
    });

    const after = await readFile(join(store.root, 'already-closed', 'identity.json'), 'utf8').catch(
      () => null,
    );
    // Not written at all: the skip happens before any store call for this
    // identity, so its exact `updated_at` / `close_note` from before this
    // dissolve survive unchanged.
    expect(entitySpy.mock.calls.map((call) => call[0])).not.toContain('already-closed');
    expect(after).not.toBeNull();
    const parsed = JSON.parse(after as string) as AgentEntityIdentity;
    expect(parsed.close_note).toBe('closed before this dissolve');
  });

  it('excludes a held member from the record pass by identity, even when its own close fails', async () => {
    const store = await newStore();
    await seedIdentity(store, 'held-fails');
    await seedIdentity(store, 'cold-3');
    const failing = fakeHeldMember('held-fails', async () => {
      throw new Error('runtime stop failed');
    });

    await expect(
      closeMembersForDissolve({
        teamId: TEAM,
        note: 'team dissolved',
        held: [failing],
        roster: [
          await store.entity('held-fails').read() as AgentEntityIdentity,
          await store.entity('cold-3').read() as AgentEntityIdentity,
        ],
        store,
      }),
    ).rejects.toThrow('runtime stop failed');

    // The failure surfaces as itself: a held member that failed to close is
    // never declared "closed" over a runtime that might still be live.
    const held = await store.entity('held-fails').read();
    expect(held?.status).toBe('running');
    // A held member's own failure does not block the record pass for members
    // this process never materialized.
    const cold = await store.entity('cold-3').read();
    expect(cold?.status).toBe('closed');
  });
});

describe('bulk member dissolve has no Dispatcher-facing lifecycle surface', () => {
  it('a dispatcher-scoped TeammateCollection (teamScope: null) refuses the bulk close/stop capability outright', async () => {
    const collection = new TeammateCollection({
      dispatcherId: DISPATCHER,
      teamScope: null,
      config: { agents: {} } as never,
      agentRuntimeProviders: {} as never,
      worktrees: {} as never,
      store: {} as never,
      names: {} as never,
      admissions: {} as never,
      log: silentLog as never,
    });

    // Dissolve is not a dispatcher verb: the bulk capability only exists for
    // a Team's own scoped collection, which `TeamClosing` holds directly
    // rather than reaching it through `TeammateOps`.
    await expect(collection.closeAllForDissolve('note')).rejects.toThrow(
      'bulk member dissolve is a Team capability',
    );
    await expect(collection.stopAllForDissolve()).rejects.toThrow(
      'bulk member dissolve is a Team capability',
    );
  });

  it('the TeammateOps surface a Dispatcher receives declares no bulk-dissolve verb', async () => {
    const text = await readFile(
      new URL('../src/service/teammate-collection/types.ts', import.meta.url),
      'utf8',
    );
    const interfaceStart = text.indexOf('export interface TeammateOps');
    expect(interfaceStart).toBeGreaterThan(-1);
    const interfaceEnd = text.indexOf('\n}', interfaceStart);
    const body = text.slice(interfaceStart, interfaceEnd);
    expect(body).not.toMatch(/closeAllForDissolve|stopAllForDissolve/);
  });
});
