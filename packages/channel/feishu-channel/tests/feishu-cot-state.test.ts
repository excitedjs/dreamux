/**
 * The COT correlation ledger and its fences (COVERAGE CELL F).
 *
 * Everything here is session-local and pure: which visible message a Team's
 * card hangs under, which turn a card is allowed to show, what a closed Team or
 * a withdrawn binding forbids, and how a Dispatcher conversation is bounded.
 * None of it is durable, so the whole contract is what a later call observes.
 */
import { describe, expect, it } from 'vitest';

import {
  DispatcherCotStateStore,
  FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX,
  FEISHU_COT_DISPATCHER_TURNS_MAX,
  FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX,
} from '../src/feishu-cot-dispatcher-state.js';
import {
  cotLeaderKey,
  cotOpenCallKey,
  cotStateAdmitsTurn,
  cotStateHasAnchor,
  ensureLeaderState,
  LeaderLifecycleFence,
  prepareVisibleAnchor,
  reapCotState,
  refreshLeaderNextAnchor,
  releaseLeaderTurn,
  rememberOpenToolCall,
  setLeaderFallbackAnchorIfAbsent,
  type LeaderState,
  type VisibleMessageAnchor,
} from '../src/feishu-cot-state.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { anchor, groupTarget, LEADER, TEAM, threadTarget } from './helpers/cot-fixtures.js';

function leaders(): Map<string, LeaderState> {
  return new Map<string, LeaderState>();
}

function stateFor(
  map: Map<string, LeaderState>,
  teamName = TEAM,
  leaderName = LEADER,
): LeaderState {
  const found = map.get(cotLeaderKey(teamName, leaderName));
  if (found === undefined) throw new Error('no leader state');
  return found;
}

describe('an anchor is accepted only when it names one real visible message', () => {
  it('rejects a blank chat id, a blank message id, or a target that names another chat', () => {
    expect(prepareVisibleAnchor(anchor('om-1', chatTarget('', 'group')))).toBeNull();
    expect(prepareVisibleAnchor({ ...anchor('om-1'), messageId: '' })).toBeNull();
    expect(
      prepareVisibleAnchor({
        chatId: 'oc-a',
        messageId: 'om-1',
        // A target pointing somewhere else would retire the wrong anchors when
        // that other conversation is unbound.
        target: chatTarget('oc-b', 'group'),
      }),
    ).toBeNull();
  });

  it('copies the target so a later mutation of the caller\'s value cannot move a live card', () => {
    const target = { ...groupTarget() };
    const prepared = prepareVisibleAnchor({
      chatId: target.chatId,
      messageId: 'om-1',
      target,
    });
    expect(prepared).toEqual({ chatId: target.chatId, messageId: 'om-1', target });
    expect(prepared?.target).not.toBe(target);
  });
});

