/**
 * The live COT card state machine (COVERAGE CELL F).
 *
 * Everything here is asserted through the *platform* surface: what the adapter
 * did is exactly the sequence of create / append / complete requests the real
 * transport would have issued, with each AG-UI event decoded back out of the
 * wire body. No private field is read and no internal method is called — the
 * adapter's only inputs are neutral Core turn events plus this Channel's own
 * anchors and route facts, and its only output is those requests.
 *
 * The contracts this pins, per issue #352:
 *   - reply-anchor lifecycle and routing fences;
 *   - append batching under the platform budgets;
 *   - turn-settlement projection;
 *   - conversation activity bounds;
 *   - failure isolation and error redaction;
 *   - close behavior and the state it leaves behind.
 */
import { describe, expect, it, vi } from 'vitest';

import { FeishuCotApiError } from '@excitedjs/feishu-transport';

import { createFakeCotClient, settleCot } from './helpers/fake-cot-client.js';
import {
  anchor,
  assistant,
  DISPATCHER_AGENT,
  dispatcherAssistant,
  dispatcherSettled,
  dispatcherSubmitted,
  groupTarget,
  harness,
  LEADER,
  openLeaderCard,
  settled,
  submitted,
  TEAM,
  teamState,
  threadTarget,
  toolCall,
  userMessage,
  type CotHarness,
} from './helpers/cot-fixtures.js';
import { chatTarget } from '../src/routing/target.js';

const RECEIPT = '已收到消息，开始处理。';

function cotIdOf(h: CotHarness, index: number): string {
  const created = h.cot.createRequests();
  if (created.length <= index) {
    throw new Error(`no COT was created at index ${index}`);
  }
  return `cot-${index + 1}`;
}

function textOn(h: CotHarness, cotId: string): string {
  return h.cot
    .eventsFor(cotId)
    .filter((event) => event.eventType === 'TEXT_MESSAGE_CONTENT')
    .map((event) => String(event.content['delta']))
    .join('');
}

function finishStatuses(h: CotHarness, cotId: string): string[] {
  return h.cot
    .eventsFor(cotId)
    .filter((event) => event.eventType === 'RUN_FINISHED')
    .map((event) => String(event.content['status']));
}

function originOf(h: CotHarness, index: number): {
  receiveId: unknown;
  originMessageId: unknown;
} {
  const request = h.cot.createRequests()[index];
  return {
    receiveId: request?.data?.['receive_id'],
    originMessageId: request?.data?.['origin_message_id'],
  };
}

async function openSettledLeaderCard(h: CotHarness): Promise<void> {
  openLeaderCard(h);
  await settleCot();
  h.adapter.onTurnSettled(settled());
  await settleCot();
}

