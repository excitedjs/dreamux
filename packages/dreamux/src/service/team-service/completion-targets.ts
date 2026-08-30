import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
  PreparedCompletionDelivery,
  PreparedCompletionFact,
} from '../completion-router/index.js';
import { isTeamUnavailable } from '../team-collection/errors.js';
import type { TurnCompletionDelivery } from '../teammate-service/turn-recording.js';

export interface TeamCompletionTargetDeps {
  /** Run one delivery step inside the Team's work fence. */
  admit<T>(task: () => Promise<T>): Promise<T>;
  prepareLeaderCompletion(
    completion: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery>;
}

/**
 * One Team's leader as a fenced completion recipient.
 *
 * Every completion produced inside a Team goes to that Team's leader, so this
 * is resolved from ownership rather than from the producing record: one Team,
 * one leader, one recipient key for as long as the Team exists. Each step
 * observes the same fence an ordinary submission does — a Team that is
 * dissolving or already closed reports the delivery as unsupported, so the
 * completion router falls back instead of reviving a Team being torn down.
 */
export class TeamLeaderCompletionTargets {
  private readonly recipientKey = Object.freeze({});

  constructor(private readonly deps: TeamCompletionTargetDeps) {}

  current(): CompletionInitiator {
    const { deps, recipientKey } = this;
    return {
    recipientKey,
    prepareCompletion: async (completion) => {
      let prepared: PreparedCompletionDelivery;
      try {
        prepared = await deps.admit(() =>
          deps.prepareLeaderCompletion(completion));
      } catch (error) {
        if (isTeamUnavailable(error)) return unsupportedCompletion();
        throw error;
      }
      return Object.freeze({
        submit: async () => {
          try {
            return await deps.admit(() => prepared.submit());
          } catch (error) {
            if (isTeamUnavailable(error)) {
              return {
                status: 'unsupported' as const,
                reason: 'Team is closing or unavailable',
              };
            }
            throw error;
          }
        },
      });
    },
    };
  }
}

function unsupportedCompletion(): PreparedCompletionDelivery {
  const reason = 'Team is closing or unavailable';
  return Object.freeze({
    submit: async () => ({
      status: 'unsupported' as const,
      reason,
    }),
  });
}

/**
 * Where this Team's own leader reports: the dispatcher Agent that owns the
 * Team, resolved once and captured as the delivery closure a leader turn
 * carries. `null` means nobody Core-side is waiting for that turn.
 */
export async function resolveTeamLeaderCompletionDelivery(deps: {
  initiator: () => Promise<CompletionInitiator | null>;
  completionDelivery: CompletionDeliveryPolicy;
}): Promise<TurnCompletionDelivery | null> {
  const initiator = await deps.initiator();
  if (initiator === null) return null;
  return (completion, fact) =>
    deps.completionDelivery.deliverRuntime(initiator, completion, fact);
}