describe('the standing leader anchor', () => {
  it('is set once by a binding fallback and never replaces an anchor already held', () => {
    const map = leaders();
    setLeaderFallbackAnchorIfAbsent(map, TEAM, LEADER, anchor('om-fallback-1'));
    expect(stateFor(map).anchor?.messageId).toBe('om-fallback-1');

    setLeaderFallbackAnchorIfAbsent(map, TEAM, LEADER, anchor('om-fallback-2'));
    // An inbound conversation already owns the card; a later notification must
    // not silently move it somewhere else.
    expect(stateFor(map).anchor?.messageId).toBe('om-fallback-1');
  });

  it('ignores a blank identity and an unusable anchor without creating state', () => {
    const map = leaders();
    setLeaderFallbackAnchorIfAbsent(map, '', LEADER, anchor('om-1'));
    setLeaderFallbackAnchorIfAbsent(map, TEAM, '', anchor('om-1'));
    setLeaderFallbackAnchorIfAbsent(map, TEAM, LEADER, {
      ...anchor('om-1'),
      messageId: '',
    });
    expect(map.size).toBe(0);
  });

  it('takes a Reply as the *next* anchor, only inside the same conversation', () => {
    const map = leaders();
    setLeaderFallbackAnchorIfAbsent(map, TEAM, LEADER, anchor('om-inbound-1'));

    refreshLeaderNextAnchor(map, TEAM, LEADER, anchor('om-reply-1'));
    expect(stateFor(map).nextAnchor?.messageId).toBe('om-reply-1');
    // The card on screen has not moved; only the next one will.
    expect(stateFor(map).anchor?.messageId).toBe('om-inbound-1');

    // Replying into a different conversation is an ordinary outbound message,
    // not a new home for this leader's next card.
    refreshLeaderNextAnchor(
      map,
      TEAM,
      LEADER,
      anchor('om-elsewhere', chatTarget('oc-other', 'group')),
    );
    expect(stateFor(map).nextAnchor?.messageId).toBe('om-reply-1');

    // Last write inside the same conversation wins.
    refreshLeaderNextAnchor(map, TEAM, LEADER, anchor('om-reply-2'));
    expect(stateFor(map).nextAnchor?.messageId).toBe('om-reply-2');
  });

  it('never creates state, and never takes a next anchor, for a leader with no anchor at all', () => {
    const map = leaders();
    refreshLeaderNextAnchor(map, TEAM, LEADER, anchor('om-reply-1'));
    expect(map.size).toBe(0);

    ensureLeaderState(map, TEAM, LEADER);
    refreshLeaderNextAnchor(map, TEAM, LEADER, anchor('om-reply-1'));
    expect(stateFor(map).nextAnchor).toBeNull();
    expect(cotStateHasAnchor(stateFor(map))).toBe(false);
  });
});

describe('turn admission and the reap that keeps the ledger from growing', () => {
  it('admits exactly the leader turn the session bound, and releases only that one', () => {
    const map = leaders();
    const state = ensureLeaderState(map, TEAM, LEADER);
    state.admittedTurnId = 'turn-1';

    expect(cotStateAdmitsTurn(state, 'turn-1')).toBe(true);
    expect(cotStateAdmitsTurn(state, 'turn-2')).toBe(false);

    releaseLeaderTurn(state, 'turn-2');
    expect(state.admittedTurnId).toBe('turn-1');
    releaseLeaderTurn(state, 'turn-1');
    expect(state.admittedTurnId).toBeNull();
  });

  it('reaps an idle anchorless leader and keeps every leader that is still live', () => {
    const map = leaders();
    const dispatcher = new DispatcherCotStateStore();
    const state = ensureLeaderState(map, TEAM, LEADER);
    const key = cotLeaderKey(TEAM, LEADER);

    state.anchor = anchor('om-1');
    reapCotState(false, key, state, map, dispatcher);
    expect(map.has(key)).toBe(true);

    state.anchor = null;
    state.openCalls.set('c', { generation: 0 });
    reapCotState(false, key, state, map, dispatcher);
    expect(map.has(key)).toBe(true);

    state.openCalls.clear();
    state.inFlight = 1;
    reapCotState(false, key, state, map, dispatcher);
    expect(map.has(key)).toBe(true);

    state.inFlight = 0;
    reapCotState(false, key, state, map, dispatcher);
    expect(map.has(key)).toBe(false);
  });

  it('bounds the open tool-call ledger and refreshes an id instead of duplicating it', () => {
    const openCalls = new Map<string, { readonly generation: number }>();
    const max = 4;
    for (let index = 0; index < max; index += 1) {
      rememberOpenToolCall(openCalls, 1, cotOpenCallKey('turn-1', `call-${index}`), max);
    }
    expect(openCalls.size).toBe(max);

    // Re-remembering an id moves it to newest without growing the map.
    rememberOpenToolCall(openCalls, 1, cotOpenCallKey('turn-1', 'call-0'), max);
    expect(openCalls.size).toBe(max);

    rememberOpenToolCall(openCalls, 1, cotOpenCallKey('turn-1', 'call-new'), max);
    expect(openCalls.size).toBe(max);
    // `call-1` was the oldest after the refresh, so it is what fell out.
    expect(openCalls.has(cotOpenCallKey('turn-1', 'call-1'))).toBe(false);
    expect(openCalls.has(cotOpenCallKey('turn-1', 'call-0'))).toBe(true);
  });

  it('keys open calls per turn, so a reused call id cannot cross turns', () => {
    expect(cotOpenCallKey('turn-1', 'call-1')).not.toBe(
      cotOpenCallKey('turn-2', 'call-1'),
    );
  });
});

