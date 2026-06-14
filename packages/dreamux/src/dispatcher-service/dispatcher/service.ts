import type { ChannelTarget } from '@excitedjs/dreamux-types';

import {
  bundledSkillSourcesForRole,
  type AgentRuntime,
  type AgentRuntimeMcpServer,
  type AgentRuntimeProviderCatalog,
  type CompletionEnvelope,
} from '../../agent-runtime/index.js';
import type { FeishuBot } from '../../channel/feishu/bot.js';
import {
  FeishuChannelSession,
  createFeishuChannelSession,
  type FeishuInboundEnvelope,
  handleFeishuListChatBots,
  type FeishuMcpListChatBotsResult,
} from '../../channel/feishu/feishu-channel.js';
import {
  feishuMcpServerDescriptor,
  type FeishuMcpToolName,
} from '../../channel/feishu/feishu-mcp-surface.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  dispatcherFeishuChannels,
  type DreamuxConfig,
} from '../../config/config.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import {
  DispatcherStore,
  type DispatcherRow,
  type DispatcherStatus,
} from '../../state/dispatcher-store.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
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
    channelId: string,
    input: import('../../agent-runtime/turn.js').InboundTurnInput,
    envelope: FeishuInboundEnvelope,
    hooks?: import('../../agent-runtime/turn.js').InboundDeliveryHooks,
  ) => Promise<import('../../agent-runtime/types.js').AgentRuntimeTurnResult>;
}

export interface DispatcherAgentSlot {
  row: DispatcherRow;
  runtime: AgentRuntime;
  /**
   * Live channel sessions keyed by dispatcher-local `channel_id` (issue #209
   * live multi-channel routing). A single-channel dispatcher holds one entry;
   * iteration order follows channel declaration order, so the first is the
   * primary (default egress) channel.
   */
  channels: Map<string, FeishuChannelSession>;
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
  /**
   * Which channel's bot the egress (reply/react) leaves through (issue #209 live
   * multi-channel routing). Omitted → the dispatcher's primary (first) channel,
   * so a single-channel dispatcher is unchanged. A TeamLeader's reply carries the
   * channel resolved from its active binding so it always egresses the bound bot.
   */
  channelId?: string;
}

const COMPLETION_DELIVERY_CACHE_LIMIT = 512;

