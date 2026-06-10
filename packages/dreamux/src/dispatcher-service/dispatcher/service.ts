import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeProviderCatalog,
  CompletionEnvelope,
} from '../../agent-runtime/index.js';
import type {
  FeishuBot,
  FeishuCreateGroupInput,
  FeishuCreateGroupResult,
} from '../../channel/feishu/bot.js';
import {
  FeishuChannelSession,
  type FeishuInboundEnvelope,
  handleFeishuListChatBots,
  type FeishuMcpListChatBotsResult,
} from '../../channel/feishu/feishu-channel.js';
import type { FeishuMcpToolName } from '../../channel/feishu/feishu-mcp-surface.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  type DreamuxConfig,
} from '../../config/config.js';
import {
  DispatcherStore,
  type DispatcherRow,
  type DispatcherStatus,
} from '../../state/dispatcher-store.js';
import {
  adminSocketPath as defaultAdminSocketPath,
  defaultDispatcherCwd,
} from '../../platform/paths.js';
import {
  loggerToLevelFn,
  type DreamuxLogger,
} from '../../platform/logger.js';
import { teammateMcpServerDescriptor } from '../teammate/mcp-config.js';
import { teamMcpServerDescriptor } from '../team/mcp-config.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';

export interface DispatcherAgentServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  adminSocketPath?: string;
  botFactory?: (row: DispatcherRow, secret: string) => FeishuBot;
  skipBotSecret?: boolean;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
  routeChannelInput?: (
    dispatcherId: string,
    input: import('../../agent-runtime/turn.js').InboundTurnInput,
    envelope: FeishuInboundEnvelope,
    hooks?: import('../../agent-runtime/turn.js').InboundDeliveryHooks,
  ) => Promise<import('../../agent-runtime/types.js').AgentRuntimeTurnResult>;
}

export interface DispatcherAgentSlot {
  row: DispatcherRow;
  runtime: AgentRuntime;
  channel: FeishuChannelSession;
  log: DreamuxLogger;
}

export interface DispatcherSummary {
  dispatcher_id: string;
  bot_app_id: string;
  status: DispatcherStatus;
  thread_id: string | null;
  enabled: boolean;
}

export interface FeishuChannelToolCall {
  dispatcherId: string;
  toolName: FeishuMcpToolName;
  arguments: unknown;
}

const COMPLETION_DELIVERY_CACHE_LIMIT = 512;

/**
 * Owns live dispatcher agents and their built-in Feishu channel sessions.
 *
 * Server bootstraps this service and admin/MCP layers route into it; the service
 * owns runtime creation, channel connection lifecycle, restart-notice delivery,
 * and per-dispatcher channel MCP dispatch.
 */
export class DispatcherAgentService {
  private readonly slots = new Map<string, DispatcherAgentSlot>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly inFlightCompletionDeliveries = new Map<string, Promise<void>>();
  private readonly deliveredCompletionIds = new Set<string>();
  private readonly deliveredCompletionOrder: string[] = [];
  private restartIntent: RestartIntentConsumer | null = null;

