/**
 * The fail-open seam between a live Feishu session and its COT adapter
 * (COVERAGE CELL F).
 *
 * COT is optional display. The seam's entire job is that nothing it does can
 * become a second failure for the session that owns it: a hostile event on the
 * shared Core stream, a broken logger, or a stale generation must all end in
 * "no card", never in a thrown error reaching Reply, inbound delivery, or
 * teardown. The session fence (`isCurrent`) is the other half — a session whose
 * generation was revoked must present nothing at all.
 */
import { describe, expect, it } from 'vitest';

import type { ChannelCoreEvent, DreamuxLogger } from '@excitedjs/dreamux-types';

import { FeishuCotSessionSeam } from '../src/feishu-cot-session.js';
import { createFakeCotClient, settleCot, type FakeCotClient } from './helpers/fake-cot-client.js';
import {
  anchor,
  assistant,
  DISPATCHER_ID,
  groupTarget,
  LEADER,
  recordingLogger,
  settled,
  submitted,
  TEAM,
  teamState,
  toolCall,
  type CapturedLog,
} from './helpers/cot-fixtures.js';

interface Seam {
  readonly seam: FeishuCotSessionSeam;
  readonly cot: FakeCotClient;
  readonly logs: CapturedLog[];
  current: boolean;
}

function newSeam(log?: DreamuxLogger): Seam {
  const cot = createFakeCotClient();
  const logs: CapturedLog[] = [];
  const state: Seam = {
    seam: new FeishuCotSessionSeam({
      dispatcherId: DISPATCHER_ID,
      channelId: 'primary',
      log: log ?? recordingLogger(logs),
      cotClient: () => cot,
    }),
    cot,
    logs,
    current: true,
  };
  state.seam.start(() => state.current);
  return state;
}

/** The ordinary production sequence: submit, then bind the visible message. */
function submitAndAnchor(state: Seam, turnId: string, messageId: string): void {
  state.seam.handle(submitted({ turn_id: turnId }));
  state.seam.attachInboundAnchor(turnId, anchor(messageId));
}

describe('the seam starts once and owns the adapter lifecycle', () => {
  it('refuses a second start', () => {
    const state = newSeam();
    expect(() => state.seam.start(() => true)).toThrow(/already started/);
  });

  it('does nothing at all before start, and closing an unstarted seam resolves', async () => {
    const cot = createFakeCotClient();
    const seam = new FeishuCotSessionSeam({
      dispatcherId: DISPATCHER_ID,
      channelId: 'primary',
      log: recordingLogger([]),
      cotClient: () => cot,
    });

    seam.handle(submitted());
    seam.attachInboundAnchor('turn-1', anchor('om-1'));
    seam.setBindingFallbackAnchor(TEAM, LEADER, anchor('om-1'));
    seam.onRouteReleased({ teamName: TEAM, target: groupTarget() });
    await settleCot();

    expect(cot.requests).toHaveLength(0);
    await expect(seam.close()).resolves.toBeUndefined();
  });

  it('opens a card through the ordinary submit-then-anchor path', async () => {
    const state = newSeam();

    submitAndAnchor(state, 'turn-1', 'om-inbound-1');
    state.seam.handle(assistant({ content: '正在处理' }));
    state.seam.handle(settled());
    await settleCot();

    expect(state.cot.createRequests()).toHaveLength(1);
    expect(state.cot.createRequests()[0]?.data?.['origin_message_id'])
      .toBe('om-inbound-1');
    expect(state.cot.eventTypesFor('cot-1')).toContain('RUN_FINISHED');
    await state.seam.close();
  });

  it('closes the adapter and forgets every unclaimed submission', async () => {
    const state = newSeam();
    state.seam.handle(submitted({ turn_id: 'turn-1' }));

    await state.seam.close();

    // The claim proof did not survive teardown, so a late anchor binds nothing.
    state.seam.attachInboundAnchor('turn-1', anchor('om-1'));
    await settleCot();
    expect(state.cot.requests).toHaveLength(0);
    // Closing twice is a no-op.
    await expect(state.seam.close()).resolves.toBeUndefined();
  });
});

describe('the session fence: a revoked generation presents nothing', () => {
  it('drops every event and every anchor call while the session is not current', async () => {
    const state = newSeam();
    state.current = false;

    state.seam.handle(submitted({ turn_id: 'turn-1' }));
    state.seam.attachInboundAnchor('turn-1', anchor('om-1'));
    state.seam.setBindingFallbackAnchor(TEAM, LEADER, anchor('om-2'));
    state.seam.refreshReplyNextAnchor({
      caller: { kind: 'team_leader', team_name: TEAM, leader_name: LEADER },
      anchor: anchor('om-3'),
    });
    state.seam.onRouteReleased({ teamName: TEAM, target: groupTarget() });
    state.seam.onRouteClaimed({ teamName: TEAM, target: groupTarget() });
    state.seam.handle(assistant());
    state.seam.handle(teamState({ status: 'closed' }));
    await settleCot();

    expect(state.cot.requests).toHaveLength(0);
    await state.seam.close();
  });

  it('records a submission even while fenced only through the events it is allowed to see', async () => {
    const state = newSeam();
    state.current = false;
    state.seam.handle(submitted({ turn_id: 'turn-1' }));

    // Becoming current again does not resurrect what the fence refused to see.
    state.current = true;
    state.seam.attachInboundAnchor('turn-1', anchor('om-1'));
    await settleCot();

    expect(state.cot.requests).toHaveLength(0);
    await state.seam.close();
  });
});

