import { describe, expect, it, vi } from 'vitest';

import { FeishuCotApiError } from '@excitedjs/feishu-transport';
import type {
  ChannelBindingRouteEvent,
  ChannelTeamStateEvent,
  ChannelTurnSubmittedEvent,
} from '@excitedjs/dreamux-types';

import { FeishuCotAdapter } from '../src/feishu-cot-adapter.js';
import {
  cotLeaderKey,
  DispatcherCotStateStore,
  LeaderLifecycleFence,
  type VisibleMessageAnchor,
} from '../src/feishu-cot-state.js';
import {
  assistant,
  CHANNEL_ID,
  dispatcherAssistant,
  dispatcherSettled,
  dispatcherSubmitted,
  groupEndpoint,
  groupTarget,
  harness,
  LEADER,
  origin,
  settled,
  submitted,
  TEAM,
  topicEndpoint,
  topicTarget,
  toolCall,
  userMessage,
} from './helpers/cot-fixtures.js';
import {
  settleCot,
  type FakeCotClient,
} from './helpers/fake-cot-client.js';

function runFinishedStatuses(cot: FakeCotClient, cotId: string): unknown[] {
  return cot.eventsFor(cotId)
    .filter((event) => event.eventType === 'RUN_FINISHED')
    .map((event) => event.content['status']);
}

function createdOrigins(cot: FakeCotClient): unknown[] {
  return cot.createRequests().map((request) =>
    request.data?.['origin_message_id']);
}

function openCallCount(adapter: FeishuCotAdapter): number {
  const leaders = (adapter as unknown as {
    leaders: Map<string, { openCalls: Map<string, unknown> }>;
  }).leaders;
  return [...leaders.values()][0]?.openCalls.size ?? 0;
}

function pendingTurnCount(adapter: FeishuCotAdapter): number {
  const leaders = (adapter as unknown as {
    leaders: Map<string, { pendingTurns: Map<string, unknown> }>;
  }).leaders;
  return [...leaders.values()][0]?.pendingTurns.size ?? 0;
}

function leaderStateCount(adapter: FeishuCotAdapter): number {
  return (adapter as unknown as {
    leaders: Map<string, unknown>;
  }).leaders.size;
}

function leaderFence(adapter: FeishuCotAdapter): LeaderLifecycleFence {
  return (adapter as unknown as {
    leaderFence: LeaderLifecycleFence;
  }).leaderFence;
}

function leaderAnchorState(adapter: FeishuCotAdapter): {
  generation: number;
  admittedTurnId: string | null;
  anchor: {
    chatId: string;
    messageId: string;
    target: { target_type: string; target_key: string };
  } | null;
  nextAnchor: {
    chatId: string;
    messageId: string;
    target: { target_type: string; target_key: string };
  } | null;
  active: unknown;
} | undefined {
  const leaders = (adapter as unknown as {
    leaders: Map<string, {
      generation: number;
      admittedTurnId: string | null;
      anchor: {
        chatId: string;
        messageId: string;
        target: { target_type: string; target_key: string };
      } | null;
      nextAnchor: {
        chatId: string;
        messageId: string;
        target: { target_type: string; target_key: string };
      } | null;
      active: unknown;
    }>;
  }).leaders;
  return [...leaders.values()][0];
}

function dispatcherStore(adapter: FeishuCotAdapter): DispatcherCotStateStore {
  return (adapter as unknown as {
    dispatcher: DispatcherCotStateStore;
  }).dispatcher;
}

function dispatcherStateSizes(adapter: FeishuCotAdapter): {
  conversations: number;
  turns: number;
} {
  const store = dispatcherStore(adapter) as unknown as {
    conversations: Map<string, unknown>;
    turns: Map<string, unknown>;
  };
  return {
    conversations: store.conversations.size,
    turns: store.turns.size,
  };
}

function dispatcherAnchor(chatId: string): VisibleMessageAnchor {
  return {
    chatId,
    messageId: `message-${chatId}`,
    target: topicTarget(chatId, `thread-${chatId}`),
    binding: null,
  };
}