/**
 * Owns live dispatcher agents and their built-in Feishu channel sessions.
 *
 * Server bootstraps this service and admin/MCP layers route into it; the service
 * owns runtime creation, channel connection lifecycle, restart-notice delivery,
 * and per-dispatcher channel tool dispatch.
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
    for (const [channelId, session] of slot.channels) {
      try {
        await session.close();
      } catch (err) {
        slot.log.error(
          { dispatcher_id: id, channel_id: channelId, err: errInfo(err) },
          'error closing bot',
        );
      }
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
    return this.sessionFor(slot, input.channelId).handleMcpTool(
      input.toolName,
      input.arguments,
    );
  }

  feishuMessageBelongsToChat(
    dispatcherId: string,
    messageId: string,
    chatId: string,
  ): boolean {
    const slot = this.slots.get(dispatcherId);
    if (slot === undefined) return false;
    // A message belongs to the chat if ANY live channel session observed it; a
    // dispatcher's bots see disjoint chats, so this stays unambiguous.
    for (const session of slot.channels.values()) {
      if (session.messageBelongsToChat(messageId, chatId)) return true;
    }
    return false;
  }

  /**
   * Pick the channel session egress/target resolution runs through. A known
   * `channelId` selects that channel's bot; otherwise the primary (first) channel
   * — so single-channel dispatchers are unchanged. Fails loud if a requested
   * channel is not live.
   */
  private sessionFor(
    slot: DispatcherAgentSlot,
    channelId?: string,
  ): FeishuChannelSession {
    if (channelId !== undefined) {
      const session = slot.channels.get(channelId);
      if (session === undefined) {
        throw new Error(
          `dispatcher '${slot.row.dispatcher_id}' has no live channel '${channelId}'`,
        );
      }
      return session;
    }
    const first = slot.channels.values().next().value;
    if (first === undefined) {
      throw new Error(
        `dispatcher '${slot.row.dispatcher_id}' has no live channel session`,
      );
    }
    return first;
  }

  /**
   * Resolve a provider selector to a neutral `ChannelTarget` via the live channel
   * session (issue #209 binding store v2). Target resolution is provider-owned;
   * core calls it here for both binding and inbound routing so `target_key` stays
   * opaque to core. The originating/selected `channelId` picks the session (live
   * multi-channel); omitted resolves through the primary channel. Requires a
   * running dispatcher — both call paths (the bind tool, the inbound router) run
   * only while a channel session is live.
   */
  resolveChannelTarget(
    dispatcherId: string,
    meta: unknown,
    channelId?: string,
  ): ChannelTarget {
    return this.sessionFor(
      this.mustRunningSlot(dispatcherId),
      channelId,
    ).resolveTarget(meta);
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
    // Config accepts the general multi-channel shape (issue #209). Live routing
    // now runs one Feishu session per channel; this guard stays the single
    // runtime boundary that fails loud on a not-yet-runnable shape (a channel
    // naming an unwired provider). State seeding stays fail-soft so this is the
    // only place that rejects it.
    if (dispatcherConfig !== undefined) {
      assertRunnableChannelShape(dispatcherConfig);
    }

    const runtimeProvider = this.opts.agentRuntimeProviders.resolve(
      dispatcherConfig?.runtime.provider ?? BUILTIN_CODEX_PROVIDER_REF,
    );
    // The dispatcher agent runs in its validated workspace (issue #182 PR-4):
    // no fallback to a Dreamux state dir. Server startup pre-flights this, so a
    // misconfigured dispatcher never reaches launch; the call here is idempotent
    // and keeps the launch path self-validating.
    const cwd = await ensureDispatcherWorkspace(this.opts.config, id);
    const channelLog = this.opts.channelLoggerFactory(id);
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
      role: 'dispatcher',
      skillSources: bundledSkillSourcesForRole('dispatcher'),
      cwd,
      systemPromptContent,
      mcpServers: this.dreamuxMcpServerDescriptors(id),
      log: loggerToLevelFn(channelLog),
    });

    // One live session per configured Feishu channel, each connecting as its own
    // bot (issue #209 live multi-channel routing). A single-channel dispatcher
    // gets one session, identical to before. The defensive no-config path keeps
    // the legacy single row-bot session under the conventional 'primary' id.
    const channelSpecs =
      dispatcherConfig !== undefined
        ? dispatcherFeishuChannels(dispatcherConfig)
        : [];
    const specs =
      channelSpecs.length > 0
        ? channelSpecs
        : [{ channelId: 'primary', config: undefined }];
    const channels = new Map<string, FeishuChannelSession>();

    try {
      await runtime.start();
      for (const spec of specs) {
        const session = createFeishuChannelSession({
          dispatcherId: id,
          row,
          config: this.opts.config,
          log: channelLog,
          ...(spec.config !== undefined
            ? {
                channel: {
                  appId: spec.config.app_id,
                  appSecret: spec.config.app_secret,
                },
              }
            : {}),
          ...(this.opts.botFactory !== undefined
            ? { botFactory: this.opts.botFactory }
            : {}),
          ...(this.opts.skipBotSecret !== undefined
            ? { skipBotSecret: this.opts.skipBotSecret }
            : {}),
        });
        const channelId = spec.channelId;
        // Register before start so a session whose start() throws is still
        // closed by the catch below (it would otherwise leak — not yet mapped).
        channels.set(channelId, session);
        // Each session tags its own channel_id onto every inbound turn it
        // delivers, so the router keys on the channel the message actually
        // arrived through rather than re-deriving a single channel from config.
        await session.start({
          submitTurn: (turn, envelope, hooks) =>
            this.opts.routeChannelInput?.(id, channelId, turn, envelope, hooks) ??
            runtime.channelInput(turn, hooks),
        });
      }
    } catch (err) {
      for (const session of channels.values()) {
        try {
          await session.close();
        } catch {
          /* best effort */
        }
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
      channels,
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
    dispatcherId: string,
  ): AgentRuntimeMcpServer[] {
    const context = {
      dispatcherId,
      adminSocketPath: this.opts.adminSocketPath ?? defaultAdminSocketPath(),
    };
    return [
      feishuMcpServerDescriptor(context),
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
