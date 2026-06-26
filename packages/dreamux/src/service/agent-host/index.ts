import type { SchedulerService } from '../scheduler/service.js';
import {
  TeammateCollection,
  type TeammateOps,
} from '../teammate-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';

export interface AgentHostOptions {
  members: TeammateCollection;
  agent?: TeammateService;
  agentDescription: string;
}

/**
 * Shared host for a conversational agent plus its owned member collection.
 * DispatcherService and TeamService keep their domain-specific policy and
 * records, while this owns the duplicated member/scheduler lifecycle surface.
 */
export class AgentHost {
  private readonly members_: TeammateCollection;
  private agent_: TeammateService | null;
  private readonly agentDescription: string;

  constructor(opts: AgentHostOptions) {
    this.members_ = opts.members;
    this.agent_ = opts.agent ?? null;
    this.agentDescription = opts.agentDescription;
  }

  setAgent(agent: TeammateService): void {
    this.agent_ = agent;
  }

  get agent(): TeammateService {
    return this.mustAgent();
  }

  mustAgent(): TeammateService {
    if (this.agent_ === null) {
      throw new Error(`${this.agentDescription} is not booted`);
    }
    return this.agent_;
  }

  get scheduler(): SchedulerService {
    const scheduler = this.mustAgent().scheduler;
    if (scheduler === null) {
      throw new Error(`${this.agentDescription} has no scheduler capability`);
    }
    return scheduler;
  }

  get teammates(): TeammateOps {
    return this.members_;
  }

  get members(): TeammateCollection {
    return this.members_;
  }

  async startScheduler(): Promise<void> {
    await this.mustAgent().startScheduler();
  }

  stopScheduler(): void {
    this.mustAgent().stopScheduler();
  }

  async deleteSchedulerStore(): Promise<void> {
    await this.mustAgent().deleteSchedulerStore();
  }

  async stopAll(): Promise<void> {
    await this.members_.stopAll();
    await this.mustAgent().stop();
  }
}