describe('visible-message anchors', () => {
  it('drops late Reply anchors for missing leaders and foreign chats', async () => {
    const { adapter } = harness();
    adapter.refreshNextAnchor(TEAM, LEADER, {
      chatId: 'oc-group-1',
      messageId: 'om-reply-late',
      target: groupTarget(),
    });
    expect(leaderAnchorState(adapter)).toBeUndefined();

    adapter.onTurnSubmitted(submitted());
    await settleCot();
    adapter.refreshNextAnchor(TEAM, LEADER, {
      chatId: 'oc-group-2',
      messageId: 'om-reply-foreign',
      target: topicTarget('oc-group-2', 'omt-thread-2'),
    });
    expect(leaderAnchorState(adapter)).toMatchObject({
      anchor: { chatId: 'oc-group-1', messageId: 'om-source-1' },
      nextAnchor: null,
    });
  });

  it('drops a late same-chat topic receipt and keeps same-target last-write-wins', async () => {
    const { adapter } = harness();
    adapter.onTurnSubmitted(submitted({
      channel_origin: origin({
        message_id: 'om-topic-b-inbound',
        target: topicTarget('oc-group-1', 'omt-topic-b'),
      }),
    }));
    await settleCot();

    adapter.refreshNextAnchor(TEAM, LEADER, {
      chatId: 'oc-group-1',
      messageId: 'om-topic-a-late-reply',
      target: topicTarget('oc-group-1', 'omt-topic-a'),
    });
    expect(leaderAnchorState(adapter)).toMatchObject({
      anchor: {
        messageId: 'om-topic-b-inbound',
        target: { target_type: 'topic', target_key: 'omt-topic-b' },
      },
      nextAnchor: null,
    });

    for (const index of [1, 2]) {
      adapter.refreshNextAnchor(TEAM, LEADER, {
        chatId: 'oc-group-1',
        messageId: `om-topic-b-reply-${index}`,
        target: topicTarget('oc-group-1', 'omt-topic-b'),
      });
    }
    expect(leaderAnchorState(adapter)?.nextAnchor).toMatchObject({
      messageId: 'om-topic-b-reply-2',
      target: { target_type: 'topic', target_key: 'omt-topic-b' },
    });
  });

  it.each(['completion', 'scheduled'] as const)(
    'uses a binding fallback anchor for a first %s turn',
    async (turnSource) => {
      const { adapter, cot } = harness();
      adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, {
        chatId: 'oc-binding',
        messageId: 'om-binding-notification',
        target: groupTarget('oc-binding'),
        binding: groupEndpoint('oc-binding'),
      });

      expect(cot.createRequests()).toEqual([]);
      expect(leaderAnchorState(adapter)).toMatchObject({
        generation: 0,
        anchor: {
          chatId: 'oc-binding',
          messageId: 'om-binding-notification',
        },
        active: null,
      });
      adapter.onTurnSubmitted(submitted({
        turn_id: `${turnSource}-turn`,
        turn_source: turnSource,
        channel_origin: undefined,
      }));
      adapter.onTurnMessage(userMessage({
        event_id: `${turnSource}-message`,
        turn_id: `${turnSource}-turn`,
      }));
      await settleCot();

      expect(createdOrigins(cot)).toEqual(['om-binding-notification']);
      expect(cot.createRequests()[0]?.data?.['receive_id']).toBe('oc-binding');
    },
  );

  it('does not replace or detach an existing inbound anchor with a fallback', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    await settleCot();

    adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, {
      chatId: 'oc-binding',
      messageId: 'om-binding-notification',
      target: groupTarget('oc-binding'),
      binding: groupEndpoint('oc-binding'),
    });
    await settleCot();
    expect(leaderAnchorState(adapter)).toMatchObject({
      generation: 1,
      anchor: { chatId: 'oc-group-1', messageId: 'om-source-1' },
    });
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual([]);

    adapter.onTurnSettled(settled());
    await settleCot();
    adapter.onTurnSubmitted(submitted({
      turn_id: 'completion-after-binding',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(userMessage({
      event_id: 'completion-after-binding-message',
      turn_id: 'completion-after-binding',
    }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-source-1']);
  });

  it('keeps the current card fixed and consumes only the last Reply on the next card', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    await settleCot();

    for (const index of [1, 2]) {
      adapter.refreshNextAnchor(TEAM, LEADER, {
        chatId: 'oc-group-1',
        messageId: `om-reply-${index}`,
        target: topicTarget(),
      });
    }
    adapter.onTurnMessage(assistant({ event_id: 'current-card-continues' }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1']);
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual([]);
    expect(leaderAnchorState(adapter)).toMatchObject({
      generation: 1,
      anchor: { messageId: 'om-source-1' },
      nextAnchor: { messageId: 'om-reply-2' },
    });

    adapter.onTurnSettled(settled());
    await settleCot();
    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-2',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'next-card-activity',
      turn_id: 'turn-2',
    }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-reply-2']);
    expect(leaderAnchorState(adapter)).toMatchObject({
      generation: 1,
      anchor: { messageId: 'om-reply-2' },
      nextAnchor: null,
    });
  });

  it('discards a pending Reply anchor when a newer inbound anchor arrives', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    await settleCot();
    adapter.refreshNextAnchor(TEAM, LEADER, {
      chatId: 'oc-group-1',
      messageId: 'om-reply-pending',
      target: topicTarget(),
    });

    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-2',
      channel_origin: origin({ message_id: 'om-inbound-2' }),
    }));
    await settleCot();
    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-inbound-2']);
    expect(leaderAnchorState(adapter)).toMatchObject({
      anchor: { messageId: 'om-inbound-2' },
      nextAnchor: null,
    });

    adapter.onTurnSettled(settled({ turn_id: 'turn-2' }));
    await settleCot();
    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-3',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'turn-3-activity',
      turn_id: 'turn-3',
    }));
    await settleCot();
    expect(createdOrigins(cot)).toEqual([
      'om-source-1',
      'om-inbound-2',
      'om-inbound-2',
    ]);
  });

  it('prefers a Reply next anchor over the binding fallback anchor', async () => {
    const { adapter, cot } = harness();
    adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, {
      chatId: 'oc-binding',
      messageId: 'om-binding-notification',
      target: groupTarget('oc-binding'),
      binding: groupEndpoint('oc-binding'),
    });
    adapter.refreshNextAnchor(TEAM, LEADER, {
      chatId: 'oc-binding',
      messageId: 'om-reply-after-binding',
      target: groupTarget('oc-binding'),
    });

    adapter.onTurnSubmitted(submitted({
      turn_id: 'completion-after-binding',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(userMessage({
      event_id: 'completion-after-binding-message',
      turn_id: 'completion-after-binding',
    }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-reply-after-binding']);
    expect(cot.createRequests()[0]?.data?.['receive_id']).toBe('oc-binding');
    expect(leaderAnchorState(adapter)).toMatchObject({
      anchor: { messageId: 'om-reply-after-binding' },
      nextAnchor: null,
    });
  });

  it('eagerly creates a fixed receipt before the first runtime activity', async () => {
    const { adapter, cot } = harness();

    adapter.onTurnSubmitted(submitted());
    await settleCot();
    expect(createdOrigins(cot)).toEqual(['om-source-1']);
    expect(cot.createRequests()[0]?.data).toMatchObject({
      origin_message_id: 'om-source-1',
      cot_hidden: false,
      enable_badge: false,
      update_feed_rank: false,
    });
    expect(cot.createRequests()[0]?.data).not.toHaveProperty('reply_in_thread');
    expect(cot.eventTypesFor('cot-1')).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(cot.eventsFor('cot-1').find((event) =>
      event.eventType === 'TEXT_MESSAGE_CONTENT')?.content['delta'])
      .toBe('已收到消息，开始处理。');

    adapter.onTurnMessage(assistant());
    await settleCot();

    expect(cot.eventTypesFor('cot-1')).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
  });

  it('diagnoses an empty projection after creating only the fixed receipt', async () => {
    const { adapter, cot, logs } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant({ content: ' \n\t ' }));
    await settleCot();

    expect(cot.createdCotIds()).toEqual(['cot-1']);
    expect(cot.eventTypesFor('cot-1').filter((type) =>
      type === 'TEXT_MESSAGE_START')).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'debug',
      fields: expect.objectContaining({
        activity: 'assistant',
        reason: 'empty_after_projection',
      }),
    }));
  });

  it('gates missing and disabled anchors before projection diagnostics', async () => {
    const missing = harness();
    missing.adapter.onTurnMessage(assistant({ content: ' \n\t ' }));
    expect(missing.logs).not.toContainEqual(expect.objectContaining({
      fields: expect.objectContaining({ reason: 'empty_after_projection' }),
    }));

    const disabled = harness();
    disabled.cot.failNextCreate(new Error('create failed'));
    disabled.adapter.onTurnSubmitted(submitted());
    disabled.adapter.onTurnMessage(assistant({ event_id: 'disable-generation' }));
    await settleCot();
    const before = disabled.logs.filter((line) =>
      line.fields['reason'] === 'empty_after_projection').length;
    disabled.adapter.onTurnMessage(assistant({
      event_id: 'empty-while-disabled',
      content: ' \n\t ',
    }));
    expect(disabled.logs.filter((line) =>
      line.fields['reason'] === 'empty_after_projection')).toHaveLength(before);
  });

  it('keeps all Reply activity on the inbound anchor', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    for (const index of [1, 2]) {
      adapter.onTurnToolCall(toolCall({
        event_id: `reply-${index}-start`,
        call_id: `reply-${index}`,
        tool_name: 'feishu.reply',
        arguments_json: JSON.stringify({ text: `reply ${index}` }),
      }));
      adapter.onTurnToolCall(toolCall({
        event_id: `reply-${index}-result`,
        call_id: `reply-${index}`,
        tool_name: 'feishu.reply',
        status: 'completed',
        arguments_json: JSON.stringify({ text: `reply ${index}` }),
        result_json: JSON.stringify({ message_ids: [`om-reply-${index}`] }),
      }));
      adapter.onTurnMessage(assistant({ event_id: `after-reply-${index}` }));
    }
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1']);
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual([]);
  });

  it('moves only when a newer inbound message supplies a new anchor', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-inbound-2',
      channel_origin: origin({
        message_id: 'om-inbound-2',
      }),
    }));
    adapter.onTurnMessage(assistant({ event_id: 'after-interleave' }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-inbound-2']);
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual(['done']);
  });

  it('keeps React activity on the same anchor and never finishes it', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnToolCall(toolCall({
      tool_name: 'feishu.react',
      arguments_json: JSON.stringify({
        chat_id: 'oc-secret',
        message_id: 'om-secret',
        emoji: 'THUMBSUP',
      }),
    }));
    adapter.onTurnToolCall(toolCall({
      event_id: 'evt-react-result',
      tool_name: 'feishu.react',
      status: 'completed',
      arguments_json: JSON.stringify({
        message_id: 'om-secret',
        emoji: 'THUMBSUP',
      }),
      result_json: JSON.stringify({ reaction_id: 'on-secret' }),
    }));
    await settleCot();

    expect(cot.createdCotIds()).toEqual(['cot-1']);
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual([]);
    expect(cot.eventTypesFor('cot-1')).toContain('TOOL_CALL_RESULT');
    expect(JSON.stringify(cot.eventsFor('cot-1'))).not.toContain('om-secret');
  });

  it('accepts only the admitted leader turn and ignores member and user activity', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant({
      event_id: 'admitted-leader',
      content: 'admitted leader activity',
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'unadmitted-leader',
      turn_id: 'turn-unadmitted',
      content: 'unadmitted leader activity',
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'mate',
      role: 'team_member',
      agent_name: 'mate',
    }));
    adapter.onTurnMessage(assistant({ event_id: 'user', message_role: 'user' }));
    await settleCot();

    expect(cot.createdCotIds()).toEqual(['cot-1']);
    expect(cot.eventTypesFor('cot-1').filter((type) =>
      type === 'TEXT_MESSAGE_START')).toHaveLength(2);
    expect(JSON.stringify(cot.eventsFor('cot-1'))).toContain(
      'admitted leader activity',
    );
    expect(JSON.stringify(cot.eventsFor('cot-1'))).not.toContain(
      'unadmitted leader activity',
    );
  });

  it.each([
    ['completed', 'done'],
    ['failed', 'interrupted'],
    ['stopped', 'interrupted'],
  ] as const)('settles %s by closing the current card as %s', async (status, terminal) => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant());
    await settleCot();

    adapter.onTurnSettled(settled({ status }));
    await settleCot();

    expect(runFinishedStatuses(cot, 'cot-1')).toEqual([terminal]);
    expect(createdOrigins(cot)).toEqual(['om-source-1']);
  });

  it('reuses the preserved inbound anchor for activity after settlement', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    await settleCot();
    adapter.onTurnSettled(settled());
    await settleCot();

    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-2',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'next-turn-activity',
      turn_id: 'turn-2',
    }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-source-1']);
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual(['done']);
    expect(runFinishedStatuses(cot, 'cot-2')).toEqual([]);
  });
});

