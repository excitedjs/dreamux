import { randomUUID } from 'node:crypto';

import type {
  DreamuxLogger,
  JsonValue,
  RuntimeActivityEvent,
  RuntimeNativeTurnEnd,
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
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const COMMON_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AKLT)[A-Z0-9]{12,}\b/gu;

/**
 * What may sit inside a path without ending it.
 *
 * A prefix only counts as a path when the characters around it agree that it is
 * one: `~/work` is this operator's home, `/home/alicexyz` is somebody else's
 * directory that merely starts with the same letters, and `not/home/alice` is a
 * fragment of a longer path that was never rooted here. Letters, digits, and
 * the separators/punctuation that appear inside real path segments continue a
 * token; anything else — whitespace, a quote, a colon, a comma — ends it.
 * Two narrower exceptions are handled at a match: a period closes prose only
 * when what follows is already a boundary, and a preceding slash starts a path
 * only when it completes a URL scheme's `://`.
 */
const PATH_TOKEN_CHARACTER_RE = /[\p{L}\p{N}_.~\\/-]/u;

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
  /**
   * One runtime-native turn ended for this Agent.
   *
   * Takes no turn: a provider folds any number of submissions into one native
   * turn, so the only identity this fact honestly carries is the Agent whose
   * runtime produced it.
   */
  projectNativeTurnEnd(agent: ProjectedAgent, end: RuntimeNativeTurnEnd): void;
}

export function createConversationProjection(input: {
  coreEvents: DispatcherCoreEventPublisher;
  log: DreamuxLogger;
  homePathPrefixes: readonly string[];
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
        messageEvent(
          scope,
          randomUUID(),
          turn.submittedAt,
          'user',
          turn.prompt,
          identity.cwd,
          input.homePathPrefixes,
        ),
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
            input.homePathPrefixes,
            event.activity.truncated,
          )
        : toolEvent(scope, event, identity.cwd, input.homePathPrefixes);
      input.coreEvents.publish(identity.dispatcher_id, projected);
    },
    projectSettled({ agent, turn, settlement }) {
      const identity = agent.identity;
      const scope = eventScope(agent, turn.id);
      if (scope === null || input.coreEvents.hasSources?.() === false) return;
      input.coreEvents.publish(
        identity.dispatcher_id,
        settledEvent(scope, settlement, identity.cwd, input.homePathPrefixes),
      );
    },
    projectNativeTurnEnd(agent, end) {
      const identity = agent.identity;
      const scope = actorScope(agent);
      if (scope === null || input.coreEvents.hasSources?.() === false) return;
      input.coreEvents.publish(identity.dispatcher_id, {
        ...scope,
        kind: 'teammate.native_turn.ended',
        occurred_at: end.occurredAt,
        status: end.status,
      });
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
  const scope = actorScope(agent);
  return scope === null ? null : { ...scope, turn_id: turnId };
}

/**
 * The same conversation selection, without a turn.
 *
 * A native turn end names no logical turn, so it needs the actor half of the
 * scope on its own. Keeping one implementation means a conversation that does
 * not project turns cannot start projecting native ends.
 */
