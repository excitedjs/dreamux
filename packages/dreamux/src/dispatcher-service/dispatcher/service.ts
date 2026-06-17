import type {
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
  ChannelTarget,
  InboundDeliveryResult,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import {
  bundledSkillSourcesForRole,
  dispatcherHostPaths,
  HOST_INJECT_ENV,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  CompletionEnvelope,
  TeamMateCompletionDeliveryResult,
} from '@excitedjs/dreamux-types';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type {
  DispatcherChannelConfig,
  DreamuxConfig,
} from '../../config/config.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import {
  DispatcherStore,
  type DispatcherRow,
  type DispatcherStatus,
} from '../../state/dispatcher-store.js';
import {
  dispatcherCacheDir,
  dispatcherDir,
} from '../../platform/paths.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import {
  channelMcpServerDescriptorsForCaller,
  dispatcherMcpServerDescriptors,
  type ChannelMcpCallerScope,
} from './mcp-descriptors.js';

export interface DispatcherRuntimeServiceOptions {
  id: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  /** Channel-provider catalog: core resolves each channel's provider. */
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
  routeChannelInput?: (
    channelId: string,
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
    hooks?: InboundDeliveryHooks,
  ) => Promise<AgentRuntimeTurnResult>;
}

export interface DispatcherRuntimeSlot {
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
  /** Provider ref carried by the channel MCP descriptor. Used to select/verify the session. */
  providerRef?: string;
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

/**
 * Owns one live dispatcher runtime and its built-in channel sessions.
 *
 * DispatcherService composes this service directly; runtime creation, channel
 * connection lifecycle, restart-notice delivery, and channel tool dispatch stay
 * local to that dispatcher.
 */
export class DispatcherRuntimeService {
  private slot: DispatcherRuntimeSlot | null = null;
  private starting: Promise<void> | null = null;
  private restartIntent: RestartIntentConsumer | null = null;

  constructor(private readonly opts: DispatcherRuntimeServiceOptions) {}

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.restartIntent = consumer;
  }

  async start(): Promise<void> {
    if (this.slot !== null) return;
    if (this.starting !== null) return this.starting;

    const promise = this.doStart().finally(() => {
      this.starting = null;
    });
    this.starting = promise;
    return promise;
  }

  async stop(): Promise<void> {
    const slot = this.slot;
    if (slot === null) return;
    const id = this.opts.id;
    for (const [channelId, session] of slot.channels) {
      try {
        await session.close();
      } catch (err) {
        slot.log.error(
          {
            dispatcher_id: id,
            channel_id: channelId,
            err: errInfo(err),
          },
          'error closing bot',
        );
      }
    }
    try {
      await slot.runtime.stop();
    } catch (err) {
      slot.log.error(
        {
          dispatcher_id: id,
          err: errInfo(err),
        },
        'error stopping dispatcher',
      );
    }
    this.slot = null;
  }

  getRuntime(): AgentRuntime | null {
    return this.slot?.runtime ?? null;
  }