describe('a card opens under the exact visible message its turn came from', () => {
  it('creates the card eagerly with a receipt line, on the anchor the session supplied', async () => {
    const h = harness();

    openLeaderCard(h, { messageId: 'om-inbound-1' });
    await settleCot();

    expect(h.cot.createRequests()).toHaveLength(1);
    expect(originOf(h, 0)).toEqual({
      receiveId: groupTarget().chatId,
      originMessageId: 'om-inbound-1',
    });
    expect(h.cot.eventTypesFor(cotIdOf(h, 0))).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(textOn(h, cotIdOf(h, 0))).toBe(RECEIPT);
    await h.adapter.close();
  });

  it('creates nothing for a submission whose anchor names no real visible message', async () => {
    const h = harness();

    h.adapter.onAnchoredSubmission({
      event: submitted(),
      anchor: { ...anchor('om-1'), messageId: '' },
    });
    // A team_leader event with no Team is not a leader conversation at all.
    h.adapter.onAnchoredSubmission({
      event: submitted({ team_name: null }),
      anchor: anchor('om-2'),
    });
    await settleCot();

    expect(h.cot.requests).toHaveLength(0);
    await h.adapter.close();
  });

  it('keeps a Reply as the *next* card\'s anchor, leaving the open card where it is', async () => {
    const h = harness();
    openLeaderCard(h, { messageId: 'om-inbound-1' });
    await settleCot();

    // The leader replied; that reply becomes the anchor for the next card only.
    h.adapter.refreshNextAnchor(TEAM, LEADER, anchor('om-reply-1'));
    h.adapter.onTurnMessage(assistant({ content: '仍在当前卡片' }));
    await settleCot();

    expect(h.cot.createRequests()).toHaveLength(1);
    expect(textOn(h, cotIdOf(h, 0))).toContain('仍在当前卡片');

    // Settle, then let a continuation open the next card: it lands on the reply.
    h.adapter.onTurnSettled(settled());
    await settleCot();
    h.adapter.onTurnSubmitted(
      submitted({ turn_id: 'turn-2', turn_source: 'task-notification' }),
    );
    h.adapter.onTurnMessage(
      userMessage({ turn_id: 'turn-2', event_id: 'evt-user-2', content: '任务完成' }),
    );
    await settleCot();

    expect(h.cot.createRequests()).toHaveLength(2);
    expect(originOf(h, 1).originMessageId).toBe('om-reply-1');
    await h.adapter.close();
  });

  it('ignores a Reply anchor pointing into a different conversation', async () => {
    const h = harness();
    openLeaderCard(h, { messageId: 'om-inbound-1' });
    await settleCot();
    h.adapter.onTurnSettled(settled());
    await settleCot();

    h.adapter.refreshNextAnchor(
      TEAM,
      LEADER,
      anchor('om-elsewhere', chatTarget('oc-other', 'group')),
    );
    h.adapter.onTurnSubmitted(
      submitted({ turn_id: 'turn-2', turn_source: 'cron' }),
    );
    h.adapter.onTurnMessage(
      userMessage({ turn_id: 'turn-2', event_id: 'evt-user-2', content: '定时触发' }),
    );
    await settleCot();

    // The standing anchor is still the inbound message this Team is watched at.
    expect(originOf(h, 1).originMessageId).toBe('om-inbound-1');
    await h.adapter.close();
  });

  it('never lets a binding fallback anchor displace an anchor the conversation already has', async () => {
    const h = harness();
    openLeaderCard(h, { messageId: 'om-inbound-1' });
    await settleCot();
    h.adapter.onTurnSettled(settled());
    await settleCot();

    h.adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, anchor('om-notification-1'));
    h.adapter.onTurnSubmitted(
      submitted({ turn_id: 'turn-2', turn_source: 'task-notification' }),
    );
    h.adapter.onTurnMessage(
      userMessage({ turn_id: 'turn-2', event_id: 'evt-user-2', content: '任务完成' }),
    );
    await settleCot();

    expect(originOf(h, 1).originMessageId).toBe('om-inbound-1');
    await h.adapter.close();
  });

  it('uses a binding fallback anchor when the Team has never been talked to here', async () => {
    const h = harness();

    h.adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, anchor('om-notification-1'));
    h.adapter.onTurnSubmitted(
      submitted({ turn_id: 'turn-2', turn_source: 'task-notification' }),
    );
    h.adapter.onTurnMessage(
      userMessage({ turn_id: 'turn-2', event_id: 'evt-user-2', content: '任务完成' }),
    );
    await settleCot();

    expect(h.cot.createRequests()).toHaveLength(1);
    expect(originOf(h, 0).originMessageId).toBe('om-notification-1');
    await h.adapter.close();
  });
});

