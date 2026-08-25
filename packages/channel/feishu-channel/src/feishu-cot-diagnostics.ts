/**
 * Structured diagnostics for the Feishu COT display surface.
 *
 * COT is optional, fail-open display: it must never widen the host's log
 * surface. So every line it emits is assembled here, and carries only routing
 * scope, presentation/card identity, the failing stage, and an error
 * *category* — never a free-form message, stack, request payload, or
 * credential, any of which could echo a host path or secret.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { FeishuCotApiError } from '@excitedjs/feishu-transport';

import { isFeishuOperationError } from './feishu-bounded-operation.js';

/** Which platform call failed. */
export type CotStage = 'create' | 'append' | 'complete';

/** Routing scope shared by every COT log line. */
export interface CotLogScope {
  readonly dispatcher_id: string;
  readonly channel_id: string | null;
  readonly team_name?: string;
  readonly leader_name?: string;
  readonly agent_name?: string;
}

export function cotLogScope(input: {
  dispatcherId: string;
  channelId: string | undefined;
  leader?: { teamName: string; leaderName: string } | undefined;
  dispatcherAgent?: { agentName: string } | undefined;
}): CotLogScope {
  return {
    dispatcher_id: input.dispatcherId,
    channel_id: input.channelId ?? null,
    ...(input.leader !== undefined
      ? { team_name: input.leader.teamName, leader_name: input.leader.leaderName }
      : {}),
    ...(input.dispatcherAgent !== undefined
      ? { agent_name: input.dispatcherAgent.agentName }
      : {}),
  };
}

/**
 * The only shape a COT diagnostic may carry about a failure: the error class
 * plus Feishu's own business code.
 */
export function cotErrorCategory(error: unknown): {
  err_name: string;
  err_code: number | null;
} {
  return {
    err_name: error instanceof Error ? error.name : 'unknown',
    err_code: error instanceof FeishuCotApiError ? error.code : null,
  };
}

/** Report a failed platform call. Cancellation at session close is not news. */
export function logCotFailure(
  log: DreamuxLogger,
  scope: CotLogScope,
  card: { presentationId: string; stage: CotStage },
  error: unknown,
): void {
  const fields = {
    ...scope,
    presentation_id: card.presentationId,
    stage: card.stage,
    ...cotErrorCategory(error),
  };
  if (isFeishuOperationError(error, 'aborted')) {
    log.debug(fields, 'Feishu COT call cancelled with the session');
    return;
  }
  log.warn(fields, 'Feishu COT call failed; presentation only');
}