describe('LeaderLifecycleFence: what a leader may no longer present into', () => {
  function fenced(): {
    fence: LeaderLifecycleFence;
    map: Map<string, LeaderState>;
    interrupted: string[];
  } {
    const map = leaders();
    const interrupted: string[] = [];
    return {
      fence: new LeaderLifecycleFence(),
      map,
      interrupted,
    };
  }

  it('blocks every anchor for a Team that closed, and interrupts the cards it had', () => {
    const { fence, map, interrupted } = fenced();
    const state = ensureLeaderState(map, TEAM, LEADER);
    state.anchor = anchor('om-1');

    fence.onTeamState(
      { team_name: TEAM, leader_name: LEADER, status: 'closed' },
      map,
      (key) => interrupted.push(key),
    );

    expect(interrupted).toEqual([cotLeaderKey(TEAM, LEADER)]);
    expect(fence.blocksAnchor(cotLeaderKey(TEAM, LEADER), anchor('om-2'))).toBe(true);
    // Another Team is untouched.
    expect(fence.blocksAnchor(cotLeaderKey('team-beta', LEADER), anchor('om-2')))
      .toBe(false);
  });

  it('lifts the fence when the Team runs again', () => {
    const { fence, map } = fenced();
    const key = cotLeaderKey(TEAM, LEADER);
    fence.onTeamState({ team_name: TEAM, leader_name: LEADER, status: 'closed' }, map,
      () => undefined);
    expect(fence.blocksAnchor(key, anchor('om-1'))).toBe(true);

    fence.onTeamState({ team_name: TEAM, leader_name: LEADER, status: 'running' }, map,
      () => undefined);
    expect(fence.blocksAnchor(key, anchor('om-1'))).toBe(false);
  });

  it('fences exactly the conversation a binding was withdrawn from, and no other', () => {
    const { fence, map, interrupted } = fenced();
    const key = cotLeaderKey(TEAM, LEADER);
    const state = ensureLeaderState(map, TEAM, LEADER);
    const released = groupTarget();
    const surviving = topicTarget(released.chatId, 'omt-thread-9');
    state.anchor = anchor('om-1', released);

    fence.onRouteReleased({ teamName: TEAM, target: released }, map, (k) =>
      interrupted.push(k),
    );

    expect(interrupted).toEqual([key]);
    expect(fence.blocksAnchor(key, anchor('om-2', released))).toBe(true);
    // A topic inside the same chat is a different place; its binding survives.
    expect(fence.blocksAnchor(key, anchor('om-2', surviving))).toBe(false);
  });

  it('does not interrupt a leader whose anchors point somewhere else, but still fences the route', () => {
    const { fence, map, interrupted } = fenced();
    const key = cotLeaderKey(TEAM, LEADER);
    const elsewhere = chatTarget('oc-elsewhere', 'group');
    const state = ensureLeaderState(map, TEAM, LEADER);
    state.anchor = anchor('om-1', elsewhere);

    fence.onRouteReleased({ teamName: TEAM, target: groupTarget() }, map, (k) =>
      interrupted.push(k),
    );

    expect(interrupted).toEqual([]);
    // The card on screen keeps running; only the withdrawn place is closed off.
    expect(fence.blocksAnchor(key, anchor('om-2', elsewhere))).toBe(false);
    expect(fence.blocksAnchor(key, anchor('om-2', groupTarget()))).toBe(true);
  });

  it('interrupts a leader whose *next* anchor pointed at the withdrawn conversation', () => {
    const { fence, map, interrupted } = fenced();
    const state = ensureLeaderState(map, TEAM, LEADER);
    state.anchor = anchor('om-1', chatTarget('oc-elsewhere', 'group'));
    state.nextAnchor = anchor('om-2', groupTarget());

    fence.onRouteReleased({ teamName: TEAM, target: groupTarget() }, map, (k) =>
      interrupted.push(k),
    );
    expect(interrupted).toEqual([cotLeaderKey(TEAM, LEADER)]);
  });

  it('re-opens a conversation this Channel binds again', () => {
    const { fence, map } = fenced();
    const key = cotLeaderKey(TEAM, LEADER);
    ensureLeaderState(map, TEAM, LEADER);
    fence.onRouteReleased({ teamName: TEAM, target: groupTarget() }, map, () => undefined);
    expect(fence.blocksAnchor(key, anchor('om-2'))).toBe(true);

    fence.onRouteClaimed({ teamName: TEAM, target: groupTarget() });
    expect(fence.blocksAnchor(key, anchor('om-2'))).toBe(false);
  });

  it('a route claim for one Team never lifts another Team\'s fence on the same conversation', () => {
    const { fence, map } = fenced();
    ensureLeaderState(map, TEAM, LEADER);
    ensureLeaderState(map, 'team-beta', LEADER);
    fence.onRouteReleased({ teamName: TEAM, target: groupTarget() }, map, () => undefined);
    fence.onRouteReleased({ teamName: 'team-beta', target: groupTarget() }, map,
      () => undefined);

    fence.onRouteClaimed({ teamName: TEAM, target: groupTarget() });

    expect(fence.blocksAnchor(cotLeaderKey(TEAM, LEADER), anchor('om-1'))).toBe(false);
    expect(fence.blocksAnchor(cotLeaderKey('team-beta', LEADER), anchor('om-1')))
      .toBe(true);
  });

  it('bounds both fence ledgers at 512 entries, dropping the oldest', () => {
    const { fence, map } = fenced();
    for (let index = 0; index < 512; index += 1) {
      fence.onTeamState(
        { team_name: `team-${index}`, leader_name: LEADER, status: 'closed' },
        map,
        () => undefined,
      );
    }
    expect(fence.blocksAnchor(cotLeaderKey('team-0', LEADER), anchor('om-1'))).toBe(true);
    fence.onTeamState(
      { team_name: 'team-overflow', leader_name: LEADER, status: 'closed' },
      map,
      () => undefined,
    );
    expect(fence.blocksAnchor(cotLeaderKey('team-0', LEADER), anchor('om-1'))).toBe(false);
    expect(
      fence.blocksAnchor(cotLeaderKey('team-overflow', LEADER), anchor('om-1')),
    ).toBe(true);

    const routeFence = new LeaderLifecycleFence();
    const routeMap = leaders();
    ensureLeaderState(routeMap, TEAM, LEADER);
    const leaderKey = cotLeaderKey(TEAM, LEADER);
    for (let index = 0; index < 512; index += 1) {
      routeFence.onRouteReleased(
        { teamName: TEAM, target: chatTarget(`oc-${index}`, 'group') },
        routeMap,
        () => undefined,
      );
    }
    expect(
      routeFence.blocksAnchor(leaderKey, anchor('om-1', chatTarget('oc-0', 'group'))),
    ).toBe(true);

    routeFence.onRouteReleased(
      { teamName: TEAM, target: chatTarget('oc-overflow', 'group') },
      routeMap,
      () => undefined,
    );
    expect(
      routeFence.blocksAnchor(leaderKey, anchor('om-1', chatTarget('oc-0', 'group'))),
    ).toBe(false);
    expect(
      routeFence.blocksAnchor(
        leaderKey,
        anchor('om-1', chatTarget('oc-overflow', 'group')),
      ),
    ).toBe(true);
  });

  it('clear() drops every fence, as session teardown requires', () => {
    const { fence, map } = fenced();
    ensureLeaderState(map, TEAM, LEADER);
    fence.onTeamState({ team_name: TEAM, leader_name: LEADER, status: 'closed' }, map,
      () => undefined);
    fence.onRouteReleased({ teamName: TEAM, target: groupTarget() }, map, () => undefined);

    fence.clear();

    expect(fence.blocksAnchor(cotLeaderKey(TEAM, LEADER), anchor('om-1'))).toBe(false);
  });
});

