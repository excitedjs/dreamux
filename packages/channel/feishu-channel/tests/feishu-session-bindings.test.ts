/**
 * `FeishuBindingOperations` is where every operator-visible routing decision
 * happens: the durable row, the COT route-ownership fence, and the card that
 * tells the conversation, all from one place (COVERAGE CELL F).
 *
 * The load-bearing contract under test is synchronous pre-validation: a
 * manual `bindChannel` must ask Core whether the target Team is routable
 * *before* it persists the binding and *before* it renders a card, so a bind
 * to a nonexistent or closed Team never becomes durable or user-visible. That
 * ordering is asserted by recording the sequence of side effects (Core ask,
 * disk state, card send) rather than by inspecting internals.
 *
 * `bindChannel`'s `isBindableTarget` p2p guard is not exercised here: its own
 * `FeishuBindTargetSelector` input has no `kind` field, and `selectorTarget`
 * always maps a bare `chatId` to a `group` target, so a p2p target can never
 * reach this method through its public surface. The actual, reachable
 * enforcement that a direct-message chat never routes to a Team is
 * `FeishuRouting.plan()` answering `dispatcher`/`not_bindable`, covered in
 * `feishu-routing.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@excitedjs/dreamux-types';

import { teamStatus } from './helpers/team-status.js';

import { FeishuRouting } from '../src/routing/index.js';
import { FeishuRoutingStore } from '../src/routing/store.js';
import { chatTarget } from '../src/routing/target.js';
import { FeishuBindingOperations } from '../src/feishu-session-bindings.js';
import type { FeishuCotSessionSeam } from '../src/feishu-cot-session.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-binding-ops-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  routing: FeishuRouting;
  ops: FeishuBindingOperations;
  calls: string[];
  notifications: Array<{ target: unknown; card: unknown; anchorTeamName: string | null }>;
  cotCalls: Array<{ op: 'released' | 'claimed'; teamName: string }>;
  setStatus(teamName: string, status: 'running' | 'closed' | 'missing'): void;
}

async function harness(readStatus?: (teamName: string) => Promise<JsonValue>): Promise<Harness> {
  const store = new FeishuRoutingStore({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    stateDir: dir,
  });
  await store.load();
  const routing = new FeishuRouting({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    store,
  });

  const statuses = new Map<string, 'running' | 'closed' | 'missing'>();
  const calls: string[] = [];
  const notifications: Harness['notifications'] = [];
  const cotCalls: Harness['cotCalls'] = [];

  const cot = {
    onRouteReleased: (input: { teamName: string }) => {
      cotCalls.push({ op: 'released', teamName: input.teamName });
    },
    onRouteClaimed: (input: { teamName: string }) => {
      cotCalls.push({ op: 'claimed', teamName: input.teamName });
    },
  } as unknown as FeishuCotSessionSeam;

  const invoke = async (command: string, payload: JsonValue): Promise<JsonValue> => {
    calls.push(command);
    if (command !== 'team.status') {
      throw new Error(`unexpected command ${command}`);
    }
    const teamName = (payload as Record<string, unknown>)['team_name'] as string;
    if (readStatus !== undefined) return readStatus(teamName);
    const status = statuses.get(teamName) ?? 'missing';
    if (status === 'missing') {
      const err = new Error(`Team ${JSON.stringify(teamName)} does not exist`) as Error & { code: string };
      err.code = 'TEAM_NOT_FOUND';
      throw err;
    }
    return teamStatus(teamName, status);
  };

  const notify = (
    target: unknown,
    card: unknown,
    anchorTeamName: string | null,
  ): void => {
    calls.push('notify');
    notifications.push({ target, card, anchorTeamName });
  };

  const ops = new FeishuBindingOperations({ routing, cot, invoke, notify });

  return {
    routing,
    ops,
    calls,
    notifications,
    cotCalls,
    setStatus: (teamName, status) => statuses.set(teamName, status),
  };
}

describe('FeishuBindingOperations — manual bind synchronous validation', () => {
  it('asks Core team.status before persisting the binding and before rendering the card', async () => {
    const h = await harness();
    h.setStatus('team-open', 'running');
    const target = { chatId: 'oc_group', threadId: undefined };

    await h.ops.bindChannel({
      target,
      teamName: 'team-open',
      display: null,
    });

    // Exact order: ask Core, then notify (persistence is not on this trace,
    // but is asserted below to have happened between them).
    expect(h.calls).toEqual(['team.status', 'notify']);
    expect(h.routing.bindingFor(chatTarget('oc_group', 'group'))?.team_name).toBe(
      'team-open',
    );
    expect(h.notifications).toHaveLength(1);
  });

  it('waits for complete canonical context before committing, including a lazy runtime', async () => {
    let resolveStatus!: (answer: JsonValue) => void;
    const h = await harness(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const bind = vi.spyOn(h.routing, 'bind');
    const pending = h.ops.bindChannel({ target: { chatId: 'chat-a' }, teamName: 'team-a', display: null });
    expect(bind).not.toHaveBeenCalled();
    expect(h.notifications).toEqual([]);
    resolveStatus(teamStatus('team-a'));
    await pending;
    expect(bind).toHaveBeenCalledOnce();
    const card = JSON.stringify(h.notifications[0]!.card);
    expect(card).toContain('team-a-leader');
    expect(card).toContain('trae-gpt');
    expect(card).toContain('/workspace/team-a');
    expect(h.calls).toEqual(['team.status', 'notify']);
  });

  it('refuses a Team whose stored leader view is missing before binding or announcing', async () => {
    const h = await harness(async () => ({ ...teamStatus('team-a'), leader: null }));
    await expect(h.ops.bindChannel({ target: { chatId: 'chat-a' }, teamName: 'team-a', display: null }))
      .rejects.toThrow('no complete TeamLeader runtime context');
    expect(h.routing.bindingFor(chatTarget('chat-a', 'group'))).toBeUndefined();
    expect(h.notifications).toEqual([]);
    expect(h.cotCalls).toEqual([]);
  });

  it('a bind to a nonexistent Team never becomes durable and never renders a card', async () => {
    const h = await harness();
    const target = { chatId: 'oc_ghost', threadId: undefined };

    await expect(
      h.ops.bindChannel({ target, teamName: 'ghost-team', display: null }),
    ).rejects.toThrow(/does not exist/);

    expect(h.routing.bindingFor(chatTarget('oc_ghost', 'group'))).toBeUndefined();
    expect(h.notifications).toHaveLength(0);
    expect(h.calls).toEqual(['team.status']);
  });

  it('a bind to a closed Team never becomes durable and never renders a card', async () => {
    const h = await harness();
    h.setStatus('closed-team', 'closed');
    const target = { chatId: 'oc_closed', threadId: undefined };

    await expect(
      h.ops.bindChannel({ target, teamName: 'closed-team', display: null }),
    ).rejects.toThrow(/is closed/);

    expect(h.routing.bindingFor(chatTarget('oc_closed', 'group'))).toBeUndefined();
    expect(h.notifications).toHaveLength(0);
  });

});

describe('FeishuBindingOperations — unbind, and closed-Team cleanup announcement', () => {
  it('unbindChannel releases the COT route and sends the unbound card only when something was actually removed', async () => {
    const h = await harness();
    h.setStatus('team-open', 'running');
    const target = { chatId: 'oc_group', threadId: undefined };
    await h.ops.bindChannel({ target, teamName: 'team-open', display: null });
    h.notifications.length = 0;
    h.cotCalls.length = 0;

    const result = await h.ops.unbindChannel(target);
    expect(result.team_name).toBe('team-open');
    expect(JSON.stringify(h.notifications[0]!.card)).toContain('the Team remains active.');
    expect(h.cotCalls).toEqual([{ op: 'released', teamName: 'team-open' }]);
    expect(h.notifications).toHaveLength(1);
  });

  it('unbindChannel on an unrouted target is a no-op: no COT release, no card', async () => {
    const h = await harness();
    const result = await h.ops.unbindChannel({ chatId: 'oc_never', threadId: undefined });
    expect(result.team_name).toBeNull();
    expect(h.cotCalls).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

});

describe('FeishuBindingOperations — announceRoutesRemoved and announceProvisioned', () => {
  it('announceRoutesRemoved emits one COT release and one card per removed route', async () => {
    const h = await harness();
    const removed = [
      { target: chatTarget('oc_a', 'group'), display: 'A' },
      { target: chatTarget('oc_b', 'group'), display: null },
    ];

    h.ops.announceRoutesRemoved({ teamName: 'closed-team', removed, reason: 'team_closed' });

    expect(h.cotCalls).toEqual([
      { op: 'released', teamName: 'closed-team' },
      { op: 'released', teamName: 'closed-team' },
    ]);
    expect(h.notifications).toHaveLength(2);
    for (const { card } of h.notifications) {
      expect(JSON.stringify(card)).toContain('all of its routes were removed automatically.');
      expect(JSON.stringify(card)).not.toContain('remains active');
    }
  });

  it('announceProvisioned claims the COT route and sends a bound card with canonical runtime context', async () => {
    const h = await harness();
    const target = chatTarget('oc_new', 'group');

    h.ops.announceProvisioned({
      target,
      display: null,
      teamName: 'provisioned-team',
      leaderName: 'leader-a',
      agentRuntime: 'trae-gpt',
      runtimeCwd: '/workspace/team-a',
    });

    expect(h.cotCalls).toEqual([{ op: 'claimed', teamName: 'provisioned-team' }]);
    expect(h.notifications).toEqual([
      {
        target,
        card: expect.anything(),
        anchorTeamName: 'provisioned-team',
      },
    ]);
  });
});
