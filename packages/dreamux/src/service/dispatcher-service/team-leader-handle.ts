import type {
  AgentEntityCapabilities,
  AgentEntitySpawnResult,
} from '../agent-entity/types.js';
import type {
  SpawnTeamMateRequest,
  TeammateOps,
} from '../teammate-collection/index.js';
import type { TeamLeaderLease } from '../team-collection/types.js';
import type { TeamService } from '../team-service/index.js';
import type { WorkflowOps } from '../workflow-service/index.js';

export interface TeamLeaderTeammateOps {
  send: TeammateOps['send'];
  close: TeammateOps['close'];
  list: TeammateOps['list'];
  status: TeammateOps['status'];
  history: TeammateOps['history'];
  last: TeammateOps['last'];
  getCapabilities(): Promise<AgentEntityCapabilities>;
}

export interface TeamLeaderHandle {
  teammates: TeamLeaderTeammateOps;
  workflows: WorkflowOps;
  spawnTeamMate(
    input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>,
  ): Promise<AgentEntitySpawnResult>;
}

export function teamLeaderHandle(input: {
  lease: TeamLeaderLease;
  withService: <T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ) => Promise<T>;
}): TeamLeaderHandle {
  const run = async <T>(task: (service: TeamService) => Promise<T>) =>
    input.withService(input.lease, task);
  const finishOutsideLease = async <T>(
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> => {
    // Some workflow operations can wait for agents that re-enter this Team
    // lease. Carry their completion promise out as data before awaiting it.
    const pending = await run(async (service) => ({ completion: task(service) }));
    return pending.completion;
  };
  return {
    teammates: {
      send: (sendInput) => run((service) => service.teammates.send(sendInput)),
      close: (closeInput) => run((service) => service.teammates.close(closeInput)),
      list: () => run((service) => service.teammates.list()),
      status: (name) => run((service) => service.teammates.status(name)),
      history: (historyInput) =>
        run((service) => service.teammates.history(historyInput)),
      last: (name, turns) => run((service) => service.teammates.last(name, turns)),
      getCapabilities: () =>
        run(async (service) => service.teammates.getCapabilities()),
    },
    workflows: {
      run: (workflowInput) =>
        finishOutsideLease((service) => service.workflows.run(workflowInput)),
      status: (statusInput) =>
        run((service) => service.workflows.status(statusInput)),
      stop: (stopInput) =>
        finishOutsideLease((service) => service.workflows.stop(stopInput)),
      list: () => run((service) => service.workflows.list()),
    },
    spawnTeamMate: (spawnInput) =>
      run((service) => service.spawnTeamMate(spawnInput)),
  };
}
