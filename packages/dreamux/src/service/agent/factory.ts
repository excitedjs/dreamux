import type { AdmissionLedger } from './admission.js';
import type { AgentEntityIdentity } from './identity.js';
import { AgentService } from './service.js';
import type { TeammateServiceDeps, TeammateServiceOptions } from './service-types.js';

export interface CreateAgentServiceInput extends Omit<TeammateServiceDeps, 'admissions'> {
  identity: AgentEntityIdentity;
  options: TeammateServiceOptions;
}

/**
 * Builds every `AgentService` for one dispatcher — its own Agent, each Team's
 * leader, and every TeamMate a `TeammateCollection` holds.
 *
 * `dispatcherId` and the dispatcher-lifetime `AdmissionLedger` are bound once,
 * at construction, instead of threaded through every call: the ledger has to
 * outlive an entity's service object (rematerialized on reopen, dropped on
 * retire), so one factory instance carries the one ledger for as long as the
 * dispatcher runs.
 */
export class AgentServiceFactory {
  constructor(
    private readonly dispatcherId: string,
    private readonly admissions: AdmissionLedger,
  ) {}

  create(input: CreateAgentServiceInput): AgentService {
    return new AgentService(
      { ...input, admissions: this.admissions },
      this.dispatcherId,
      input.identity,
      input.options,
    );
  }
}
