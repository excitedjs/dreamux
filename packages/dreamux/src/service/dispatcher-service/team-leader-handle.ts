import type {
  AgentEntityCapabilities,
  AgentEntitySpawnResult,
} from '../agent-entity/types.js';
import type {
  SpawnTeamMateRequest,
  TeammateOps,
} from '../teammate-collection/types.js';
import type { TeamLeaderLease } from '../team-collection/types.js';
import type { TeamService } from '../team-service/index.js';

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
    spawnTeamMate: (spawnInput) =>
      run((service) => service.spawnTeamMate(spawnInput)),
  };
}
