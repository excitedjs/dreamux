import type {
  DreamuxLogger,
  JsonValue,
  RuntimeActivity,
  TeammateActivity,
  TeammateActivityEvent,
  TeammateInputEvent,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import { errorInfo } from '../platform/error-info.js';
import type { DispatcherCoreEventPublisher } from '../service/dispatcher-core-events/index.js';
import type { AgentEntityIdentity } from '../service/agent-entity/types.js';

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

/**
 * Core redacts and never truncates. How much of a payload a surface can show
 * is that surface's own limit, applied where it sends (operator ruling,
 * 2026-09-04: 「core那边只做脱敏，不做截断 … Channel这边先去解析JSON，然后在发送接
 * 口之前去做截断」). Cutting here would hand every surface an already-damaged
 * value — a JSON result that no longer parses — with no way to get it back.
 */
interface RedactedText { value: string; redacted: boolean }

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

/** One input Core admitted, as the submitting owner supplied it. */
export interface ConversationInput {
  /** The open provenance name the owner chose; Core neither parses nor branches on it. */
  readonly source: string;
  /** The submitting caller's own id, echoed back so it can recognize its own submission. */
  readonly sourceId: string | null;
  /** The source's own body, never the assembled provenance envelope. */
  readonly text: string;
  readonly occurredAt: number;
}

/**
 * The display-only stream of one Agent's conversation.
 *
 * Two facts, split by producer: Core says what it admitted, the runtime says
 * what it did. Neither is keyed on a submission — a provider folds any number
 * of submissions into one native turn, so a display keyed on submissions has to
 * invent a correlation that does not exist.
 *
 * Neither call ever throws. A conversation display is redundant by design, and
 * its producers publish from inside operations whose durable work has already
 * succeeded — so a defect in sanitizing a payload must cost the update it was
 * building, never the turn that produced it.
 */
export interface ConversationProjection {
  projectInput(agent: ProjectedAgent, input: ConversationInput): void;
  projectActivity(agent: ProjectedAgent, activity: RuntimeActivity): void;
}

export function createConversationProjection(input: {
  coreEvents: DispatcherCoreEventPublisher;
  log: DreamuxLogger;
  homePathPrefixes: readonly string[];
}): ConversationProjection {
  const guarded = (
    agent: ProjectedAgent,
    entryPoint: 'input' | 'activity',
    operation: () => void,
  ): void => {
    try {
      operation();
    } catch (error) {
      try {
        input.log.warn(
          {
            dispatcher_id: agent.identity.dispatcher_id,
            agent_name: agent.identity.name,
            role: agent.role,
            entry_point: entryPoint,
            err: errorInfo(error),
          },
          'Conversation projection failed; continuing without this display update',
        );
      } catch {
        // Display diagnostics are non-authoritative for turn execution.
      }
    }
  };
  return {
    projectInput(agent, admitted) {
      const identity = agent.identity;
      const scope = actorScope(agent);
      if (scope === null || input.coreEvents.hasSources?.() === false) return;
      guarded(agent, 'input', () => {
        const content = redactText(admitted.text, identity.cwd, input.homePathPrefixes);
        const event: TeammateInputEvent = {
          ...scope,
          kind: 'teammate.input',
          occurred_at: admitted.occurredAt,
          source: admitted.source,
          source_id: admitted.sourceId,
          content: content.value,
          redacted: content.redacted,
        };
        input.coreEvents.publish(identity.dispatcher_id, event);
      });
    },
    projectActivity(agent, activity) {
      const identity = agent.identity;
      const scope = actorScope(agent);
      if (scope === null || input.coreEvents.hasSources?.() === false) return;
      guarded(agent, 'activity', () => {
        const event: TeammateActivityEvent = {
          ...scope,
          kind: 'teammate.activity',
          occurred_at: activity.occurredAt,
          activity: projectedActivity(activity, identity.cwd, input.homePathPrefixes),
        };
        input.coreEvents.publish(identity.dispatcher_id, event);
      });
    },
  };
}

/**
 * Which conversation an Agent belongs to.
 *
 * Only two conversations exist at this boundary: a Team's, and the dispatcher's
 * own. A dispatcher-scoped TeamMate has neither — it projects nothing — which
 * is why the Team branch keys on the Team the owner bound, not on the role
 * value it now shares with Team-scoped TeamMates.
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

/** Make one runtime fact safe to display, keeping the runtime's own vocabulary. */
function projectedActivity(
  activity: RuntimeActivity,
  cwd: string,
  homePathPrefixes: readonly string[],
): TeammateActivity {
  switch (activity.kind) {
    case 'assistant.message': {
      const content = redactText(activity.text, cwd, homePathPrefixes);
      return {
        kind: 'assistant.message',
        event_id: activity.id,
        content: content.value,
        redacted: content.redacted,
      };
    }
    case 'tool.call': {
      const summary = activity.summary === null
        ? null
        : redactText(activity.summary, cwd, homePathPrefixes);
      const invocation = activity.invocation === null
        ? null
        : redactText(activity.invocation, cwd, homePathPrefixes);
      const items = activity.items.map((item) => redactText(item, cwd, homePathPrefixes));
      const args = redactJson(activity.arguments, cwd, homePathPrefixes);
      const result = redactJson(activity.error ?? activity.result, cwd, homePathPrefixes);
      return {
        kind: 'tool.call',
        event_id: activity.id,
        call_id: activity.callId,
        tool_name: activity.toolName,
        tool_action: activity.action,
        summary: summary?.value ?? null,
        invocation: invocation?.value ?? null,
        items: items.map((item) => item.value),
        status: activity.status,
        arguments_json: args?.value ?? null,
        result_json: result?.value ?? null,
        redacted: (summary?.redacted ?? false) || (invocation?.redacted ?? false) ||
          items.some((item) => item.redacted) ||
          (args?.redacted ?? false) || (result?.redacted ?? false),
      };
    }
    case 'turn.ended': {
      const reason = activity.reason === null
        ? null
        : redactText(activity.reason, cwd, homePathPrefixes);
      return {
        kind: 'turn.ended',
        status: activity.status,
        reason: reason?.value ?? null,
        redacted: reason?.redacted ?? false,
      };
    }
  }
}

/**
 * A structured value travels as its compact JSON text, redacted like any other
 * string; a value that already is a string travels as itself. A consumer that
 * wants the structure back parses the text — it is whole, never cut.
 */
function redactJson(
  value: JsonValue | string | null,
  cwd: string,
  homePathPrefixes: readonly string[],
): RedactedText | null {
  if (value === null) return null;
  return redactText(typeof value === 'string' ? value : JSON.stringify(value), cwd, homePathPrefixes);
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
): RedactedText {
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
 * a workspace `<cwd>/rest` turns into `rest`. A hit that ends there takes
 * `exactReplacement`, so a bare workspace becomes `.`.
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
