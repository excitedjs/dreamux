import { randomUUID } from 'node:crypto';

import type {
  ChannelOrigin,
  ChannelTurnSource,
  ChannelTurnMessageEvent,
  ChannelTurnSettledEvent,
  ChannelTurnSubmittedEvent,
  ChannelTurnToolCallEvent,
  DreamuxLogger,
  JsonValue,
  RuntimeActivityEvent,
} from '@excitedjs/dreamux-types';

import type { DispatcherCoreEventPublisher } from '../service/dispatcher-core-events/index.js';
import type {
  AgentEntityIdentity,
  AgentEntityTurnOrigin,
} from '../service/agent-entity/types.js';

export const ASSISTANT_TEXT_MAX = 160_000;
export const CONVERSATION_MESSAGE_MAX = 100_000;
export const CONVERSATION_TOOL_ARGUMENTS_MAX = 60_000;
export const CONVERSATION_TOOL_RESULT_MAX = 120_000;
export const CONVERSATION_ACTIVITY_FACTS_MAX = 512;

const INLINE_SECRET_RE = /(["']?\b(?:secret|password|passwd|token|authorization|cookie|credential|api[_-]?key|private[_-]?key|client[_-]?secret)\b["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/giu;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu;
const POSIX_HOME_PATH_RE = /(?:\/home\/[^/\s"'`]+|\/Users\/[^/\s"'`]+|\/root)(?:\/[^\s"'`]*)?/gu;
const WINDOWS_HOME_PATH_RE = /\b[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\s"'`]*)?/giu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const COMMON_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AKLT)[A-Z0-9]{12,}\b/gu;

interface SanitizedText { value: string; truncated: boolean; redacted: boolean }
interface ProjectableTurn {
  readonly id: string;
  readonly submittedAt: number;
  readonly prompt: string | null;
  /** Present on entity turns; the channel branch carries the frozen origin. */
  readonly origin?: AgentEntityTurnOrigin | null;
}

export type ConversationTurnSettlement =
  | {
      readonly status: 'completed';
      readonly resultText: string | null;
      readonly truncated: boolean;
    }
  | { readonly status: 'failed' | 'stopped' };

export interface ConversationProjection {
  projectSubmitted(identity: AgentEntityIdentity, turn: ProjectableTurn): void;
  projectActivity(
    identity: AgentEntityIdentity,
    turn: ProjectableTurn,
    event: RuntimeActivityEvent,
  ): void;
  projectSettled(input: {
    identity: AgentEntityIdentity;
    turn: ProjectableTurn;
    settlement: ConversationTurnSettlement;
  }): void;
}

export function createConversationProjection(input: {
  coreEvents: DispatcherCoreEventPublisher;
  log: DreamuxLogger;
}): ConversationProjection {
  const activityFacts = new WeakMap<object, Set<string>>();
  const activityFactsWarned = new WeakSet<object>();
  return {
    projectSubmitted(identity, turn) {
      const context = projectionContext(identity, turn);
      if (context === null || turn.prompt === null || input.coreEvents.hasSources?.() === false) return;
      input.coreEvents.publish(
        identity.dispatcher_id,
        submittedEvent(
          context.scope,
          turn.submittedAt,
          context.channelOrigin,
          turnSourceOf(turn),
        ),
      );
      input.coreEvents.publish(
        identity.dispatcher_id,
        messageEvent(context.scope, randomUUID(), turn.submittedAt, 'user', turn.prompt, identity.cwd),
      );
    },
    projectActivity(identity, turn, event) {
      const context = projectionContext(identity, turn);
      if (context === null || input.coreEvents.hasSources?.() === false) return;
      let submissionFacts = activityFacts.get(event.submission);
      if (submissionFacts === undefined) {
        submissionFacts = new Set();
        activityFacts.set(event.submission, submissionFacts);
      }
      if (submissionFacts.has(event.activity.id)) return;
      if (submissionFacts.size >= CONVERSATION_ACTIVITY_FACTS_MAX) {
        if (!activityFactsWarned.has(event.submission)) {
          activityFactsWarned.add(event.submission);
          input.log.warn(
            {
              dispatcher_id: identity.dispatcher_id,
              agent_name: identity.name,
              role: identity.role,
              turn_id: turn.id,
              maximum: CONVERSATION_ACTIVITY_FACTS_MAX,
            },
            'Conversation projection activity fact set is full; dropping newest activity',
          );
        }
        return;
      }
      submissionFacts.add(event.activity.id);
      const projected = event.activity.kind === 'assistant.message'
        ? messageEvent(
            context.scope,
            event.activity.id,
            event.occurredAt,
            'assistant',
            event.activity.text,
            identity.cwd,
            event.activity.truncated,
          )
        : toolEvent(context.scope, event, identity.cwd);
      input.coreEvents.publish(identity.dispatcher_id, projected);
    },
    projectSettled({ identity, turn, settlement }) {
      const context = projectionContext(identity, turn);
      if (context === null || input.coreEvents.hasSources?.() === false) return;
      input.coreEvents.publish(
        identity.dispatcher_id,
        settledEvent(context.scope, settlement, identity.cwd),
      );
    },
  };
}

function projectionContext(
  identity: AgentEntityIdentity,
  turn: ProjectableTurn,
): {
  readonly scope: NonNullable<ReturnType<typeof eventScope>>;
  readonly channelOrigin: ChannelOrigin | undefined;
} | null {
  const scope = eventScope(identity, turn.id);
  if (scope === null) return null;
  const channelOrigin = channelOriginOf(turn);
  if (scope.role === 'dispatcher' && channelOrigin === undefined) return null;
  return { scope, channelOrigin };
}

function eventScope(identity: AgentEntityIdentity, turnId: string) {
  if (
    (identity.role === 'team_leader' || identity.role === 'team_member') &&
    identity.team_id !== null
  ) {
    return {
      schema_version: 1 as const,
      team_name: identity.team_id,
      agent_name: identity.name,
      role: identity.role,
      turn_id: turnId,
    };
  }
  if (identity.role === 'dispatcher' && identity.team_id === null) {
    return {
      schema_version: 1 as const,
      team_name: null,
      agent_name: identity.name,
      role: identity.role,
      turn_id: turnId,
    };
  }
  return null;
}

/**
 * The presentable inbound location captured for a Channel turn. A Channel
 * input can omit it when its route snapshot cannot be frozen; absence means
 * only that no displayable anchor was captured, not that the turn was not a
 * Channel input. Non-Channel inputs also omit it.
 */
function channelOriginOf(turn: ProjectableTurn): ChannelOrigin | undefined {
  const origin = turn.origin;
  if (origin === null || origin === undefined || typeof origin !== 'object') {
    return undefined;
  }
  return origin.kind === 'channel' ? origin.channel_origin ?? undefined : undefined;
}

function turnSourceOf(turn: ProjectableTurn): ChannelTurnSource | undefined {
  const origin = turn.origin;
  if (origin === null || origin === undefined) return undefined;
  if (typeof origin === 'string') {
    switch (origin) {
      case 'dispatcher':
      case 'team_leader':
        return origin;
    }
  }
  switch (origin.kind) {
    case 'channel':
      return 'channel';
    case 'scheduled':
      return 'scheduled';
    case 'completion':
      return 'completion';
    case 'control':
      return 'control';
  }
}

function submittedEvent(
  scope: NonNullable<ReturnType<typeof eventScope>>,
  occurredAt: number,
  channelOrigin: ChannelOrigin | undefined,
  turnSource: ChannelTurnSource | undefined,
): ChannelTurnSubmittedEvent {
  return {
    ...scope,
    kind: 'turn.submitted',
    occurred_at: occurredAt,
    ...(channelOrigin !== undefined ? { channel_origin: channelOrigin } : {}),
    ...(turnSource !== undefined ? { turn_source: turnSource } : {}),
  };
}

function settledEvent(
  scope: NonNullable<ReturnType<typeof eventScope>>,
  settlement: ConversationTurnSettlement,
  cwd: string,
): ChannelTurnSettledEvent {
  const assistant = settlement.status === 'completed' && settlement.resultText !== null
    ? sanitizeText(settlement.resultText, cwd, ASSISTANT_TEXT_MAX)
    : null;
  return {
    ...scope,
    kind: 'turn.settled',
    occurred_at: Date.now(),
    status: settlement.status,
    assistant: assistant?.value ?? null,
    assistant_truncated: settlement.status === 'completed' &&
      (settlement.truncated || (assistant?.truncated ?? false)),
    redacted: assistant?.redacted ?? false,
  };
}

function messageEvent(
  scope: NonNullable<ReturnType<typeof eventScope>>,
  eventId: string,
  occurredAt: number,
  role: 'user' | 'assistant',
  text: string,
  cwd: string,
  sourceTruncated = false,
): ChannelTurnMessageEvent {
  const content = sanitizeText(text, cwd, CONVERSATION_MESSAGE_MAX);
  return {
    ...scope,
    kind: 'turn.message',
    event_id: eventId,
    occurred_at: occurredAt,
    message_role: role,
    content: content.value,
    content_truncated: sourceTruncated || content.truncated,
    redacted: content.redacted,
  };
}

function toolEvent(
  scope: NonNullable<ReturnType<typeof eventScope>>,
  event: RuntimeActivityEvent,
  cwd: string,
): ChannelTurnToolCallEvent {
  if (event.activity.kind !== 'tool.call') throw new Error('expected tool activity');
  const args = sanitizeJson(event.activity.arguments, cwd, CONVERSATION_TOOL_ARGUMENTS_MAX);
  const nativeResult = event.activity.error ?? event.activity.result;
  const result = sanitizeJson(nativeResult, cwd, CONVERSATION_TOOL_RESULT_MAX);
  return {
    ...scope,
    kind: 'turn.tool_call',
    event_id: event.activity.id,
    occurred_at: event.occurredAt,
    call_id: event.activity.callId,
    tool_name: event.activity.toolName.slice(0, 200),
    tool_action: event.activity.action,
    status: event.activity.status,
    arguments_json: args?.value ?? null,
    result_json: result?.value ?? null,
    arguments_truncated: args?.truncated ?? false,
    result_truncated: result?.truncated ?? false,
    redacted: (args?.redacted ?? false) || (result?.redacted ?? false),
  };
}

function sanitizeJson(value: JsonValue | string | null, cwd: string, max: number): SanitizedText | null {
  if (value === null) return null;
  return sanitizeText(typeof value === 'string' ? value : JSON.stringify(value), cwd, max);
}

function sanitizeText(value: string, cwd: string, max: number): SanitizedText {
  const safe = redactText(value, cwd);
  return {
    value: safe.value.length > max ? safe.value.slice(0, max) : safe.value,
    truncated: safe.value.length > max,
    redacted: safe.redacted,
  };
}

function redactText(value: string, cwd: string): { value: string; redacted: boolean } {
  let redacted = value;
  if (cwd !== '') redacted = redacted.split(cwd).join('$WORKSPACE');
  redacted = redacted.replace(PRIVATE_KEY_RE, '<redacted-private-key>');
  redacted = redacted.replace(POSIX_HOME_PATH_RE, '$HOME_PATH');
  redacted = redacted.replace(WINDOWS_HOME_PATH_RE, '$HOME_PATH');
  redacted = redacted.replace(BEARER_RE, 'Bearer <redacted>');
  redacted = redacted.replace(JWT_RE, '<redacted-jwt>');
  redacted = redacted.replace(COMMON_ACCESS_KEY_RE, '<redacted-access-key>');
  redacted = redacted.replace(INLINE_SECRET_RE, (_match, key: string, separator: string) => `${key}${separator}<redacted>`);
  return { value: redacted, redacted: redacted !== value };
}
