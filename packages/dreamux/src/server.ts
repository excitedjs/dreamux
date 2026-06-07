/**
 * The dreamux Server — the long-running Node process that hosts N dispatchers.
 *
 * Lifecycle:
 *   1. load dispatcher declarations from config
 *   2. open admin Unix socket (so server-ctl can talk to us even if a
 *      dispatcher fails to come up)
 *   3. for each enabled dispatcher: spawn codex, open feishu, start turn worker
 *   4. install SIGTERM/SIGINT handlers for graceful drain
 *
 * Current MVP: accepted inbound work is process-local. Restarting the server
 * drops in-flight inbound submissions instead of replaying them.
 */

import {
  createBuiltinAgentRuntimeProviderCatalog,
  type AgentRuntime,
  type AgentRuntimeMcpServer,
  type AgentRuntimeProviderCatalog,
} from './agent-runtime/index.js';
import type { InboundTurnInput } from './dispatcher/turn-manager.js';
import type { CodexProcess, CodexProcessOptions } from './codex/supervisor.js';
import type { CodexWsClient } from './codex/rpc.js';
import { type FeishuBot, type FeishuInboundEvent } from './feishu/bot.js';
import { isBotSenderType } from '@excitedjs/feishu-transport';
import {
  CHANNEL_CAPABILITY,
  ChannelCapabilityError,
  type ChannelConnection,
  type ChannelProvider,
} from './channel/provider.js';
import { resolveChannelProvider } from './channel/channel-providers.js';
import {
  detectIntroduce,
  introduceAckText,
  introduceDenyReason,
  introducedPeers,
} from './channel/introduce.js';
import { formatFeishuMessageForCodex } from './channel/feishu-message.js';
import {
  clearBaselineIfCurrent,
  listChatBots,
  observeKnownBot,
  pendingBaseline,
  recordBotAdded,
  trustIntroducedBots,
  trustedBotIds,
} from './channel/chat-bots-store.js';
import type { PeerBot } from './channel/chat-bots-store.js';
import { resolveBotSecret } from './runtime/secrets.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  BUILT_IN_DEFAULTS,
  defaultDispatcherCodexConfig,
  dispatcherCodexConfig,
  type DispatcherCodexConfig,
  type DreamuxConfig,
} from './runtime/config.js';
import {
  DispatcherStore,
  type DispatcherRow,
  type DispatcherStatus,
} from './runtime/dispatcher-store.js';
import type { DispatcherCodexHomeDoctor } from './runtime/dispatcher-codex-home.js';
import {
  adminSocketPath,
  dispatcherCodexCwd,
  dispatcherFeishuAttachmentCacheDir,
  setRuntimeConfig,
} from './runtime/paths.js';
import {
  createLogger,
  loggerToLevelFn,
  pinoToTransportLogger,
  type DreamuxLogger,
} from './runtime/logger.js';
import { createAdminSocketServer, type AdminSocketServer } from './admin/socket.js';
import { RestartIntentConsumer } from './daemon/restart-intent.js';
import {
  NestedTeamMateDispatchError,
  legacyTaskStatus,
  resolveTeammateTarget,
  TEAMMATE_INPUT_MODES,
  TEAMMATE_TARGET_MODES,
  type TeamMateDeliveryStatus,
  type TeamMateInputMode,
  type TeamMateLifecycleStatus,
  type TeamMateScheduleCallerKind,
  type TeamMateTargetMode,
  type TeamMateTaskRecord,
  TeamMateTaskLedger,
} from './teammate/ledger.js';
import { teammateMcpServerDescriptor } from './teammate/mcp-config.js';
import {
  TeamMateDeliveryService,
  type TeamMateDeliveryReport,
} from './teammate/delivery.js';
import {
  TeamMateWorkerExecutionService,
  type TeamMateExecutionOutcome,
} from './teammate/worker-execution.js';
import { TeamMateWorkerProviderCatalog } from './teammate/worker/catalog.js';
import type { TeamMateWorkerProvider } from './teammate/worker/types.js';
import { createCodexTeamMateWorkerProvider } from './teammate/worker/codex-provider.js';
import {
  awaitTeamMateCompletion,
  clampWaitTimeout,
  isWaitToken,
  lastEventId,
  TEAMMATE_WAIT_DEFAULT_MS,
  TEAMMATE_WAIT_DEFAULT_UNTIL,
  TEAMMATE_WAIT_MAX_MS,
  TeamMateWaitBroker,
  type TeamMateWaitToken,
} from './teammate/wait-broker.js';

export const RECEIVED_REACTION_EMOJI = 'Get';
export const IN_PROGRESS_REACTION_EMOJI = 'OnIt';
const MAX_PENDING_RECEIVED_REACTION_CLEARS = 1024;

export interface ServerOptions {
  /**
   * Global dreamux config (typically loaded from ~/.dreamux/config.json by
   * the CLI entry point). When omitted, the built-in defaults are used —
   * convenient for tests, but in production the CLI is expected to load
   * the file and pass it in so user edits take effect.
   */
  config?: DreamuxConfig;
  /** Override admin socket path (tests). */
  adminSocketPath?: string;
  /** Inject a custom bot factory (tests use this to plug in a fake). */
  botFactory?: (row: DispatcherRow, secret: string) => FeishuBot;
  /**
   * Resolve a channel provider ref to its implementation. Defaults to
   * {@link resolveChannelProvider}. Tests inject a fake provider — e.g. an
   * inbound-only channel that exposes no reply capability — to exercise the
   * capability-gated outbound paths.
   */
  channelProviderResolver?: (ref: string) => ChannelProvider;
  /** Codex binary path override (tests, highest precedence). */
  codexBinPath?: string;
  /** Inject a CodexProcess factory (tests). */
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  /** Inject a CodexWsClient factory (tests). */
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  /** Inject a Codex home doctor (tests). */
  codexHomeDoctor?: DispatcherCodexHomeDoctor;
  /** Skip resolving bot secret (tests with fake bot). */
  skipBotSecret?: boolean;
  /** Codex child/WS restart backoff base override (tests). */
  codexRestartBackoffBaseMs?: number;
  /** Codex child/WS restart backoff cap override (tests). */
  codexRestartBackoffMaxMs?: number;
  /** Override runtime provider catalog (tests / future provider composition). */
  agentRuntimeProviderCatalog?: AgentRuntimeProviderCatalog;
  /**
   * TeamMate worker provider catalog (issue #126 PR2). Empty by default — the
   * MVP wires no real worker, so execution tools report `provider_unavailable`
   * exactly as PR1. Tests inject a fake worker catalog to drive the full
   * accepted → running → completed/failed/cancelled orchestration.
   */
  teamMateWorkerProviders?: TeamMateWorkerProviderCatalog;
  /** Max TeamMate completion delivery attempts before delivery_failed (tests). */
  teamMateDeliveryMaxAttempts?: number;
  /** TeamMate delivery backoff per attempt, ms (tests pass 0). */
  teamMateDeliveryBackoffMs?: (attempt: number) => number;
  /**
   * Server-level logger (admin socket, dispatcher supervision, shutdown). When
   * omitted, a stderr-only logger is used — the CLI entry point injects a
   * file-backed one so tests stay filesystem-free.
   */
  logger?: DreamuxLogger;
  /**
   * Per-dispatcher channel logger factory (gate, inbound, outbound, introduce,
   * dispatcher lifecycle). Defaults to a stderr-only logger per dispatcher; the
   * CLI injects a factory that writes `logs/feishu-channel/<id>.log`.
   */
  channelLoggerFactory?: (dispatcherId: string) => DreamuxLogger;
}

