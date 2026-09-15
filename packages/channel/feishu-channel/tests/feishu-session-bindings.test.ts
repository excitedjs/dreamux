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
 * A direct-message target is refused by the binding operation before Core is
 * queried or a row can be written.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonValue, TeamSummary } from '@excitedjs/dreamux-types';

import { teamSummary } from './helpers/team-status.js';

import { FeishuRouting } from '../src/routing/index.js';
import { FeishuRoutingStore } from '../src/routing/store.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
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

/** The invoke port carries JSON; a Core `TeamSummary` crosses it as plain data. */
const asPortResult = (summary: TeamSummary): JsonValue =>
  JSON.parse(JSON.stringify(summary)) as JsonValue;

async function harness(readStatus?: (teamName: string) => Promise<TeamSummary>): Promise<Harness> {
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
    if (readStatus !== undefined) return asPortResult(await readStatus(teamName));
    const status = statuses.get(teamName) ?? 'missing';
    if (status === 'missing') {
      const err = new Error(`Team ${JSON.stringify(teamName)} does not exist`) as Error & { code: string };
      err.code = 'TEAM_NOT_FOUND';
      throw err;
    }
    return asPortResult(teamSummary(teamName, status));
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
  it('refuses direct messages before querying Core or writing any binding row', async () => {
    const h = await harness();
    await expect(h.ops.bindChannel({
      target: chatTarget('oc_dm', 'p2p'), teamName: 'team-a', display: null,
    })).rejects.toThrow('A Feishu direct message chat cannot be bound to a Team.');
    expect(h.routing.listBindings()).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.cotCalls).toEqual([]);
  });

  it('announces the displaced Team on a rebind, but not on first or same-Team binds', async () => {
    const h = await harness();
    h.setStatus('team-a', 'running');
    h.setStatus('team-b', 'running');
    const target = chatTarget('oc_rebind', 'group');
    await h.ops.bindChannel({ target, teamName: 'team-a', display: null });
    expect(JSON.stringify(h.notifications[0]!.card)).not.toContain('Previous Team');
    const result = await h.ops.bindChannel({ target, teamName: 'team-b', display: null });
    expect(result).toEqual({ team_name: 'team-b', previous_team_name: 'team-a' });
    expect(h.routing.bindingFor(target)?.team_name).toBe('team-b');
    expect(h.notifications[1]).toMatchObject({ target, anchorTeamName: 'team-b' });
    expect(JSON.stringify(h.notifications[1]!.card)).toContain('Previous Team: team-a');
    await h.ops.bindChannel({ target, teamName: 'team-b', display: null });
    expect(JSON.stringify(h.notifications[2]!.card)).not.toContain('Previous Team');
    expect(h.cotCalls).toEqual([
      { op: 'claimed', teamName: 'team-a' },
      { op: 'released', teamName: 'team-a' },
      { op: 'claimed', teamName: 'team-b' },
      { op: 'claimed', teamName: 'team-b' },
    ]);
  });

  it('announces in a separately bound topic without giving its card to the new Team as an anchor', async () => {
    const h = await harness();
    h.setStatus('team-a', 'running');
    h.setStatus('team-b', 'running');
    const target = chatTarget('oc_group', 'group');
    const topic = topicTarget('oc_group', 'omt_a');
    await h.ops.bindChannel({ target: topic, teamName: 'team-a', display: null });
    await h.ops.bindChannel({ target, teamName: 'team-b', display: null, announceIn: topic });
    expect(h.routing.plan(topic, null)).toMatchObject({ kind: 'bound', teamName: 'team-a' });
    expect(h.routing.plan(target, null)).toMatchObject({ kind: 'bound', teamName: 'team-b' });
    expect(h.notifications[1]).toMatchObject({ target: topic, anchorTeamName: null });
    expect(JSON.stringify(h.notifications[1]!.card)).toContain('Dreamux group bound');
    expect(h.cotCalls).toEqual([
      { op: 'claimed', teamName: 'team-a' },
      { op: 'claimed', teamName: 'team-b' },
    ]);
  });

  it('asks Core team.status before persisting the binding and before rendering the card', async () => {
    const h = await harness();
    h.setStatus('team-open', 'running');
    const target = chatTarget('oc_group', 'group');

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
    let resolveStatus!: (answer: TeamSummary) => void;
    const h = await harness(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const bind = vi.spyOn(h.routing, 'bind');
    const pending = h.ops.bindChannel({ target: chatTarget('chat-a', 'group'), teamName: 'team-a', display: null });
    expect(bind).not.toHaveBeenCalled();
    expect(h.notifications).toEqual([]);
    resolveStatus(teamSummary('team-a'));
    await pending;
    expect(bind).toHaveBeenCalledOnce();
    const card = JSON.stringify(h.notifications[0]!.card);
    expect(card).toContain('team-a-leader');
    expect(card).toContain('trae-gpt');
    expect(card).toContain('/workspace/team-a');
    expect(h.calls).toEqual(['team.status', 'notify']);
  });

  it('refuses a Team whose stored leader view is missing before binding or announcing', async () => {
    const h = await harness(async () => ({
      ...teamSummary('team-a'),
      leader_state: null,
    }));
    await expect(h.ops.bindChannel({ target: chatTarget('chat-a', 'group'), teamName: 'team-a', display: null }))
      .rejects.toThrow('no readable TeamLeader identity');
    expect(h.routing.bindingFor(chatTarget('chat-a', 'group'))).toBeUndefined();
    expect(h.notifications).toEqual([]);
    expect(h.cotCalls).toEqual([]);
  });

  it('a bind to a nonexistent Team never becomes durable and never renders a card', async () => {
    const h = await harness();
    const target = chatTarget('oc_ghost', 'group');

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
    const target = chatTarget('oc_closed', 'group');

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
    const target = chatTarget('oc_group', 'group');
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
    const result = await h.ops.unbindChannel(chatTarget('oc_never', 'group'));
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
