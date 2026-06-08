import type { AgentRuntimeProviderCatalog } from '../agent-runtime/index.js';
import type { DreamuxConfig } from '../runtime/config.js';
import type { DispatcherStore } from '../runtime/dispatcher-store.js';
import type { DreamuxLogger } from '../runtime/logger.js';
import { TeamMateAgentService } from './teammate/service.js';
import type {
  CloseTeamMateInput,
  ResumeTeamMateInput,
  SendTeamMateInput,
  SpawnTeamMateInput,
} from './teammate/types.js';

export interface DispatcherServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  log: DreamuxLogger;
}

/**
 * Dispatcher Service owns server-side orchestration for dispatchers.
 *
 * The stdio MCP shim and admin method layer only map tool/admin calls into this
 * service. Teammate identities, resume history, and teammate AgentRuntime
 * instances are delegated to the agent-centric TeamMate sub-service.
 */
export class DispatcherService {
  readonly teammates: TeamMateAgentService;

  constructor(opts: DispatcherServiceOptions) {
    this.teammates = new TeamMateAgentService({
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      log: opts.log,
    });
  }

  spawnTeamMate(input: SpawnTeamMateInput) {
    return this.teammates.spawn(input);
  }

  sendTeamMate(input: SendTeamMateInput) {
    return this.teammates.send(input);
  }

  resumeTeamMate(input: ResumeTeamMateInput) {
    return this.teammates.resume(input);
  }

  closeTeamMate(input: CloseTeamMateInput) {
    return this.teammates.close(input);
  }

  listTeamMates(dispatcherId: string) {
    return this.teammates.list(dispatcherId);
  }

  getTeamMateStatus(dispatcherId: string, name: string) {
    return this.teammates.status(dispatcherId, name);
  }

  getTeamMateHistory(dispatcherId: string, name: string) {
    return this.teammates.history(dispatcherId, name);
  }

  getTeamMateLast(dispatcherId: string, name: string) {
    return this.teammates.last(dispatcherId, name);
  }

  getTeamMateContext(dispatcherId: string, name: string) {
    return this.teammates.context(dispatcherId, name);
  }

  getTeamMateCapabilities() {
    return this.teammates.getCapabilities();
  }

  async shutdown(): Promise<void> {
    await this.teammates.stopAll();
  }
}
