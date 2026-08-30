import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { teamCronJobsPath, teamMateCollectionDir } from '../../platform/paths.js';
import { AgentEntityCollectionStore } from '../agent-entity/identity-store.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import type { CompletionInitiator } from '../completion-router/index.js';
import { SchedulerService } from '../scheduler/service.js';
import { CronJobStore } from '../scheduler/store.js';
import type {
  SchedulerCommands,
  SchedulerServiceOptions,
} from '../scheduler/types.js';
import {
  TeammateCollection,
  type CreateLockedTeammateOptions,
} from '../teammate-collection/index.js';
import type { SpawnTeamMateRequest } from '../teammate-collection/types.js';
import type { LockedTeammate } from '../teammate-service/types.js';
import { WorkflowService } from '../workflow-service/index.js';
import type { TeamServiceDeps } from './types.js';

/**
 * The Agents one Team owns, as its own team-scoped collection.
 *
 * Every Agent in it belongs to this Team, so its completions go to this Team's
 * leader: ownership decides the recipient, not a field on the producing record.
 */
export function buildTeamMembers(input: {
  deps: TeamServiceDeps;
  teamId: string;
  onPersisted: (identity: AgentEntityIdentity) => void;
  leaderCompletionTarget: () => CompletionInitiator;
}): TeammateCollection {
  const { deps } = input;
  return new TeammateCollection({
    dispatcherId: deps.dispatcherId,
    teamScope: input.teamId,
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    worktrees: deps.worktrees,
    store: new AgentEntityCollectionStore({
      root: teamMateCollectionDir(deps.teamRoot),
      dispatcherId: deps.dispatcherId,
      log: deps.log,
      onPersisted: input.onPersisted,
    }),
    names: deps.names,
    admissions: deps.admissions,
    conversationProjection: deps.conversationProjection,
    completionDelivery: deps.completionDelivery,
    initiatorFor: async () => input.leaderCompletionTarget(),
    ...(deps.agentNameSuffixGenerator !== undefined
      ? { suffixGenerator: deps.agentNameSuffixGenerator }
      : {}),
    log: deps.log,
  });
}

/** This Team's Workflow scope: team-scoped runs, reporting to its leader. */
export function buildTeamWorkflows(input: {
  deps: TeamServiceDeps;
  teamId: string;
  createLocked: (
    request: SpawnTeamMateRequest,
    options?: CreateLockedTeammateOptions,
  ) => Promise<LockedTeammate>;
  leaderCompletionTarget: () => CompletionInitiator;
}): WorkflowService {
  const { deps } = input;
  return new WorkflowService({
    dispatcherId: deps.dispatcherId,
    teamId: input.teamId,
    callerKind: 'team_leader',
    teammates: { createLocked: input.createLocked },
    completionDelivery: deps.completionDelivery,
    completionInitiator: input.leaderCompletionTarget,
    log: deps.workflowLog,
  });
}

export interface TeamSchedulerDeps {
  dispatcherId: string;
  teamId: string;
  teamRoot: string;
  /** The dispatcher admission gate, held around the scheduler itself. */
  admitOperation: <T>(task: () => Promise<T>) => Promise<T>;
  /** This Team's own work fence, held around each public mutation and fire. */
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  /** Deliver one scheduled prompt to this Team's TeamLeader. */
  submitScheduled: SchedulerServiceOptions['submitScheduled'];
  log: DreamuxLogger;
}

/**
 * Wire one Team's cron scheduler to the two fences it answers to.
 *
 * The dispatcher gate wraps the scheduler itself, so nothing it owns writes
 * after dispatcher shutdown begins. The Team's own fence wraps each short
 * public mutation and each timer fire separately, so a Team being dissolved
 * stops taking cron work without the scheduler knowing what a dissolve is. The
 * lifecycle verbs stay off {@link SchedulerCommands}: they belong to whoever
 * owns the Team, not to a cron caller.
 */
export function buildTeamScheduler(deps: TeamSchedulerDeps): {
  service: SchedulerService;
  commands: SchedulerCommands;
} {
  const service = new SchedulerService({
    ownerId: `${deps.dispatcherId}/team/${deps.teamId}`,
    store: new CronJobStore({
      cronJobsPath: teamCronJobsPath(deps.teamRoot),
      dispatcherId: deps.dispatcherId,
    }),
    admit: (task) => deps.admitOperation(task),
    submitScheduled: (input) => deps.admit(() => deps.submitScheduled(input)),
    log: deps.log,
  });
  return {
    service,
    commands: {
      list: () => service.commands.list(),
      create: (input) => deps.admit(() => service.commands.create(input)),
      update: (input) => deps.admit(() => service.commands.update(input)),
      delete: (id) => deps.admit(() => service.commands.delete(id)),
    },
  };
}