describe('which turns a conversation narrates', () => {
  it('admits a completion or a cron fire onto the standing anchor, but only once its own text arrives', async () => {
    const h = harness();
    await openSettledLeaderCard(h);
    const createdBefore = h.cot.createRequests().length;

    h.adapter.onTurnSubmitted(
      submitted({ turn_id: 'turn-2', turn_source: 'task-notification' }),
    );
    await settleCot();
    // Nothing was produced yet, so no empty card was opened.
    expect(h.cot.createRequests()).toHaveLength(createdBefore);

    h.adapter.onTurnMessage(
      userMessage({ turn_id: 'turn-2', event_id: 'evt-user-2', content: '任务完成' }),
    );
    await settleCot();

    expect(h.cot.createRequests()).toHaveLength(createdBefore + 1);
    expect(textOn(h, cotIdOf(h, 1))).toContain('任务完成');
    await h.adapter.close();
  });

  it('never narrates a turn that arrived out of band', async () => {
    const h = harness();
    await openSettledLeaderCard(h);
    const createdBefore = h.cot.createRequests().length;

    for (const source of ['admin', 'mcp', 'unknown', 'feishu']) {
      h.adapter.onTurnSubmitted(
        submitted({ turn_id: `turn-${source}`, turn_source: source }),
      );
      h.adapter.onTurnMessage(
        userMessage({
          turn_id: `turn-${source}`,
          event_id: `evt-${source}`,
          content: `来自 ${source}`,
        }),
      );
      h.adapter.onTurnMessage(
        assistant({ turn_id: `turn-${source}`, event_id: `evt-a-${source}` }),
      );
    }
    await settleCot();

    expect(h.cot.createRequests()).toHaveLength(createdBefore);
    await h.adapter.close();
  });

  it('shows only the turn the conversation admitted, never another Agent\'s', async () => {
    const h = harness();
    openLeaderCard(h, { turnId: 'turn-1' });
    await settleCot();

    // A Team member's own turn, and a second leader turn nobody anchored.
    h.adapter.onTurnMessage(
      assistant({ role: 'teammate', teammate_name: 'member-1', content: '成员输出' }),
    );
    h.adapter.onTurnMessage(
      assistant({ turn_id: 'turn-9', event_id: 'evt-9', content: '未被接纳的轮次' }),
    );
    h.adapter.onTurnToolCall(
      toolCall({ role: 'teammate', teammate_name: 'member-1', call_id: 'call-m' }),
    );
    await settleCot();

    const text = textOn(h, cotIdOf(h, 0));
    expect(text).not.toContain('成员输出');
    expect(text).not.toContain('未被接纳的轮次');
    expect(h.cot.createRequests()).toHaveLength(1);
    await h.adapter.close();
  });
});

describe('settlement projects the run status onto the card', () => {
  it.each([
    ['completed', 'done'],
    ['failed', 'interrupted'],
    ['stopped', 'interrupted'],
  ] as const)('maps a %s turn to a %s run', async (status, expected) => {
    const h = harness();
    openLeaderCard(h);
    await settleCot();

    h.adapter.onTurnSettled(settled({ status }));
    await settleCot();

    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual([expected]);
    await h.adapter.close();
  });

  it('ignores a settlement for a turn this card is not showing', async () => {
    const h = harness();
    openLeaderCard(h, { turnId: 'turn-1' });
    await settleCot();

    h.adapter.onTurnSettled(settled({ turn_id: 'turn-stale', status: 'failed' }));
    await settleCot();
    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual([]);

    h.adapter.onTurnSettled(settled({ turn_id: 'turn-1' }));
    await settleCot();
    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['done']);
    await h.adapter.close();
  });

  it('finishes a card exactly once, whatever arrives afterwards', async () => {
    const h = harness();
    openLeaderCard(h);
    await settleCot();

    h.adapter.onTurnSettled(settled());
    h.adapter.onTurnSettled(settled({ status: 'failed' }));
    await settleCot();
    h.adapter.onTurnMessage(assistant({ content: '结束后的输出' }));
    await settleCot();

    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['done']);
    expect(textOn(h, cotIdOf(h, 0))).not.toContain('结束后的输出');
    await h.adapter.close();
  });
});

