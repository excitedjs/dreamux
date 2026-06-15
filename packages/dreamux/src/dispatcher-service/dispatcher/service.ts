import type {
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelMcpDescriptorContext,
  ChannelProvider,
  ChannelSession,
  ChannelTarget,
  ChannelToolDescriptor,
  InboundDeliveryResult,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import {
  bundledSkillSourcesForRole,
  dispatcherHostPaths,
  hostStateCallbacks,
  neutralLoggerFromHostLogger,
  HOST_INJECT_ENV,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  CompletionEnvelope,
} from '@excitedjs/dreamux-types';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import { dreamuxBinPath } from '../../platform/package-bin.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  type DispatcherChannelConfig,
  type DreamuxConfig,
} from '../../config/config.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import {
  DispatcherStore,
  type DispatcherRow,
  type DispatcherStatus,
} from '../../state/dispatcher-store.js';
import {
  adminSocketPath as defaultAdminSocketPath,
  dispatcherCacheDir,
  dispatcherDir,
} from '../../platform/paths.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import type { DreamuxLogger } from '../../platform/logger.js';
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
  /** Channel-provider catalog: core resolves each channel's neutral provider. */
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
  routeChannelInput?: (
    dispatcherId: string,
    channelId: string,
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
    hooks?: InboundDeliveryHooks,
  ) => Promise<AgentRuntimeTurnResult>;
}

export interface DispatcherAgentSlot {
  row: DispatcherRow;
  runtime: AgentRuntime;
  /**
   * Live channel sessions keyed by dispatcher-local `channel_id`. Decision #4
   * (issue #209) caps a dispatcher at one channel per provider ref, so a
   * single-channel dispatcher holds a single session; iteration order
   * follows channel declaration order, the first being the primary (default
   * egress) channel.
   */
  channels: Map<string, ChannelSession>;
  log: DreamuxLogger;
}

export interface DispatcherSummary {
  dispatcher_id: string;
  channel_identity: string;
  status: DispatcherStatus;
  thread_id: string | null;
  enabled: boolean;
}

export interface ChannelToolInvocation {
  dispatcherId: string;
  /** Provider-owned tool name, forwarded opaquely (core never enumerates it). */
  name: string;
  /** Raw provider-owned tool arguments, forwarded opaquely to the session. */
  arguments: unknown;
  /**
   * Which channel's bot the egress leaves through (issue #209 live multi-channel
   * routing). Omitted → the dispatcher's primary (first) channel, so a
   * single-channel dispatcher is unchanged. A TeamLeader's tool call carries the
   * channel resolved from its active binding so it always egresses the bound bot.
   */
  channelId?: string;
}

const COMPLETION_DELIVERY_CACHE_LIMIT = 512;