export interface Repos {
  dispatchers: DispatcherStore;
}

interface DispatcherSlot {
  row: DispatcherRow;
  runtime: AgentRuntime;
  bot: FeishuBot;
  channelProvider: ChannelProvider;
  channelState: DispatcherChannelState;
  log: DreamuxLogger;
}

interface DispatcherChannelState {
  inboundReactions: Map<string, InboundReactionLedgerEntry>;
  pendingReceivedReactionClears: Set<string>;
}

type InboundReactionState = 'received' | 'in_progress';

interface InboundReactionLedgerEntry {
  chatId: string;
  reactionId: string;
  state: InboundReactionState;
}

async function sendIntroduceAck(input: {
  dispatcherId: string;
  channelProvider: ChannelProvider;
  connection: ChannelConnection;
  log: DreamuxLogger;
  chatId: string;
  messageId: string;
  peers: PeerBot[];
}): Promise<void> {
  const text = introduceAckText(input.peers);
  if (text === null) return;
  // Best-effort ack: if the channel exposes no reply capability, skip silently
  // rather than assuming every channel is two-way.
  if (
    !input.channelProvider.hasCapability(CHANNEL_CAPABILITY.reply) ||
    input.channelProvider.reply === undefined
  ) {
    return;
  }
  let result: { messageIds: string[] };
  try {
    result = await input.channelProvider.reply(input.connection, {
      chatId: input.chatId,
      text,
    });
  } catch (err) {
    input.log.error(
      {
        dispatcher_id: input.dispatcherId,
        chat_id: input.chatId,
        message_id: input.messageId,
        peer_count: input.peers.length,
        err: errInfo(err),
      },
      'introduce ack failed',
    );
    return;
  }
  input.log.info(
    {
      dispatcher_id: input.dispatcherId,
      chat_id: input.chatId,
      message_id: input.messageId,
      peer_count: input.peers.length,
      message_ids: result.messageIds,
    },
    'introduce ack sent',
  );
}

export interface ServerMcpReplyInput {
  dispatcherId: string;
  chatId: string;
  text: string;
  messageId?: string;
  mentionUserIds?: string[];
}

export interface ServerMcpReactInput {
  dispatcherId: string;
  messageId: string;
  emoji: string;
}

export interface ServerMcpListChatBotsInput {
  dispatcherId: string;
  chatId: string;
}

export interface WireChatBot {
  open_id: string;
  name?: string;
}

export interface ServerMcpListChatBotsResult {
  chat_id: string;
  known: WireChatBot[];
  trusted: WireChatBot[];
}

export interface ServerMcpScheduleTeamMateInput {
  dispatcherId: string;
  callerKind: TeamMateScheduleCallerKind;
  title: string;
  prompt: string;
  teammateId?: string;
}

export interface ServerMcpScheduleTeamMateResult {
  status: 'accepted';
  task_id: string;
  dispatcher_id: string;
  created_at: number;
  teammate_id?: string;
}

export interface ServerTeamMateCompletionInput {
  dispatcherId: string;
  taskId: string;
  outcome: 'completed' | 'failed';
  finalText: string;
}

export interface ServerTeamMateTaskSummary {
  task_id: string;
  /** Back-compat projection of lifecycle + delivery into the v1 status enum. */
  status: string;
  lifecycle_status: TeamMateLifecycleStatus;
  delivery_status: TeamMateDeliveryStatus;
  title: string;
  teammate_id: string | null;
  provider_ref: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
  delivery_attempts: number;
  has_result: boolean;
}

export interface ServerTeamMatePullResult {
  task_id: string;
  status: string;
  lifecycle_status: TeamMateLifecycleStatus;
  delivery_status: TeamMateDeliveryStatus;
  outcome: 'completed' | 'failed';
  text: string;
  delivered: boolean;
  delivery_attempts: number;
}

export interface ServerMcpRunTeamMateTaskInput {
  dispatcherId: string;
  callerKind: TeamMateScheduleCallerKind;
  title: string;
  prompt: string;
  targetPath: string;
  teammateId?: string;
  intent?: string;
  targetMode?: TeamMateTargetMode;
  providerRef?: string;
  operationId?: string;
}

export interface ServerMcpExecuteTeamMateTaskInput {
  dispatcherId: string;
  taskId: string;
  providerRef?: string;
  targetMode?: TeamMateTargetMode;
  operationId?: string;
}

export interface ServerMcpSendTeamMateInputInput {
  dispatcherId: string;
  taskId: string;
  prompt: string;
  mode?: TeamMateInputMode;
  operationId?: string;
}

export interface ServerMcpAwaitTeamMateCompletionInput {
  dispatcherId: string;
  taskId: string;
  afterEventId?: number;
  until?: string[];
  timeoutMs?: number;
}

/**
 * Execution attempt outcome (issue #126). With no worker wired (production MVP)
 * this is always `provider_unavailable`, exactly as PR1; an injected worker
 * catalog produces `running`/`completed`/`failed`/`cancelled` with the resolved
 * `provider_ref`. The `reason`/`code`/`retryable` fields are present only for
 * `provider_unavailable`.
 */
export interface ServerTeamMateExecutionResult {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'provider_unavailable';
  provider_ref?: string;
  reason?: string;
  code?: string;
  retryable?: boolean;
}

export interface ServerMcpRunTeamMateTaskResult {
  task: ServerTeamMateTaskSummary;
  execution: ServerTeamMateExecutionResult;
}

export interface ServerMcpSendTeamMateInputResult {
  input_id: string;
  mode: TeamMateInputMode;
  /**
   * `submitted` when a live worker session accepted the input, `queued`
   * otherwise (no worker, or the worker rejected it) — the input is still
   * durably recorded either way (issue #126 PR2).
   */
  status: 'queued' | 'submitted';
  after_event_id: number;
  task: ServerTeamMateTaskSummary;
}

export interface ServerMcpAwaitTeamMateCompletionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'reached' | 'still_running';
  task_id: string;
  after_event_id: number;
  task: ServerTeamMateTaskSummary | null;
  result?: ServerTeamMatePullResult | null;
}

/** Worker capability advertisement for a built-in runtime (placeholder in PR1). */
export interface ServerTeamMateProviderCapability {
  provider_ref: string;
  worker_available: boolean;
  unsupported_reason: string;
  modes: { steer: boolean; queue: boolean; interrupt: boolean };
  resume: boolean;
  logs: boolean;
}

export interface ServerTeamMateCapabilities {
  execution_available: boolean;
  wait: { default_ms: number; max_ms: number };
  target_modes: TeamMateTargetMode[];
  input_modes: TeamMateInputMode[];
  default_input_mode: TeamMateInputMode;
  providers: ServerTeamMateProviderCapability[];
}

