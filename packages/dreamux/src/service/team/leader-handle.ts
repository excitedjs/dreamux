import type {
  AgentEntityCapabilities,
  AgentEntitySpawnResult,
} from '../agent/identity.js';
import type { SpawnTeamMateRequest, TeammateOps } from '../agent/types.js';
import type { TeamService } from './service.js';
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
  teamId: string;
  withMutationService: <T>(
    teamId: string,
    task: (service: TeamService) => Promise<T>,
  ) => Promise<T>;
  withReadService: <T>(
    teamId: string,
    task: (service: TeamService) => Promise<T>,
  ) => Promise<T>;
}): TeamLeaderHandle {
  const mutate = async <T>(task: (service: TeamService) => Promise<T>) =>
    input.withMutationService(input.teamId, task);
  const read = async <T>(task: (service: TeamService) => Promise<T>) =>
    input.withReadService(input.teamId, task);
  return {
    teammates: {
      send: (sendInput) =>
        mutate((service) => service.teammates.send(sendInput)),
      close: (closeInput) =>
        mutate((service) => service.teammates.close(closeInput)),
      list: () => read((service) => service.teammates.list()),
      status: (name) => read((service) => service.teammates.status(name)),
      history: (historyInput) =>
        read((service) => service.teammates.history(historyInput)),
      last: (name, query) =>
        read((service) => service.teammates.last(name, query)),
      getCapabilities: () =>
        read(async (service) => service.teammates.getCapabilities()),
    },
    // `run`/`stop` route through the same `mutate` closure as every other
    // mutating op. `TeamService.admit()` (`withMutationService`'s ultimate
    // target) is a stateless refusal check, not a lock held across the whole
    // call — so there is no lease for a long-running Workflow call to hold
    // while it awaits an agent that re-enters this Team, and nothing to carry
    // out as data before awaiting.
    workflows: {
      run: (workflowInput) =>
        mutate((service) => service.workflows.run(workflowInput)),
      status: (statusInput) =>
        read((service) => service.workflows.status(statusInput)),
      stop: (stopInput) =>
        mutate((service) => service.workflows.stop(stopInput)),
      list: () => read((service) => service.workflows.list()),
    },
    spawnTeamMate: (spawnInput) =>
      mutate((service) => service.spawnTeamMate(spawnInput)),
  };
}