describe('tool activity is paired, bounded, and generation-scoped', () => {
  it('opens a tool call and closes it with its own result on the same card', async () => {
    const h = harness();
    openLeaderCard(h);
    await settleCot();

    h.adapter.onTurnToolCall(toolCall({ status: 'started' }));
    h.adapter.onTurnToolCall(
      toolCall({
        status: 'completed',
        event_id: 'evt-tool-result-1',
        result_json: 'all green',
      }),
    );
    await settleCot();

    const types = h.cot.eventTypesFor(cotIdOf(h, 0));
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('TOOL_CALL_END');
    expect(types).toContain('TOOL_CALL_RESULT');
    await h.adapter.close();
  });

  it('drops a result for a call this card never opened', async () => {
    const h = harness();
    openLeaderCard(h);
    await settleCot();

    h.adapter.onTurnToolCall(
      toolCall({ status: 'completed', call_id: 'never-started', result_json: 'x' }),
    );
    await settleCot();

    expect(h.cot.eventTypesFor(cotIdOf(h, 0))).not.toContain('TOOL_CALL_RESULT');
    await h.adapter.close();
  });

  it('does not carry an open call across a new anchor', async () => {
    const h = harness();
    openLeaderCard(h, { turnId: 'turn-1', messageId: 'om-inbound-1' });
    await settleCot();
    h.adapter.onTurnToolCall(toolCall({ turn_id: 'turn-1', status: 'started' }));
    await settleCot();

    // A newer inbound message replaces the anchor and the generation with it.
    openLeaderCard(h, { turnId: 'turn-2', messageId: 'om-inbound-2' });
    await settleCot();
    h.adapter.onTurnToolCall(
      toolCall({
        turn_id: 'turn-1',
        status: 'completed',
        event_id: 'evt-late-result',
        result_json: '迟到的结果',
      }),
    );
    await settleCot();

    expect(JSON.stringify(h.cot.eventsFor(cotIdOf(h, 1)))).not.toContain('迟到的结果');
    await h.adapter.close();
  });

  it('keeps every append inside the platform batch budgets under a burst', async () => {
    const h = harness();
    openLeaderCard(h);
    await settleCot();

    for (let index = 0; index < 40; index += 1) {
      h.adapter.onTurnMessage(
        assistant({ event_id: `evt-${index}`, content: `输出 ${index}`.repeat(40) }),
      );
    }
    await settleCot(40);

    const appends = h.cot.appendRequests();
    expect(appends.length).toBeGreaterThan(1);
    for (const request of appends) {
      const events = request.data?.['events'] as readonly unknown[];
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.length).toBeLessThanOrEqual(50);
      expect(Buffer.byteLength(JSON.stringify(request.data), 'utf8'))
        .toBeLessThanOrEqual(64 * 1_024);
    }
    await h.adapter.close();
  });

  it('coalesces a burst arriving during a slow append into one queued flush', async () => {
    const h = harness();
    openLeaderCard(h);
    await settleCot();
    const appendsBefore = h.cot.appendRequests().length;

    const release = h.cot.blockNextAppend();
    h.adapter.onTurnMessage(assistant({ event_id: 'evt-1', content: '第一条' }));
    await settleCot();
    for (let index = 2; index <= 10; index += 1) {
      h.adapter.onTurnMessage(
        assistant({ event_id: `evt-${index}`, content: `第 ${index} 条` }),
      );
    }
    await settleCot();
    release();
    await settleCot(40);

    // One in-flight append plus one drain of everything that queued behind it:
    // a nine-message burst does not become nine platform calls.
    expect(h.cot.appendRequests().length - appendsBefore).toBeLessThanOrEqual(2);
    const text = textOn(h, cotIdOf(h, 0));
    for (let index = 1; index <= 10; index += 1) {
      expect(text).toContain(index === 1 ? '第一条' : `第 ${index} 条`);
    }
    await h.adapter.close();
  });
});