export class Server {
  readonly repos: Repos;
  private readonly slots = new Map<string, DispatcherSlot>();
  private readonly teamMateLedgers = new Map<string, TeamMateTaskLedger>();
  private readonly teamMateWaitBroker = new TeamMateWaitBroker();
  /**
   * PR #3 review #4: in-flight startDispatcher promises, keyed by id.
   * Two concurrent callers must await the same start, not race to spawn
   * duplicate Codex children / Feishu listeners.
   */
  private readonly starting = new Map<string, Promise<void>>();
  private admin: AdminSocketServer | null = null;
  /**
   * One-shot restart-notice snapshot loaded at start(). Null until start();
   * each resumed dispatcher claims its notice once as it comes up (issue #78).
   */
  private restartIntent: RestartIntentConsumer | null = null;
  private shuttingDown = false;
  private readonly opts: ServerOptions;
  private readonly log: DreamuxLogger;
  private readonly channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  private readonly channelProviderResolver: (ref: string) => ChannelProvider;
  private readonly agentRuntimeProviders: AgentRuntimeProviderCatalog;
  private readonly teamMateDelivery: TeamMateDeliveryService;
  private readonly teamMateWorkers: TeamMateWorkerProviderCatalog;
  private readonly teamMateWorkerExecution: TeamMateWorkerExecutionService;

  constructor(opts: ServerOptions = {}) {
    this.opts = opts;
    this.channelProviderResolver =
      opts.channelProviderResolver ?? resolveChannelProvider;
    // Install the config snapshot before any paths.* / runtime.* lookup
    // happens. paths.stateRoot / adminSocketPath / etc. consult this
    // snapshot for non-env defaults (env vars still win).
    setRuntimeConfig(opts.config ?? BUILT_IN_DEFAULTS);
    // Default loggers are stderr-only (zero files opened) so tests that
    // construct a Server without injecting a logger never touch ~/.dreamux.
    this.log = opts.logger ?? createLogger({ name: 'server' });
    this.channelLoggerFactory =
      opts.channelLoggerFactory ??
      ((id) => createLogger({ name: `channel/${id}` }));
    const codexProviderOptions = {
      resolveBinPath: (dispatcherBin: string) =>
        this.resolveCodexBinPath(dispatcherBin),
      ...(opts.codexProcessFactory !== undefined
        ? { codexProcessFactory: opts.codexProcessFactory }
        : {}),
      ...(opts.codexClientFactory !== undefined
        ? { codexClientFactory: opts.codexClientFactory }
        : {}),
      ...(opts.codexHomeDoctor !== undefined
        ? { codexHomeDoctor: opts.codexHomeDoctor }
        : {}),
      ...(opts.codexRestartBackoffBaseMs !== undefined
        ? { restartBackoffBaseMs: opts.codexRestartBackoffBaseMs }
        : {}),
      ...(opts.codexRestartBackoffMaxMs !== undefined
        ? { restartBackoffMaxMs: opts.codexRestartBackoffMaxMs }
        : {}),
    };
    this.agentRuntimeProviders =
      opts.agentRuntimeProviderCatalog ??
      createBuiltinAgentRuntimeProviderCatalog({
        codex: codexProviderOptions,
      });
    this.teamMateDelivery = new TeamMateDeliveryService({
      ledger: (dispatcherId) => this.teamMateLedger(dispatcherId),
      resolveRuntime: (dispatcherId) => this.getRuntime(dispatcherId),
      notifyEvent: (dispatcherId, taskId) =>
        this.teamMateWaitBroker.notify(dispatcherId, taskId),
      log: (level, message, fields) => this.log[level](fields ?? {}, message),
      ...(opts.teamMateDeliveryMaxAttempts !== undefined
        ? { maxAttempts: opts.teamMateDeliveryMaxAttempts }
        : {}),
      ...(opts.teamMateDeliveryBackoffMs !== undefined
        ? { backoffMs: opts.teamMateDeliveryBackoffMs }
        : {}),
    });
    // Default worker catalog wires the real Codex worker (issue #126 PR3), so a
    // production `dreamux serve` executes TeamMate tasks for real and
    // `get_capabilities` reports `builtin:codex` as worker-available. Tests
    // still fully control execution by injecting `teamMateWorkerProviders`
    // (the fake provider, or an empty catalog for the no-worker path). The
    // worker reuses the same codex process/client test seams as the dispatcher
    // runtime, so a fake-codex test drives it without spawning a real binary.
    this.teamMateWorkers =
      opts.teamMateWorkerProviders ??
      new TeamMateWorkerProviderCatalog({
        providers: [
          createCodexTeamMateWorkerProvider({
            resolveBinPath: (dispatcherBin) =>
              this.resolveCodexBinPath(dispatcherBin),
            resolveCodexConfig: (dispatcherId) =>
              this.resolveDispatcherCodexConfig(dispatcherId),
            resolveDispatcherCwd: (dispatcherId) =>
              this.resolveDispatcherCwd(dispatcherId),
            ...(opts.codexProcessFactory !== undefined
              ? { codexProcessFactory: opts.codexProcessFactory }
              : {}),
            ...(opts.codexClientFactory !== undefined
              ? { codexClientFactory: opts.codexClientFactory }
              : {}),
            log: (level, message, fields) =>
              this.log[level](fields ?? {}, message),
          }),
        ],
        defaultRef: BUILTIN_CODEX_PROVIDER_REF,
      });
    this.teamMateWorkerExecution = new TeamMateWorkerExecutionService({
      ledger: (dispatcherId) => this.teamMateLedger(dispatcherId),
      workers: () => this.teamMateWorkers,
      reportCompletion: (report) =>
        this.teamMateDelivery.reportCompletion(report),
      notifyEvent: (dispatcherId, taskId) =>
        this.teamMateWaitBroker.notify(dispatcherId, taskId),
      log: (level, message, fields) => this.log[level](fields ?? {}, message),
    });
    this.repos = {
      dispatchers: new DispatcherStore(opts.config ?? BUILT_IN_DEFAULTS),
    };
  }

  /** Effective config (caller-supplied or built-in defaults). */
  private effectiveConfig(): DreamuxConfig {
    return this.opts.config ?? BUILT_IN_DEFAULTS;
  }

  /**
   * Final codex binary path for one dispatcher. Precedence (highest first):
   *   1. ServerOptions.codexBinPath (test seam)
   *   2. CODEX_HOST_CODEX_BIN env (deliberate host-level override across every
   *      dispatcher; onboard no longer sets it automatically)
   *   3. the dispatcher's dispatchers[].runtime.config.bin (default "codex")
   *
   * The codex binary is a per-dispatcher config field; the env var only exists
   * as an explicit host/service-wide override.
   */
  private resolveCodexBinPath(dispatcherBin: string): string {
    if (this.opts.codexBinPath !== undefined) return this.opts.codexBinPath;
    const fromEnv = process.env['CODEX_HOST_CODEX_BIN'];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    return dispatcherBin;
  }

  /**
   * Codex launch config for one dispatcher's TeamMate worker (issue #126 PR3).
   * A worker inherits the same approval/sandbox/env/handshake settings as the
   * dispatcher's own runtime so it is never more permissive; an unknown
   * dispatcher falls back to the built-in defaults.
   */
  private resolveDispatcherCodexConfig(
    dispatcherId: string,
  ): DispatcherCodexConfig {
    const dispatcher = this.effectiveConfig().dispatchers.find(
      (entry) => entry.id === dispatcherId,
    );
    return dispatcher === undefined
      ? defaultDispatcherCodexConfig()
      : dispatcherCodexConfig(dispatcher);
  }

  /**
   * Fallback working directory for a TeamMate worker whose task carries no
   * resolved target (e.g. a `schedule`d task later executed). Mirrors the
   * dispatcher runtime's own cwd resolution.
   */
  private resolveDispatcherCwd(dispatcherId: string): string {
    return (
      this.repos.dispatchers.get(dispatcherId)?.codex_cwd ??
      dispatcherCodexCwd(dispatcherId)
    );
  }

