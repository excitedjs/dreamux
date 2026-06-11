/**
 * The dreamux Server — process-level wiring for admin IPC and dispatcher
 * services.
 *
 * Server loads process config, owns the admin socket, and boots the
 * DispatcherService. Dispatcher agent lifecycle, Feishu channel sessions, and
 * TeamMate agents live under DispatcherService.
 */

import {
  createBuiltinAgentRuntimeProviderCatalog,
  type AgentRuntimeProviderCatalog,
} from './agent-runtime/index.js';
import type { CodexProcess, CodexProcessOptions } from './agent-runtime/builtin/codex/supervisor.js';
import type { CodexWsClient } from './agent-runtime/builtin/codex/rpc.js';
import type { FeishuBot } from './channel/feishu/bot.js';
import {
  createBuiltinProviderRegistry,
  parseProviderRef,
  type ProviderRegistry,
} from './registry/index.js';
import {
  BUILT_IN_DEFAULTS,
  type DreamuxConfig,
} from './config/config.js';
import {
  DispatcherStore,
  type DispatcherRow,
} from './state/dispatcher-store.js';
import type { DispatcherCodexHomeDoctor } from './agent-runtime/builtin/codex/codex-home.js';
import {
  adminSocketPath,
  setRuntimeConfig,
} from './platform/paths.js';
import {
  createLogger,
  type DreamuxLogger,
} from './platform/logger.js';
import {
  assertNoLegacyAdminServer,
  createAdminSocketServer,
  type AdminSocketServer,
} from './admin/socket.js';
import { RestartIntentConsumer } from './daemon/restart-intent.js';
import type { ClaudeCodeSessionFactory } from './agent-runtime/builtin/claude-code/supervisor.js';
import { DispatcherService } from './dispatcher-service/service.js';
import { ensureDispatcherWorkspace } from './dispatcher-service/dispatcher-workspace.js';
export {
  IN_PROGRESS_REACTION_EMOJI,
  RECEIVED_REACTION_EMOJI,
} from './channel/feishu/feishu-channel.js';

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
   * Provider registry used by runtime composition. When config contains
   * external npm Agent Runtime refs, this must be the registry returned by
   * loadConfig() after external provider loading.
   */
  providerRegistry?: ProviderRegistry;
  /** Inject a CodexProcess factory (tests). */
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  /** Inject a CodexWsClient factory (tests). */
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  /** Inject a Codex home doctor (tests). */
  codexHomeDoctor?: DispatcherCodexHomeDoctor;
  /** Inject a Claude Code resident-session factory for tests. */
  claudeCodeWorkerSessionFactory?: ClaudeCodeSessionFactory;
  /** Skip resolving bot secret (tests with fake bot). */
  skipBotSecret?: boolean;
  /** Codex child/WS restart backoff base override (tests). */
  codexRestartBackoffBaseMs?: number;
  /** Codex child/WS restart backoff cap override (tests). */
  codexRestartBackoffMaxMs?: number;
  /** Override runtime provider catalog (tests / future provider composition). */
  agentRuntimeProviderCatalog?: AgentRuntimeProviderCatalog;
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
  /**
   * Optional sweep of the volatile runtime-socket dirs (issue #182), run once
   * after the admin-socket lock is held (single-server guarantee — every
   * leftover socket is a dead crash orphan) and before any dispatcher starts.
   * The CLI injects the real `sweepRuntimeSocketDirs`; tests and embedded
   * servers omit it so they never touch the operator's run root. Returns the
   * swept directories for logging.
   */
  runtimeSocketSweep?: () => Promise<string[]>;
  /**
   * Pre-#182 admin lock path probed before binding the new admin socket, to
   * detect a still-running OLD-version server (issue #182 PR-1, PR #183 review
   * P1). The CLI injects the real legacy path (`state/admin.sock.lock`); tests
   * and embedded servers omit it (skip the check) so they never read the
   * operator's real state dir. Detection only — never removed or migrated.
   */
  legacyAdminLockPath?: string | null;
}

export interface Repos {
  dispatchers: DispatcherStore;
}

export class Server {
  readonly repos: Repos;
  readonly dispatcherService: DispatcherService;
  private admin: AdminSocketServer | null = null;
  private shuttingDown = false;
  private readonly opts: ServerOptions;
  private readonly log: DreamuxLogger;
  private readonly providerRegistry: ProviderRegistry;
  private readonly agentRuntimeProviders: AgentRuntimeProviderCatalog;