describe('routing fences: where a Team may no longer present', () => {
  it('interrupts the open card when its Team closes, and opens nothing afterwards', async () => {
    const h = harness();
    openLeaderCard(h, { turnId: 'turn-1' });
    await settleCot();

    h.adapter.onTeamState(teamState({ status: 'closed' }));
    await settleCot();
    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['interrupted']);

    openLeaderCard(h, { turnId: 'turn-2', messageId: 'om-inbound-2' });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(1);
    await h.adapter.close();
  });

  it('lets the Team present again once it is running', async () => {
    const h = harness();
    openLeaderCard(h, { turnId: 'turn-1' });
    await settleCot();
    h.adapter.onTeamState(teamState({ status: 'closed' }));
    await settleCot();

    h.adapter.onTeamState(teamState({ status: 'running' }));
    openLeaderCard(h, { turnId: 'turn-2', messageId: 'om-inbound-2' });
    await settleCot();

    expect(h.cot.createRequests()).toHaveLength(2);
    await h.adapter.close();
  });

  it('retires the cards anchored in a conversation this Channel unbound, and only those', async () => {
    const h = harness();
    const otherTarget = chatTarget('oc-other', 'group');
    openLeaderCard(h, { turnId: 'turn-1', messageId: 'om-a' });
    h.adapter.onAnchoredSubmission({
      event: submitted({ turn_id: 'turn-2', teammate_name: 'leader-b' }),
      anchor: anchor('om-b', otherTarget),
    });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(2);

    h.adapter.onRouteReleased({ teamName: TEAM, target: groupTarget() });
    await settleCot();

    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['interrupted']);
    // The other conversation's card is untouched.
    expect(finishStatuses(h, cotIdOf(h, 1))).toEqual([]);

    // And the unbound conversation is closed to new cards until it is re-bound.
    openLeaderCard(h, { turnId: 'turn-3', messageId: 'om-c' });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(2);

    h.adapter.onRouteClaimed({ teamName: TEAM, target: groupTarget() });
    openLeaderCard(h, { turnId: 'turn-4', messageId: 'om-d' });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(3);
    await h.adapter.close();
  });

  it('matches the fence to the exact conversation, not merely the chat it is in', async () => {
    const h = harness();
    const topic = threadTarget();
    openLeaderCard(h, { turnId: 'turn-1', messageId: 'om-topic', target: topic });
    await settleCot();

    // Unbinding the surrounding group does not retire a topic's own card.
    h.adapter.onRouteReleased({ teamName: TEAM, target: groupTarget() });
    await settleCot();
    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual([]);

    h.adapter.onRouteReleased({ teamName: TEAM, target: topic });
    await settleCot();
    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['interrupted']);
    await h.adapter.close();
  });

  it('fences only the Team whose route moved', async () => {
    const h = harness();
    openLeaderCard(h, { turnId: 'turn-1', messageId: 'om-a' });
    h.adapter.onAnchoredSubmission({
      event: submitted({ team_name: 'team-beta', turn_id: 'turn-2' }),
      anchor: anchor('om-b'),
    });
    await settleCot();

    h.adapter.onRouteReleased({ teamName: TEAM, target: groupTarget() });
    await settleCot();

    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['interrupted']);
    expect(finishStatuses(h, cotIdOf(h, 1))).toEqual([]);
    await h.adapter.close();
  });
});

