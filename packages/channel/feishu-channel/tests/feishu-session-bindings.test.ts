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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JsonValue } from '@excitedjs/dreamux-types';

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

async function harness(): Promise<Harness> {
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
    const status = statuses.get(teamName) ?? 'missing';
    if (status === 'missing') {
      const err = new Error(`no such team ${teamName}`) as Error & { code: string };
      err.code = 'TEAM_NOT_FOUND';
      throw err;
    }
    return { team: { status } } as unknown as JsonValue;
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

  it('a bind to a nonexistent Team never becomes durable and never renders a card', async () => {
    const h = await harness();
    const target = { chatId: 'oc_ghost', threadId: undefined };

    await expect(
      h.ops.bindChannel({ target, teamName: 'ghost-team', display: null }),
    ).rejects.toThrow(/no Team named/);

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

describe('FeishuBindingOperations — announceTeamClosed and announceProvisioned', () => {
  it('announceTeamClosed emits one COT release and one card per removed route', async () => {
    const h = await harness();
    const removed = [
      { target: chatTarget('oc_a', 'group'), display: 'A' },
      { target: chatTarget('oc_b', 'group'), display: null },
    ];

    h.ops.announceTeamClosed({ teamName: 'closed-team', removed });

    expect(h.cotCalls).toEqual([
      { op: 'released', teamName: 'closed-team' },
      { op: 'released', teamName: 'closed-team' },
    ]);
    expect(h.notifications).toHaveLength(2);
  });

  it('announceProvisioned claims the COT route and sends a bound card naming the space', async () => {
    const h = await harness();
    const target = chatTarget('oc_new', 'group');

    h.ops.announceProvisioned({
      target,
      display: null,
      teamName: 'provisioned-team',
      spaceName: 'space-a',
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
