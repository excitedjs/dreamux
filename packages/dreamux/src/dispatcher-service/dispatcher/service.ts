import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { FeishuBot } from '../../feishu/bot.js';
import {
  FeishuChannelSession,
  handleFeishuListChatBots,
  type FeishuMcpListChatBotsResult,
} from '../../channel/feishu-channel.js';
import type { FeishuMcpToolName } from '../../channel/feishu-mcp-surface.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  type DreamuxConfig,
} from '../../runtime/config.js';
import {
  DispatcherStore,
  type DispatcherRow,
  type DispatcherStatus,
} from '../../runtime/dispatcher-store.js';
import {
  adminSocketPath as defaultAdminSocketPath,
  dispatcherCodexCwd,
} from '../../runtime/paths.js';
import {
  loggerToLevelFn,
  type DreamuxLogger,
} from '../../runtime/logger.js';
import { teammateMcpServerDescriptor } from '../../teammate/mcp-config.js';
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
    const runtime = runtimeProvider.createRuntime({
      row,
      dispatchers: this.opts.dispatchers,
      dispatcher: dispatcherConfig ?? null,
      mcpServers: this.dreamuxMcpServerDescriptors(channel, id),
      log: loggerToLevelFn(channelLog),
    });

    try {
      await runtime.start();
      await channel.start({
        submitTurn: (turn, hooks) => runtime.submitTurn(turn, hooks),
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
        cwd: row.codex_cwd ?? dispatcherCodexCwd(id),
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
      const result = await runtime.submitTurn({
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
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