describe('the Dispatcher Agent presents one turn per visible message', () => {
  it('answers the message it was asked in, without echoing the question back', async () => {
    const h = harness();
    const chat = chatTarget('oc-dm-1', 'p2p');

    h.adapter.onAnchoredSubmission({
      event: dispatcherSubmitted('turn-d1'),
      anchor: anchor('om-dm-1', chat),
    });
    await settleCot();
    h.adapter.onTurnMessage(
      dispatcherAssistant('turn-d1', 'evt-d1', { content: '这是回答' }),
    );
    // The user's own message is already visible in the chat.
    h.adapter.onTurnMessage(
      dispatcherAssistant('turn-d1', 'evt-d1-user', {
        message_role: 'user',
        content: '这是提问',
      }),
    );
    await settleCot();

    expect(originOf(h, 0)).toEqual({
      receiveId: 'oc-dm-1',
      originMessageId: 'om-dm-1',
    });
    const text = textOn(h, cotIdOf(h, 0));
    expect(text).toContain('这是回答');
    expect(text).not.toContain('这是提问');
    await h.adapter.close();
  });

  it('runs two conversations side by side without either stealing or closing the other', async () => {
    const h = harness();
    h.adapter.onAnchoredSubmission({
      event: dispatcherSubmitted('turn-a'),
      anchor: anchor('om-a', chatTarget('oc-a', 'p2p')),
    });
    h.adapter.onAnchoredSubmission({
      event: dispatcherSubmitted('turn-b'),
      anchor: anchor('om-b', chatTarget('oc-b', 'p2p')),
    });
    await settleCot();

    h.adapter.onTurnMessage(dispatcherAssistant('turn-a', 'evt-a', { content: 'A 的回答' }));
    h.adapter.onTurnMessage(dispatcherAssistant('turn-b', 'evt-b', { content: 'B 的回答' }));
    h.adapter.onTurnSettled(dispatcherSettled('turn-a'));
    await settleCot();

    expect(textOn(h, cotIdOf(h, 0))).toContain('A 的回答');
    expect(textOn(h, cotIdOf(h, 0))).not.toContain('B 的回答');
    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['done']);
    expect(finishStatuses(h, cotIdOf(h, 1))).toEqual([]);

    h.adapter.onTurnSettled(dispatcherSettled('turn-b', { status: 'failed' }));
    await settleCot();
    expect(finishStatuses(h, cotIdOf(h, 1))).toEqual(['interrupted']);
    await h.adapter.close();
  });

  it('never opens a card for a Dispatcher turn this session did not submit', async () => {
    const h = harness();

    // No `onAnchoredSubmission`: this turn belongs to another session.
    h.adapter.onTurnSubmitted(dispatcherSubmitted('turn-foreign'));
    h.adapter.onTurnMessage(
      dispatcherAssistant('turn-foreign', 'evt-f', { content: '别的会话' }),
    );
    h.adapter.onTurnToolCall(
      toolCall({ role: 'dispatcher', teammate_name: DISPATCHER_AGENT, turn_id: 'turn-foreign' }),
    );
    await settleCot();

    expect(h.cot.requests).toHaveLength(0);
    await h.adapter.close();
  });

  it('stops accepting activity for a Dispatcher turn once it settles', async () => {
    const h = harness();
    h.adapter.onAnchoredSubmission({
      event: dispatcherSubmitted('turn-a'),
      anchor: anchor('om-a', chatTarget('oc-a', 'p2p')),
    });
    await settleCot();
    h.adapter.onTurnSettled(dispatcherSettled('turn-a'));
    await settleCot();

    h.adapter.onTurnMessage(
      dispatcherAssistant('turn-a', 'evt-late', { content: '结束后的输出' }),
    );
    await settleCot();

    expect(textOn(h, cotIdOf(h, 0))).not.toContain('结束后的输出');
    await h.adapter.close();
  });
});