  /**
   * Seam ③ of the reverse-delivery path (issue #147): forward a teammate
   * completion into the live dispatcher runtime, waking it for a fresh turn. Thin
   * by design (issue #233) — the at-most-once idempotency + retry policy lives in
   * the per-dispatcher `CompletionRouter`, which is the single delivery
   * chokepoint. Returns `unsupported` when the dispatcher is not running or its
   * runtime exposes no completion surface, so the router drops cleanly and the
   * consumer falls back to `last`.
   */
  async deliverCompletion(
    completion: CompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult> {
    const slot = this.slot;
    if (slot === null) {
      return { status: 'unsupported', reason: 'dispatcher not running' };
    }
    const deliver = slot.runtime.completionInput;
    if (deliver === undefined) {
      return {
        status: 'unsupported',
        reason: 'runtime has no completion delivery',
      };
    }
    return deliver.call(slot.runtime, completion);
  }

  summary(row: DispatcherRow): DispatcherSummary {
    const runtime = this.slot?.runtime;
    return {
      dispatcher_id: row.dispatcher_id,
      channel_identity: row.channel_identity,
      status: runtime?.getStatus() ?? row.status,
      thread_id: runtime?.getThreadId() ?? row.thread_id,
      enabled: row.enabled === 1,
    };
  }

  /**
   * Invoke a provider-owned channel tool, forwarding the raw `{name, arguments}`
   * to the channel provider seam (core is a blind MCP conduit; it never names a
   * tool). A live channel session handles it via `session.handleTool`; with no
   * live session the configured provider's `handleSessionlessTool` is tried
   * instead (the provider feature-detects and throws for an unknown sessionless
   * tool). `channelId` / `providerRef` select and verify the live session the
   * channel MCP descriptor was built for; omitted keeps the legacy primary
   * fallback for direct/internal callers.
   */
  async invokeChannelTool(input: ChannelToolInvocation): Promise<unknown> {
    const slot = this.slot;
    if (slot === null || slot.channels.size === 0) {
      return this.invokeSessionlessChannelTool(
        input.providerRef,
        input.channelId,
        input.name,
        input.arguments,
      );
    }
    const session = this.sessionFor(slot, input.channelId, input.providerRef);
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
      { dispatcher_id: this.opts.id, channel_id: session.channel_id },
    );
  }

  /**
   * Service a channel tool that has no live session (e.g. `list_chat_bots`
   * before a dispatcher's sessions connect) through the selected configured
   * provider's `handleSessionlessTool`. Core hands it host locators
   * (state root + logger); the provider owns tool-name feature detection and
   * throws for an unknown sessionless tool.
   */
  private async invokeSessionlessChannelTool(
    providerRef: string | undefined,
    channelId: string | undefined,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    const channelConfig = this.channelConfigFor(providerRef, channelId);
    const provider = this.opts.channelProviders.resolve(channelConfig.provider);
    if (provider.handleSessionlessTool === undefined) {
      throw new Error(
        `channel provider '${provider.ref}' exposes no sessionless tool surface`,
      );
    }
    return provider.handleSessionlessTool(
      name,
      (args ?? {}) as Record<string, unknown>,
      {
        dispatcher_id: this.opts.id,
        channel_id: channelConfig.id,
        state_root: dispatcherDir(this.opts.id),
        logger: this.opts.channelLoggerFactory(this.opts.id),
      },
    );
  }

  /**
   * Resolve the channel provider that backs a dispatcher's sessionless tool
   * calls. A channel MCP descriptor should carry the channel id/provider ref it
   * was built for; old callers may omit both and keep the primary fallback.
   */
  private channelConfigFor(
    providerRef?: string,
    channelId?: string,
  ): DispatcherChannelConfig {
    const dispatcherId = this.opts.id;
    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === dispatcherId,
    );
    const channels = dispatcherConfig?.channels ?? [];
    let channelConfig: DispatcherChannelConfig | undefined;

