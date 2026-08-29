import { randomUUID } from 'node:crypto';

import type {
  DreamuxLogger,
  JsonValue,
  RuntimeActivityEvent,
  TeammateRole,
  TeammateTurnMessageEvent,
  TeammateTurnSettledEvent,
  TeammateTurnSubmittedEvent,
  TeammateTurnToolCallEvent,
} from '@excitedjs/dreamux-types';

import type { DispatcherCoreEventPublisher } from '../service/dispatcher-core-events/index.js';
import type { AgentEntityIdentity } from '../service/agent-entity/types.js';

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
  /**
   * The open provenance name the turn was submitted under, echoed verbatim on
   * the submitted event. Core neither parses it nor decides anything by it.
   */
  readonly source: string;
}

export type ConversationTurnSettlement =
  | {
      readonly status: 'completed';
      readonly resultText: string | null;
      readonly truncated: boolean;
    }
  | { readonly status: 'failed' | 'stopped' };

/**
 * The projected Agent: its durable identity plus the runtime role its owner
 * derived. Role arrives with the call because only the Service that
 * materialized the Agent knows it — a dispatcher-scoped TeamMate and a
 * Team-scoped TeamMate carry identical records and are told apart solely by who
 * owns them.
 */
export interface ProjectedAgent {
  readonly identity: AgentEntityIdentity;
  readonly role: TeammateRole;
}

export interface ConversationProjection {
  projectSubmitted(agent: ProjectedAgent, turn: ProjectableTurn): void;
  projectActivity(
    agent: ProjectedAgent,
    turn: ProjectableTurn,
    event: RuntimeActivityEvent,
  ): void;
  projectSettled(input: {
    agent: ProjectedAgent;
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
    projectSubmitted(agent, turn) {
      const identity = agent.identity;
      const scope = eventScope(agent, turn.id);
      if (scope === null || turn.prompt === null || input.coreEvents.hasSources?.() === false) return;
      input.coreEvents.publish(
        identity.dispatcher_id,
        submittedEvent(scope, turn.submittedAt, turn.source),
      );
      input.coreEvents.publish(
        identity.dispatcher_id,
        messageEvent(scope, randomUUID(), turn.submittedAt, 'user', turn.prompt, identity.cwd),
      );
    },
    projectActivity(agent, turn, event) {
      const identity = agent.identity;
      const scope = eventScope(agent, turn.id);
      if (scope === null || input.coreEvents.hasSources?.() === false) return;
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
              role: agent.role,
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
            scope,
            event.activity.id,
            event.occurredAt,
            'assistant',
            event.activity.text,
            identity.cwd,
            event.activity.truncated,
          )
        : toolEvent(scope, event, identity.cwd);
      input.coreEvents.publish(identity.dispatcher_id, projected);
    },
    projectSettled({ agent, turn, settlement }) {
      const identity = agent.identity;
      const scope = eventScope(agent, turn.id);
      if (scope === null || input.coreEvents.hasSources?.() === false) return;
      input.coreEvents.publish(
        identity.dispatcher_id,
        settledEvent(scope, settlement, identity.cwd),
      );
    },
  };
}

/**
 * Which conversation a turn belongs to.
 *
 * Only two conversations exist at this boundary: a Team's, and the dispatcher's
 * own. A dispatcher-scoped TeamMate has neither — it projects nothing — which
 * is why the Team branch keys on the Team the owner bound, not on the role
 * value it now shares with Team-scoped TeamMates.
 */
function eventScope(agent: ProjectedAgent, turnId: string) {
  const { identity, role } = agent;
  if (role !== 'dispatcher' && identity.team_id !== null) {
    return {
      schema_version: 1 as const,
      team_name: identity.team_id,
      teammate_name: identity.name,
      role,
      turn_id: turnId,
    };
  }
  if (role === 'dispatcher' && identity.team_id === null) {
    return {
      schema_version: 1 as const,
      team_name: null,
      teammate_name: identity.name,
      role,
      turn_id: turnId,
    };
  }
  return null;
}

/**
 * Publish every turn of a projected conversation, whatever submitted it.
 *
 * Core cannot filter by provenance without learning what a concrete source
 * means, which is exactly the coupling this boundary exists to prevent. It
 * states the open `turn_source` and lets each Channel decide what its own
 * presentation shows — the same place that already owns the visible-message
 * anchor the submitted event binds to `turn_id`.
 */
function submittedEvent(
  scope: NonNullable<ReturnType<typeof eventScope>>,
  occurredAt: number,
  turnSource: string,
): TeammateTurnSubmittedEvent {
  return {
    ...scope,
    kind: 'teammate.turn.submitted',
    occurred_at: occurredAt,
    turn_source: turnSource,
  };
}

function settledEvent(
  scope: NonNullable<ReturnType<typeof eventScope>>,
  settlement: ConversationTurnSettlement,
  cwd: string,
): TeammateTurnSettledEvent {
  const assistant = settlement.status === 'completed' && settlement.resultText !== null
    ? sanitizeText(settlement.resultText, cwd, ASSISTANT_TEXT_MAX)
    : null;
  return {
    ...scope,
    kind: 'teammate.turn.settled',
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
): TeammateTurnMessageEvent {
  const content = sanitizeText(text, cwd, CONVERSATION_MESSAGE_MAX);
  return {
    ...scope,
    kind: 'teammate.turn.message',
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
): TeammateTurnToolCallEvent {
  if (event.activity.kind !== 'tool.call') throw new Error('expected tool activity');
  const args = sanitizeJson(event.activity.arguments, cwd, CONVERSATION_TOOL_ARGUMENTS_MAX);
  const nativeResult = event.activity.error ?? event.activity.result;
  const result = sanitizeJson(nativeResult, cwd, CONVERSATION_TOOL_RESULT_MAX);
  return {
    ...scope,
    kind: 'teammate.turn.tool_call',
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