describe('leader lifecycle fences', () => {
  const teamState = (
    status: ChannelTeamStateEvent['status'],
    teamName = TEAM,
    leaderName = LEADER,
  ): ChannelTeamStateEvent => ({
    schema_version: 1,
    kind: 'team.state',
    occurred_at: 10,
    team_name: teamName,
    leader_name: leaderName,
    status,
  });

  const unbound = (
    chatId = 'oc-group-1',
    teamName = TEAM,
    leaderName = LEADER,
  ): ChannelBindingRouteEvent => ({
    schema_version: 1,
    kind: 'binding.route',
    occurred_at: 11,
    action: 'unbound',
    transition: 'unbound',
    endpoint: groupEndpoint(chatId),
    previous_team: { team_name: teamName, leader_name: leaderName },
    current_team: null,
  });

  const bound = (
    transition: 'bound' | 'replaced' = 'bound',
    chatId = 'oc-group-1',
  ): ChannelBindingRouteEvent => ({
    schema_version: 1,
    kind: 'binding.route',
    occurred_at: 12,
    action: 'bound',
    transition,
    endpoint: groupEndpoint(chatId),
    previous_team: transition === 'replaced'
      ? { team_name: TEAM, leader_name: LEADER }
      : null,
    current_team: {
      team_name: transition === 'replaced' ? 'team-beta' : TEAM,
      leader_name: transition === 'replaced' ? 'leader-beta' : LEADER,
      leader_agent_runtime: 'codex',
      runtime_cwd: '/workspace/team',
    },
  });

  const submittedForChat = (
    chatId: string,
    turnId: string,
  ): ChannelTurnSubmittedEvent => submitted({
    turn_id: turnId,
    channel_origin: origin({
      message_id: `message-${turnId}`,
      target: groupTarget(chatId),
      binding: groupEndpoint(chatId),
    }),
  });

  it('drops a late submitted turn after Team close without creating state', async () => {
    const { adapter, cot } = harness();
    adapter.onTeamState(teamState('closed'));

    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant());
    await settleCot();

    expect(leaderStateCount(adapter)).toBe(0);
    expect(cot.createRequests()).toEqual([]);
  });

  it('drops a late submitted turn after route unbind without creating state', async () => {
    const { adapter, cot } = harness();
    adapter.onBindingRoute(unbound());

    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant());
    await settleCot();

    expect(leaderStateCount(adapter)).toBe(0);
    expect(cot.createRequests()).toEqual([]);
  });

  it('drops a late submitted turn for the previous Team after route replacement', async () => {
    const { adapter, cot } = harness();
    adapter.onBindingRoute(bound('replaced'));

    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant());
    await settleCot();

    expect(leaderStateCount(adapter)).toBe(0);
    expect(cot.createRequests()).toEqual([]);
  });

  it('keeps a surviving endpoint live while rejecting the unbound endpoint', async () => {
    const { adapter, cot } = harness();
    adapter.onBindingRoute(unbound('oc-endpoint-a'));

    adapter.onTurnSubmitted(submittedForChat('oc-endpoint-b', 'turn-b'));
    await settleCot();
    expect(leaderStateCount(adapter)).toBe(1);
    expect(createdOrigins(cot)).toEqual(['message-turn-b']);

    adapter.onTurnSubmitted(submittedForChat('oc-endpoint-a', 'turn-a'));
    adapter.onTurnMessage(assistant({
      event_id: 'late-a',
      turn_id: 'turn-a',
      content: 'rejected endpoint activity',
    }));
    adapter.onTurnToolCall(toolCall({
      event_id: 'late-a-tool',
      turn_id: 'turn-a',
      tool_name: 'shell',
    }));
    await settleCot();

    expect(leaderStateCount(adapter)).toBe(1);
    expect(createdOrigins(cot)).toEqual(['message-turn-b']);
    expect(JSON.stringify(cot.eventsFor('cot-1'))).not.toContain(
      'rejected endpoint activity',
    );
    expect(cot.eventTypesFor('cot-1')).not.toContain('TOOL_CALL_START');
  });

  it('does not let a fenced turn open on a surviving inactive anchor', async () => {
    const { adapter, cot } = harness();
    adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, {
      chatId: 'oc-endpoint-b',
      messageId: 'om-binding-b',
      target: groupTarget('oc-endpoint-b'),
      binding: groupEndpoint('oc-endpoint-b'),
    });
    adapter.onBindingRoute(unbound('oc-endpoint-a'));

    expect(leaderAnchorState(adapter)).toMatchObject({
      anchor: { chatId: 'oc-endpoint-b', messageId: 'om-binding-b' },
      active: null,
    });
    adapter.onTurnSubmitted(submittedForChat('oc-endpoint-a', 'turn-a'));
    adapter.onTurnMessage(assistant({
      event_id: 'late-a-with-inactive-state',
      turn_id: 'turn-a',
      content: 'must not open on endpoint B',
    }));
    await settleCot();

    expect(leaderAnchorState(adapter)).toMatchObject({
      anchor: { chatId: 'oc-endpoint-b', messageId: 'om-binding-b' },
      active: null,
    });
    expect(cot.createRequests()).toEqual([]);
  });

  it('matches route fences to the authoritative accepted binding only', async () => {
    const groupFence = harness();
    groupFence.adapter.onBindingRoute(unbound('oc-group-1'));
    groupFence.adapter.onTurnSubmitted(submitted({
      turn_id: 'topic-bound-turn',
      channel_origin: origin({
        message_id: 'om-topic-bound',
        target: topicTarget('oc-group-1', 'omt-topic-b'),
        binding: topicEndpoint('oc-group-1', 'omt-topic-b'),
      }),
    }));
    await settleCot();
    expect(createdOrigins(groupFence.cot)).toEqual(['om-topic-bound']);

    const topicFence = harness();
    topicFence.adapter.onBindingRoute({
      ...unbound('oc-group-1'),
      endpoint: topicEndpoint('oc-group-1', 'omt-topic-a'),
    });
    topicFence.adapter.onTurnSubmitted(submitted({
      turn_id: 'group-bound-topic-target',
      channel_origin: origin({
        message_id: 'om-group-bound-topic',
        target: topicTarget('oc-group-1', 'omt-topic-a'),
        binding: groupEndpoint('oc-group-1'),
      }),
    }));
    await settleCot();
    expect(createdOrigins(topicFence.cot)).toEqual(['om-group-bound-topic']);

    const claimRelease = harness();
    claimRelease.adapter.onBindingRoute({
      ...unbound('oc-group-1'),
      endpoint: topicEndpoint('oc-group-1', 'omt-released-claim'),
    });
    claimRelease.adapter.onTurnSubmitted(submitted({
      turn_id: 'surviving-group-turn',
      channel_origin: origin({
        message_id: 'om-surviving-group',
        target: groupTarget('oc-group-1'),
        binding: groupEndpoint('oc-group-1'),
      }),
    }));
    await settleCot();
    expect(createdOrigins(claimRelease.cot)).toEqual(['om-surviving-group']);
  });

  it('allows a surviving endpoint fallback while another endpoint is fenced', () => {
    const { adapter } = harness();
    adapter.onBindingRoute(unbound('oc-endpoint-a'));
    adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, {
      chatId: 'oc-endpoint-b',
      messageId: 'om-binding-b',
      target: groupTarget('oc-endpoint-b'),
      binding: groupEndpoint('oc-endpoint-b'),
    });

    expect(leaderAnchorState(adapter)).toMatchObject({
      anchor: { chatId: 'oc-endpoint-b', messageId: 'om-binding-b' },
    });
  });

  it('rejects a fenced endpoint fallback and its following internal turn', async () => {
    const { adapter, cot } = harness();
    adapter.onBindingRoute(unbound('oc-fenced'));

    adapter.setFallbackAnchorIfAbsent(TEAM, LEADER, {
      chatId: 'oc-fenced',
      messageId: 'om-late-notification',
      target: groupTarget('oc-fenced'),
      binding: groupEndpoint('oc-fenced'),
    });
    expect(leaderStateCount(adapter)).toBe(0);

    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-completion',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'completion-activity',
      turn_id: 'turn-completion',
    }));
    await settleCot();

    expect(leaderStateCount(adapter)).toBe(0);
    expect(cot.createRequests()).toEqual([]);
  });

  it('clears the fence when the Team runs again or receives a new bound route', async () => {
    const restarted = harness();
    restarted.adapter.onTeamState(teamState('closed'));
    restarted.adapter.onBindingRoute(unbound());
    expect(leaderFence(restarted.adapter).leaderSize).toBe(1);
    expect(leaderFence(restarted.adapter).routeSize).toBe(1);
    restarted.adapter.onTeamState(teamState('running'));
    expect(leaderFence(restarted.adapter).leaderSize).toBe(0);
    expect(leaderFence(restarted.adapter).routeSize).toBe(0);
    restarted.adapter.onTurnSubmitted(submitted());
    await settleCot();
    expect(restarted.cot.createRequests()).toHaveLength(1);

    const rebound = harness();
    rebound.adapter.onBindingRoute(unbound());
    rebound.adapter.onBindingRoute(bound());
    expect(leaderFence(rebound.adapter).routeSize).toBe(0);
    rebound.adapter.onTurnSubmitted(submitted());
    await settleCot();
    expect(rebound.cot.createRequests()).toHaveLength(1);
  });

  it('bounds leader and route fence memory at 512 entries and drops the oldest', async () => {
    const { adapter, cot } = harness();
    for (let index = 0; index < 513; index += 1) {
      adapter.onTeamState(teamState(
        'closed',
        `team-${index}`,
        `leader-${index}`,
      ));
    }

    const fences = leaderFence(adapter);
    expect(fences.leaderSize).toBe(512);
    expect(fences.blocksAnchor(
      cotLeaderKey('team-0', 'leader-0'),
      { binding: groupEndpoint() },
      CHANNEL_ID,
    )).toBe(false);
    expect(fences.blocksAnchor(
      cotLeaderKey('team-512', 'leader-512'),
      { binding: groupEndpoint() },
      CHANNEL_ID,
    )).toBe(true);

    for (let index = 0; index < 513; index += 1) {
      adapter.onBindingRoute({
        ...unbound(`oc-foreign-${index}`, 'foreign-team', 'foreign-leader'),
        endpoint: {
          ...groupEndpoint(`oc-foreign-${index}`),
          channel_id: 'foreign-channel',
        },
      });
    }
    expect(fences.routeSize).toBe(0);

    for (let index = 0; index < 513; index += 1) {
      adapter.onBindingRoute(unbound(
        `oc-route-${index}`,
        'route-team',
        'route-leader',
      ));
    }
    const routeLeaderKey = cotLeaderKey('route-team', 'route-leader');
    expect(fences.routeSize).toBe(512);
    expect(fences.blocksAnchor(
      routeLeaderKey,
      { binding: groupEndpoint('oc-route-0') },
      CHANNEL_ID,
    )).toBe(false);
    expect(fences.blocksAnchor(
      routeLeaderKey,
      { binding: groupEndpoint('oc-route-512') },
      CHANNEL_ID,
    )).toBe(true);

    adapter.onTurnSubmitted(submitted({
      team_name: 'team-0',
      agent_name: 'leader-0',
      turn_id: 'turn-oldest',
    }));
    adapter.onTurnSubmitted(submitted({
      team_name: 'team-512',
      agent_name: 'leader-512',
      turn_id: 'turn-newest',
    }));
    await settleCot();

    expect(leaderStateCount(adapter)).toBe(1);
    expect(cot.createRequests()).toHaveLength(1);
  });
});