  constructor(private readonly opts: DispatcherAgentServiceOptions) {}

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.restartIntent = consumer;
  }

  async startDispatcher(id: string): Promise<void> {
    if (this.slots.has(id)) return;
    const inflight = this.starting.get(id);
    if (inflight !== undefined) return inflight;

    const promise = this.doStartDispatcher(id).finally(() => {
      this.starting.delete(id);
    });
    this.starting.set(id, promise);
    return promise;
  }

  async stopDispatcher(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    try {
      await slot.channel.close();
    } catch (err) {
      slot.log.error({ dispatcher_id: id, err: errInfo(err) }, 'error closing bot');
    }
    try {
      await slot.runtime.stop();
    } catch (err) {
      slot.log.error(
        { dispatcher_id: id, err: errInfo(err) },
        'error stopping dispatcher',
      );
    }
    this.slots.delete(id);
  }

  getRuntime(id: string): AgentRuntime | null {
    return this.slots.get(id)?.runtime ?? null;
  }

  /**
   * Seam ③ of the reverse-delivery path (issue #147): deliver a teammate
   * completion into the live dispatcher runtime, waking it for a fresh turn. The
   * retry policy lives here — `completionInput` mints a unique sourceId per call,
   * so re-delivering on a `failed` result (definitely not submitted) is safe.
   *
   * Never throws into the teammate settle path: an absent slot/runtime,
   * a runtime without completion delivery, an `unsupported` result (runtime
   * stopped), a thrown call, or exhausted retries all log and return.
   */
  async deliverCompletion(
    dispatcherId: string,
    completion: CompletionEnvelope,
  ): Promise<void> {
    const completionKey = completionDeliveryKey(dispatcherId, completion.id);
    if (this.deliveredCompletionIds.has(completionKey)) return;
    const inFlight = this.inFlightCompletionDeliveries.get(completionKey);
    if (inFlight !== undefined) return inFlight;

    const delivery = this.doDeliverCompletion(dispatcherId, completion, completionKey);
    this.inFlightCompletionDeliveries.set(completionKey, delivery);
    try {
      await delivery;
    } finally {
      this.inFlightCompletionDeliveries.delete(completionKey);
    }
  }

  private async doDeliverCompletion(
    dispatcherId: string,
    completion: CompletionEnvelope,
    completionKey: string,
  ): Promise<void> {
    const slot = this.slots.get(dispatcherId);
    if (slot === undefined) {
      this.opts.log.warn(
        { dispatcher_id: dispatcherId, source: completion.source },
        'dropping teammate completion: dispatcher not running',
      );
      return;
    }
    const deliver = slot.runtime.completionInput;
    if (deliver === undefined) {
      slot.log.warn(
        { dispatcher_id: dispatcherId, source: completion.source },
        'dropping teammate completion: runtime has no completion delivery',
      );
      return;
    }
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let outcome;
      try {
        outcome = await deliver.call(slot.runtime, completion);
      } catch (err) {
        slot.log.warn(
          { dispatcher_id: dispatcherId, source: completion.source, err: errInfo(err) },
          'teammate completion delivery threw',
        );
        return;
      }
      if (outcome.status === 'accepted') {
        this.rememberDeliveredCompletion(completionKey);
        return;
      }
      if (outcome.status === 'unsupported') {
        slot.log.warn(
          { dispatcher_id: dispatcherId, source: completion.source, reason: outcome.reason },
          'dropping teammate completion: runtime delivery unsupported',
        );
        return;
      }
      slot.log.warn(
        {
          dispatcher_id: dispatcherId,
          source: completion.source,
          attempt,
          max_attempts: maxAttempts,
          err: errInfo(outcome.error),
        },
        'teammate completion delivery failed',
      );
    }
    slot.log.warn(
      { dispatcher_id: dispatcherId, source: completion.source, max_attempts: maxAttempts },
      'teammate completion delivery exhausted retries; dropping',
    );
  }

  summarize(): DispatcherSummary[] {
    return this.opts.dispatchers.list().map((row) => {
      const runtime = this.slots.get(row.dispatcher_id)?.runtime;
      return {
        dispatcher_id: row.dispatcher_id,
        bot_app_id: row.bot_app_id,
        status: runtime?.getStatus() ?? row.status,
        thread_id: runtime?.getThreadId() ?? row.thread_id,
        enabled: row.enabled === 1,
      };
    });
  }

  async callFeishuMcpTool(
    input: FeishuChannelToolCall,
  ): Promise<Record<string, unknown> | FeishuMcpListChatBotsResult> {
    if (input.toolName === 'list_chat_bots') {
      return handleFeishuListChatBots(input.dispatcherId, input.arguments);
    }
    const slot = this.mustRunningSlot(input.dispatcherId);
    return slot.channel.handleMcpTool(input.toolName, input.arguments);
  }

  feishuMessageBelongsToChat(
    dispatcherId: string,
    messageId: string,
    chatId: string,
  ): boolean {
    const slot = this.slots.get(dispatcherId);
    return slot?.channel.messageBelongsToChat(messageId, chatId) ?? false;
  }

  async createFeishuGroup(
    input: FeishuCreateGroupInput & { dispatcherId: string },
  ): Promise<FeishuCreateGroupResult> {
    const slot = this.mustRunningSlot(input.dispatcherId);
    const created = await slot.channel.bot.createGroup({
      name: input.name,
      userOpenIds: input.userOpenIds,
    });
    return created;
  }

  async shutdown(): Promise<void> {
    for (const id of Array.from(this.slots.keys())) {
      await this.stopDispatcher(id);
    }
  }

  private async doStartDispatcher(id: string): Promise<void> {
    const row = this.opts.dispatchers.get(id);
    if (row === null) throw new Error(`no dispatcher '${id}'`);
    if (this.slots.has(id)) return;

    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === id,
    );
    const channelRef =
      dispatcherConfig?.channels[0]?.provider ?? BUILTIN_FEISHU_PROVIDER_REF;
    if (channelRef !== BUILTIN_FEISHU_PROVIDER_REF) {
      throw new Error(
        `dispatcher '${id}' channel ${JSON.stringify(channelRef)} is not wired; only ${BUILTIN_FEISHU_PROVIDER_REF} is built in this phase`,
      );
    }

    const runtimeProvider = this.opts.agentRuntimeProviders.resolve(
      dispatcherConfig?.runtime.provider ?? BUILTIN_CODEX_PROVIDER_REF,
    );
    const cwd = dispatcherConfig?.cwd ?? defaultDispatcherCwd(id);
    const channelLog = this.opts.channelLoggerFactory(id);
    const channel = new FeishuChannelSession({
      dispatcherId: id,
      row,
      config: this.opts.config,
      adminSocketPath: this.opts.adminSocketPath ?? defaultAdminSocketPath(),
      log: channelLog,
      ...(this.opts.botFactory !== undefined
        ? { botFactory: this.opts.botFactory }
        : {}),
      ...(this.opts.skipBotSecret !== undefined
        ? { skipBotSecret: this.opts.skipBotSecret }
        : {}),
    });
    // The dispatcher prompt is runtime-injected via the runtime's systemPrompt
    // capability. 'replace' runtimes (codex) consume the full prompt as their
    // base instructions; 'append' runtimes (claude-code) receive a focused
    // dispatcher-role delta layered on top of their own system prompt.
    const systemPromptContent =
      runtimeProvider.getCapabilities().systemPrompt.mode === 'replace'
        ? DREAMUX_DISPATCHER_BASE_INSTRUCTIONS
        : DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS;
    const runtime = runtimeProvider.createRuntime({
      row,
      dispatchers: this.opts.dispatchers,
      dispatcher: dispatcherConfig ?? null,
      cwd,
      systemPromptContent,
      mcpServers: this.dreamuxMcpServerDescriptors(channel, id),
      log: loggerToLevelFn(channelLog),
    });

    try {
      await runtime.start();
      await channel.start({
        submitTurn: (turn, envelope, hooks) =>
          this.opts.routeChannelInput?.(id, turn, envelope, hooks) ??
          runtime.channelInput(turn, hooks),
      });
    } catch (err) {
      try {
        await channel.close();
      } catch {
        /* best effort */
      }
      try {
        await runtime.stop();
      } catch {
        /* best effort */
      }
      throw err;
    }

    this.slots.set(id, {
      row,
      runtime,
      channel,
      log: channelLog,
    });
    this.opts.log.info(
      {
        dispatcher_id: id,
        bot_app_id: row.bot_app_id,
        cwd,
      },
      'dispatcher ready',
    );
    await this.injectRestartNoticeIfNeeded(id, runtime, channelLog);
  }

  private dreamuxMcpServerDescriptors(
    channel: FeishuChannelSession,
    dispatcherId: string,
  ): AgentRuntimeMcpServer[] {
    const context = {
      dispatcherId,
      adminSocketPath: this.opts.adminSocketPath ?? defaultAdminSocketPath(),
    };
    return [
      ...channel.mcpServerDescriptors(),
      teamMcpServerDescriptor(context),
      teammateMcpServerDescriptor({
        ...context,
        callerKind: 'dispatcher',
      }),
    ];
  }

  private async injectRestartNoticeIfNeeded(
    dispatcherId: string,
    runtime: AgentRuntime,
    log: DreamuxLogger,
  ): Promise<void> {
    if (!runtime.wasThreadResumed()) return;
    const notice = this.restartIntent?.claim(dispatcherId, Date.now()) ?? null;
    if (notice === null) return;
    try {
      const result = await runtime.systemInput({
        kind: 'system',
        text: notice,
        reason: 'restart-notice',
      });
      if (result.status === 'failed') {
        log.warn(
          { dispatcher_id: dispatcherId, err: errInfo(result.error) },
          'restart notice injection failed',
        );
      }
    } catch (err) {
      log.warn(
        { dispatcher_id: dispatcherId, err: errInfo(err) },
        'restart notice injection errored',
      );
    }
  }

  private mustRunningSlot(id: string): DispatcherAgentSlot {
    const slot = this.slots.get(id);
    if (slot === undefined) {
      throw new Error(`dispatcher '${id}' is not running`);
    }
    return slot;
  }

  private rememberDeliveredCompletion(key: string): void {
    if (this.deliveredCompletionIds.has(key)) return;
    this.deliveredCompletionIds.add(key);
    this.deliveredCompletionOrder.push(key);
    while (this.deliveredCompletionOrder.length > COMPLETION_DELIVERY_CACHE_LIMIT) {
      const evicted = this.deliveredCompletionOrder.shift();
      if (evicted !== undefined) this.deliveredCompletionIds.delete(evicted);
    }
  }
}

function completionDeliveryKey(dispatcherId: string, completionId: string): string {
  return JSON.stringify([dispatcherId, completionId]);
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
