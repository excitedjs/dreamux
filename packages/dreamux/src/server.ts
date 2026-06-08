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
import { createAdminSocketServer, type AdminSocketServer } from './admin/socket.js';
import { RestartIntentConsumer } from './daemon/restart-intent.js';
import type { ClaudeCodeSessionFactory } from './agent-runtime/builtin/claude-code/supervisor.js';
import { DispatcherService } from './dispatcher-service/service.js';
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
        await this.dispatcherService.startDispatcher(row.dispatcher_id);
      } catch (err) {
        this.log.error(
          { dispatcher_id: row.dispatcher_id, err: errInfo(err) },
          'dispatcher failed to start',
        );
      }
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