describe('team-member display exclusion', () => {
  it('ignores all member event kinds without creating presentation state', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted({
      role: 'team_member',
      agent_name: 'member',
    }));
    adapter.onTurnMessage(assistant({
      role: 'team_member',
      agent_name: 'member',
      content: 'member assistant activity',
    }));
    adapter.onTurnToolCall(toolCall({
      role: 'team_member',
      agent_name: 'member',
    }));
    adapter.onTurnSettled(settled({
      role: 'team_member',
      agent_name: 'member',
    }));
    await settleCot();

    expect(leaderStateCount(adapter)).toBe(0);
    expect(dispatcherStateSizes(adapter)).toEqual({ conversations: 0, turns: 0 });
    expect(cot.createRequests()).toEqual([]);
  });

  it('renders only the leader when leader and member turns share a Team', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnSubmitted(submitted({
      role: 'team_member',
      agent_name: 'member',
      turn_id: 'member-turn',
    }));
    adapter.onTurnMessage(assistant({
      role: 'team_member',
      agent_name: 'member',
      turn_id: 'member-turn',
      content: 'member activity must remain hidden',
    }));
    adapter.onTurnMessage(assistant({ content: 'leader activity remains visible' }));
    await settleCot();

    expect(cot.createdCotIds()).toEqual(['cot-1']);
    expect(JSON.stringify(cot.eventsFor('cot-1'))).toContain(
      'leader activity remains visible',
    );
    expect(JSON.stringify(cot.eventsFor('cot-1'))).not.toContain(
      'member activity must remain hidden',
    );
  });
});