  /** Bring up admin socket + all enabled dispatchers. */
  async start(): Promise<void> {
    // Restore each dispatcher's persisted status.json into the in-memory store
    // before any row is listed or launched (the constructor only seeded
    // config-derived defaults — the status read is async).
    await this.repos.dispatchers.hydrate((message) => this.log.warn(message));
    // Load (and delete) any restart marker before bringing dispatchers up, so
    // the snapshot is in memory when each resumed dispatcher claims its notice.
    this.restartIntent = await RestartIntentConsumer.load({
      now: Date.now(),
      warn: (message) => this.log.warn(message),
    });

    this.admin = createAdminSocketServer(
      this,
      this.opts.adminSocketPath ?? adminSocketPath(),
    );
    await this.admin.start();
    this.log.info(
      { admin_socket: this.admin.socketPath },
      'admin socket listening',
    );

    const rows = this.repos.dispatchers.listEnabled();
    for (const row of rows) {
      try {
        await this.startDispatcher(row.dispatcher_id);
      } catch (err) {
        this.log.error(
          { dispatcher_id: row.dispatcher_id, err: errInfo(err) },
          'dispatcher failed to start',
        );
        // server keeps running; admin can inspect & retry via dispatcher.start
      }
    }
  }

  /** Bring one dispatcher up. Safe to call when already running (no-op). */
  async startDispatcher(id: string): Promise<void> {
    if (this.slots.has(id)) return;
    // PR #3 review #4: another caller may already be mid-startup. The
    // `slots.has(id)` check above only catches *finished* startups; without
    // this in-flight map two concurrent calls (e.g. start() at boot + an
    // admin dispatcher.start) would both pass and spawn duplicate Codex
    // children / Feishu listeners. Coalesce on the first promise.
    const inflight = this.starting.get(id);
    if (inflight !== undefined) return inflight;

    const promise = this.doStartDispatcher(id).finally(() => {
      this.starting.delete(id);
    });
    this.starting.set(id, promise);
    return promise;
  }

  private async doStartDispatcher(id: string): Promise<void> {
    const row = this.repos.dispatchers.get(id);
    if (row === null) throw new Error(`no dispatcher '${id}'`);
    // Re-check inside the critical section; a concurrent caller that won
    // the race may have finished by the time we got scheduled.
    if (this.slots.has(id)) return;

    const cfg = this.effectiveConfig();
    const dispatcherConfig = cfg.dispatchers.find(
      (dispatcher) => dispatcher.id === id,
    );
    // Resolve the dispatcher's channel provider (issue #110 PR4). The server no
    // longer constructs the Feishu MCP surface / bot / gate by hard-coded name;
    // it consumes the capabilities the provider exposes. The ref is validated
    // through the capability registry, so a reserved/unknown ref fails loudly.
    const channelRef =
      dispatcherConfig?.channels[0]?.provider ?? BUILTIN_FEISHU_PROVIDER_REF;
    const channelProvider = this.channelProviderResolver(channelRef);

    // Resolve the dispatcher's agent runtime provider (issue #110 PR5).
    const runtimeProvider = this.agentRuntimeProviders.resolve(
      dispatcherConfig?.runtime.provider ?? BUILTIN_CODEX_PROVIDER_REF,
    );
    // Build the per-dispatcher channel logger first so it can be injected into
    // the bot/transport — the transport's own SDK / connection diagnostics then
    // land in this same `logs/feishu-channel/<id>.log`, not on bare stderr.
    const channelLog = this.channelLoggerFactory(id);
    // The channel provider exposes runtime-neutral MCP server descriptors; the
    // runtime provider translates them into runtime-specific args (e.g. Codex
    // `mcp_servers.*`). Core no longer emits Codex CLI args for the channel.
    const mcpContext = {
      dispatcherId: id,
      adminSocketPath: this.opts.adminSocketPath ?? adminSocketPath(),
    };
    const runtime = runtimeProvider.createRuntime({
      row,
      dispatchers: this.repos.dispatchers,
      dispatcher: dispatcherConfig ?? null,
      mcpServers: this.dreamuxMcpServerDescriptors(channelProvider, mcpContext),
      log: loggerToLevelFn(channelLog),
    });
    const botSecret = this.opts.skipBotSecret
      ? ''
      : resolveBotSecret(row.bot_secret_ref, cfg);
    const bot = this.opts.botFactory
      ? this.opts.botFactory(row, botSecret)
      : channelProvider.createConnection({
          appId: row.bot_app_id,
          appSecret: botSecret,
          logger: pinoToTransportLogger(channelLog),
        });
    const channelState: DispatcherChannelState = {
      inboundReactions: new Map(),
      pendingReceivedReactionClears: new Set(),
    };

    try {
      await runtime.start();
      await bot.start({
        onBotMemberAdded: async (added) => {
          // Issue #62 Phase 1/4: record that the bot joined a chat so a later
          // baseline can be injected. Idempotent by event id; no notification.
          await recordBotAdded(id, added.chatId, added.eventId);
        },
        onMessage: async (event: FeishuInboundEvent) => {
          const access = await channelProvider.access.load(id);

          // Issue #62: peer-bot awareness + `/introduce`, evaluated before the
          // delivery gate. A bot seen in an authorized chat becomes *known*
          // (awareness only, never trust). `/introduce` from an allowlisted
          // sender records the named peer bots as *trusted* and is consumed —
          // it never reaches Codex as a normal turn. No `@`-mention is required.
          if (
            event.chatType === 'group' &&
            isBotSenderType(event.senderType) &&
            access.group.allow_chats.includes(event.chatId)
          ) {
            await observeKnownBot(id, event.chatId, {
              openId: event.senderId,
              ...(event.senderName !== '' ? { name: event.senderName } : {}),
            });
          }
          if (detectIntroduce(event.messageType, event.rawContent, event.mentions)) {
            const denyReason = introduceDenyReason(access, {
              chatType: event.chatType,
              chatId: event.chatId,
              senderId: event.senderId,
            });
            if (denyReason === null) {
              const peers = introducedPeers(event.mentions, bot.botOpenId);
              if (peers.length > 0) {
                await trustIntroducedBots(id, event.chatId, peers);
                await sendIntroduceAck({
                  dispatcherId: id,
                  channelProvider,
                  connection: bot,
                  log: channelLog,
                  chatId: event.chatId,
                  messageId: event.messageId,
                  peers,
                });
              }
              channelLog.info(
                {
                  chat_id: event.chatId,
                  sender_id: event.senderId,
                  trusted_peers: peers.length,
                },
                'introduce consumed',
              );
              return;
            }
            // Issue #77: a `/introduce` that the sender is not authorized to run
            // would otherwise fall through and surface as an ordinary gate drop
            // (e.g. `bot not mentioned`, because the introduce path deliberately
            // waives the mention requirement that the gate enforces), hiding the
            // real cause. Emit one diagnostic with the stable deny reason, then
            // let the normal gate run unchanged — trust is not written and no
            // baseline is armed on this path.
            channelLog.info(
              {
                chat_id: event.chatId,
                sender_id: event.senderId,
                message_id: event.messageId,
                reason: denyReason,
              },
              'introduce detected but not authorized',
            );
          }

          const trustedBots =
            event.chatType === 'group'
              ? await trustedBotIds(id, event.chatId)
              : undefined;
          const gate = channelProvider.access.gate({
            senderId: event.senderId,
            senderType: event.senderType,
            chatId: event.chatId,
            chatType: event.chatType,
            mentions: event.mentions,
            botOpenId: bot.botOpenId,
            ...(trustedBots !== undefined ? { trustedBotIds: trustedBots } : {}),
          }, access);
          await channelProvider.access.save(id, gate.access);
          if (gate.warning !== null) {
            channelLog.warn(
              { chat_id: event.chatId, warning: gate.warning },
              'trust-domain warning',
            );
          }
          if (gate.action === 'drop') {
            channelLog.info(
              {
                chat_id: event.chatId,
                chat_type: event.chatType,
                sender_id: event.senderId,
                // Diagnostic only (issue #102): when a peer-bot message is
                // dropped, its union_id helps tell "same bot, different
                // app-scoped open_id" from "different entity". Not used for
                // gating.
                ...(event.senderUnionId !== undefined && event.senderUnionId !== ''
                  ? { sender_union_id: event.senderUnionId }
                  : {}),
                message_id: event.messageId,
                reason: gate.reason,
              },
              'feishu inbound dropped',
            );
            return;
          }
          // Issue #69: a group with pending discovery context gets a one-shot
          // `<group_bots>` block of its trusted bots on this delivery. We
          // snapshot the generation before enqueue so a concurrent
          // `/introduce` / bot-added that re-arms the flag mid-enqueue is not
          // clobbered by the clear below.
          const baseline =
            event.chatType === 'group'
              ? await pendingBaseline(id, event.chatId)
              : null;
          const injectBots =
            baseline !== null && baseline.needsBaseline && baseline.trusted.length > 0;
          const formatted = await formatFeishuMessageForCodex(
            event,
            {
              cacheDir: dispatcherFeishuAttachmentCacheDir(id),
              resourceFetcher: bot,
              ...(injectBots ? { trustedBots: baseline.trusted } : {}),
            },
          );
          const input: InboundTurnInput = {
            source_chat_id: event.chatId,
            source_message_id: event.messageId,
            sender_id: event.senderId,
            parsed_text: formatted.formattedText,
          };
          const delivery = await runtime.enqueueInbound(input, {
            onAccepted: async (acceptedInput) => {
              await setInboundReaction(
                id,
                bot,
                channelState,
                channelLog,
                acceptedInput,
                RECEIVED_REACTION_EMOJI,
                'received',
              );
            },
          });
          if (delivery.status === 'submitted') {
            channelLog.info(
              {
                chat_id: event.chatId,
                sender_id: event.senderId,
                message_id: event.messageId,
              },
              'feishu inbound submitted',
            );
            // Commit-after-notify: only clear the one-shot once the turn is
            // actually submitted, and only if the generation is still current.
            // `duplicate` / `stopped` / `failed` leave the context pending.
            if (injectBots) {
              await clearBaselineIfCurrent(id, event.chatId, baseline.generation);
            }
            await setInboundReaction(
              id,
              bot,
              channelState,
              channelLog,
              input,
              IN_PROGRESS_REACTION_EMOJI,
              'in_progress',
            );
          } else if (delivery.status === 'failed') {
            channelLog.error(
              {
                chat_id: event.chatId,
                message_id: event.messageId,
                err: errInfo(delivery.error),
              },
              'failed to submit feishu inbound',
            );
          }
        },
      });
    } catch (err) {
      // Failed midway: undo any partial bring-up so a retry isn't
      // racing leftovers. Best-effort — we still surface the original err.
      try {
        await bot.close();
      } catch {
        /* */
      }
      try {
        await runtime.stop();
      } catch {
        /* */
      }
      throw err;
    }

    this.slots.set(id, {
      row,
      runtime,
      bot,
      channelProvider,
      channelState,
      log: channelLog,
    });
    this.log.info(
      {
        dispatcher_id: id,
        bot_app_id: row.bot_app_id,
        cwd: row.codex_cwd ?? dispatcherCodexCwd(id),
      },
      'dispatcher ready',
    );

    // Restart-notice injection happens here — after the slot is registered and
    // the bot is listening — so the resumed turn can reply through Feishu. Only
    // a thread that was actually resumed and is a named restart target gets a
    // notice; cold boots and crash auto-heals never reach this path with a live
    // marker. Best-effort: a failure must not fail the dispatcher (issue #78).
    if (runtime.wasThreadResumed()) {
      const notice = this.restartIntent?.claim(id, Date.now()) ?? null;
      if (notice !== null) {
        try {
          await runtime.injectRestartNotice(notice);
        } catch (err) {
          channelLog.warn(
            { dispatcher_id: id, err: errInfo(err) },
            'restart notice injection errored',
          );
        }
      }
    }
  }

