import type {
  ChannelBindingEndpointSnapshot,
  ChannelOrigin,
  ChannelTarget,
  ChannelTurnMessageEvent,
  ChannelTurnSettledEvent,
  ChannelTurnSubmittedEvent,
  ChannelTurnToolCallEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { FeishuCotAdapter } from '../../src/feishu-cot-adapter.js';
import {
  createFakeCotClient,
  type FakeCotClient,
} from './fake-cot-client.js';

export const CHANNEL_ID = 'primary';
export const TEAM = 'team-alpha';
export const LEADER = 'leader';
export interface CapturedLog {
  readonly level: 'warn' | 'error' | 'info' | 'debug';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export function recordingLogger(sink: CapturedLog[]): DreamuxLogger {
  const at = (level: CapturedLog['level']) =>
    (fields: Record<string, unknown> | string, message?: string): void => {
      sink.push({
        level,
        fields: typeof fields === 'string' ? {} : fields,
        message: typeof fields === 'string' ? fields : message ?? '',
      });
    };
  return {
    trace: () => undefined,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

export function harness(options: {
  channelId?: string | undefined;
  cot?: FakeCotClient | undefined;
} = {}): {
  adapter: FeishuCotAdapter;
  cot: FakeCotClient;
  logs: CapturedLog[];
} {
  const cot = options.cot ?? createFakeCotClient();
  const logs: CapturedLog[] = [];
  const adapter = new FeishuCotAdapter({
    dispatcherId: 'dispatcher-a',
    channelId: 'channelId' in options ? options.channelId : CHANNEL_ID,
    log: recordingLogger(logs),
    cotClient: () => cot,
  });
  return { adapter, cot, logs };
}

export function groupTarget(chatId = 'oc-group-1'): ChannelTarget {
  return {
    target_type: 'group',
    target_key: chatId,
    bindable: true,
    meta: { chat_id: chatId, chat_type: 'group' },
  };
}

export function groupEndpoint(
  chatId = 'oc-group-1',
): ChannelBindingEndpointSnapshot {
  return {
    provider: 'builtin:feishu',
    channel_id: CHANNEL_ID,
    endpoint_type: 'group',
    endpoint_key: chatId,
    display: null,
    canonical_url: null,
    meta: { chat_id: chatId, chat_type: 'group' },
  };
}

export function topicEndpoint(
  chatId = 'oc-group-1',
  threadId = 'omt-thread-1',
): ChannelBindingEndpointSnapshot {
  return {
    provider: 'builtin:feishu',
    channel_id: CHANNEL_ID,
    endpoint_type: 'topic',
    endpoint_key: threadId,
    display: null,
    canonical_url: null,
    meta: {
      chat_id: chatId,
      chat_type: 'group',
      chat_mode: 'topic',
      thread_id: threadId,
    },
  };
}

export function topicTarget(
  chatId = 'oc-group-1',
  threadId = 'omt-thread-1',
): ChannelTarget {
  return {
    target_type: 'topic',
    target_key: threadId,
    bindable: true,
    meta: {
      chat_id: chatId,
      chat_type: 'group',
      chat_mode: 'topic',
      thread_id: threadId,
      message_id: 'om-source-1',
    },
    binding_fallbacks: [groupTarget(chatId)],
  };
}

export function origin(
  overrides: Partial<ChannelOrigin> = {},
): ChannelOrigin {
  return {
    provider: 'builtin:feishu',
    channel_id: CHANNEL_ID,
    message_id: 'om-source-1',
    target: topicTarget(),
    binding: groupEndpoint(),
    ...overrides,
  };
}

export function submitted(
  overrides: Partial<ChannelTurnSubmittedEvent> = {},
): ChannelTurnSubmittedEvent {
  return {
    schema_version: 1,
    kind: 'turn.submitted',
    occurred_at: 1,
    team_name: TEAM,
    agent_name: LEADER,
    role: 'team_leader',
    turn_id: 'turn-1',
    turn_source: 'channel',
    channel_origin: origin(),
    ...overrides,
  };
}

export function settled(
  overrides: Partial<ChannelTurnSettledEvent> = {},
): ChannelTurnSettledEvent {
  return {
    schema_version: 1,
    kind: 'turn.settled',
    occurred_at: 4,
    team_name: TEAM,
    agent_name: LEADER,
    role: 'team_leader',
    turn_id: 'turn-1',
    status: 'completed',
    assistant: 'done',
    assistant_truncated: false,
    redacted: false,
    ...overrides,
  };
}

export function dispatcherSubmitted(
  chatId: string,
  turnId: string,
  overrides: Partial<ChannelTurnSubmittedEvent> = {},
): ChannelTurnSubmittedEvent {
  return submitted({
    team_name: null,
    agent_name: 'dispatcher',
    role: 'dispatcher',
    turn_id: turnId,
    channel_origin: origin({
      message_id: `message-${turnId}`,
      target: topicTarget(chatId, `thread-${turnId}`),
      binding: groupEndpoint(chatId),
    }),
    ...overrides,
  });
}

export function dispatcherAssistant(
  turnId: string,
  eventId: string,
  overrides: Partial<ChannelTurnMessageEvent> = {},
): ChannelTurnMessageEvent {
  return assistant({
    team_name: null,
    agent_name: 'dispatcher',
    role: 'dispatcher',
    turn_id: turnId,
    event_id: eventId,
    ...overrides,
  });
}

export function dispatcherSettled(
  turnId: string,
  overrides: Partial<ChannelTurnSettledEvent> = {},
): ChannelTurnSettledEvent {
  return settled({
    team_name: null,
    agent_name: 'dispatcher',
    role: 'dispatcher',
    turn_id: turnId,
    ...overrides,
  });
}

export function userMessage(
  overrides: Partial<ChannelTurnMessageEvent> = {},
): ChannelTurnMessageEvent {
  return assistant({
    event_id: 'evt-user-1',
    message_role: 'user',
    content: '内部推送正文',
    ...overrides,
  });
}

export function assistant(
  overrides: Partial<ChannelTurnMessageEvent> = {},
): ChannelTurnMessageEvent {
  return {
    schema_version: 1,
    kind: 'turn.message',
    event_id: 'evt-message-1',
    occurred_at: 2,
    team_name: TEAM,
    agent_name: LEADER,
    role: 'team_leader',
    turn_id: 'turn-1',
    message_role: 'assistant',
    content: '正在处理',
    content_truncated: false,
    redacted: false,
    ...overrides,
  };
}

export function toolCall(
  overrides: Partial<ChannelTurnToolCallEvent> = {},
): ChannelTurnToolCallEvent {
  return {
    schema_version: 1,
    kind: 'turn.tool_call',
    event_id: 'evt-tool-1',
    occurred_at: 3,
    team_name: TEAM,
    agent_name: LEADER,
    role: 'team_leader',
    turn_id: 'turn-1',
    call_id: 'call-1',
    tool_name: 'exec_command',
    tool_action: 'run',
    status: 'started',
    arguments_json: JSON.stringify({ command: 'pnpm test' }),
    result_json: null,
    arguments_truncated: false,
    result_truncated: false,
    redacted: false,
    ...overrides,
  };
}
