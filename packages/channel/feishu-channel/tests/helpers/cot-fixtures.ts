/**
 * Current-architecture COT fixtures (COVERAGE CELL F).
 *
 * Every value here is built from the neutral Core event types the Channel
 * actually receives today — there is no `ChannelOrigin`, no `ChannelTarget`,
 * and no binding snapshot on a turn event. The anchor is the Channel's own
 * `VisibleMessageAnchor`, supplied by the session that submitted the turn.
 */
import type {
  DreamuxLogger,
  TeamStateEvent,
  TeammateTurnMessageEvent,
  TeammateTurnSettledEvent,
  TeammateTurnSubmittedEvent,
  TeammateTurnToolCallEvent,
} from '@excitedjs/dreamux-types';

import { FeishuCotAdapter } from '../../src/feishu-cot-adapter.js';
import type { VisibleMessageAnchor } from '../../src/feishu-cot-state.js';
import {
  chatTarget,
  topicTarget,
  type FeishuTarget,
} from '../../src/routing/target.js';
import {
  createFakeCotClient,
  type FakeCotClient,
} from './fake-cot-client.js';

export const CHANNEL_ID = 'primary';
export const DISPATCHER_ID = 'dispatcher-a';
export const TEAM = 'team-alpha';
export const LEADER = 'leader';
export const DISPATCHER_AGENT = 'dispatcher';
export const GROUP_CHAT = 'oc-group-1';

export interface CapturedLog {
  readonly level: 'warn' | 'error' | 'info' | 'debug';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export function recordingLogger(sink: CapturedLog[]): DreamuxLogger {
  const at =
    (level: CapturedLog['level']) =>
    (fields: Record<string, unknown> | string, message?: string): void => {
      sink.push({
        level,
        fields: typeof fields === 'string' ? {} : fields,
        message: typeof fields === 'string' ? fields : (message ?? ''),
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

export interface CotHarness {
  readonly adapter: FeishuCotAdapter;
  readonly cot: FakeCotClient;
  readonly logs: CapturedLog[];
}

export function harness(
  options: {
    channelId?: string | undefined;
    cot?: FakeCotClient | undefined;
    cotClient?: (() => FakeCotClient | undefined) | undefined;
  } = {},
): CotHarness {
  const cot = options.cot ?? createFakeCotClient();
  const logs: CapturedLog[] = [];
  const adapter = new FeishuCotAdapter({
    dispatcherId: DISPATCHER_ID,
    channelId: 'channelId' in options ? options.channelId : CHANNEL_ID,
    log: recordingLogger(logs),
    cotClient: options.cotClient ?? (() => cot),
  });
  return { adapter, cot, logs };
}

export function groupTarget(chatId = GROUP_CHAT): FeishuTarget {
  return chatTarget(chatId, 'group');
}

export function threadTarget(
  chatId = GROUP_CHAT,
  threadId = 'omt-thread-1',
): FeishuTarget {
  return topicTarget(chatId, threadId);
}

export function anchor(
  messageId: string,
  target: FeishuTarget = groupTarget(),
): VisibleMessageAnchor {
  return { chatId: target.chatId, messageId, target };
}

export function submitted(
  overrides: Partial<TeammateTurnSubmittedEvent> = {},
): TeammateTurnSubmittedEvent {
  return {
    schema_version: 1,
    kind: 'teammate.turn.submitted',
    occurred_at: 1,
    team_name: TEAM,
    teammate_name: LEADER,
    role: 'team_leader',
    turn_id: 'turn-1',
    turn_source: 'feishu',
    ...overrides,
  };
}

export function dispatcherSubmitted(
  turnId: string,
  overrides: Partial<TeammateTurnSubmittedEvent> = {},
): TeammateTurnSubmittedEvent {
  return submitted({
    team_name: null,
    teammate_name: DISPATCHER_AGENT,
    role: 'dispatcher',
    turn_id: turnId,
    ...overrides,
  });
}

export function assistant(
  overrides: Partial<TeammateTurnMessageEvent> = {},
): TeammateTurnMessageEvent {
  return {
    schema_version: 1,
    kind: 'teammate.turn.message',
    event_id: 'evt-message-1',
    occurred_at: 2,
    team_name: TEAM,
    teammate_name: LEADER,
    role: 'team_leader',
    turn_id: 'turn-1',
    message_role: 'assistant',
    content: '正在处理',
    content_truncated: false,
    redacted: false,
    ...overrides,
  };
}

export function userMessage(
  overrides: Partial<TeammateTurnMessageEvent> = {},
): TeammateTurnMessageEvent {
  return assistant({
    event_id: 'evt-user-1',
    message_role: 'user',
    content: '内部推送正文',
    ...overrides,
  });
}

export function dispatcherAssistant(
  turnId: string,
  eventId: string,
  overrides: Partial<TeammateTurnMessageEvent> = {},
): TeammateTurnMessageEvent {
  return assistant({
    team_name: null,
    teammate_name: DISPATCHER_AGENT,
    role: 'dispatcher',
    turn_id: turnId,
    event_id: eventId,
    ...overrides,
  });
}

export function toolCall(
  overrides: Partial<TeammateTurnToolCallEvent> = {},
): TeammateTurnToolCallEvent {
  return {
    schema_version: 1,
    kind: 'teammate.turn.tool_call',
    event_id: 'evt-tool-1',
    occurred_at: 3,
    team_name: TEAM,
    teammate_name: LEADER,
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

export function settled(
  overrides: Partial<TeammateTurnSettledEvent> = {},
): TeammateTurnSettledEvent {
  return {
    schema_version: 1,
    kind: 'teammate.turn.settled',
    occurred_at: 4,
    team_name: TEAM,
    teammate_name: LEADER,
    role: 'team_leader',
    turn_id: 'turn-1',
    status: 'completed',
    assistant: 'done',
    assistant_truncated: false,
    redacted: false,
    ...overrides,
  };
}

export function dispatcherSettled(
  turnId: string,
  overrides: Partial<TeammateTurnSettledEvent> = {},
): TeammateTurnSettledEvent {
  return settled({
    team_name: null,
    teammate_name: DISPATCHER_AGENT,
    role: 'dispatcher',
    turn_id: turnId,
    ...overrides,
  });
}

export function teamState(
  overrides: Partial<TeamStateEvent> = {},
): TeamStateEvent {
  return {
    schema_version: 1,
    kind: 'team.state',
    occurred_at: 5,
    team_name: TEAM,
    leader_name: LEADER,
    status: 'running',
    teammates: [],
    ...overrides,
  };
}

/**
 * Open one TeamLeader card the ordinary way: the session submitted an inbound
 * message, held the returned `turn_id`, and says which visible message became
 * it. The eager receipt is the first thing on the card.
 */
export function openLeaderCard(
  h: CotHarness,
  input: {
    turnId?: string;
    messageId?: string;
    target?: FeishuTarget;
  } = {},
): void {
  h.adapter.onAnchoredSubmission({
    event: submitted({ turn_id: input.turnId ?? 'turn-1' }),
    anchor: anchor(input.messageId ?? 'om-inbound-1', input.target ?? groupTarget()),
  });
}
