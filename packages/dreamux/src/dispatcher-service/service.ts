import type { AgentRuntimeProviderCatalog } from '../agent-runtime/index.js';
import type { AgentRuntime } from '../agent-runtime/index.js';
import type { DreamuxConfig } from '../runtime/config.js';
import type { DispatcherStore } from '../runtime/dispatcher-store.js';
import type { DreamuxLogger } from '../runtime/logger.js';
import type { FeishuBot } from '../channel/feishu/bot.js';
import type { DispatcherRow } from '../runtime/dispatcher-store.js';
import type { RestartIntentConsumer } from '../daemon/restart-intent.js';
import {
  DispatcherAgentService,
  type DispatcherSummary,
  type FeishuChannelToolCall,
} from './dispatcher/service.js';
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
  adminSocketPath?: string;
  botFactory?: (row: DispatcherRow, secret: string) => FeishuBot;
  skipBotSecret?: boolean;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
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
  readonly dispatchers: DispatcherAgentService;
  readonly teammates: TeamMateAgentService;

  constructor(opts: DispatcherServiceOptions) {
    this.dispatchers = new DispatcherAgentService({
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      log: opts.log,
      channelLoggerFactory: opts.channelLoggerFactory,
      ...(opts.adminSocketPath !== undefined
        ? { adminSocketPath: opts.adminSocketPath }
        : {}),
      ...(opts.botFactory !== undefined ? { botFactory: opts.botFactory } : {}),
      ...(opts.skipBotSecret !== undefined
        ? { skipBotSecret: opts.skipBotSecret }
        : {}),
    });
    this.teammates = new TeamMateAgentService({
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      log: opts.log,
    });
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.dispatchers.setRestartIntent(consumer);
  }

  startDispatcher(id: string): Promise<void> {
    return this.dispatchers.startDispatcher(id);
  }

  stopDispatcher(id: string): Promise<void> {
    return this.dispatchers.stopDispatcher(id);
  }

  getRuntime(id: string): AgentRuntime | null {
    return this.dispatchers.getRuntime(id);
  }

  summarize(): DispatcherSummary[] {
    return this.dispatchers.summarize();
  }

  callFeishuMcpTool(input: FeishuChannelToolCall) {
    return this.dispatchers.callFeishuMcpTool(input);
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
    await this.dispatchers.shutdown();
  }
}