describe('failure isolation: display never becomes a second failure', () => {
  it('degrades to no presentation at all when the platform has no COT capability', async () => {
    const h = harness({ cotClient: () => undefined });

    openLeaderCard(h);
    h.adapter.onTurnMessage(assistant());
    h.adapter.onTurnSettled(settled());
    await settleCot();

    expect(h.cot.requests).toHaveLength(0);
    expect(h.logs.some((entry) => entry.message.includes('abandoned'))).toBe(true);
    await h.adapter.close();
  });

  it('abandons the generation when create fails, and recovers on the next inbound message', async () => {
    const h = harness();
    h.cot.failNextCreate(new FeishuCotApiError(230_002, 'no permission'));

    openLeaderCard(h, { turnId: 'turn-1', messageId: 'om-1' });
    await settleCot();
    // Nothing further on this generation is attempted: no append, no complete,
    // and no second create for the card that never came into being.
    h.adapter.onTurnMessage(assistant({ content: '同一代的输出' }));
    h.adapter.onTurnToolCall(toolCall());
    await settleCot();
    expect(h.cot.requests).toHaveLength(0);

    // A new inbound message is a new generation, and presentation resumes.
    openLeaderCard(h, { turnId: 'turn-2', messageId: 'om-2' });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(1);
    expect(originOf(h, 0).originMessageId).toBe('om-2');
    expect(textOn(h, cotIdOf(h, 0))).toBe(RECEIPT);
    await h.adapter.close();
  });

  it('does not re-open a Dispatcher card on the generation whose create already failed', async () => {
    const h = harness();
    h.cot.failNextCreate(new FeishuCotApiError(230_002, 'no permission'));

    h.adapter.onAnchoredSubmission({
      event: dispatcherSubmitted('turn-d1'),
      anchor: anchor('om-dm-1', chatTarget('oc-dm-1', 'p2p')),
    });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(0);

    // A Dispatcher turn *is* its own admission, so nothing turn-scoped stops a
    // second attempt here — only the disabled generation does. Without it the
    // next activity would silently open a replacement card the operator never
    // asked for, in a chat the first attempt already failed in.
    h.adapter.onTurnMessage(
      dispatcherAssistant('turn-d1', 'evt-d1', { content: '失败后的输出' }),
    );
    h.adapter.onTurnToolCall(
      toolCall({
        role: 'dispatcher',
        teammate_name: DISPATCHER_AGENT,
        turn_id: 'turn-d1',
      }),
    );
    await settleCot();

    expect(h.cot.requests).toHaveLength(0);
    await h.adapter.close();
  });

  it('does not admit a continuation onto a TeamLeader generation whose create already failed', async () => {
    const h = harness();
    h.cot.failNextCreate(new FeishuCotApiError(230_002, 'no permission'));
    openLeaderCard(h, { turnId: 'turn-1' });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(0);

    h.adapter.onTurnSubmitted(
      submitted({ turn_id: 'turn-2', turn_source: 'task-notification' }),
    );
    h.adapter.onTurnMessage(
      userMessage({ turn_id: 'turn-2', event_id: 'evt-user-2', content: '任务完成' }),
    );
    await settleCot();

    expect(h.cot.requests).toHaveLength(0);

    // Only a new inbound message clears it, because only that is a new
    // conversation turn to present.
    openLeaderCard(h, { turnId: 'turn-3', messageId: 'om-2' });
    await settleCot();
    expect(h.cot.createRequests()).toHaveLength(1);
    await h.adapter.close();
  });

  it('best-effort completes the card once after an append failure and never retries it', async () => {
    const h = harness();
    openLeaderCard(h);
    await settleCot();
    const appendsBefore = h.cot.appendRequests().length;

    h.cot.failNextAppend(new FeishuCotApiError(230_098, 'rate limited'));
    h.adapter.onTurnMessage(assistant({ content: '写不进去的输出' }));
    await settleCot();

    // The card is closed out with `reason: error` on the same client, and the
    // batch that failed is not retried.
    expect(h.cot.completeRequests()).toHaveLength(1);
    expect(h.cot.completeRequests()[0]?.params).toMatchObject({ reason: 'error' });
    expect(h.cot.appendRequests()).toHaveLength(appendsBefore);

    // Later activity on the abandoned generation reaches the platform never.
    h.adapter.onTurnMessage(assistant({ event_id: 'evt-2', content: '之后的输出' }));
    h.adapter.onTurnSettled(settled());
    await settleCot();
    expect(h.cot.appendRequests()).toHaveLength(appendsBefore);
    expect(h.cot.completeRequests()).toHaveLength(1);
    await h.adapter.close();
  });

  it('logs only an error category — never a message, payload, or stack', async () => {
    const h = harness();
    h.cot.failNextCreate(
      new FeishuCotApiError(230_002, '/home/operator/secret/path denied'),
    );

    openLeaderCard(h);
    await settleCot();

    const failures = h.logs.filter((entry) => entry.message.startsWith('Feishu COT call'));
    expect(failures.length).toBeGreaterThan(0);
    for (const entry of failures) {
      expect(entry.fields).toMatchObject({
        err_name: 'FeishuCotApiError',
        err_code: 230_002,
        dispatcher_id: expect.any(String),
      });
      expect(Object.keys(entry.fields).sort()).toEqual([
        'channel_id',
        'dispatcher_id',
        'err_code',
        'err_name',
        'leader_name',
        'presentation_id',
        'stage',
        'team_name',
      ]);
    }
    expect(JSON.stringify(h.logs)).not.toContain('/home/operator/secret/path');
    await h.adapter.close();
  });

  it('reports a non-platform failure as an opaque category rather than its text', async () => {
    const h = harness();
    h.cot.failNextCreate(new Error('ECONNREFUSED 10.0.0.1:443'));

    openLeaderCard(h);
    await settleCot();

    const failures = h.logs.filter((entry) => entry.message.startsWith('Feishu COT call'));
    expect(failures[0]?.fields).toMatchObject({ err_name: 'Error', err_code: null });
    expect(JSON.stringify(h.logs)).not.toContain('10.0.0.1');
    await h.adapter.close();
  });

  it('warns once when a runaway conversation overruns the display buffer', async () => {
    const h = harness();
    const release = h.cot.blockNextCreate();
    openLeaderCard(h);
    await settleCot();

    // The card is still being created, so everything buffers.
    for (let index = 0; index < 600; index += 1) {
      h.adapter.onTurnMessage(
        assistant({ event_id: `evt-${index}`, content: `输出 ${index}` }),
      );
    }
    release();
    await settleCot(60);

    const dropWarnings = h.logs.filter((entry) =>
      entry.message.includes('buffer is full'),
    );
    expect(dropWarnings).toHaveLength(1);
    expect(dropWarnings[0]?.fields).toMatchObject({ buffered_events: expect.any(Number) });
    // The session survived the burst and the card is still usable.
    expect(h.cot.appendRequests().length).toBeGreaterThan(0);
    await h.adapter.close();
  });

  it('bounds the pending continuation ledger instead of growing without limit', async () => {
    const h = harness();
    await openSettledLeaderCard(h);

    for (let index = 0; index < 600; index += 1) {
      h.adapter.onTurnSubmitted(
        submitted({ turn_id: `turn-p${index}`, turn_source: 'cron' }),
      );
    }
    await settleCot();

    const full = h.logs.filter((entry) => entry.message.includes('pending turn map is full'));
    expect(full.length).toBeGreaterThan(0);
    expect(full[0]?.fields).toMatchObject({ reason: 'pending_turns_full' });
    await h.adapter.close();
  });
});