function actorScope(agent: ProjectedAgent) {
  const { identity, role } = agent;
  if (role !== 'dispatcher' && identity.team_id !== null) {
    return {
      schema_version: 1 as const,
      team_name: identity.team_id,
      teammate_name: identity.name,
      role,
    };
  }
  if (role === 'dispatcher' && identity.team_id === null) {
    return {
      schema_version: 1 as const,
      team_name: null,
      teammate_name: identity.name,
      role,
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
  homePathPrefixes: readonly string[],
): TeammateTurnSettledEvent {
  const assistant = settlement.status === 'completed' && settlement.resultText !== null
    ? sanitizeText(settlement.resultText, cwd, homePathPrefixes, ASSISTANT_TEXT_MAX)
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
  homePathPrefixes: readonly string[],
  sourceTruncated = false,
): TeammateTurnMessageEvent {
  const content = sanitizeText(text, cwd, homePathPrefixes, CONVERSATION_MESSAGE_MAX);
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
  homePathPrefixes: readonly string[],
): TeammateTurnToolCallEvent {
  if (event.activity.kind !== 'tool.call') throw new Error('expected tool activity');
  const args = sanitizeJson(
    event.activity.arguments,
    cwd,
    homePathPrefixes,
    CONVERSATION_TOOL_ARGUMENTS_MAX,
  );
  const nativeResult = event.activity.error ?? event.activity.result;
  const result = sanitizeJson(
    nativeResult,
    cwd,
    homePathPrefixes,
    CONVERSATION_TOOL_RESULT_MAX,
  );
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

function sanitizeJson(
  value: JsonValue | string | null,
  cwd: string,
  homePathPrefixes: readonly string[],
  max: number,
): SanitizedText | null {
  if (value === null) return null;
  return sanitizeText(
    typeof value === 'string' ? value : JSON.stringify(value),
    cwd,
    homePathPrefixes,
    max,
  );
}

function sanitizeText(
  value: string,
  cwd: string,
  homePathPrefixes: readonly string[],
  max: number,
): SanitizedText {
  const safe = redactText(value, cwd, homePathPrefixes);
  return {
    value: safe.value.length > max ? safe.value.slice(0, max) : safe.value,
    truncated: safe.value.length > max,
    redacted: safe.redacted,
  };
}

/**
 * Rewrite what a projected conversation must not publish verbatim.
 *
 * Two different jobs share this function. Secrets are *destroyed* — a token has
 * no legible form worth keeping. Paths are only *renamed*: an operator reading
 * a card still needs to know which file was touched, so the workspace becomes
 * `.` and this host's home becomes `~`, exactly the way the operator's own shell
 * prints them. Order matters: the workspace usually sits under the home, so
 * relativizing it first keeps the shorter, more useful form.
 *
 * `homePathPrefixes` is explicit so this pure projection never depends on
 * process-global resolution state.
 */
export function redactText(
  value: string,
  cwd: string,
  homePaths: readonly string[],
): { value: string; redacted: boolean } {
  let redacted = replacePathPrefix(value, cwd, '.', '', true);
  redacted = redacted.replace(PRIVATE_KEY_RE, '<redacted-private-key>');
  for (const homePath of homePaths) {
    redacted = replacePathPrefix(redacted, homePath, '~', '~', false);
  }
  redacted = redacted.replace(BEARER_RE, 'Bearer <redacted>');
  redacted = redacted.replace(JWT_RE, '<redacted-jwt>');
  redacted = redacted.replace(COMMON_ACCESS_KEY_RE, '<redacted-access-key>');
  redacted = redacted.replace(INLINE_SECRET_RE, (_match, key: string, separator: string) => `${key}${separator}<redacted>`);
  return { value: redacted, redacted: redacted !== value };
}

/**
 * Replace every occurrence of `rawPrefix` that is actually the head of a path.
 *
 * Scanning for a known prefix is what makes this honest where a regex is not: a
 * pattern like `/home/<name>/...` matches any string of that *shape*, including
 * a directory on some other machine quoted in a log, and blanking those costs
 * legibility for no privacy gain. Only the prefixes this host really uses are
 * offered here, and each hit must still be bounded on both sides — preceded by
 * a non-path character and followed by a separator or the end of a token.
 *
 * A hit with a path continuing after it (`<prefix>/rest`) takes
 * `nestedReplacement`, and `stripNestedSeparator` drops the separator with it so
 * a workspace turns into `./rest` rather than `.//rest`. A hit that ends there
 * takes `exactReplacement`.
 */
function replacePathPrefix(
  value: string,
  rawPrefix: string,
  exactReplacement: string,
  nestedReplacement: string,
  stripNestedSeparator: boolean,
): string {
  const prefix = rawPrefix.replace(/[\\/]+$/u, '');
  if (prefix === '') return value;

  let cursor = 0;
  let searchFrom = 0;
  let result = '';
  while (searchFrom < value.length) {
    const matchAt = value.indexOf(prefix, searchFrom);
    if (matchAt < 0) break;

    const suffixAt = matchAt + prefix.length;
    const next = value[suffixAt];
    const nested = next === '/' || next === '\\';
    const ends = isPathPrefixEnd(value, suffixAt);
    if (isPathPrefixBoundary(value, matchAt) && (nested || ends)) {
      result += value.slice(cursor, matchAt);
      result += nested ? nestedReplacement : exactReplacement;
      cursor = suffixAt + (nested && stripNestedSeparator ? 1 : 0);
      searchFrom = cursor;
      continue;
    }
    searchFrom = suffixAt;
  }
  return cursor === 0 ? value : result + value.slice(cursor);
}

function isPathPrefixBoundary(value: string, matchAt: number): boolean {
  if (matchAt === 0 || isPathTokenBoundary(value[matchAt - 1])) return true;
  return matchAt >= 3 && value.slice(matchAt - 3, matchAt) === '://';
}

function isPathPrefixEnd(value: string, suffixAt: number): boolean {
  const next = value[suffixAt];
  if (next === undefined) return true;
  return next === '.'
    ? isPathTokenBoundary(value[suffixAt + 1])
    : isPathTokenBoundary(next);
}

function isPathTokenBoundary(character: string | undefined): boolean {
  return character === undefined || !PATH_TOKEN_CHARACTER_RE.test(character);
}