describe('dispatcher conversation isolation', () => {
  it('runs concurrent chats without stealing or closing either card', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(dispatcherSubmitted('chat-a', 'turn-a'));
    adapter.onTurnSubmitted(dispatcherSubmitted('chat-b', 'turn-b'));
    adapter.onTurnMessage(dispatcherAssistant('turn-a', 'activity-a'));
    adapter.onTurnMessage(dispatcherAssistant('turn-b', 'activity-b'));
    await settleCot();

    expect(cot.createRequests().map((request) => request.data?.['receive_id']))
      .toEqual(['chat-a', 'chat-b']);
    adapter.onTurnSettled(dispatcherSettled('turn-a'));
    await settleCot();

    expect(runFinishedStatuses(cot, 'cot-1')).toEqual(['done']);
    expect(runFinishedStatuses(cot, 'cot-2')).toEqual([]);

    adapter.onTurnSettled(dispatcherSettled('turn-b', { status: 'failed' }));
    await settleCot();
    expect(runFinishedStatuses(cot, 'cot-2')).toEqual(['interrupted']);
  });

  it('treats foreign channel origins as strict dispatcher no-ops', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(dispatcherSubmitted('chat-a', 'turn-a'));
    adapter.onTurnMessage(dispatcherAssistant('turn-a', 'activity-a'));
    await settleCot();
    const before = dispatcherStateSizes(adapter);

    adapter.onTurnSubmitted(dispatcherSubmitted('chat-b', 'turn-foreign', {
      channel_origin: origin({
        channel_id: 'foreign-channel',
        message_id: 'foreign-message',
        target: topicTarget('chat-b', 'foreign-thread'),
        binding: groupEndpoint('chat-b'),
      }),
    }));
    expect(dispatcherStateSizes(adapter)).toEqual(before);
    adapter.onTurnMessage(dispatcherAssistant('turn-foreign', 'foreign-activity'));
    expect(dispatcherStateSizes(adapter)).toEqual(before);
    adapter.onTurnSettled(dispatcherSettled('turn-foreign'));
    expect(dispatcherStateSizes(adapter)).toEqual(before);
    await settleCot();

    expect(dispatcherStateSizes(adapter)).toEqual(before);
    expect(cot.createdCotIds()).toEqual(['cot-1']);
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual([]);
  });

  it.each(['create', 'append'] as const)(
    'reaps settled dispatcher state after a hung %s reaches the I/O deadline',
    async (stage) => {
      vi.useFakeTimers();
      try {
        const { adapter, cot } = harness();
        if (stage === 'create') cot.blockNextCreate();
        else cot.blockNextAppend();

        adapter.onTurnSubmitted(dispatcherSubmitted('chat-a', 'turn-hung'));
        await vi.advanceTimersByTimeAsync(0);
        expect(dispatcherStateSizes(adapter)).toEqual({
          conversations: 1,
          turns: 1,
        });

        adapter.onTurnSettled(dispatcherSettled('turn-hung'));
        await vi.advanceTimersByTimeAsync(20_001);
        await vi.advanceTimersByTimeAsync(0);

        expect(dispatcherStateSizes(adapter)).toEqual({
          conversations: 0,
          turns: 0,
        });
        expect(dispatcherStore(adapter).begin(
          'dispatcher',
          'turn-after-deadline',
          dispatcherAnchor('chat-a'),
        ).status).toBe('started');
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('leader settlement correlation', () => {
  it('ignores a stale settlement and wraps only the matching active turn', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted({ turn_id: 'turn-a' }));
    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-b',
      channel_origin: origin({ message_id: 'message-b' }),
    }));
    await settleCot();

    adapter.onTurnSettled(settled({ turn_id: 'turn-a' }));
    await settleCot();
    expect(runFinishedStatuses(cot, 'cot-2')).toEqual([]);

    adapter.onTurnSettled(settled({ turn_id: 'turn-b', status: 'stopped' }));
    await settleCot();
    expect(runFinishedStatuses(cot, 'cot-2')).toEqual(['interrupted']);
  });
});