/**
 * Owns live dispatcher agents and their built-in channel sessions.
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
        channel_identity: row.channel_identity,
        status: runtime?.getStatus() ?? row.status,
        thread_id: runtime?.getThreadId() ?? row.thread_id,
        enabled: row.enabled === 1,
      };
    });
  }

  /**
   * Invoke a provider-owned channel tool, forwarding the raw `{name, arguments}`
   * to the neutral channel seam (core is a blind MCP conduit — it never names a
   * tool). A live channel session handles it via `session.handleTool`; with no
   * live session the configured provider's `handleSessionlessTool` is tried
   * instead (the provider feature-detects and throws for an unknown sessionless
   * tool). `channelId` selects which live session egresses (the caller resolves
   * the bound channel for a TeamLeader); omitted → the primary channel.
   */
  async invokeChannelTool(input: ChannelToolInvocation): Promise<unknown> {
    const slot = this.slots.get(input.dispatcherId);
    if (slot === undefined || slot.channels.size === 0) {
      return this.invokeSessionlessChannelTool(
        input.dispatcherId,
        input.name,
        input.arguments,
      );
    }
    const session = this.sessionFor(slot, input.channelId);
    if (session.handleTool === undefined) {
      throw new Error(
        `channel '${session.channel_id}' exposes no provider tool surface`,
      );
    }
    return session.handleTool(
      {
        name: input.name,
        arguments: (input.arguments ?? {}) as Record<string, unknown>,
      },
      { dispatcher_id: input.dispatcherId, channel_id: session.channel_id },
    );
  }

  /**
   * Service a channel tool that has no live session (e.g. `list_chat_bots`
   * before a dispatcher's sessions connect) through the configured provider's
   * `handleSessionlessTool`. Core resolves the provider from the dispatcher's
   * first configured channel and hands it neutral host locators (state root +
   * logger); the provider owns tool-name feature detection and throws for an
   * unknown sessionless tool.
   */
  private async invokeSessionlessChannelTool(
    dispatcherId: string,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    const provider = this.sessionlessChannelProvider(dispatcherId);
    if (provider.handleSessionlessTool === undefined) {
      throw new Error(
        `channel provider '${provider.ref}' exposes no sessionless tool surface`,
      );
    }
    return provider.handleSessionlessTool(
      name,
      (args ?? {}) as Record<string, unknown>,
      {
        dispatcher_id: dispatcherId,
        state_root: dispatcherDir(dispatcherId),
        logger: neutralLoggerFromHostLogger(
          this.opts.channelLoggerFactory(dispatcherId),
        ),
      },
    );
  }

  /**
   * Resolve the channel provider that backs a dispatcher's sessionless tool
   * calls. Uses the dispatcher's first configured channel (the primary), so a
   * single-channel dispatcher resolves unambiguously; fails loud when the
   * dispatcher declares no channel.
   */
  private sessionlessChannelProvider(dispatcherId: string): ChannelProvider {
    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === dispatcherId,
    );
    const channelConfig = dispatcherConfig?.channels[0];
    if (channelConfig === undefined) {
      throw new Error(
        `dispatcher '${dispatcherId}' has no configured channel`,
      );
    }
    return this.opts.channelProviders.resolve(channelConfig.provider);
  }

  /**
   * The neutral channel tool list for a dispatcher (the blind MCP conduit's
   * `tools/list`). Prefers the live sessions' own `tools()`; before they connect
   * (the dispatcher's own MCP shim lists tools during runtime start) it builds
   * un-started sessions from config to enumerate them, then closes them. Tools
   * are deduped by name across channels.
   */
  async listChannelTools(dispatcherId: string): Promise<ChannelToolDescriptor[]> {
    const slot = this.slots.get(dispatcherId);
    const created = slot === undefined || slot.channels.size === 0;
    const channels = created
      ? await this.buildChannelSessions(
          dispatcherId,
          neutralLoggerFromHostLogger(this.opts.channelLoggerFactory(dispatcherId)),
        )
      : slot.channels;
    try {
      const out: ChannelToolDescriptor[] = [];
      const seen = new Set<string>();
      for (const session of channels.values()) {
        if (session.tools === undefined) continue;
        for (const tool of session.tools({
          dispatcher_id: dispatcherId,
          channel_id: session.channel_id,
        })) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          out.push(tool);
        }
      }
      return out;
    } finally {
      if (created) {
        for (const session of channels.values()) {
          try {
            await session.close();
          } catch {
            /* best effort: these sessions were never started */
          }
        }
      }
    }
  }

  /**
   * Whether a live channel session observed a message for a target — the routing
   * ownership fact the TeamLeader egress gate keys off. A message belongs to the
   * target if ANY live channel session observed it (a dispatcher's bots see
   * disjoint targets, so this stays unambiguous); a session that cannot decide is
   * skipped. The target is provider-resolved; core never names a channel field.
   */
  async messageBelongsToTarget(
    dispatcherId: string,
    target: ChannelTarget,
    messageId: string,
  ): Promise<boolean> {
    const slot = this.slots.get(dispatcherId);
    if (slot === undefined) return false;
    for (const session of slot.channels.values()) {
      const decide = session.messageBelongsToTarget;
      if (decide === undefined) continue;
      if (await decide.call(session, { target, message_id: messageId })) {
        return true;
      }
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
  ): ChannelSession {
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
  async resolveChannelTarget(
    dispatcherId: string,
    meta: unknown,
    channelId?: string,
  ): Promise<ChannelTarget> {
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
    // Config accepts the general multi-channel shape (issue #209). This guard is
    // the single runtime boundary that fails loud on a not-yet-runnable shape (a
    // channel whose provider has no loaded implementation in the channel
    // catalog). State seeding stays fail-soft so this is the only place that
    // rejects it; core names no concrete provider here.
    if (dispatcherConfig !== undefined) {
      assertRunnableChannelShape(dispatcherConfig, this.opts.channelProviders);
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
    // The neutral, message-first logger handed to providers (runtime + channel),
    // bridging core's fields-first pino logger to the dreamux-types contract so a
    // provider's structured fields survive onto the host log line.
    const neutralLog = neutralLoggerFromHostLogger(channelLog);
    // The dispatcher prompt is runtime-injected via the runtime's systemPrompt
    // capability. 'replace' runtimes (codex) consume the full prompt as their
    // base instructions; 'append' runtimes (claude-code) receive a focused
    // dispatcher-role delta layered on top of their own system prompt.
    const systemPromptContent =
      runtimeProvider.getCapabilities().systemPrompt.mode === 'replace'
        ? DREAMUX_DISPATCHER_BASE_INSTRUCTIONS
        : DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS;
    // The dispatcher's resolved runtime config comes straight from its config
    // entry; the defensive no-config path (a state row with no live config
    // entry) derives the provider's OWN defaults by parsing an empty raw block,
    // so core never names a builtin's default-config function.
    const runtimeConfig =
      dispatcherConfig !== undefined
        ? dispatcherConfig.runtime.config
        : ((await runtimeProvider.readConfig?.(
            {},
            {
              providerRef: runtimeProvider.ref,
              agentId: id,
              file: '<defaults>',
              prefix: '',
            },
          )) ?? {});
    // Build the (un-started) neutral channel sessions BEFORE the runtime so the
    // runtime's MCP descriptors are derived from each session's own
    // `mcpServerDescriptor` (a pure call) — core never names the channel's MCP
    // shape. Each session is created through its own `ChannelProvider`: core
    // resolves the provider from the catalog, hands it the provider-validated
    // config plus host state/cache dirs, and drives the returned neutral
    // `ChannelSession`. Decision #4 (issue #209) caps a dispatcher at one channel
    // per provider ref, so a single-channel dispatcher resolves to a
    // single session. The defensive no-config path (a state row with no live
    // config entry) yields no channel session — a dispatcher with no configured
    // channel has no bot identity to connect as. Sessions connect only in the
    // start loop below.
    const channels = await this.buildChannelSessions(id, neutralLog);

    const runtime = runtimeProvider.createRuntime({
      identity: { runtime_id: id, checkpoint_id: row.thread_id },
      role: 'dispatcher',
      config: runtimeConfig,
      cwd,
      systemPromptContent,
      mcpServers: this.dreamuxMcpServerDescriptors(id, channels),
      skillSources: bundledSkillSourcesForRole('dispatcher'),
      state: hostStateCallbacks(this.opts.dispatchers),
      paths: dispatcherHostPaths,
      logger: neutralLog,
      injectEnv: HOST_INJECT_ENV,
    });

    try {
      await runtime.start();
      // Register the slot before starting any channel session so an inbound
      // arriving during session.start() resolves a running slot instead of
      // throwing 'not running' (issue #209 fix #7). The slot holds the same
      // `channels` map built above, so each session is observable as it starts.
      this.slots.set(id, {
        row,
        runtime,
        channels,
        log: channelLog,
      });
      for (const [channelId, session] of channels) {
        // Each session tags its own channel_id onto every inbound turn it
        // delivers, so the router keys on the channel the message actually
        // arrived through rather than re-deriving a single channel from config.
        await session.start({
          deliver: async (turn, envelope, hooks) =>
            asInboundDeliveryResult(
              (await this.opts.routeChannelInput?.(
                id,
                channelId,
                turn,
                envelope,
                hooks,
              )) ?? (await runtime.channelInput(turn, hooks)),
            ),
        });
      }
    } catch (err) {
      // Undo the pre-registration from inside the try above so a failed start
      // never leaves a half-built slot resolvable (issue #209 fix #7). Iterate
      // the local `channels` variable, not a slot lookup, so a session created
      // before the failure is still closed.
      this.slots.delete(id);
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

    this.opts.log.info(
      {
        dispatcher_id: id,
        channel_identity: row.channel_identity,
        cwd,
      },
      'dispatcher ready',
    );
    await this.injectRestartNoticeIfNeeded(id, runtime, channelLog);
  }

  private dreamuxMcpServerDescriptors(
    dispatcherId: string,
    channels: Map<string, ChannelSession>,
  ): AgentRuntimeMcpServer[] {
    const context = {
      dispatcherId,
      adminSocketPath: this.opts.adminSocketPath ?? defaultAdminSocketPath(),
    };
    return [
      ...this.channelMcpServerDescriptors(channels, {
        dispatcher_id: dispatcherId,
        callerKind: 'dispatcher',
      }),
      teamMcpServerDescriptor(context),
      teammateMcpServerDescriptor({
        ...context,
        callerKind: 'dispatcher',
      }),
    ];
  }

  /**
   * Build the channel MCP server descriptors for a caller, derived from each
   * live channel session's own neutral `mcpServerDescriptor` (a pure call). Core
   * supplies only the neutral pieces (host bin command + admin socket + caller
   * scope); the provider shapes its own stdio descriptor. Used for a TeamLeader,
   * whose dispatcher is already running.
   */
  channelMcpServerDescriptorsForCaller(
    dispatcherId: string,
    scope: { callerKind?: 'dispatcher' | 'team_leader'; team_id?: string; leader_name?: string },
  ): AgentRuntimeMcpServer[] {
    const slot = this.slots.get(dispatcherId);
    if (slot === undefined) return [];
    return this.channelMcpServerDescriptors(slot.channels, {
      dispatcher_id: dispatcherId,
      ...scope,
    });
  }

  private channelMcpServerDescriptors(
    channels: Map<string, ChannelSession>,
    scope: {
      dispatcher_id: string;
      callerKind?: 'dispatcher' | 'team_leader';
      team_id?: string;
      leader_name?: string;
    },
  ): AgentRuntimeMcpServer[] {
    const context: ChannelMcpDescriptorContext = {
      command: dreamuxBinPath(),
      adminSocketPath: this.opts.adminSocketPath ?? defaultAdminSocketPath(),
      dispatcher_id: scope.dispatcher_id,
      ...(scope.callerKind !== undefined ? { callerKind: scope.callerKind } : {}),
      ...(scope.team_id !== undefined ? { team_id: scope.team_id } : {}),
      ...(scope.leader_name !== undefined ? { leader_name: scope.leader_name } : {}),
    };
    const out: AgentRuntimeMcpServer[] = [];
    for (const session of channels.values()) {
      const descriptor = session.mcpServerDescriptor?.(context);
      if (descriptor != null) out.push(descriptor);
    }
    return out;
  }

  /**
   * Build the (un-started) neutral channel sessions for a dispatcher from its
   * configured channels. Each provider's `readConfig` (already validated at
   * config-load) yields the neutral config view, then `createSession` builds the
   * session through the neutral create context (host state/cache roots + logger).
   * Sessions are NOT connected here — the caller starts them. On partial failure
   * the already-built sessions are closed.
   */
  private async buildChannelSessions(
    dispatcherId: string,
    neutralLog: ReturnType<typeof neutralLoggerFromHostLogger>,
  ): Promise<Map<string, ChannelSession>> {
    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === dispatcherId,
    );
    const channelConfigs: DispatcherChannelConfig[] = dispatcherConfig?.channels ?? [];
    const channels = new Map<string, ChannelSession>();
    try {
      for (const channelConfig of channelConfigs) {
        const provider = this.opts.channelProviders.resolve(channelConfig.provider);
        const channelProviderConfig = provider.readConfig
          ? await provider.readConfig(channelConfig.config, {
              dispatcher_id: dispatcherId,
              channel_id: channelConfig.id,
              provider: channelConfig.provider,
            })
          : channelConfig.config;
        channels.set(
          channelConfig.id,
          provider.createSession({
            dispatcher_id: dispatcherId,
            channel_id: channelConfig.id,
            provider: channelConfig.provider,
            config: channelProviderConfig,
            logger: neutralLog,
            state_root: dispatcherDir(dispatcherId),
            cache_root: dispatcherCacheDir(dispatcherId),
          }),
        );
      }
    } catch (err) {
      for (const session of channels.values()) {
        try {
          await session.close();
        } catch {
          /* best effort: these sessions were never started */
        }
      }
      throw err;
    }
    return channels;
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

/**
 * Narrow the wider {@link AgentRuntimeTurnResult} union to the
 * {@link InboundDeliveryResult} the neutral `ChannelRoutes.deliver` contract
 * requires. `channelInput` / `deliverToLeader` never yield the notice-only
 * `'skipped'` state (that is a restart-notice signal, not an inbound result), so
 * the conversion only ever passes the inbound variants through; the unreachable
 * `'skipped'` case maps to `'stopped'` defensively.
 */
function asInboundDeliveryResult(
  result: AgentRuntimeTurnResult,
): InboundDeliveryResult {
  return result.status === 'skipped' ? { status: 'stopped' } : result;
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