describe('close leaves nothing running and nothing half-drawn', () => {
  it('interrupts every open card and stops accepting anything afterwards', async () => {
    const h = harness();
    openLeaderCard(h, { turnId: 'turn-1' });
    h.adapter.onAnchoredSubmission({
      event: dispatcherSubmitted('turn-d1'),
      anchor: anchor('om-dm', chatTarget('oc-dm', 'p2p')),
    });
    await settleCot();

    await h.adapter.close();

    expect(finishStatuses(h, cotIdOf(h, 0))).toEqual(['interrupted']);
    expect(finishStatuses(h, cotIdOf(h, 1))).toEqual(['interrupted']);

    const after = h.cot.requests.length;
    openLeaderCard(h, { turnId: 'turn-2', messageId: 'om-2' });
    h.adapter.onTurnMessage(assistant());
    h.adapter.onTurnToolCall(toolCall());
    h.adapter.onTurnSettled(settled());
    h.adapter.onTeamState(teamState({ status: 'closed' }));
    h.adapter.onRouteReleased({ teamName: TEAM, target: groupTarget() });
    h.adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, anchor('om-3'));
    h.adapter.refreshNextAnchor(TEAM, LEADER, anchor('om-4'));
    await settleCot();
    expect(h.cot.requests).toHaveLength(after);

    // Closing twice is a no-op, not a second teardown.
    await h.adapter.close();
    expect(h.cot.requests).toHaveLength(after);
  });

  it('gives up on a stalled platform call after the drain window and aborts it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const cot = createFakeCotClient();
      const h = harness({ cot });
      openLeaderCard(h);
      await settleCot();

      cot.blockNextAppend();
      h.adapter.onTurnMessage(assistant({ content: '卡住的输出' }));
      await settleCot();

      let resolved = false;
      const closing = h.adapter.close().then(() => {
        resolved = true;
      });
      await settleCot();
      // The drain window has not elapsed, so close is still waiting.
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      expect(resolved).toBe(true);

      // The stalled call is aborted rather than left hanging, and the card is
      // completed with an error exactly once.
      await settleCot(30);
      expect(cot.completeRequests()).toHaveLength(1);
      expect(cot.completeRequests()[0]?.params).toMatchObject({ reason: 'error' });
    } finally {
      vi.useRealTimers();
    }
  });
});
