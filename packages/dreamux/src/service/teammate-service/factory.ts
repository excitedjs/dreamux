import type { AgentEntityIdentity } from '../agent-entity/types.js';
import {
  TeammateService,
} from './index.js';
import type {
  TeammateServiceDeps,
  TeammateServiceOptions,
} from './types.js';

export interface CreateTeammateServiceInput extends TeammateServiceDeps {
  dispatcherId: string;
  identity: AgentEntityIdentity;
  options: TeammateServiceOptions;
}

export function createTeammateService(
  input: CreateTeammateServiceInput,
): TeammateService {
  return new TeammateService(
    input,
    input.dispatcherId,
    input.identity,
    input.options,
  );
}
