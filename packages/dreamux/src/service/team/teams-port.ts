import type {
  AgentRuntimeInterruptOutcome,
  TeamSummary,
} from '@excitedjs/dreamux-types';

import type { TurnAdmission } from '../agent/admission.js';
import type { TeammateSubmitInput } from '../agent/submission.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import type { TeamLeaderHandle } from './leader-handle.js';
import type {
  TeamCreateInput,
  TeamDissolveCommand,
  TeamDissolveReceipt,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamListRow,
} from './types.js';

/**
 * The dispatcher-facing surface of the Team collection: every per-Team
 * operation an admin/MCP caller can reach, each already fenced by the
 * dispatcher's own admission gate internally — a caller never wraps a
 * `TeamsPort` call in its own admission check. `TeamCollection` implements
 * this directly, the same shape `SchedulerService` uses for
 * `SchedulerCommands`.
 *
 * `submitToLeader` and `createFromRequest` both take
 * `deliverCompletionToDispatcher` rather than a resolved `CompletionInitiator`:
 * a caller outside `team/` (a Command adapter, an MCP delegate) knows only
 * whether a Core-side initiator is waiting, never the dispatcher Agent itself,
 * so resolving `leaderCompletionInitiator()` stays inside the port's own
 * implementation.
 */
export interface TeamsPort {
  submitToLeader(
    teamId: string,
    input: TeammateSubmitInput & { deliverCompletionToDispatcher: boolean },
  ): Promise<TurnAdmission>;
  interruptLeader(teamId: string): Promise<AgentRuntimeInterruptOutcome>;
  dissolve(
    teamId: string,
    input: TeamDissolveCommand,
  ): Promise<TeamDissolveReceipt>;
  /** This Team's TeamLeader-scoped member/workflow surface. */
  leaderScope(teamId: string): Promise<TeamLeaderHandle>;
  scheduler(teamId: string): Promise<SchedulerCommands>;
  /** Run one caller operation inside this Team's own work fence. */
  runForLeader<T>(teamId: string, task: () => Promise<T>): Promise<T>;
  history(input: TeamHistoryQuery): Promise<TeamHistoryResult>;
  summary(teamId: string): Promise<TeamSummary>;
  list(): Promise<TeamListRow[]>;
  createFromRequest(input: {
    requestId: string;
    payloadHash: string;
    options: TeamCreateInput;
    deliverCompletionToDispatcher: boolean;
  }): Promise<TeamSummary>;
}