describe('internal input projection', () => {
  it('shows completion and scheduled user text once at the current anchor', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnSubmitted(submitted({
      turn_id: 'completion-turn',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(userMessage({
      event_id: 'completion-message',
      turn_id: 'completion-turn',
      content: 'TeamMate 已完成安全处理',
    }));
    adapter.onTurnMessage(userMessage({
      event_id: 'completion-duplicate',
      turn_id: 'completion-turn',
      content: '重复内容不得显示',
    }));
    adapter.onTurnSubmitted(submitted({
      turn_id: 'scheduled-turn',
      turn_source: 'scheduled',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(userMessage({
      event_id: 'scheduled-message',
      turn_id: 'scheduled-turn',
      content: '定时任务已触发',
    }));
    await settleCot();

    const rendered = cot.eventsFor('cot-1');
    const userStarts = rendered.filter((event) =>
      event.eventType === 'TEXT_MESSAGE_START' && event.content['role'] === 'user');
    expect(userStarts).toHaveLength(2);
    expect(JSON.stringify(rendered)).toContain('TeamMate 已完成安全处理');
    expect(JSON.stringify(rendered)).toContain('定时任务已触发');
    expect(JSON.stringify(rendered)).not.toContain('重复内容不得显示');
  });

  it('hides channel, orchestration, missing, and unknown user sources', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    const hiddenSources = [
      'channel',
      'dispatcher',
      'team_leader',
      'control',
      undefined,
      'future-source',
    ] as const;
    for (const [index, source] of hiddenSources.entries()) {
      adapter.onTurnSubmitted(submitted({
        turn_id: `hidden-${index}`,
        channel_origin: undefined,
        turn_source: source as never,
      }));
      adapter.onTurnMessage(userMessage({
        event_id: `hidden-message-${index}`,
        turn_id: `hidden-${index}`,
        content: `hidden prompt ${index}`,
      }));
    }
    await settleCot();

    expect(JSON.stringify(cot.eventsFor('cot-1'))).not.toContain('hidden prompt');
  });

  it('keeps the current anchor when a Channel origin snapshot is missing', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnSubmitted(submitted({
      turn_id: 'snapshot-failed',
      turn_source: 'channel',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(userMessage({
      event_id: 'must-hide-channel-user',
      turn_id: 'snapshot-failed',
      content: '真实 Channel 原文不得泄漏',
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'still-current-anchor',
      turn_id: 'turn-1',
      content: '继续在当前锚点展示过程',
    }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1']);
    expect(JSON.stringify(cot.eventsFor('cot-1'))).not.toContain('真实 Channel 原文');
    expect(JSON.stringify(cot.eventsFor('cot-1'))).toContain('继续在当前锚点展示过程');
  });

  it('clears pending turns on generation advance and bounds drop-newest state', async () => {
    const { adapter, cot, logs } = harness();
    adapter.onTurnSubmitted(submitted());
    for (let index = 0; index < 513; index += 1) {
      adapter.onTurnSubmitted(submitted({
        turn_id: `completion-${index}`,
        turn_source: 'completion',
        channel_origin: undefined,
      }));
    }
    expect(pendingTurnCount(adapter)).toBe(512);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      fields: expect.objectContaining({ reason: 'pending_turns_full' }),
    }));

    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-2',
      channel_origin: origin({ message_id: 'om-source-2' }),
    }));
    expect(pendingTurnCount(adapter)).toBe(0);
    adapter.onTurnMessage(userMessage({
      event_id: 'late-completion',
      turn_id: 'completion-0',
      content: '迟到内容不得迁移',
    }));
    await settleCot();
    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-source-2']);

    adapter.onTurnMessage(assistant({
      event_id: 'new-generation-work',
      turn_id: 'turn-2',
      content: '新一代过程',
    }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-source-2']);
    expect(JSON.stringify(cot.eventsFor('cot-2'))).toContain('新一代过程');
    expect(JSON.stringify(cot.eventsFor('cot-2'))).not.toContain('迟到内容不得迁移');
  });
});

describe('generation and terminal fences', () => {
  it('does not disable a same-generation card that replaced an abandoned one', async () => {
    const { adapter, cot } = harness();
    cot.failNextCreate(new Error('old create failed'));
    const releaseCreate = cot.blockNextCreate();
    adapter.onTurnSubmitted(submitted());
    await new Promise((resolve) => setImmediate(resolve));

    adapter.onTurnSettled(settled());
    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-2',
      turn_source: 'completion',
      channel_origin: undefined,
    }));
    adapter.onTurnMessage(assistant({
      event_id: 'replacement-opening',
      turn_id: 'turn-2',
    }));
    releaseCreate();
    await settleCot(20);
    adapter.onTurnMessage(assistant({
      event_id: 'replacement-follow-up',
      turn_id: 'turn-2',
      content: 'replacement remains enabled',
    }));
    await settleCot();

    expect(createdOrigins(cot)).toEqual(['om-source-1']);
    expect(JSON.stringify(cot.eventsFor('cot-1'))).toContain(
      'replacement remains enabled',
    );
  });

  it('does not revive a card whose create returns after a new anchor', async () => {
    const { adapter, cot } = harness();
    const releaseCreate = cot.blockNextCreate();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant({ event_id: 'old-work' }));

    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-2',
      channel_origin: origin({ message_id: 'om-source-2' }),
    }));
    adapter.onTurnMessage(assistant({ event_id: 'new-work' }));
    releaseCreate();
    await settleCot(20);

    expect(createdOrigins(cot)).toEqual(['om-source-1', 'om-source-2']);
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual(['done']);
    expect(runFinishedStatuses(cot, 'cot-2')).toEqual([]);
  });

  it('keeps a Reply terminal on the inbound card without changing its anchor', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnToolCall(toolCall({
      tool_name: 'feishu.reply',
      arguments_json: JSON.stringify({
        chat_id: 'oc-group-1',
        message_id: 'om-source-1',
        text: 'user-visible answer',
      }),
    }));
    await settleCot();

    adapter.onTurnToolCall(toolCall({
      event_id: 'reply-terminal',
      tool_name: 'feishu.reply',
      status: 'completed',
      arguments_json: JSON.stringify({ text: 'user-visible answer' }),
      result_json: JSON.stringify({ message_ids: ['om-reply-1'] }),
    }));
    await settleCot();

    expect(cot.createdCotIds()).toEqual(['cot-1']);
    expect(createdOrigins(cot)).toEqual(['om-source-1']);
    expect(cot.eventTypesFor('cot-1')).toContain('TOOL_CALL_RESULT');
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual([]);
  });

  it('does not append an orphan terminal to the eager receipt card', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnToolCall(toolCall({
      status: 'completed',
      result_json: JSON.stringify({ ok: true }),
    }));
    await settleCot();
    expect(cot.createdCotIds()).toEqual(['cot-1']);
    expect(cot.eventTypesFor('cot-1')).not.toContain('TOOL_CALL_RESULT');
  });

  it('bounds the leader-level open-call ledger', async () => {
    const { adapter } = harness();
    adapter.onTurnSubmitted(submitted());
    for (let index = 0; index < 530; index += 1) {
      adapter.onTurnToolCall(toolCall({ call_id: `call-${index}` }));
      if (index % 25 === 0) await settleCot();
    }
    await settleCot(24);
    expect(openCallCount(adapter)).toBe(512);
  });

  it('isolates reused call ids by turn when an old terminal arrives late', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnToolCall(toolCall({
      event_id: 'old-start',
      turn_id: 'turn-old',
      call_id: 'shared-call',
    }));
    await settleCot();

    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-new',
      channel_origin: origin({ message_id: 'om-source-2' }),
    }));
    adapter.onTurnToolCall(toolCall({
      event_id: 'new-start',
      turn_id: 'turn-new',
      call_id: 'shared-call',
    }));
    adapter.onTurnToolCall(toolCall({
      event_id: 'old-terminal',
      turn_id: 'turn-old',
      call_id: 'shared-call',
      status: 'completed',
      result_json: JSON.stringify({ output: 'old-result-must-not-migrate' }),
    }));
    expect(openCallCount(adapter)).toBe(1);
    adapter.onTurnToolCall(toolCall({
      event_id: 'new-terminal',
      turn_id: 'turn-new',
      call_id: 'shared-call',
      status: 'completed',
      result_json: JSON.stringify({ output: 'new-result-stays-local' }),
    }));
    await settleCot();

    const newEvents = cot.eventsFor('cot-2');
    expect(newEvents.filter((event) =>
      event.eventType === 'TOOL_CALL_RESULT')).toHaveLength(1);
    expect(JSON.stringify(newEvents)).toContain('new-result-stays-local');
    expect(JSON.stringify(newEvents)).not.toContain('old-result-must-not-migrate');
    expect(openCallCount(adapter)).toBe(0);
  });

  it('projects the Core-processed terminal payload and consumes the open call', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnToolCall(toolCall({ call_id: 'fallible-projection' }));
    await settleCot();
    adapter.onTurnToolCall(toolCall({
      event_id: 'throwing-terminal',
      call_id: 'fallible-projection',
      status: 'completed',
      result_json: 'visible Core result',
    }));
    await settleCot();

    expect(JSON.stringify(cot.eventsFor('cot-1'))).toContain('visible Core result');
    expect(openCallCount(adapter)).toBe(0);
  });

  it('bounds an escape-heavy terminal and consumes its open call', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnToolCall(toolCall({ call_id: 'escape-heavy' }));
    adapter.onTurnToolCall(toolCall({
      event_id: 'escape-heavy-terminal',
      call_id: 'escape-heavy',
      status: 'completed',
      result_json: JSON.stringify(
        Array.from({ length: 20 }, () => `${'\\'.repeat(256)}\u0000"`),
      ),
    }));
    await settleCot();

    expect(cot.eventTypesFor('cot-1')).toContain('TOOL_CALL_RESULT');
    const rendered = JSON.stringify(cot.eventsFor('cot-1'));
    expect(rendered).toContain('…（已截断）');
    expect(cot.eventsFor('cot-1').every((event) =>
      Buffer.byteLength(JSON.stringify(event.content), 'utf8') <= 4_096)).toBe(true);
    expect(openCallCount(adapter)).toBe(0);
  });
});

