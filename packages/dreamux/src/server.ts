/**
 * The dreamux Server — process-level wiring for admin IPC and dispatcher
 * services.
 *
 * Server loads process config, owns the admin socket, and boots the
 * Dispatchers. Dispatcher agent lifecycle, channel sessions, Teams, and
 * teammates live under dispatcher-local services.
 */
import { mustDispatcherId } from './command/host.js';
import type { CoreCommandContext } from './command/types.js';
import type { DispatcherConfig } from './config/config.js';
import type { DispatcherService } from './service/dispatcher-service/index.js';
import { DispatcherNotFoundError } from './service/dispatchers/errors.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  assertNoLegacyAdminServer,
  createAdminSocketServer,
  type AdminSocketServer,
} from './admin/socket.js';
import { AgentRuntimeProviderCatalog } from './agent-runtime/index.js';
import { ChannelProviderCatalog } from './channel/catalog.js';
import { CoreCommandPort } from './command/port.js';
import { dispatcherAgent, type DreamuxConfig } from './config/config.js';
import type { ConfigService } from './config/service.js';
import { resolveHomePathPrefixes } from './platform/home-paths.js';
import { createLogger } from './platform/logger.js';
import { adminSocketPath } from './platform/paths.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from './platform/shutdown-errors.js';
import { createServerHooks, type ServerHooks } from './plugin/host.js';
import { ProviderRegistry } from './registry/index.js';
import { createCoreCommandRegistry } from './server/command-catalog.js';
import type { CoreCommandHost } from './server/command-host.js';
import { RestartIntentConsumer } from './service/dispatcher-service/restart-intent.js';
import { ensureDispatcherWorkspace } from './service/dispatcher-workspace.js';
import { Dispatchers } from './service/index.js';
import { McpLeaseRegistry } from './service/mcp/leases.js';

export interface ServerOptions {
  /**
   * `config.json`'s single in-process authority (opened by the CLI entry
   * point and passed in so user edits, and `config.agents.replace` writes,
   * take effect). Typed as the concrete `ConfigService`, not the narrower
   * `ConfigReader`: the Server exposes this field whole as
   * `CoreCommandHost.config`, which the `config.agents.*` Commands need
   * `readAgents`/`replaceAgents` from, not just `current()`.
   */
  config: ConfigService;
  /** Override admin socket path (tests). */
  adminSocketPath?: string;
  /**
   * Provider registry whose implementations back the runtime + channel catalogs.
   * Production hands in the same registry that `ConfigService.open()`
   * (`config/service.js`) already loaded every referenced builtin/npm provider
   * into; tests either inject the catalogs below or pre-load this registry.
   * Provider implementations belong to this registry; Server never names a
   * provider's native process or transport constructors.
   */
  providerRegistry?: ProviderRegistry;
  /** Override runtime provider catalog (tests / future provider composition). */
  agentRuntimeProviderCatalog?: AgentRuntimeProviderCatalog;
  /**
   * Override channel provider catalog (tests inject a fake `ChannelProvider`;
   * future provider composition). When omitted, the built-in channel catalog is
   * built from the provider registry.
   */
  channelProviderCatalog?: ChannelProviderCatalog;
  /**
   * Server-level logger (admin socket, dispatcher supervision, shutdown). When
   * omitted, a stderr-only logger is used — the CLI entry point injects a
   * file-backed one so tests stay filesystem-free.
   */
  logger?: DreamuxLogger;
  /**
   * Per-dispatcher channel logger factory (gate, inbound, outbound, introduce,
   * dispatcher lifecycle). Called when channel sessions are built, not when a
   * disabled dispatcher is addressed. Defaults to a stderr-only logger; the
   * CLI injects a factory that writes `logs/channel/<id>.log`.
   */
  channelLoggerFactory?: (dispatcherId: string) => DreamuxLogger;
  /** Per-dispatcher Dynamic Workflow lifecycle logger factory. */
  workflowLoggerFactory?: (dispatcherId: string) => DreamuxLogger;
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
  /**
   * Host hooks after `startPlugins`. Omitted by tests and embedded servers
   * without plugins, which get empty hooks.
   */
  hooks?: ServerHooks;
}

