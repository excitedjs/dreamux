/**
 * The dreamux Server — the long-running Node process that hosts N dispatchers.
 *
 * Lifecycle:
 *   1. open SQLite (migrate if needed)
 *   2. open admin Unix socket (so server-ctl can talk to us even if a
 *      dispatcher fails to come up)
 *   3. for each enabled dispatcher: spawn codex, open feishu, start turn worker
 *   4. install SIGTERM/SIGINT handlers for graceful drain
 *
 * Issue #2 §"D1": crash recovery does NOT replay running turns. Per dispatcher,
 * the runtime's startup sweep flips stale `running` → `unknown` before
 * Feishu inbound is opened, so the user gets a visible prompt instead of a
 * silent duplicate turn.
 */

import type Database from 'better-sqlite3';

import { openDatabase } from './db/schema.js';
import { DispatcherRepo, InboundRepo } from './db/repository.js';
import type { DispatcherRow, DispatcherStatus } from './db/types.js';
import { DispatcherRuntime } from './dispatcher/runtime.js';
import type { CodexProcess, CodexProcessOptions } from './codex/supervisor.js';
import type { CodexWsClient } from './codex/rpc.js';
import {
  channelOutboundToFeishuTarget,
  createFeishuBot,
  type FeishuBot,
  type FeishuInboundEvent,
} from './feishu/bot.js';
import { compatibleFeishuGate } from './channel/feishu-gate.js';
import { parseCodexArgs, codexArgsToCli } from './runtime/codex-args.js';
import { resolveBotSecret } from './runtime/secrets.js';
import { BUILT_IN_DEFAULTS, type DreamuxConfig } from './runtime/config.js';
import type { DispatcherCodexHomeDoctor } from './runtime/dispatcher-codex-home.js';
import {
  adminSocketPath,
  databasePath,
  dispatcherCodexCwd,
  setRuntimeConfig,
} from './runtime/paths.js';
import { createAdminSocketServer, type AdminSocketServer } from './admin/socket.js';

export interface ServerOptions {
  /**
   * Global dreamux config (typically loaded from ~/.dreamux/config.json by
   * the CLI entry point). When omitted, the built-in defaults are used —
   * convenient for tests, but in production the CLI is expected to load
   * the file and pass it in so user edits take effect.
   */
  config?: DreamuxConfig;
  /** Override database path (tests). */
  databasePath?: string;
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
}

export interface Repos {
  dispatchers: DispatcherRepo;
  inbound: InboundRepo;
}

interface DispatcherSlot {
  row: DispatcherRow;
  runtime: DispatcherRuntime;
  bot: FeishuBot;
}

export class Server {
  readonly repos: Repos;
  private readonly db: Database.Database;
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
    this.db = openDatabase({ path: opts.databasePath ?? databasePath() });
    this.repos = {
      dispatchers: new DispatcherRepo(this.db),
      inbound: new InboundRepo(this.db),
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
    const codexArgs = parseCodexArgs(row.codex_args_json, {
      approvalPolicy: cfg.codex.approval_policy,
      sandboxMode: cfg.codex.sandbox_mode,
      extraArgs: cfg.codex.extra_args,
    });
    const botSecret = this.opts.skipBotSecret
      ? ''
      : resolveBotSecret(row.bot_secret_ref, cfg);
    const bot = this.opts.botFactory
      ? this.opts.botFactory(row, botSecret)
      : createFeishuBot({ appId: row.bot_app_id, appSecret: botSecret });

    const runtime = new DispatcherRuntime(row, {
      dispatchers: this.repos.dispatchers,
      inbound: this.repos.inbound,
      outbound: {
        send: async (target, text) =>
          (await bot.send(channelOutboundToFeishuTarget(target), text)).messageIds,
      },
      codexBinPath: this.resolveCodexBinPath(),
      codexProcessFactory: this.opts.codexProcessFactory,
      codexClientFactory: this.opts.codexClientFactory,
      codexHomeDoctor: this.opts.codexHomeDoctor,
      resolveExtraArgs: () => codexArgsToCli(codexArgs),
      handshakeTimeoutMs: cfg.codex.initialize_timeout_ms,
      outboundRetries: cfg.outbound.retries,
      outboundRetryDelayMs: cfg.outbound.retry_delay_ms,
    });

    try {
      await runtime.start();
      await bot.start(async (event: FeishuInboundEvent) => {
        const gate = compatibleFeishuGate({
          senderId: event.senderId,
          senderType: event.senderType,
          chatType: event.chatType,
          botOpenId: bot.botOpenId,
        });
        if (gate.action === 'drop') {
          console.error(
            `[server] dropped feishu inbound for dispatcher '${id}': ${gate.reason}`,
          );
          return;
        }
        runtime.enqueueInbound({
          source_chat_id: event.chatId,
          source_message_id: event.messageId,
          sender_id: event.senderId,
          feishu_event_json: safeStringify(event.raw),
          parsed_text: event.parsedText,
        });
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

    this.slots.set(id, { row, runtime, bot });
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

  /** Summary of every declared dispatcher (DB-backed, includes stopped). */
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

  /** Graceful shutdown — drain dispatchers, close socket, close DB. */
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
    try {
      this.db.close();
    } catch (err) {
      console.error('[server] db close error:', err);
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}