describe('the anchor claim is the proof of ownership', () => {
  it('binds only a turn_id this session\'s own submit returned, exactly once', async () => {
    const state = newSeam();
    state.seam.handle(submitted({ turn_id: 'turn-1' }));

    state.seam.attachInboundAnchor('turn-1', anchor('om-1'));
    await settleCot();
    expect(state.cot.createRequests()).toHaveLength(1);

    // The claim is consumed: a repeated attach cannot re-anchor the turn, and
    // a turn_id this session never submitted was never claimable.
    state.seam.attachInboundAnchor('turn-1', anchor('om-2'));
    state.seam.attachInboundAnchor('turn-foreign', anchor('om-3'));
    await settleCot();
    expect(state.cot.createRequests()).toHaveLength(1);
    await state.seam.close();
  });

  it('takes a Reply anchor only from a TeamLeader caller', async () => {
    const state = newSeam();
    submitAndAnchor(state, 'turn-1', 'om-inbound-1');
    await settleCot();
    state.seam.handle(settled());
    await settleCot();

    // The Dispatcher's Reply is an ordinary outbound message; it never becomes
    // a Team's next card anchor.
    state.seam.refreshReplyNextAnchor({
      caller: { kind: 'dispatcher' },
      anchor: anchor('om-dispatcher-reply'),
    });
    state.seam.refreshReplyNextAnchor({
      caller: { kind: 'team_leader', team_name: TEAM, leader_name: LEADER },
      anchor: anchor('om-leader-reply'),
    });

    state.seam.handle(
      submitted({ turn_id: 'turn-2', turn_source: 'task-notification' }),
    );
    state.seam.handle(
      assistant({
        turn_id: 'turn-2',
        event_id: 'evt-user-2',
        message_role: 'user',
        content: '任务完成',
      }),
    );
    await settleCot();

    expect(state.cot.createRequests()).toHaveLength(2);
    expect(state.cot.createRequests()[1]?.data?.['origin_message_id'])
      .toBe('om-leader-reply');
    await state.seam.close();
  });
});

describe('the seam demultiplexes one subscription', () => {
  it('routes each turn event kind and ignores every other Core event', async () => {
    const state = newSeam();
    submitAndAnchor(state, 'turn-1', 'om-1');
    await settleCot();

    state.seam.handle(toolCall({ status: 'started' }));
    state.seam.handle(
      toolCall({ status: 'completed', event_id: 'evt-r', result_json: 'ok' }),
    );
    // A kind this seam does not present must simply pass by.
    state.seam.handle({
      schema_version: 1,
      kind: 'teammate.state',
      occurred_at: 9,
      teammate_name: LEADER,
      role: 'team_leader',
      team_name: TEAM,
      status: 'running',
    } as ChannelCoreEvent);
    await settleCot();

    const types = state.cot.eventTypesFor('cot-1');
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('TOOL_CALL_RESULT');

    state.seam.handle(teamState({ status: 'closed' }));
    await settleCot();
    expect(state.cot.eventsFor('cot-1').filter(
      (event) => event.eventType === 'RUN_FINISHED',
    )).toHaveLength(1);
    await state.seam.close();
  });
});

describe('nothing the seam does can become a second failure', () => {
  it('swallows a hostile event and keeps presenting afterwards', async () => {
    const state = newSeam();
    submitAndAnchor(state, 'turn-1', 'om-1');
    await settleCot();

    const hostile = {
      get kind(): string {
        throw new Error('/home/operator/secret exploded');
      },
    } as unknown as ChannelCoreEvent;
    expect(() => state.seam.handle(hostile)).not.toThrow();

    // The session is still alive and the card still takes activity.
    state.seam.handle(assistant({ content: '故障之后仍在工作' }));
    await settleCot();
    expect(JSON.stringify(state.cot.allEvents())).toContain('故障之后仍在工作');
    await state.seam.close();
  });

  it('logs only an error category for a swallowed failure', async () => {
    const state = newSeam();
    const hostile = {
      get kind(): string {
        throw new Error('/home/operator/secret exploded');
      },
    } as unknown as ChannelCoreEvent;

    state.seam.handle(hostile);

    const warned = state.logs.filter((entry) => entry.message.startsWith('Feishu COT '));
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toEqual({
      dispatcher_id: DISPATCHER_ID,
      err_name: 'Error',
      err_code: null,
    });
    expect(JSON.stringify(state.logs)).not.toContain('/home/operator/secret');
    await state.seam.close();
  });

  it('survives a logger that throws, so display can never break the session', async () => {
    const hostileLogger: DreamuxLogger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => {
        throw new Error('logger is broken');
      },
      error: () => {
        throw new Error('logger is broken');
      },
    };
    const state = newSeam(hostileLogger);
    const hostile = {
      get kind(): string {
        throw new Error('boom');
      },
    } as unknown as ChannelCoreEvent;

    expect(() => state.seam.handle(hostile)).not.toThrow();
    expect(() =>
      state.seam.refreshReplyNextAnchor({
        caller: { kind: 'team_leader', team_name: TEAM, leader_name: LEADER },
        anchor: anchor('om-1'),
      }),
    ).not.toThrow();
    await expect(state.seam.close()).resolves.toBeUndefined();
  });
});
