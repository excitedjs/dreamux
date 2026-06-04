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

import { DispatcherRuntime } from './dispatcher/runtime.js';
import type { InboundTurnInput } from './dispatcher/turn-manager.js';
import type { CodexProcess, CodexProcessOptions } from './codex/supervisor.js';
import type { CodexWsClient } from './codex/rpc.js';
import {
  channelOutboundToFeishuTarget,
  createFeishuBot,
  type FeishuBot,
  type FeishuInboundEvent,
} from './feishu/bot.js';
import {
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
} from './channel/feishu-gate.js';
import { formatFeishuMessageForCodex } from './channel/feishu-message.js';
import { parseCodexArgs, codexArgsToCli } from './runtime/codex-args.js';
import { feishuMcpCodexArgs } from './codex/mcp-config.js';
import { resolveBotSecret } from './runtime/secrets.js';
import { BUILT_IN_DEFAULTS, type DreamuxConfig } from './runtime/config.js';
import {
  DispatcherStore,
  type DispatcherRow,
  type DispatcherStatus,
} from './runtime/dispatcher-store.js';
import type { DispatcherCodexHomeDoctor } from './runtime/dispatcher-codex-home.js';
import {
  adminSocketPath,
  dispatcherCodexCwd,
  setRuntimeConfig,
} from './runtime/paths.js';
import { createAdminSocketServer, type AdminSocketServer } from './admin/socket.js';

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
}

export interface Repos {
  dispatchers: DispatcherStore;
}

interface DispatcherSlot {
  row: DispatcherRow;
  runtime: DispatcherRuntime;
  bot: FeishuBot;
  channelState: DispatcherChannelState;
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

export class Server {
  readonly repos: Repos;
  private readonly slots = new Map<string, DispatcherSlot>();
  /**
   * PR #3 review #4: in-flight startDispatcher promises, keyed by id.
   * Two concurrent callers must await the same start, not race to spawn
   * duplicate Codex children / Feishu listeners.
   */
  private readonly starting = new Map<string, Promise<void>>();
  private admin: AdminSocketServer | null = null;
  private shuttingDown = false;
  private readonly opts: ServerOptions;

  constructor(opts: ServerOptions = {}) {
    this.opts = opts;
    // Install the config snapshot before any paths.* / runtime.* lookup
    // happens. paths.runtimeRoot / adminSocketPath / etc. consult this
    // snapshot for non-env defaults (env vars still win).
    setRuntimeConfig(opts.config ?? BUILT_IN_DEFAULTS);
    this.repos = {
      dispatchers: new DispatcherStore(opts.config ?? BUILT_IN_DEFAULTS),
    };
  }

  /** Effective config (caller-supplied or built-in defaults). */
  private effectiveConfig(): DreamuxConfig {
    return this.opts.config ?? BUILT_IN_DEFAULTS;
  }

  /**
   * Final codex binary path. Precedence:
   *   1. ServerOptions.codexBinPath (test seam)
   *   2. CODEX_HOST_CODEX_BIN env (CI / debug escape hatch)
   *   3. config.codex.bin (~/.dreamux/config.json)
   *   4. 'codex' (PATH lookup)
   */
  private resolveCodexBinPath(): string | undefined {
    if (this.opts.codexBinPath !== undefined) return this.opts.codexBinPath;
    const fromEnv = process.env['CODEX_HOST_CODEX_BIN'];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    const fromConfig = this.effectiveConfig().codex.bin;
    return fromConfig === '' ? undefined : fromConfig;
  }