  constructor(opts: ServerOptions = {}) {
    this.opts = opts;
    this.providerRegistry =
      opts.providerRegistry ?? createBuiltinProviderRegistry();
    const config = opts.config ?? BUILT_IN_DEFAULTS;
    if (
      opts.providerRegistry === undefined &&
      opts.agentRuntimeProviderCatalog === undefined
    ) {
      assertNoExternalRuntimeConfigWithoutRegistry(config);
    }
    setRuntimeConfig(config);
    this.log = opts.logger ?? createLogger({ name: 'server' });
    const channelLoggerFactory =
      opts.channelLoggerFactory ??
      ((id: string) => createLogger({ name: `channel/${id}` }));
    const codexProviderOptions = {
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
        registry: this.providerRegistry,
        codex: codexProviderOptions,
        ...(opts.claudeCodeWorkerSessionFactory !== undefined
          ? { claudeCode: { sessionFactory: opts.claudeCodeWorkerSessionFactory } }
          : {}),
      });
    this.repos = {
      dispatchers: new DispatcherStore(config),
    };
    this.dispatcherService = new DispatcherService({
      config,
      dispatchers: this.repos.dispatchers,
      agentRuntimeProviders: this.agentRuntimeProviders,
      adminSocketPath: opts.adminSocketPath ?? adminSocketPath(),
      botFactory: opts.botFactory,
      skipBotSecret: opts.skipBotSecret,
      channelLoggerFactory,
      log: this.log,
    });
  }

  /** Bring up admin socket + all enabled dispatchers. */
  async start(): Promise<void> {
    await this.repos.dispatchers.hydrate((message) => this.log.warn(message));
    this.dispatcherService.setRestartIntent(
      await RestartIntentConsumer.load({
        now: Date.now(),
        warn: (message) => this.log.warn(message),
      }),
    );

    // Dispatcher workspace cwd contract (issue #182 PR-4): every enabled
    // dispatcher must declare an explicit, usable `cwd` — there is no fallback
    // to a Dreamux state dir. Pre-flight all of them before taking the admin
    // lock or launching anything, and fail the whole start loud (aggregated) so
    // a misconfigured deployment never comes up half-broken.
    await this.assertDispatcherWorkspaces();

    // Before taking the new run/ admin lock, fail loud if an OLD-version
    // server still holds the pre-#182 state/ admin lock — the two locks are at
    // different paths and would not otherwise see each other (issue #182 P1).
    if (this.opts.legacyAdminLockPath != null) {
      await assertNoLegacyAdminServer({
        legacyLockPath: this.opts.legacyAdminLockPath,
      });
    }

    this.admin = createAdminSocketServer(
      this,
      this.opts.adminSocketPath ?? adminSocketPath(),
    );
    await this.admin.start();
    this.log.info(
      { admin_socket: this.admin.socketPath },
      'admin socket listening',
    );

    if (this.opts.runtimeSocketSweep !== undefined) {
      try {
        const swept = await this.opts.runtimeSocketSweep();
        this.log.info({ dirs: swept }, 'swept volatile runtime-socket dirs');
      } catch (err) {
        this.log.warn(
          { err: errInfo(err) },
          'runtime-socket sweep failed; continuing startup',
        );
      }
    }

    const rows = this.repos.dispatchers.listEnabled();
    for (const row of rows) {
      try {
        await this.dispatcherService.startDispatcher(row.dispatcher_id);
      } catch (err) {
        this.log.error(
          { dispatcher_id: row.dispatcher_id, err: errInfo(err) },
          'dispatcher failed to start',
        );
      }
    }
  }

  /**
   * Validate the workspace cwd of every enabled dispatcher (issue #182 PR-4).
   * Aggregates all failures into one loud error so the operator sees every
   * misconfigured dispatcher at once, rather than fixing them one boot at a
   * time. A throw here aborts `start()` before any socket or dispatcher.
   */
  private async assertDispatcherWorkspaces(): Promise<void> {
    const config = this.opts.config ?? BUILT_IN_DEFAULTS;
    const failures: string[] = [];
    for (const row of this.repos.dispatchers.listEnabled()) {
      try {
        await ensureDispatcherWorkspace(config, row.dispatcher_id);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `dreamux serve cannot start — dispatcher workspace cwd contract failed:\n` +
          failures.map((message) => `  - ${message}`).join('\n'),
      );
    }
  }

  summarize() {
    return this.dispatcherService.summarize();
  }

  /** Graceful shutdown — drain dispatchers and close the admin socket. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info('shutting down');
    await this.dispatcherService.shutdown();
    if (this.admin !== null) {
      await this.admin.close();
      this.admin = null;
    }
  }
}

function assertNoExternalRuntimeConfigWithoutRegistry(config: DreamuxConfig): void {
  const dispatcher = config.dispatchers.find(
    (item) => parseProviderRef(item.runtime.provider).source === 'npm',
  );
  if (dispatcher === undefined) return;
  throw new Error(
    `dispatcher '${dispatcher.id}' uses external AgentRuntime provider ` +
      `${JSON.stringify(dispatcher.runtime.provider)}, but Server was not ` +
      'constructed with the providerRegistry returned by loadConfig()',
  );
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
