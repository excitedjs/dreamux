import type { ChannelSession, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { TaskChannelHostCollection } from '../channel-task-host/index.js';
import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { DispatcherTaskDrain } from './inbound-task-drain.js';
import { closeAllBuilt, errInfo } from './runtime-helpers.js';
import { stopTeamRuntimes } from './team-runtime-stop.js';

export async function stopDispatcherResources(input: {
  dispatcherId: string;
  preparing: Promise<void> | null;
  inputSourcesStarting: Promise<void> | null;
  taskHosts: TaskChannelHostCollection | null;
  scheduler: SchedulerService;
  teams: TeamCollection;
  admittedTasks: DispatcherTaskDrain;
  collaborationSpaces: CollaborationSpaceService;
  channels: ChannelService;
  preparedChannels: Map<string, ChannelSession> | null;
  agent: TeammateService | null;
  log: DreamuxLogger;
}): Promise<void> {
  const failures: unknown[] = [];
  if (input.preparing !== null) await input.preparing.catch(() => {});
  if (input.inputSourcesStarting !== null) {
    await input.inputSourcesStarting.catch(() => {});
  }
  await collectShutdownFailure(failures, () =>
    input.taskHosts?.prepareStop() ?? Promise.resolve(),
  );
  input.scheduler.stop();
  input.teams.stopSchedulers();
  await input.admittedTasks.drain();
  await input.collaborationSpaces.drainLifecycleTasks();
  await collectShutdownFailure(failures, () =>
    input.taskHosts?.drain() ?? Promise.resolve(),
  );
  input.scheduler.stop();
  input.teams.stopSchedulers();
  const teamStopError = await stopTeamRuntimes({
    dispatcherId: input.dispatcherId,
    teams: input.teams,
    log: input.log,
  });
  if (teamStopError !== null) failures.push(teamStopError);
  await collectShutdownFailure(failures, () =>
    input.taskHosts?.finishStop() ?? Promise.resolve(),
  );
  await input.channels.closeAll(input.log);
  input.taskHosts?.detachEventSinks();
  if (input.preparedChannels !== null) await closeAllBuilt(input.preparedChannels);
  input.channels.clear();
  await collectShutdownFailure(failures, async () => input.agent?.stop());
  for (const failure of failures) {
    input.log.error(
      { dispatcher_id: input.dispatcherId, err: errInfo(failure) },
      'error stopping dispatcher resource',
    );
  }
  throwShutdownFailures(
    failures,
    `multiple resources in dispatcher ${JSON.stringify(input.dispatcherId)} failed to stop`,
  );
}
