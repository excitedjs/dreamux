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
  withMutationService: <T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ) => Promise<T>;
  withReadService: <T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ) => Promise<T>;
}): TeamLeaderHandle {
  const mutate = async <T>(task: (service: TeamService) => Promise<T>) =>
    input.withMutationService(input.lease, task);
  const read = async <T>(task: (service: TeamService) => Promise<T>) =>
    input.withReadService(input.lease, task);
  const finishOutsideLease = async <T>(
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> => {
    // Some workflow operations can wait for agents that re-enter this Team
    // lease. Carry their completion promise out as data before awaiting it.
    const pending = await mutate(async (service) => ({ completion: task(service) }));
    return pending.completion;
  };
  return {
    teammates: {
      send: (sendInput) => mutate((service) => service.teammates.send(sendInput)),
      close: (closeInput) => mutate((service) => service.teammates.close(closeInput)),
      list: () => read((service) => service.teammates.list()),
      status: (name) => read((service) => service.teammates.status(name)),
      history: (historyInput) =>
        read((service) => service.teammates.history(historyInput)),
      last: (name, turns) => read((service) => service.teammates.last(name, turns)),
      getCapabilities: () =>
        read(async (service) => service.teammates.getCapabilities()),
    },
    workflows: {
      run: (workflowInput) =>
        finishOutsideLease((service) => service.workflows.run(workflowInput)),
      status: (statusInput) =>
        read((service) => service.workflows.status(statusInput)),
      stop: (stopInput) =>
        finishOutsideLease((service) => service.workflows.stop(stopInput)),
      list: () => read((service) => service.workflows.list()),
    },
    spawnTeamMate: (spawnInput) =>
      mutate((service) => service.spawnTeamMate(spawnInput)),
  };
}
