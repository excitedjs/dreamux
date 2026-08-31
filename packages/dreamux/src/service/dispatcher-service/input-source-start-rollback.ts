import type {
  ChannelInstance,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import type { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeammateCollection } from '../teammate-collection/index.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import type { DispatcherTaskDrain } from './inbound-task-drain.js';
import { closeAllBuilt } from './runtime-helpers.js';
import { stopTeamRuntimes } from './team-runtime-stop.js';

/**
 * Roll back live resources through their existing dispatcher-owned boundaries.
 *
 * A rollback gives back exactly what this start took: schedulers, Team and
 * Agent runtimes, the sessions this run built, and the accepted work still in
 * flight. It closes nothing. An Agent that existed durably before the start —
 * and that a failed start never even ran — must come out of it unchanged.
 */
export async function rollbackFailedInputSourceStart(input: {
  dispatcherId: string;
  sessions: Map<string, ChannelInstance>;
  channels: ChannelService;
  coreEvents: DispatcherCoreEventBus;
  scheduler: SchedulerService;
  teams: TeamCollection;
  teammates: TeammateCollection;
  admittedTasks: DispatcherTaskDrain;
  agent: TeammateService | null;
  log: DreamuxLogger;
}): Promise<void> {
  const failures: unknown[] = [];
  input.scheduler.stop();
  input.teams.stopSchedulers();
  const teamStopError = await stopTeamRuntimes({
    dispatcherId: input.dispatcherId,
    teams: input.teams,
    log: input.log,
  });
  if (teamStopError !== null) failures.push(teamStopError);
  for (const teammate of input.teammates.materializedEntities()) {
    await collectShutdownFailure(failures, () => teammate.stopForHost());
  }
  await collectShutdownFailure(failures, async () => {
    await input.agent?.stopForHost();
  });
  // Subscriptions outlive the runtime stop above on purpose: a runtime settling
  // during rollback still produces facts worth delivering. They are revoked
  // once, here, immediately before the sessions that hold them are closed.
  input.coreEvents.revokeSources();
  await collectShutdownFailure(failures, () => closeAllBuilt(input.sessions));
  input.channels.clear();
  await collectShutdownFailure(failures, () => input.admittedTasks.drain());
  // An admitted task may start a runtime while the first sweep is releasing
  // it. Repeat the idempotent convergence after the drain.
  const lateTeamStopError = await stopTeamRuntimes({
    dispatcherId: input.dispatcherId,
    teams: input.teams,
    log: input.log,
  });
  if (lateTeamStopError !== null) failures.push(lateTeamStopError);
  for (const teammate of input.teammates.materializedEntities()) {
    await collectShutdownFailure(failures, () => teammate.stopForHost());
  }
  await collectShutdownFailure(failures, async () => {
    await input.agent?.stopForHost();
  });
  throwShutdownFailures(
    failures,
    `dispatcher ${JSON.stringify(input.dispatcherId)} start rollback could not prove resource release`,
  );
}