describe('failure isolation and lifecycle fences', () => {
  it('disables a failed generation and re-enables only on a new anchor', async () => {
    const { adapter, cot } = harness();
    cot.failNextCreate(new Error('create failed'));
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant({ event_id: 'first-attempt' }));
    await settleCot();

    expect(leaderAnchorState(adapter)?.admittedTurnId).toBeNull();
    adapter.onTurnMessage(assistant({ event_id: 'forbidden-retry' }));
    await settleCot();
    expect(cot.createRequests()).toEqual([]);

    adapter.onTurnSubmitted(submitted({
      turn_id: 'turn-2',
      channel_origin: origin({ message_id: 'om-source-2' }),
    }));
    expect(leaderAnchorState(adapter)?.admittedTurnId).toBe('turn-2');
    adapter.onTurnMessage(assistant({ event_id: 'next-generation' }));
    await settleCot();
    expect(createdOrigins(cot)).toEqual(['om-source-2']);
  });

  it('best-effort completes once after append failure and never retries the card', async () => {
    const { adapter, cot } = harness();
    cot.failNextAppend(new Error('append failed'));
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant());
    await settleCot();

    expect(cot.completeRequests()).toHaveLength(1);
    adapter.onTurnMessage(assistant({ event_id: 'after-append-failure' }));
    await settleCot();
    expect(cot.createRequests()).toHaveLength(1);
    expect(cot.completeRequests()).toHaveLength(1);
  });

  it('independently completes once when close aborts a slow append', async () => {
    vi.useFakeTimers();
    let releaseAppend: (() => void) | undefined;
    try {
      const { adapter, cot } = harness();
      adapter.onTurnSubmitted(submitted());
      adapter.onTurnMessage(assistant({ event_id: 'initial' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(cot.appendRequests()).toHaveLength(1);

      releaseAppend = cot.blockNextAppend();
      adapter.onTurnMessage(assistant({ event_id: 'slow' }));
      await vi.advanceTimersByTimeAsync(0);

      const closing = adapter.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      await vi.advanceTimersByTimeAsync(0);

      expect(cot.completeRequests()).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            message_id: 'om-cot-1',
            reason: 'error',
          }),
        }),
      ]);

      releaseAppend();
      releaseAppend = undefined;
      await vi.runAllTimersAsync();
      expect(cot.appendRequests()).toHaveLength(2);
      expect(cot.completeRequests()).toHaveLength(1);
    } finally {
      releaseAppend?.();
      vi.useRealTimers();
    }
  });

  it('disposes a create that returns after the close drain fence', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, cot } = harness();
      const releaseCreate = cot.blockNextCreate();
      adapter.onTurnSubmitted(submitted());
      adapter.onTurnMessage(assistant());
      await vi.advanceTimersByTimeAsync(0);

      const closing = adapter.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      releaseCreate();
      await vi.runAllTimersAsync();

      expect(cot.createRequests()).toHaveLength(1);
      expect(cot.appendRequests()).toEqual([]);
      expect(cot.completeRequests()).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            message_id: 'om-cot-1',
            reason: 'error',
          }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs only error categories for a failing platform call', async () => {
    const { adapter, cot, logs } = harness();
    const secret = new FeishuCotApiError(
      232003,
      'failed at /home/person/private/token.txt',
    );
    cot.failNextCreate(secret);
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant());
    await settleCot();

    const failure = logs.find((line) => line.fields['stage'] === 'create');
    expect(failure?.fields).toMatchObject({
      err_name: 'FeishuCotApiError',
      err_code: 232003,
    });
    expect(Object.keys(failure?.fields ?? {})).not.toContain('cot_id');
    expect(JSON.stringify(logs)).not.toContain('/home/person');
  });

  it('interrupts matching binding fallback, Team close, and session close', async () => {
    const first = harness();
    first.adapter.onTurnSubmitted(submitted());
    first.adapter.onTurnMessage(assistant());
    await settleCot();
    const route: ChannelBindingRouteEvent = {
      schema_version: 1,
      kind: 'binding.route',
      occurred_at: 9,
      action: 'unbound',
      transition: 'unbound',
      endpoint: groupEndpoint(),
      previous_team: { team_name: TEAM, leader_name: LEADER },
      current_team: null,
    };
    first.adapter.onBindingRoute(route);
    await settleCot();
    expect(runFinishedStatuses(first.cot, 'cot-1')).toEqual(['interrupted']);

    const second = harness();
    second.adapter.onTurnSubmitted(submitted());
    second.adapter.onTurnMessage(assistant());
    await settleCot();
    const closed: ChannelTeamStateEvent = {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: 10,
      team_name: TEAM,
      leader_name: LEADER,
      status: 'closed',
    };
    second.adapter.onTeamState(closed);
    await settleCot();
    expect(runFinishedStatuses(second.cot, 'cot-1')).toEqual(['interrupted']);
    await second.adapter.close();
  });

  it('clears the anchor on a non-Feishu takeover', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant());
    await settleCot();
    adapter.onTurnSubmitted(submitted({
      channel_origin: origin({ provider: 'builtin:other', channel_id: 'other' }),
    }));
    adapter.onTurnMessage(assistant({ event_id: 'must-not-render' }));
    await settleCot();
    expect(runFinishedStatuses(cot, 'cot-1')).toEqual(['interrupted']);
    expect(cot.createdCotIds()).toEqual(['cot-1']);
  });
});