export class Server implements CoreCommandHost {
  private dispatchers_: Dispatchers | null = null;
  /**
   * The admitted Command port every adapter resolves against. The process owns
   * the composition; the definitions themselves are owned by their domains, and
   * the unadmitted registry is deliberately not reachable from here.
   */
  readonly commands: CoreCommandPort;
  private admin: AdminSocketServer | null = null;
  private shutdownTask: Promise<void> | null = null;
  private readonly opts: ServerOptions;
  private readonly log: DreamuxLogger;
  private readonly providerRegistry: ProviderRegistry;
  private readonly agentRuntimeProviders: AgentRuntimeProviderCatalog;
  private readonly channelProviders: ChannelProviderCatalog;
  private readonly channelLoggerFactory: (
    dispatcherId: string,
  ) => DreamuxLogger;
  /**
   * The one Agent-facing MCP lease registry for this process.
   *
   * It sits here rather than inside a dispatcher because both ends need it and
   * they meet nowhere lower: dispatchers mint tokens when they launch runtimes,
   * and the MCP transport Commands resolve those tokens with nothing but the
   * token to go on.
   */
  readonly mcpLeases: McpLeaseRegistry;

  /**
   * The server log, for the adapters that answer a failure they do not own. A
   * caller reads its message; the operator needs the whole value behind it, and
   * this is the log that whole is written to.
   */
  get logger(): DreamuxLogger {
    return this.log;
  }

  /** The process dispatcher collection, available after start has resolved host paths. */
  get dispatchers(): Dispatchers {
    if (this.dispatchers_ === null) {
      throw new Error('dreamux server has not started');
    }
    return this.dispatchers_;
  }

  constructor(opts: ServerOptions) {
    this.opts = opts;
    this.providerRegistry = opts.providerRegistry ?? new ProviderRegistry();
    const config = opts.config;
    // The catalogs below are pure registry lookups, so when no runtime catalog is
    // injected every referenced provider implementation must already be loaded
    // (production: the ConfigService.open registry; tests: an injected catalog
    // or a pre-loaded registry). Fail loud at construction, not at dispatcher start.
    if (opts.agentRuntimeProviderCatalog === undefined) {
      assertRuntimeImplementationsLoaded(
        config.current(),
        this.providerRegistry,
      );
    }
    this.log = opts.logger ?? createLogger({ name: 'server' });
    // Built after the logger it records unclassified tool failures through: an
    // Agent reads only the message, so the whole value belongs in this log.
    this.mcpLeases = new McpLeaseRegistry(this.log);
    this.channelLoggerFactory =
      opts.channelLoggerFactory ??
      ((id: string) => createLogger({ name: `channel/${id}` }));
    this.agentRuntimeProviders =
      opts.agentRuntimeProviderCatalog ??
      new AgentRuntimeProviderCatalog({ registry: this.providerRegistry });
    this.channelProviders =
      opts.channelProviderCatalog ??
      new ChannelProviderCatalog({ registry: this.providerRegistry });
    // The Command port is composed before the dispatchers because they hold it:
    // a Channel session invokes Commands through the same admitted port the
    // admin socket does. The host below resolves its targets lazily, so the
    // aggregate it reaches is the one this collection builds on demand.
    this.commands = new CoreCommandPort(createCoreCommandRegistry(this));
  }

  get config(): ConfigService {
    return this.opts.config;
  }

  /** Validate the command address before accessing the collection created by start. */
  addressedDispatcher(context: CoreCommandContext): DispatcherService {
    const id = mustDispatcherId(context);
    this.configuredDispatcher(id);
    return this.dispatchers.get(id);
  }

  configuredDispatcher(id: string): DispatcherConfig {
    const entry = this.config
      .current()
      .dispatchers.find((entry) => entry.id === id);
    if (entry === undefined) throw new DispatcherNotFoundError(id);
    return entry;
  }

