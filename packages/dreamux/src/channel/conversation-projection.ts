import type {
  DreamuxLogger,
  JsonValue,
  RuntimeActivity,
  TeammateActivity,
  TeammateActivityEvent,
  TeammateInputEvent,
  TeammateInputNotice,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import { redactJson, redactText } from '@excitedjs/dreamux-utils';

import { errorInfo } from '../platform/error-info.js';
import type { DispatcherCoreEventPublisher } from '../service/dispatcher-core-events/index.js';
import type { AgentEntityIdentity } from '../service/agent-entity/types.js';


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
  /** Which producer's work this reports, for the automated push-backs that carry one. */
  readonly notice: TeammateInputNotice | null;
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
          // The producer is an Agent name this host assigned, from an alphabet
          // (`TEAMMATE_NAME_PATTERN`) with no separator, colon, or space in it:
          // no redaction rule can match one, and the two that could match its
          // *shape* would only mangle a legal name.
          notice: admitted.notice,
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
      const redact = (text: string | null) =>
        text === null ? null : redactText(text, cwd, homePathPrefixes);
      const summary = redact(activity.summary);
      const invocation = redact(activity.invocation);
      const items = activity.items.map((item) => redactText(item, cwd, homePathPrefixes));
      // A call's payloads arrive as structure, so they are walked rather than
      // read as one string: a key that names a secret is answered by its name,
      // and every string leaf is ordinary text by the time it is redacted.
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
        arguments_json: jsonText(args.value),
        result_json: jsonText(result.value),
        redacted: [summary, invocation, args, result, ...items]
          .some((member) => member?.redacted ?? false),
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
 * A structured value travels as its compact JSON text; a value that already is
 * a string travels as itself. The text is whole, never cut, and it is written
 * after redaction rather than before, so a structured payload is still valid
 * JSON when it arrives.
 */
function jsonText(value: JsonValue | string | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