    if (channelId !== undefined) {
      channelConfig = channels.find((channel) => channel.id === channelId);
      if (channelConfig === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no configured channel '${channelId}'`,
        );
      }
    } else if (providerRef !== undefined) {
      channelConfig = channels.find((channel) => channel.provider === providerRef);
      if (channelConfig === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no configured channel for provider '${providerRef}'`,
        );
      }
    } else {
      channelConfig = channels[0];
      if (channelConfig === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no configured channel`,
        );
      }
    }

    if (providerRef !== undefined && channelConfig.provider !== providerRef) {
      throw new Error(
        `dispatcher '${dispatcherId}' channel '${channelConfig.id}' is provider '${channelConfig.provider}', not '${providerRef}'`,
      );
    }
    return channelConfig;
  }

  /**
   * Whether a live channel session observed a message for a target — the routing
   * ownership fact the TeamLeader egress gate keys off. A message belongs to the
   * target if ANY live channel session observed it (a dispatcher's bots see
   * disjoint targets, so this stays unambiguous); a session that cannot decide is
   * skipped. The target is provider-resolved; core never names a channel field.
   */
  async messageBelongsToTarget(
    target: ChannelTarget,
    messageId: string,
    channelId?: string,
  ): Promise<boolean> {
    const slot = this.slot;
    if (slot === null) return false;
    const sessions =
      channelId === undefined
        ? slot.channels.values()
        : [this.sessionFor(slot, channelId)].values();
    for (const session of sessions) {
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
   * `channelId` selects that channel's bot; otherwise `providerRef` selects the
   * one configured channel for that provider; otherwise the primary (first)
   * channel keeps direct/internal callers unchanged. Fails loud when the
   * descriptor's provider/channel identity does not match a live session.
   */
  private sessionFor(
    slot: DispatcherRuntimeSlot,
    channelId?: string,
    providerRef?: string,
  ): ChannelSession {
    let session: ChannelSession | undefined;
    if (channelId !== undefined) {
      session = slot.channels.get(channelId);
      if (session === undefined) {
        throw new Error(
          `dispatcher '${slot.row.dispatcher_id}' has no live channel '${channelId}'`,
        );
      }
    } else if (providerRef !== undefined) {
      session = Array.from(slot.channels.values()).find(
        (candidate) => candidate.provider === providerRef,
      );
      if (session === undefined) {
        throw new Error(
          `dispatcher '${slot.row.dispatcher_id}' has no live channel for provider '${providerRef}'`,
        );
      }
    } else {
      session = slot.channels.values().next().value;
      if (session === undefined) {
        throw new Error(
          `dispatcher '${slot.row.dispatcher_id}' has no live channel session`,
        );
      }
    }

    if (providerRef !== undefined && session.provider !== providerRef) {
      throw new Error(
        `dispatcher '${slot.row.dispatcher_id}' channel '${session.channel_id}' is provider '${session.provider}', not '${providerRef}'`,
      );
    }
    return session;
  }

  /**
   * Resolve a provider selector to a `ChannelTarget` via the live channel
   * session (issue #209 binding store v2). Target resolution is provider-owned;
   * core calls it here for both binding and inbound routing so `target_key` stays
   * opaque to core. The originating/selected `channelId` picks the session (live
   * multi-channel); omitted resolves through the primary channel. Requires a
   * running dispatcher — both call paths (the bind tool, the inbound router) run
   * only while a channel session is live.
   */
  async resolveChannelTarget(
    meta: unknown,
    channelId?: string,
    providerRef?: string,
  ): Promise<ChannelTarget> {
    return this.sessionFor(
      this.mustRunningSlot(),
      channelId,
      providerRef,
    ).resolveTarget(meta);
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  private async doStart(): Promise<void> {
    const id = this.opts.id;
    const row = this.opts.dispatchers.get(id);
    if (row === null) throw new Error(`no dispatcher '${id}'`);
    if (this.slot !== null) return;

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

    if (dispatcherConfig === undefined) {
      throw new Error(`dispatcher '${id}' has no config entry`);
    }
    const runtimeProvider = this.opts.agentRuntimeProviders.resolve(
      dispatcherConfig.runtime.provider,
    );
    // The dispatcher agent runs in its validated workspace (issue #182 PR-4):
    // no fallback to a Dreamux state dir. Server startup pre-flights this, so a
    // misconfigured dispatcher never reaches launch; the call here is idempotent
    // and keeps the launch path self-validating.
    const cwd = await ensureDispatcherWorkspace(this.opts.config, id);
    // The logger handed to providers (runtime + channel). Core's logger
    // IS the dreamux-types `DreamuxLogger`, so it is injected directly.
    const providerLog = this.opts.channelLoggerFactory(id);
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
    const runtimeConfig = dispatcherConfig.runtime.config;
    // Build the un-started channel sessions BEFORE the runtime so the
    // runtime's MCP descriptors are derived from each session's own
    // `mcpServerDescriptor` (a pure call) — core never names the channel's MCP
    // shape. Each session is created through its own `ChannelProvider`: core
    // resolves the provider from the catalog, hands it the provider-validated
    // config plus host state/cache dirs, and drives the returned
    // `ChannelSession`. Decision #4 (issue #209) caps a dispatcher at one channel
    // per provider ref, so a single-channel dispatcher resolves to a
    // single session. The defensive no-config path (a state row with no live
    // config entry) yields no channel session — a dispatcher with no configured
    // channel has no bot identity to connect as. Sessions connect only in the
    // start loop below.
    const channels = await this.buildChannelSessions(id, providerLog);

    const runtime = runtimeProvider.createRuntime({
      identity: { runtime_id: id, checkpoint_id: row.thread_id },
      role: 'dispatcher',
      config: runtimeConfig,
      cwd,
      systemPromptContent,
      mcpServers: dispatcherMcpServerDescriptors({
        dispatcherId: id,
        channels,
        adminSocketPath: this.opts.adminSocketPath,
      }),
      skillSources: bundledSkillSourcesForRole('dispatcher'),
      state: this.opts.dispatchers,
      paths: dispatcherHostPaths,
      logger: providerLog,
      injectEnv: HOST_INJECT_ENV,
    });

    try {
      await runtime.start();
      // Register the slot before starting any channel session so an inbound
      // arriving during session.start() resolves a running slot instead of
      // throwing 'not running' (issue #209 fix #7). The slot holds the same
      // `channels` map built above, so each session is observable as it starts.
      this.slot = {
        row,
        runtime,
        channels,
        log: providerLog,
      };
      for (const [channelId, session] of channels) {
        // Each session tags its own channel_id onto every inbound turn it
        // delivers, so the router keys on the channel the message actually
        // arrived through rather than re-deriving a single channel from config.
        await session.start({
          deliver: async (turn, envelope, hooks) =>
            asInboundDeliveryResult(
              (await this.opts.routeChannelInput?.(
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
      this.slot = null;
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
    await this.injectRestartNoticeIfNeeded(id, runtime, providerLog);
  }

  /**
   * Build the channel MCP server descriptors for a caller, derived from each
   * live channel session's own `mcpServerDescriptor` (a pure call). Core
   * supplies only host pieces (bin command + admin socket + caller
   * scope); the provider shapes its own stdio descriptor. Used for a TeamLeader,
   * whose dispatcher is already running.
   */
  channelMcpServerDescriptorsForCaller(
    scope: ChannelMcpCallerScope,
  ): AgentRuntimeMcpServer[] {
    const slot = this.slot;
    if (slot === null) return [];
    return channelMcpServerDescriptorsForCaller({
      dispatcherId: this.opts.id,
      channels: slot.channels,
      adminSocketPath: this.opts.adminSocketPath,
      scope,
    });
  }

  /**
   * Build the un-started channel sessions for a dispatcher from its
   * configured channels. Each provider's `readConfig` (already validated at
   * config-load) yields the provider config view, then `createSession` builds the
   * session through the create context (host state/cache roots + logger).
   * Sessions are NOT connected here — the caller starts them. On partial failure
   * the already-built sessions are closed.
   */
  private async buildChannelSessions(
    dispatcherId: string,
    providerLog: DreamuxLogger,
  ): Promise<Map<string, ChannelSession>> {
    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === dispatcherId,
    );
    const channelConfigs: DispatcherChannelConfig[] = dispatcherConfig?.channels ?? [];
    const channels = new Map<string, ChannelSession>();
    try {
      for (const channelConfig of channelConfigs) {
        const provider = this.opts.channelProviders.resolve(channelConfig.provider);
        channels.set(
          channelConfig.id,
          provider.createSession({
            dispatcher_id: dispatcherId,
            channel_id: channelConfig.id,
            provider: channelConfig.provider,
            config: channelConfig.config,
            logger: providerLog,
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
          {
            dispatcher_id: dispatcherId,
            err: errInfo(result.error),
          },
          'restart notice injection failed',
        );
      }
    } catch (err) {
      log.warn(
        {
          dispatcher_id: dispatcherId,
          err: errInfo(err),
        },
        'restart notice injection errored',
      );
    }
  }

  private mustRunningSlot(): DispatcherRuntimeSlot {
    const slot = this.slot;
    if (slot === null) {
      throw new Error(`dispatcher '${this.opts.id}' is not running`);
    }
    return slot;
  }

}

/**
 * Narrow the wider {@link AgentRuntimeTurnResult} union to the
 * {@link InboundDeliveryResult} the `ChannelRoutes.deliver` contract
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