  /** Gracefully stop one dispatcher. Idempotent. */
  async stopDispatcher(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    try {
      await slot.bot.close();
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

  async replyFromMcp(input: ServerMcpReplyInput): Promise<{ message_ids: string[] }> {
    const slot = this.mustRunningSlot(input.dispatcherId);
    if (
      !slot.channelProvider.hasCapability(CHANNEL_CAPABILITY.reply) ||
      slot.channelProvider.reply === undefined
    ) {
      throw new ChannelCapabilityError(
        slot.channelProvider.ref,
        CHANNEL_CAPABILITY.reply,
      );
    }
    let result: { messageIds: string[] };
    try {
      result = await slot.channelProvider.reply(slot.bot, {
        chatId: input.chatId,
        text: input.text,
        ...(input.messageId !== undefined
          ? { replyToMessageId: input.messageId }
          : {}),
        ...(input.mentionUserIds !== undefined
          ? { mentionUserIds: input.mentionUserIds }
          : {}),
      });
    } catch (err) {
      // Persist the outbound failure so a daemon can later tell whether a model
      // reply ever left the host. The message body (`input.text`) is omitted.
      slot.log.error(
        {
          dispatcher_id: input.dispatcherId,
          chat_id: input.chatId,
          message_id: input.messageId,
          err: errInfo(err),
        },
        'feishu reply failed',
      );
      throw err;
    }
    slot.log.info(
      {
        dispatcher_id: input.dispatcherId,
        chat_id: input.chatId,
        message_id: input.messageId,
        message_ids: result.messageIds,
      },
      'feishu reply sent',
    );
    if (input.messageId !== undefined) {
      await clearInboundReaction(
        input.dispatcherId,
        slot.bot,
        slot.channelState,
        slot.log,
        input.messageId,
      );
    }
    return { message_ids: result.messageIds };
  }

  async reactFromMcp(input: ServerMcpReactInput): Promise<{ reaction_id: string }> {
    const slot = this.mustRunningSlot(input.dispatcherId);
    if (
      !slot.channelProvider.hasCapability(CHANNEL_CAPABILITY.react) ||
      slot.channelProvider.react === undefined
    ) {
      throw new ChannelCapabilityError(
        slot.channelProvider.ref,
        CHANNEL_CAPABILITY.react,
      );
    }
    let reactionId: string;
    try {
      reactionId = (
        await slot.channelProvider.react(slot.bot, {
          messageId: input.messageId,
          emoji: input.emoji,
        })
      ).reactionId;
    } catch (err) {
      slot.log.error(
        {
          dispatcher_id: input.dispatcherId,
          message_id: input.messageId,
          emoji: input.emoji,
          err: errInfo(err),
        },
        'feishu react failed',
      );
      throw err;
    }
    slot.log.info(
      {
        dispatcher_id: input.dispatcherId,
        message_id: input.messageId,
        emoji: input.emoji,
        reaction_id: reactionId,
      },
      'feishu react sent',
    );
    return { reaction_id: reactionId };
  }

  /**
   * Read-only query of one chat's known + trusted peer bots (issue #69). Backs
   * the model-facing `list_chat_bots` MCP tool. Reads the per-dispatcher
   * chat-bots store directly, so it does not require a running dispatcher slot.
   */
  async listChatBotsFromMcp(
    input: ServerMcpListChatBotsInput,
  ): Promise<ServerMcpListChatBotsResult> {
    const listing = await listChatBots(input.dispatcherId, input.chatId);
    return {
      chat_id: input.chatId,
      known: listing.known.map(toWireChatBot),
      trusted: listing.trusted.map(toWireChatBot),
    };
  }

  /**
   * Compatibility create-only tool (`schedule`): accepts a task into the ledger
   * and returns immediately. It never starts a worker — the executable normal
   * path is {@link runTeamMateTaskFromMcp}. (issue #126.)
   */
  async scheduleTeamMateFromMcp(
    input: ServerMcpScheduleTeamMateInput,
  ): Promise<ServerMcpScheduleTeamMateResult> {
    this.assertTeamMateSchedulingAuthority(input.callerKind);
    const task = await this.teamMateLedger(input.dispatcherId).acceptTask({
      title: input.title,
      prompt: input.prompt,
      callerKind: input.callerKind,
      ...(input.teammateId !== undefined
        ? { teammateId: input.teammateId }
        : {}),
    });
    this.teamMateWaitBroker.notify(input.dispatcherId, task.task_id);
    this.log.info(
      {
        dispatcher_id: input.dispatcherId,
        task_id: task.task_id,
        caller_kind: input.callerKind,
      },
      'teammate task accepted',
    );
    return {
      status: 'accepted',
      task_id: task.task_id,
      dispatcher_id: task.dispatcher_id,
      created_at: task.created_at,
      ...(task.teammate_id !== null ? { teammate_id: task.teammate_id } : {}),
    };
  }

  /**
   * Primary create-and-execute tool (`run_task`, issue #126). Creates a v2 task
   * with a resolved local target, then attempts execution through the worker
   * provider seam. With no worker wired (production MVP) the task is created
   * durably and the execution sub-result reports `provider_unavailable`; an
   * injected worker catalog starts a live session and drives the lifecycle.
   */
  async runTeamMateTaskFromMcp(
    input: ServerMcpRunTeamMateTaskInput,
  ): Promise<ServerMcpRunTeamMateTaskResult> {
    this.assertTeamMateSchedulingAuthority(input.callerKind);
    const target = resolveTeammateTarget(
      input.targetPath,
      this.mustDispatcherDir(input.dispatcherId),
    );
    const accepted = await this.teamMateLedger(input.dispatcherId).acceptTask({
      title: input.title,
      prompt: input.prompt,
      callerKind: input.callerKind,
      target,
      origin: 'dispatcher',
      ...(input.teammateId !== undefined ? { teammateId: input.teammateId } : {}),
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.targetMode !== undefined ? { targetMode: input.targetMode } : {}),
      ...(input.providerRef !== undefined
        ? { providerRef: input.providerRef }
        : {}),
      ...(input.operationId !== undefined
        ? { operationId: input.operationId }
        : {}),
    });
    this.teamMateWaitBroker.notify(input.dispatcherId, accepted.task_id);
    this.log.info(
      {
        dispatcher_id: input.dispatcherId,
        task_id: accepted.task_id,
        caller_kind: input.callerKind,
      },
      'teammate task run requested',
    );
    const execution = await this.teamMateWorkerExecution.execute({
      dispatcherId: input.dispatcherId,
      taskId: accepted.task_id,
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
    });
    return this.teamMateExecutionResult(input.dispatcherId, accepted, execution);
  }

  /**
   * Start or retry execution for an already-accepted task (`execute_task`,
   * issue #126). With no worker wired this returns `provider_unavailable` with
   * the current snapshot (it never fakes a running worker); an injected worker
   * catalog starts/retries a live session.
   */
  async executeTeamMateTaskFromMcp(
    input: ServerMcpExecuteTeamMateTaskInput,
  ): Promise<ServerMcpRunTeamMateTaskResult> {
    const task = await this.teamMateLedger(input.dispatcherId).getTask(
      input.taskId,
    );
    if (task === null) {
      throw new Error(`TeamMate task ${JSON.stringify(input.taskId)} does not exist`);
    }
    const execution = await this.teamMateWorkerExecution.execute({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
    });
    return this.teamMateExecutionResult(input.dispatcherId, task, execution);
  }

  /**
   * Build the `{ task, execution }` wire result. The task summary is re-read so
   * it reflects any lifecycle transition the worker's `onRunning`/terminal
   * callbacks landed during execution; the local target path stays out of it.
   */
  private async teamMateExecutionResult(
    dispatcherId: string,
    fallback: TeamMateTaskRecord,
    execution: TeamMateExecutionOutcome,
  ): Promise<ServerMcpRunTeamMateTaskResult> {
    const latest =
      (await this.teamMateLedger(dispatcherId).getTask(fallback.task_id)) ??
      fallback;
    return {
      task: toTeamMateTaskSummary(latest),
      execution: toExecutionResult(execution),
    };
  }

  /**
   * Record a follow-up input to a steerable task session (`send_input`, issue
   * #126). The default mode is `steer`; without a worker the input is queued in
   * the ledger and waits for a future worker. Returns the new input id and the
   * `after_event_id` cursor for waiting.
   */
  async sendTeamMateInputFromMcp(
    input: ServerMcpSendTeamMateInputInput,
  ): Promise<ServerMcpSendTeamMateInputResult> {
    const ledger = this.teamMateLedger(input.dispatcherId);
    // Record the input durably first (`queued` + an `input_queued` event), so it
    // survives even if no worker is live.
    const { task, input: recorded } = await ledger.appendInput(input.taskId, {
      text: input.prompt,
      mode: input.mode ?? 'steer',
    });
    this.teamMateWaitBroker.notify(input.dispatcherId, task.task_id);
    // Route to a live worker session, if any. An accepted disposition promotes
    // the input to `submitted`; with no live worker it stays `queued`.
    const routed = await this.teamMateWorkerExecution.sendInput({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      inputId: recorded.input_id,
      text: recorded.text,
      mode: recorded.mode,
    });
    let status: 'queued' | 'submitted' = 'queued';
    let latest = task;
    if (routed.delivered && routed.disposition?.status === 'accepted') {
      latest = await ledger.markInputSubmitted(input.taskId, recorded.input_id);
      this.teamMateWaitBroker.notify(input.dispatcherId, input.taskId);
      status = 'submitted';
    }
    return {
      input_id: recorded.input_id,
      mode: recorded.mode,
      status,
      after_event_id: lastEventId(latest),
      task: toTeamMateTaskSummary(latest),
    };
  }

  /**
   * Server-owned bounded wait for a task to reach a terminal state without shell
   * polling (`await_completion`, issue #126). Timeout is a successful
   * `still_running` result with the latest snapshot, never a tool failure. The
   * ledger is the source of truth; the caller resumes with `after_event_id`.
   */
  async awaitTeamMateCompletionFromMcp(
    input: ServerMcpAwaitTeamMateCompletionInput,
  ): Promise<ServerMcpAwaitTeamMateCompletionResult> {
    const ledger = this.teamMateLedger(input.dispatcherId);
    const until = parseWaitUntil(input.until);
    const afterEventId =
      input.afterEventId !== undefined && Number.isFinite(input.afterEventId)
        ? Math.max(0, Math.floor(input.afterEventId))
        : 0;
    const outcome = await awaitTeamMateCompletion(this.teamMateWaitBroker, {
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      afterEventId,
      until,
      timeoutMs: clampWaitTimeout(input.timeoutMs),
      loadTask: () => ledger.getTask(input.taskId),
    });
    if (outcome.status === 'not_found') {
      throw new Error(
        `TeamMate task ${JSON.stringify(input.taskId)} does not exist`,
      );
    }
    if (outcome.status === 'still_running') {
      return {
        status: 'still_running',
        task_id: input.taskId,
        after_event_id: outcome.last_event_id,
        task: toTeamMateTaskSummary(outcome.task),
      };
    }
    const task = outcome.task;
    const status: ServerMcpAwaitTeamMateCompletionResult['status'] =
      task.lifecycle_status === 'completed' ||
      task.lifecycle_status === 'failed' ||
      task.lifecycle_status === 'cancelled'
        ? task.lifecycle_status
        : 'reached';
    return {
      status,
      task_id: input.taskId,
      after_event_id: outcome.last_event_id,
      task: toTeamMateTaskSummary(task),
      result: task.result === null ? null : toTeamMatePullResult(task),
    };
  }

  /**
   * Read-only capability advertisement (`get_capabilities`, issue #126). The
   * worker catalog is the source of truth: each built-in runtime is reported
   * with its worker capability looked up from the catalog (unavailable when the
   * catalog has no worker for it — the production MVP), and any worker provider
   * not also an agent runtime (e.g. an injected fake) is appended. With the
   * default empty catalog, every provider is `worker_available: false` and
   * `execution_available` is false, exactly as PR1.
   */
  getTeamMateCapabilitiesFromMcp(): ServerTeamMateCapabilities {
    const workers = this.teamMateWorkers;
    const workerByRef = new Map(
      workers.list().map((worker) => [worker.ref, worker] as const),
    );
    const providers: ServerTeamMateProviderCapability[] = [];
    const seen = new Set<string>();
    for (const runtime of this.agentRuntimeProviders.list()) {
      providers.push(toProviderCapability(runtime.ref, workerByRef.get(runtime.ref)));
      seen.add(runtime.ref);
    }
    for (const worker of workers.list()) {
      if (seen.has(worker.ref)) continue;
      providers.push(toProviderCapability(worker.ref, worker));
      seen.add(worker.ref);
    }
    return {
      execution_available: workers.hasAvailableProvider(),
      wait: { default_ms: TEAMMATE_WAIT_DEFAULT_MS, max_ms: TEAMMATE_WAIT_MAX_MS },
      target_modes: [...TEAMMATE_TARGET_MODES],
      input_modes: [...TEAMMATE_INPUT_MODES],
      default_input_mode: 'steer',
      providers,
    };
  }

  /**
   * Record a TeamMate task's final result and deliver it into the dispatcher
   * context with bounded retry (issue #110 PR8). The result is persisted before
   * delivery, so a downed runtime ends in `delivery_failed` with the result
   * still pull-able. This is the worker/operator ingest entry — deliberately not
   * a dispatcher-facing MCP tool, so a dispatcher model cannot fake completions.
   */
  async reportTeamMateCompletion(
    input: ServerTeamMateCompletionInput,
  ): Promise<TeamMateDeliveryReport> {
    // The delivery service wakes await_completion waiters via notifyEvent the
    // instant the result is recorded and on each terminal delivery transition.
    return this.teamMateDelivery.reportCompletion({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      outcome: input.outcome,
      finalText: input.finalText,
    });
  }

  /**
   * The scheduling-authority boundary (issue #126). Ordinary TeamMates cannot
   * nested-dispatch; a future Team leader's scheduling authority will be granted
   * here as an explicit role/capability, not by relaxing the ledger backstop.
   */
  private assertTeamMateSchedulingAuthority(
    callerKind: TeamMateScheduleCallerKind,
  ): void {
    if (callerKind === 'teammate') {
      throw new NestedTeamMateDispatchError();
    }
  }

  private mustDispatcherDir(dispatcherId: string): string {
    const dir = this.repos.dispatchers.get(dispatcherId)?.codex_cwd ?? null;
    if (dir === null || dir === '') {
      throw new Error(
        `dispatcher '${dispatcherId}' has no configured working directory; ` +
          'a path target cannot be resolved',
      );
    }
    return dir;
  }

  /** List a dispatcher's TeamMate tasks (corrupt files skipped, not fatal). */
  async listTeamMateTasksFromMcp(
    dispatcherId: string,
  ): Promise<ServerTeamMateTaskSummary[]> {
    const tasks = await this.teamMateLedger(dispatcherId).listTasks({
      onCorrupt: (taskId, err) =>
        this.log.warn(
          { dispatcher_id: dispatcherId, task_id: taskId, err: errInfo(err) },
          'skipping corrupt TeamMate task file',
        ),
    });
    return tasks.map(toTeamMateTaskSummary);
  }

  /** Fetch one TeamMate task in full (fail-loud on a corrupt specific task). */
  async getTeamMateTaskFromMcp(
    dispatcherId: string,
    taskId: string,
  ): Promise<TeamMateTaskRecord | null> {
    return this.teamMateLedger(dispatcherId).getTask(taskId);
  }

  /**
   * Pull a retained TeamMate result — the fallback after push delivery failed.
   * Returns the result for the given task, or the latest result-bearing task
   * when no id is given. Works at `delivery_failed` (the whole point of pull).
   */
  async pullTeamMateResultFromMcp(
    dispatcherId: string,
    taskId?: string,
  ): Promise<ServerTeamMatePullResult | null> {
    const ledger = this.teamMateLedger(dispatcherId);
    const task =
      taskId !== undefined
        ? await ledger.getTask(taskId)
        : await ledger.latestResultTask();
    if (task === null || task.result === null) return null;
    return toTeamMatePullResult(task);
  }

  private dreamuxMcpServerDescriptors(
    channelProvider: ChannelProvider,
    context: { dispatcherId: string; adminSocketPath: string },
  ): AgentRuntimeMcpServer[] {
    return [
      ...channelProvider.mcpServerDescriptors(context),
      teammateMcpServerDescriptor({
        ...context,
        callerKind: 'dispatcher',
      }),
    ];
  }

  private teamMateLedger(dispatcherId: string): TeamMateTaskLedger {
    const existing = this.teamMateLedgers.get(dispatcherId);
    if (existing !== undefined) return existing;
    const created = new TeamMateTaskLedger(dispatcherId);
    this.teamMateLedgers.set(dispatcherId, created);
    return created;
  }

  private mustRunningSlot(id: string): DispatcherSlot {
    const slot = this.slots.get(id);
    if (slot === undefined) {
      throw new Error(`dispatcher '${id}' is not running`);
    }
    return slot;
  }

  /** Summary of every declared dispatcher (config-backed, includes stopped). */
  summarize(): Array<{
    dispatcher_id: string;
    bot_app_id: string;
    status: DispatcherStatus;
    thread_id: string | null;
    enabled: boolean;
  }> {
    return this.repos.dispatchers.list().map((row) => {
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

  /** Graceful shutdown — drain dispatchers and close the admin socket. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info('shutting down');
    // Reap any live TeamMate worker app-servers first so their child processes
    // do not leak past server exit. This is a pure resource release with no
    // ledger transition (issue #126 PR3): an in-flight task stays `running` for
    // the deferred orphan-reconciliation path rather than being force-failed.
    await this.teamMateWorkerExecution.reapAll();
    for (const id of Array.from(this.slots.keys())) {
      await this.stopDispatcher(id);
    }
    if (this.admin !== null) {
      await this.admin.close();
      this.admin = null;
    }
  }
}

function toWireChatBot(bot: PeerBot): WireChatBot {
  return {
    open_id: bot.openId,
    ...(bot.name !== undefined && bot.name !== '' ? { name: bot.name } : {}),
  };
}

function toTeamMateTaskSummary(
  task: TeamMateTaskRecord,
): ServerTeamMateTaskSummary {
  return {
    task_id: task.task_id,
    status: legacyTaskStatus(task),
    lifecycle_status: task.lifecycle_status,
    delivery_status: task.delivery_status,
    title: task.title,
    teammate_id: task.teammate_id,
    provider_ref: task.provider_ref,
    created_at: task.created_at,
    updated_at: task.updated_at,
    last_event_id: lastEventId(task),
    delivery_attempts: task.delivery?.attempts ?? 0,
    has_result: task.result !== null,
  };
}

function toTeamMatePullResult(
  task: TeamMateTaskRecord,
): ServerTeamMatePullResult {
  if (task.result === null) {
    throw new Error(
      `TeamMate task ${JSON.stringify(task.task_id)} has no retained result`,
    );
  }
  return {
    task_id: task.task_id,
    status: legacyTaskStatus(task),
    lifecycle_status: task.lifecycle_status,
    delivery_status: task.delivery_status,
    outcome: task.result.outcome,
    text: task.result.text,
    delivered: task.delivery_status === 'delivered',
    delivery_attempts: task.delivery?.attempts ?? 0,
  };
}

/** Map the execution service outcome onto the public `execution` sub-result. */
function toExecutionResult(
  outcome: TeamMateExecutionOutcome,
): ServerTeamMateExecutionResult {
  if (outcome.status === 'provider_unavailable') {
    return {
      status: 'provider_unavailable',
      reason: outcome.reason,
      code: outcome.code,
      retryable: outcome.retryable,
    };
  }
  return {
    status: outcome.status,
    ...(outcome.provider_ref !== '' ? { provider_ref: outcome.provider_ref } : {}),
  };
}

/**
 * Build a provider capability row for `get_capabilities`. When the catalog has a
 * worker for the ref, its capabilities are reported; otherwise the ref is listed
 * as worker-unavailable (the production MVP for both built-in runtimes).
 */
function toProviderCapability(
  ref: string,
  worker: TeamMateWorkerProvider | undefined,
): ServerTeamMateProviderCapability {
  if (worker === undefined) {
    return {
      provider_ref: ref,
      worker_available: false,
      unsupported_reason:
        'TeamMate worker execution is not implemented yet (issue #126)',
      modes: { steer: false, queue: false, interrupt: false },
      resume: false,
      logs: false,
    };
  }
  const caps = worker.capabilities();
  return {
    provider_ref: ref,
    worker_available: caps.worker_available,
    unsupported_reason: caps.unsupported_reason,
    modes: { ...caps.modes },
    resume: caps.resume,
    logs: caps.logs,
  };
}

/** Validate and default the `await_completion.until` token set (issue #126). */
function parseWaitUntil(until: string[] | undefined): Set<TeamMateWaitToken> {
  if (until === undefined) return new Set(TEAMMATE_WAIT_DEFAULT_UNTIL);
  if (!Array.isArray(until) || until.length === 0) {
    throw new Error('until must be a non-empty array of states');
  }
  const tokens = new Set<TeamMateWaitToken>();
  for (const token of until) {
    if (!isWaitToken(token)) {
      throw new Error(`unsupported await_completion state: ${String(token)}`);
    }
    tokens.add(token);
  }
  return tokens;
}

async function setInboundReaction(
  dispatcherId: string,
  bot: FeishuBot,
  channelState: DispatcherChannelState,
  log: DreamuxLogger,
  input: InboundTurnInput,
  emoji: string,
  state: InboundReactionState,
): Promise<void> {
  const messageId = input.source_message_id;
  if (messageId === null || messageId === '') return;
  if (channelState.pendingReceivedReactionClears.has(messageId)) return;

  const previous = channelState.inboundReactions.get(messageId);

  // Add-then-cancel (issue #69): add the new reaction FIRST so the message
  // never shows zero reactions during the received -> in_progress transition,
  // then cancel the previous one. A failed/empty add keeps the previous
  // reaction and ledger entry rather than leaving the message bare.
  let reactionId: string;
  try {
    reactionId = await bot.addReaction(messageId, emoji);
  } catch (err) {
    log.warn(
      { dispatcher_id: dispatcherId, message_id: messageId, err: errInfo(err) },
      `failed to add the ${state} reaction`,
    );
    return;
  }
  if (reactionId === '') {
    log.warn(
      { dispatcher_id: dispatcherId, message_id: messageId },
      `Feishu returned no reaction_id for the ${state} reaction`,
    );
    return;
  }

  // A reply may have cleared this message while the add was in flight. Remove
  // the just-added reaction and do not store it; the previous reaction was
  // already taken by clearInboundReaction, which read the ledger before any
  // store here. This preserves the reply-wins-the-race guarantee.
  if (channelState.pendingReceivedReactionClears.has(messageId)) {
    try {
      await bot.removeReaction(messageId, reactionId);
    } catch (err) {
      log.warn(
        { dispatcher_id: dispatcherId, message_id: messageId, err: errInfo(err) },
        `failed to clear the late ${state} reaction`,
      );
    }
    return;
  }

  channelState.inboundReactions.set(messageId, {
    chatId: input.source_chat_id,
    reactionId,
    state,
  });

  if (previous !== undefined) {
    try {
      await bot.removeReaction(messageId, previous.reactionId);
    } catch (err) {
      log.warn(
        { dispatcher_id: dispatcherId, message_id: messageId, err: errInfo(err) },
        `failed to replace the ${previous.state} reaction`,
      );
    }
  }
}

async function clearInboundReaction(
  dispatcherId: string,
  bot: FeishuBot,
  channelState: DispatcherChannelState,
  log: DreamuxLogger,
  messageId: string,
): Promise<void> {
  rememberPendingReceivedReactionClear(channelState, messageId);
  const reaction = channelState.inboundReactions.get(messageId);
  if (reaction === undefined) {
    return;
  }
  try {
    await bot.removeReaction(messageId, reaction.reactionId);
    channelState.inboundReactions.delete(messageId);
  } catch (err) {
    log.warn(
      { dispatcher_id: dispatcherId, message_id: messageId, err: errInfo(err) },
      `failed to clear the ${reaction.state} reaction`,
    );
  }
}

/** Compact, redaction-friendly error shape for structured log fields. */
function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}

function rememberPendingReceivedReactionClear(
  channelState: DispatcherChannelState,
  messageId: string,
): void {
  channelState.pendingReceivedReactionClears.add(messageId);
  while (
    channelState.pendingReceivedReactionClears.size >
    MAX_PENDING_RECEIVED_REACTION_CLEARS
  ) {
    const oldest = channelState.pendingReceivedReactionClears.values().next().value;
    if (typeof oldest !== 'string') return;
    channelState.pendingReceivedReactionClears.delete(oldest);
  }
}