  /** Bring up admin socket + all enabled dispatchers. */
  async start(): Promise<void> {
    // The published-conversation projection renames this host's home out of the
    // text it publishes, and the canonical name of that home costs a `realpath`.
    // Resolve it once here so no projected event pays for it, and so the
    // projection itself stays synchronous.
    const homePathPrefixes = await resolveHomePathPrefixes();
    // Loaded before `Dispatchers` exists: nothing between here and its
    // construction needs the collection first, and every `DispatcherService`
    // it builds afterward receives this same consumer as a plain constructor
    // value (there is no setter to reach a dispatcher materialized earlier).
    const restartIntent = await RestartIntentConsumer.load({
      now: Date.now(),
      log: this.log,
    });
    this.dispatchers_ = new Dispatchers({
      config: this.opts.config,
      agentRuntimeProviders: this.agentRuntimeProviders,
      channelProviders: this.channelProviders,
      mcpLeases: this.mcpLeases,
      restartIntent,
      commands: this.commands,
      homePathPrefixes,
      adminSocketPath: this.opts.adminSocketPath ?? adminSocketPath(),
      channelLoggerFactory: this.channelLoggerFactory,
      dispatcherHook: (this.opts.hooks ?? createServerHooks(this.log))
        .dispatcher,
      workflowLoggerFactory: this.opts.workflowLoggerFactory,
      log: this.log,
    });

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
      {
        admin_socket: this.admin.socketPath,
      },
      'admin socket listening',
    );

    if (this.opts.runtimeSocketSweep !== undefined) {
      const swept = await this.opts.runtimeSocketSweep();
      this.log.info({ dirs: swept }, 'swept volatile runtime-socket dirs');
    }

    await this.dispatchers.start();
  }

  /**
   * Validate the workspace cwd of every enabled dispatcher (issue #182 PR-4).
   * Aggregates all failures into one loud error so the operator sees every
   * misconfigured dispatcher at once, rather than fixing them one boot at a
   * time. A throw here aborts `start()` before any socket or dispatcher.
   */
  private async assertDispatcherWorkspaces(): Promise<void> {
    // ensureDispatcherWorkspace is a call-boundary DreamuxConfig consumer, not
    // a capability holder (config/service.ts's ConfigReader doc); this whole
    // preflight loop runs once at boot, before anything could observe a later
    // config.agents.replace, so one resolved value for the loop is correct.
    const config = this.opts.config.current();
    const failures: string[] = [];
    for (const dispatcher of config.dispatchers.filter((d) => d.enabled)) {
      try {
        await ensureDispatcherWorkspace(config, dispatcher.id);
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

  /** Graceful shutdown — drain dispatchers and close the admin socket. */
  async shutdown(): Promise<void> {
    if (this.shutdownTask !== null) return this.shutdownTask;
    this.shutdownTask = this.doShutdown().finally(() => {
      this.shutdownTask = null;
    });
    return this.shutdownTask;
  }

  private async doShutdown(): Promise<void> {
    this.log.info('shutting down');
    const failures: unknown[] = [];
    this.commands.closeAdmission();
    const dispatchers = this.dispatchers_;
    if (dispatchers !== null) {
      await collectShutdownFailure(failures, () => dispatchers.shutdown());
    }
    await collectShutdownFailure(failures, () => this.commands.drain());
    await collectShutdownFailure(failures, async () => {
      if (this.admin === null) return;
      await this.admin.close();
      this.admin = null;
    });
    throwShutdownFailures(failures, 'server shutdown failed');
  }
}

/**
 * Every dispatcher's runtime provider must already have a loaded implementation
 * in `registry` (`config/load.js`'s `readConfigFile`, which both `loadConfig`
 * and `ConfigService.open` run, contributes every built-in through
 * `loadPlugins` and then loads any `npm:`-ref provider through
 * `resolveConfig`'s dynamic path). A descriptor without an implementation — or
 * a ref that does not resolve at all — means the registry was not one that
 * path loaded. Fail loud.
 */
function assertRuntimeImplementationsLoaded(
  config: DreamuxConfig,
  registry: ProviderRegistry,
): void {
  for (const dispatcher of config.dispatchers) {
    const ref = dispatcherAgent(config, dispatcher.id).provider;
    let loaded = false;
    try {
      loaded =
        registry.getImplementation(registry.resolve(ref).id) !== undefined;
    } catch {
      loaded = false;
    }
    if (loaded) continue;
    throw new Error(
      `dispatcher '${dispatcher.id}' uses AgentRuntime provider ` +
        `${JSON.stringify(ref)} whose implementation is not loaded; Server was ` +
        'not constructed with a providerRegistry that loadConfig() or ' +
        'ConfigService.open() already loaded providers into ' +
        '(or an injected agentRuntimeProviderCatalog).',
    );
  }
}
