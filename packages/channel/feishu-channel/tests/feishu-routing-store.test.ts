/**
 * `FeishuRoutingStore` is Feishu's single durable-fact commit authority
 * (TeamLeader failure ledger item 19, `.agents/tasks/architecture/
 * minimize-provider-boundaries/README.md`). A rejected write must never
 * mutate the live in-memory document, and a change becomes readable only
 * after its own atomic write lands on disk — never through an unrelated
 * later write.
 *
 * These tests drive the store directly rather than through `FeishuRouting`,
 * because the commit-authority contract is a property of the store's
 * `update()` method itself: prepare against the last *committed* document,
 * serialize concurrent preparations, and publish only after persistence
 * succeeds.
 */
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FeishuRoutingStore, routingDocumentFilename } from '../src/routing/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newStore(channelId = 'chan-store'): FeishuRoutingStore {
  return new FeishuRoutingStore({
    dispatcherId: 'disp-1',
    channelId,
    stateDir: dir,
  });
}

describe('FeishuRoutingStore — commit authority', () => {
  it('a failed write leaves the prior committed in-memory value unchanged, and does not reach disk', async () => {
    const store = newStore();
    await store.load();

    // Commit A successfully.
    await store.update((doc) => {
      doc.bindings.push({
        target: { kind: 'group', chat_id: 'oc_a' },
        display: null,
        team_name: 'team-a',
        origin: 'manual',
        space_id: null,
        created_at: 1,
        updated_at: 1,
      });
      return true;
    });
    expect(store.current.bindings).toHaveLength(1);

    // Break the state directory so the *next* write cannot persist: replace
    // it with a regular file. `ensureOwnerOnlyDir`'s recursive mkdir throws
    // deterministically (EEXIST) on a non-directory path, with no reliance on
    // filesystem permissions/uid.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');

    await expect(
      store.update((doc) => {
        doc.bindings.push({
          target: { kind: 'group', chat_id: 'oc_b' },
          display: null,
          team_name: 'team-b',
          origin: 'manual',
          space_id: null,
          created_at: 2,
          updated_at: 2,
        });
        return true;
      }),
    ).rejects.toThrow();

    // The rejected write never became the live value: still just A.
    expect(store.current.bindings.map((b) => b.team_name)).toEqual(['team-a']);

    // Repair the directory and commit C. It must be prepared against the
    // last *committed* document (A), not against the failed B.
    unlinkSync(dir);
    await store.update((doc) => {
      doc.bindings.push({
        target: { kind: 'group', chat_id: 'oc_c' },
        display: null,
        team_name: 'team-c',
        origin: 'manual',
        space_id: null,
        created_at: 3,
        updated_at: 3,
      });
      return true;
    });

    expect(store.current.bindings.map((b) => b.team_name).sort()).toEqual([
      'team-a',
      'team-c',
    ]);

    // The failed B write must never become durable through the later,
    // unrelated C commit: reload from a *fresh* store instance and prove
    // disk holds exactly A + C.
    const reloaded = newStore();
    await reloaded.load();
    expect(reloaded.current.bindings.map((b) => b.team_name).sort()).toEqual([
      'team-a',
      'team-c',
    ]);
  });

  it('serializes concurrent updates: the second mutator sees the first mutator\'s change as its base', async () => {
    const store = newStore('chan-concurrent');
    await store.load();

    // Two updates queued back-to-back without awaiting the first. If they
    // were prepared against the same stale base rather than serialized, one
    // of the two pushes would be lost.
    const first = store.update((doc) => {
      doc.bindings.push({
        target: { kind: 'group', chat_id: 'oc_1' },
        display: null,
        team_name: 'team-1',
        origin: 'manual',
        space_id: null,
        created_at: 1,
        updated_at: 1,
      });
      return true;
    });
    const second = store.update((doc) => {
      // At the moment this mutator runs, it must already see whatever the
      // first commit produced (this is the doc it is handed).
      expect(doc.bindings.some((b) => b.team_name === 'team-1')).toBe(true);
      doc.bindings.push({
        target: { kind: 'group', chat_id: 'oc_2' },
        display: null,
        team_name: 'team-2',
        origin: 'manual',
        space_id: null,
        created_at: 2,
        updated_at: 2,
      });
      return true;
    });

    await Promise.all([first, second]);
    expect(store.current.bindings.map((b) => b.team_name).sort()).toEqual([
      'team-1',
      'team-2',
    ]);
  });

  it('an idempotent mutator that reports no change writes nothing and does not bump updated_at', async () => {
    const store = newStore('chan-idempotent');
    await store.load();
    const before = store.current.updated_at;

    await store.update(() => false);

    expect(store.current.updated_at).toBe(before);
  });

  it('drain() resolves even after a commit failed, so session close never hangs on a broken write', async () => {
    const store = newStore('chan-drain');
    await store.load();
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');

    await expect(
      store.update((doc) => {
        doc.bindings.push({
          target: { kind: 'group', chat_id: 'oc_x' },
          display: null,
          team_name: 'team-x',
          origin: 'manual',
          space_id: null,
          created_at: 1,
          updated_at: 1,
        });
        return true;
      }),
    ).rejects.toThrow();

    await expect(store.drain()).resolves.toBeUndefined();
  });

  it('a document from an incompatible version fails loud on load rather than silently upgrading', async () => {
    const channelId = 'chan-incompatible';
    const filename = routingDocumentFilename(channelId);
    writeFileSync(
      join(dir, filename),
      JSON.stringify({
        version: 999,
        dispatcher_id: 'disp-1',
        channel_id: channelId,
        bindings: [],
        spaces: [],
        updated_at: 1,
      }),
    );
    const store = newStore(channelId);
    await expect(store.load()).rejects.toThrow(/unsupported version/);
  });

  it('routingDocumentFilename is stable for a given channel id and differs across channel ids', () => {
    const a1 = routingDocumentFilename('channel-a');
    const a2 = routingDocumentFilename('channel-a');
    const b = routingDocumentFilename('channel-b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('persists the committed document to the exact filename the store reads back', async () => {
    const channelId = 'chan-roundtrip';
    const store = newStore(channelId);
    await store.load();
    await store.update((doc) => {
      doc.bindings.push({
        target: { kind: 'group', chat_id: 'oc_r' },
        display: null,
        team_name: 'team-r',
        origin: 'manual',
        space_id: null,
        created_at: 1,
        updated_at: 1,
      });
      return true;
    });
    const filename = routingDocumentFilename(channelId);
    const onDisk = JSON.parse(readFileSync(join(dir, filename), 'utf8')) as {
      bindings: Array<{ team_name: string }>;
    };
    expect(onDisk.bindings.map((b) => b.team_name)).toEqual(['team-r']);
  });
});
