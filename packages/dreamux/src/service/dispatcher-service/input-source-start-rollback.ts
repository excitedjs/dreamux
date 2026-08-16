import type {
  ChannelSession,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
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

/** Roll back live resources through their existing dispatcher-owned boundaries. */
export async function rollbackFailedInputSourceStart(input: {
  dispatcherId: string;
  sessions: Map<string, ChannelSession>;
  channels: ChannelService;
  coreEvents: DispatcherCoreEventBus;
  scheduler: SchedulerService;
  teams: TeamCollection;
  teammates: TeammateCollection;
  admittedTasks: DispatcherTaskDrain;
  collaborationSpaces: CollaborationSpaceService;
  agent: TeammateService | null;
  log: DreamuxLogger;
}): Promise<void> {
  const failures: unknown[] = [];
  input.scheduler.stop();
  input.teams.stopSchedulers();
  input.coreEvents.revokeSources();
  input.teams.interruptDissolvesForShutdown();
  const teamStopError = await stopTeamRuntimes({
    dispatcherId: input.dispatcherId,
    teams: input.teams,
    log: input.log,
  });
  if (teamStopError !== null) failures.push(teamStopError);
  await collectShutdownFailure(failures, async () => {
    await input.teammates.materializeNonClosedEntities();
  });
  for (const teammate of input.teammates.materializedEntities()) {
    await collectShutdownFailure(failures, async () => {
      await teammate.close({ note: 'Dispatcher start failed' });
    });
  }
  await collectShutdownFailure(failures, async () => {
    await input.agent?.close({ note: 'Dispatcher start failed' });
  });
  await collectShutdownFailure(failures, () => closeAllBuilt(input.sessions));
  input.channels.clear();
  await collectShutdownFailure(failures, () =>
    input.collaborationSpaces.drainLifecycleTasks());
  await collectShutdownFailure(failures, () => input.admittedTasks.drain());
  // An admitted task may publish durable state while the first sweep is
  // closing it. Repeat the idempotent canonical convergence after the drain.
  const lateTeamStopError = await stopTeamRuntimes({
    dispatcherId: input.dispatcherId,
    teams: input.teams,
    log: input.log,
  });
  if (lateTeamStopError !== null) failures.push(lateTeamStopError);
  await collectShutdownFailure(failures, async () => {
    await input.teammates.materializeNonClosedEntities();
  });
  for (const teammate of input.teammates.materializedEntities()) {
    await collectShutdownFailure(failures, async () => {
      await teammate.close({ note: 'Dispatcher start failed' });
    });
  }
  await collectShutdownFailure(failures, async () => {
    await input.agent?.close({ note: 'Dispatcher start failed' });
  });
  throwShutdownFailures(
    failures,
    `dispatcher ${JSON.stringify(input.dispatcherId)} start rollback could not prove resource closure`,
  );
}