describe('DispatcherCotStateStore is one bounded turn ledger', () => {
  const dispatcherAnchor = (chatId: string): VisibleMessageAnchor =>
    anchor(`om-${chatId}`, chatTarget(chatId, 'p2p'));

  it('begins one turn per turn_id and refuses a duplicate without disturbing it', () => {
    const store = new DispatcherCotStateStore();
    const first = store.begin('agent', 'turn-1', dispatcherAnchor('oc-1'));
    expect(first.status).toBe('started');

    expect(store.begin('agent', 'turn-1', dispatcherAnchor('oc-2'))).toEqual({
      status: 'duplicate',
    });
    expect(store.find('agent', 'turn-1')?.state.chatId).toBe('oc-1');
  });

  it('settles once, and a settled turn is no longer findable', () => {
    const store = new DispatcherCotStateStore();
    store.begin('agent', 'turn-1', dispatcherAnchor('oc-1'));

    expect(store.settle('agent', 'turn-1')).not.toBeNull();
    expect(store.settle('agent', 'turn-1')).toBeNull();
    expect(store.find('agent', 'turn-1')).toBeNull();
    expect(store.find('agent', 'never-began')).toBeNull();
  });

  it('refuses the 65th turn in one chat with no partial state left behind', () => {
    const store = new DispatcherCotStateStore();
    for (let index = 0; index < FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX; index += 1) {
      expect(store.begin('agent', `turn-${index}`, dispatcherAnchor('oc-1')).status)
        .toBe('started');
    }

    expect(store.begin('agent', 'turn-overflow', dispatcherAnchor('oc-1'))).toEqual({
      status: 'full',
      reason: 'chat_turns',
      maximum: FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX,
    });
    expect(store.find('agent', 'turn-overflow')).toBeNull();
    // Another conversation is unaffected by one chat being busy.
    expect(store.begin('agent', 'turn-other', dispatcherAnchor('oc-2')).status)
      .toBe('started');
  });

  it('refuses a session turn past the whole-session cap without indexing it', () => {
    const store = new DispatcherCotStateStore();
    let created = 0;
    for (let chat = 0; created < FEISHU_COT_DISPATCHER_TURNS_MAX; chat += 1) {
      for (
        let index = 0;
        index < FEISHU_COT_DISPATCHER_TURNS_PER_CHAT_MAX &&
        created < FEISHU_COT_DISPATCHER_TURNS_MAX;
        index += 1
      ) {
        store.begin('agent', `turn-${created}`, dispatcherAnchor(`oc-${chat}`));
        created += 1;
      }
    }

    expect(store.begin('agent', 'turn-overflow', dispatcherAnchor('oc-fresh'))).toEqual({
      status: 'full',
      reason: 'session_turns',
      maximum: FEISHU_COT_DISPATCHER_TURNS_MAX,
    });
    expect(store.find('agent', 'turn-overflow')).toBeNull();
    expect([...store.all()]).toHaveLength(FEISHU_COT_DISPATCHER_TURNS_MAX);
  });

  it('caps distinct conversations at the same ceiling, refusing before any is indexed', () => {
    // A conversation exists only while it holds a turn, and the session-turn
    // bound is the same 512, so one turn per conversation reaches the ceiling
    // for both at once. That is the reachable contract: the 513th distinct
    // conversation is refused and indexed nowhere.
    expect(FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX).toBe(
      FEISHU_COT_DISPATCHER_TURNS_MAX,
    );
    const store = new DispatcherCotStateStore();
    for (let index = 0; index < FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX; index += 1) {
      expect(
        store.begin('agent', `turn-${index}`, dispatcherAnchor(`oc-${index}`)).status,
      ).toBe('started');
    }

    const refused = store.begin('agent', 'turn-overflow', dispatcherAnchor('oc-fresh'));
    expect(refused).toMatchObject({
      status: 'full',
      maximum: FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX,
    });
    expect(store.find('agent', 'turn-overflow')).toBeNull();
    expect([...store.all()]).toHaveLength(FEISHU_COT_DISPATCHER_CONVERSATIONS_MAX);
  });

  it('reaps a finished turn and forgets its conversation once empty', () => {
    const store = new DispatcherCotStateStore();
    const started = store.begin('agent', 'turn-1', dispatcherAnchor('oc-1'));
    if (started.status !== 'started') throw new Error('turn did not start');
    store.begin('agent', 'turn-2', dispatcherAnchor('oc-1'));

    store.reap(started.key, started.state);
    expect(store.find('agent', 'turn-1')).toBeNull();
    expect([...store.all()]).toHaveLength(1);
    // The conversation is still live because a sibling turn holds it, so a new
    // turn in it does not have to re-open one.
    expect(store.begin('agent', 'turn-3', dispatcherAnchor('oc-1')).status)
      .toBe('started');

    store.clear();
    expect([...store.all()]).toHaveLength(0);
  });

  it('scopes turns per agent name, so two agents never collide on one turn id', () => {
    const store = new DispatcherCotStateStore();
    expect(store.begin('agent-a', 'turn-1', dispatcherAnchor('oc-1')).status)
      .toBe('started');
    expect(store.begin('agent-b', 'turn-1', dispatcherAnchor('oc-2')).status)
      .toBe('started');
    expect(store.find('agent-a', 'turn-1')?.state.chatId).toBe('oc-1');
    expect(store.find('agent-b', 'turn-1')?.state.chatId).toBe('oc-2');
  });

  it('a dispatcher turn state is always admitted for its own turn — it *is* the turn', () => {
    const store = new DispatcherCotStateStore();
    const started = store.begin('agent', 'turn-1', dispatcherAnchor('oc-1'));
    if (started.status !== 'started') throw new Error('turn did not start');
    expect(cotStateAdmitsTurn(started.state, 'turn-1')).toBe(true);
    expect(cotStateAdmitsTurn(started.state, 'any-other')).toBe(true);
    expect(cotStateHasAnchor(started.state)).toBe(true);
  });
});

describe('leader identity keys are injective', () => {
  it('cannot be spelled by another team/leader pair', () => {
    expect(cotLeaderKey('a', 'b')).not.toBe(cotLeaderKey('ab', ''));
    expect(cotLeaderKey(TEAM, LEADER)).toBe(cotLeaderKey(TEAM, LEADER));
  });

  it('a topic anchor and its group anchor are different places', () => {
    const group = anchor('om-1', groupTarget());
    const topic = anchor('om-1', threadTarget());
    const fence = new LeaderLifecycleFence();
    const map = leaders();
    ensureLeaderState(map, TEAM, LEADER);

    fence.onRouteReleased({ teamName: TEAM, target: topic.target }, map, () => undefined);
    expect(fence.blocksAnchor(cotLeaderKey(TEAM, LEADER), topic)).toBe(true);
    expect(fence.blocksAnchor(cotLeaderKey(TEAM, LEADER), group)).toBe(false);
  });
});
