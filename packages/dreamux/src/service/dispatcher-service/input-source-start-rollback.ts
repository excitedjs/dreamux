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
  admittedTasks: DispatcherTaskDrain;
  collaborationSpaces: CollaborationSpaceService;
  agent: TeammateService | null;
  log: DreamuxLogger;
}): Promise<void> {
  input.scheduler.stop();
  input.teams.stopSchedulers();
  input.coreEvents.revokeSources();
  input.channels.clear();
  await closeAllBuilt(input.sessions);
  input.teams.interruptDissolvesForShutdown();
  await input.admittedTasks.drain();
  await input.collaborationSpaces.drainLifecycleTasks();
  input.scheduler.stop();
  input.teams.stopSchedulers();
  await stopTeamRuntimes({
    dispatcherId: input.dispatcherId,
    teams: input.teams,
    log: input.log,
  });
  try {
    await input.agent?.stop();
  } catch {
    /* best effort; preserve the original Channel start failure */
  }
}