  /** Bring up admin socket + all enabled dispatchers. */
  async start(): Promise<void> {
    this.admin = createAdminSocketServer(
      this,
      this.opts.adminSocketPath ?? adminSocketPath(),
    );
    await this.admin.start();
    console.error(`[server] admin socket listening at ${this.admin.socketPath}`);

    const rows = this.repos.dispatchers.listEnabled();
    for (const row of rows) {
      try {
        await this.startDispatcher(row.dispatcher_id);
      } catch (err) {
        console.error(
          `[server] dispatcher '${row.dispatcher_id}' failed to start:`,
          err,
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
    const codexArgs = parseCodexArgs(row.codex_args_json, {
      approvalPolicy: cfg.codex.approval_policy,
      sandboxMode: cfg.codex.sandbox_mode,
      extraArgs: cfg.codex.extra_args,
    });
    const codexCliArgs = [
      ...codexArgsToCli(codexArgs),
      ...feishuMcpCodexArgs({
        dispatcherId: id,
        adminSocketPath: this.opts.adminSocketPath ?? adminSocketPath(),
      }),
    ];
    const botSecret = this.opts.skipBotSecret
      ? ''
      : resolveBotSecret(row.bot_secret_ref, cfg);
    const bot = this.opts.botFactory
      ? this.opts.botFactory(row, botSecret)
      : createFeishuBot({ appId: row.bot_app_id, appSecret: botSecret });
    const channelState: DispatcherChannelState = {
      inboundReactions: new Map(),
      pendingReceivedReactionClears: new Set(),
    };

    const runtime = new DispatcherRuntime(row, {
      dispatchers: this.repos.dispatchers,
      codexBinPath: this.resolveCodexBinPath(),
      codexProcessFactory: this.opts.codexProcessFactory,
      codexClientFactory: this.opts.codexClientFactory,
      codexHomeDoctor: this.opts.codexHomeDoctor,
      resolveExtraArgs: () => codexCliArgs,
      handshakeTimeoutMs: cfg.codex.initialize_timeout_ms,
      extraEnv: dispatcherConfig?.codex.extra_env ?? {},
      restartBackoffBaseMs: this.opts.codexRestartBackoffBaseMs,
      restartBackoffMaxMs: this.opts.codexRestartBackoffMaxMs,
    });

    try {
      await runtime.start();
      await bot.start(async (event: FeishuInboundEvent) => {
        const access = loadDispatcherAccess(id);
        const gate = dreamuxFeishuGate({
          senderId: event.senderId,
          senderType: event.senderType,
          chatId: event.chatId,
          chatType: event.chatType,
          mentions: event.mentions,
          botOpenId: bot.botOpenId,
        }, access);
        saveDispatcherAccess(id, gate.access);
        if (gate.warning !== null) {
          console.error(
            `[server] trust-domain warning for dispatcher '${id}': ${gate.warning}`,
          );
        }
        if (gate.action === 'drop') {
          console.error(
            `[server] dropped feishu inbound for dispatcher '${id}': ${gate.reason}`,
          );
          return;
        }
        const input: InboundTurnInput = {
          source_chat_id: event.chatId,
          source_message_id: event.messageId,
          sender_id: event.senderId,
          parsed_text: formatFeishuMessageForCodex(event),
        };
        const delivery = await runtime.enqueueInbound(input, {
          onAccepted: async (acceptedInput) => {
            await setInboundReaction(
              id,
              bot,
              channelState,
              acceptedInput,
              RECEIVED_REACTION_EMOJI,
              'received',
            );
          },
        });
        if (delivery.status === 'submitted') {
          await setInboundReaction(
            id,
            bot,
            channelState,
            input,
            IN_PROGRESS_REACTION_EMOJI,
            'in_progress',
          );
        } else if (delivery.status === 'failed') {
          console.error(
            `[server] failed to submit Feishu inbound for dispatcher '${id}': ${delivery.error.message}`,
          );
        }
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

    this.slots.set(id, { row, runtime, bot, channelState });
    console.error(
      `[server] dispatcher '${id}' is ready (bot=${row.bot_app_id} cwd=${row.codex_cwd ?? dispatcherCodexCwd(id)})`,
    );
  }

  /** Gracefully stop one dispatcher. Idempotent. */
  async stopDispatcher(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    try {
      await slot.bot.close();
    } catch (err) {
      console.error(`[server] error closing bot for '${id}':`, err);
    }
    try {
      await slot.runtime.stop();
    } catch (err) {
      console.error(`[server] error stopping dispatcher '${id}':`, err);
    }
    this.slots.delete(id);
  }

  getRuntime(id: string): DispatcherRuntime | null {
    return this.slots.get(id)?.runtime ?? null;
  }

  async replyFromMcp(input: ServerMcpReplyInput): Promise<{ message_ids: string[] }> {
    const slot = this.mustRunningSlot(input.dispatcherId);
    const result = await slot.bot.send(
      channelOutboundToFeishuTarget({
        conversationId: input.chatId,
        ...(input.messageId !== undefined ? { replyTo: input.messageId } : {}),
        ...(input.mentionUserIds !== undefined
          ? { mentionUsers: input.mentionUserIds }
          : {}),
      }),
      input.text,
    );
    if (input.messageId !== undefined) {
      await clearInboundReaction(
        input.dispatcherId,
        slot.bot,
        slot.channelState,
        input.messageId,
      );
    }
    return { message_ids: result.messageIds };
  }

  async reactFromMcp(input: ServerMcpReactInput): Promise<{ reaction_id: string }> {
    const slot = this.mustRunningSlot(input.dispatcherId);
    const reactionId = await slot.bot.addReaction(input.messageId, input.emoji);
    return { reaction_id: reactionId };
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
    console.error('[server] shutting down...');
    for (const id of Array.from(this.slots.keys())) {
      await this.stopDispatcher(id);
    }
    if (this.admin !== null) {
      await this.admin.close();
      this.admin = null;
    }
  }
}

async function setInboundReaction(
  dispatcherId: string,
  bot: FeishuBot,
  channelState: DispatcherChannelState,
  input: InboundTurnInput,
  emoji: string,
  state: InboundReactionState,
): Promise<void> {
  const messageId = input.source_message_id;
  if (messageId === null || messageId === '') return;
  if (channelState.pendingReceivedReactionClears.has(messageId)) return;

  const previous = channelState.inboundReactions.get(messageId);
  if (previous !== undefined) {
    try {
      await bot.removeReaction(messageId, previous.reactionId);
    } catch (err) {
      console.error(
        `[server] failed to replace the ${previous.state} reaction for dispatcher '${dispatcherId}' message '${messageId}':`,
        err,
      );
    }
    channelState.inboundReactions.delete(messageId);
  }
  if (channelState.pendingReceivedReactionClears.has(messageId)) return;

  try {
    const reactionId = await bot.addReaction(messageId, emoji);
    if (reactionId === '') {
      console.error(
        `[server] Feishu returned no reaction_id for the ${state} reaction in dispatcher '${dispatcherId}'`,
      );
      return;
    }
    if (channelState.pendingReceivedReactionClears.has(messageId)) {
      try {
        await bot.removeReaction(messageId, reactionId);
      } catch (err) {
        console.error(
          `[server] failed to clear the late ${state} reaction for dispatcher '${dispatcherId}' message '${messageId}':`,
          err,
        );
      }
      return;
    }
    channelState.inboundReactions.set(messageId, {
      chatId: input.source_chat_id,
      reactionId,
      state,
    });
  } catch (err) {
    console.error(
      `[server] failed to add the ${state} reaction for dispatcher '${dispatcherId}':`,
      err,
    );
  }
}

async function clearInboundReaction(
  dispatcherId: string,
  bot: FeishuBot,
  channelState: DispatcherChannelState,
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
    console.error(
      `[server] failed to clear the ${reaction.state} reaction for dispatcher '${dispatcherId}' message '${messageId}':`,
      err,
    );
  }
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
