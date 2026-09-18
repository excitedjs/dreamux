import type {
  DreamuxLogger,
  RuntimeActivity,
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
          occurredAt: admitted.occurredAt,
          source: admitted.source,
          sourceId: admitted.sourceId,
          content: content.value,
          // The producer is an Agent name this host assigned, from an alphabet
          // (`TEAMMATE_NAME_PATTERN`) with no separator, colon, or space in it:
          // no redaction rule can match one, and the two that could match its
          // *shape* would only mangle a legal name.
          notice: admitted.notice,
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
          occurredAt: activity.occurredAt,
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
      schemaVersion: 1 as const,
      teamName: identity.team_id,
      teammateName: identity.name,
      role,
    };
  }
  if (role === 'dispatcher' && identity.team_id === null) {
    return {
      schemaVersion: 1 as const,
      teamName: null,
      teammateName: identity.name,
      role,
    };
  }
  return null;
}

/** Redact payloads while preserving the runtime's activity shape and identity. */
function projectedActivity(
  activity: RuntimeActivity,
  cwd: string,
  homePathPrefixes: readonly string[],
): RuntimeActivity {
  const redact = (text: string | null): string | null =>
    text === null ? null : redactText(text, cwd, homePathPrefixes).value;
  switch (activity.kind) {
    case 'context.compacted':
    case 'turn.interrupted':
    case 'token.usage':
      return activity;
    case 'assistant.message':
      return { ...activity, text: redactText(activity.text, cwd, homePathPrefixes).value };
    case 'tool.call':
      return {
        ...activity,
        summary: redact(activity.summary),
        invocation: redact(activity.invocation),
        items: activity.items.map((item) => redactText(item, cwd, homePathPrefixes).value),
        // A call's payloads arrive as structure, so they are walked rather
        // than read as one string: a key that names a secret is answered by
        // its name, and every string leaf is ordinary text by the time it is
        // redacted.
        arguments: redactJson(activity.arguments, cwd, homePathPrefixes).value,
        result: redactJson(activity.result, cwd, homePathPrefixes).value,
        error: redact(activity.error),
      };
    case 'turn.ended':
      return { ...activity, reason: redact(activity.reason) };
    default: {
      // Every activity kind must pass through this redaction boundary.
      // The monorepo ships one release pinned through workspace dependencies,
      // so an unknown kind cannot reach a deployed process. A missing arm is
      // a compile error, not a runtime condition to defend against.
      const exhaustive: never = activity;
      return exhaustive;
    }
  }
}
