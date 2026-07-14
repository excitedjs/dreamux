/**
 * The dreamux Server — process-level wiring for admin IPC and dispatcher
 * services.
 *
 * Server loads process config, owns the admin socket, and boots the
 * Dispatchers. Dispatcher agent lifecycle, channel sessions, Teams, and
 * teammates live under dispatcher-local services.
 */

import { AgentRuntimeProviderCatalog } from './agent-runtime/index.js';
import { ChannelProviderCatalog } from './channel/catalog.js';
import {
  createBuiltinProviderRegistry,
  type ProviderRegistry,
} from './registry/index.js';
import {
  BUILT_IN_DEFAULTS,
  type DreamuxConfig,
} from './config/config.js';
import { DispatcherStore } from './state/dispatcher-store.js';
import {
  adminSocketPath,
  dispatcherCronJobsPath,
  dispatcherTeamCronJobsPath,
  setRuntimeConfig,
} from './platform/paths.js';
import { createLogger } from './platform/logger.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  assertNoLegacyAdminServer,
  createAdminSocketServer,
  type AdminSocketServer,
} from './admin/socket.js';
import { AdminError } from './admin/protocol.js';
import { RestartIntentConsumer } from './daemon/restart-intent.js';
import {
  Dispatchers,
  type DispatcherService,
} from './service/index.js';
import { ensureDispatcherWorkspace } from './service/dispatcher-workspace.js';
import {
  detectLegacyDispatcherState,
  legacyDispatcherStateMessage,
} from './service/legacy-state.js';
import { detectAmbiguousV2ChannelBindingRoutes } from './service/channel-binding/preflight.js';
import { detectLegacyChannelBindingStore } from './service/channel-binding/store.js';
import { detectLegacyCronJobStore } from './service/scheduler/store.js';
import { TeamStore } from './service/team-collection/store.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from './service/shutdown-errors.js';

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
  /**
   * Provider registry whose implementations back the runtime + channel catalogs.
   * Production hands in the registry returned by loadConfig() (every referenced
   * builtin/npm provider already loaded); tests either inject the catalogs below
   * or pre-load this registry. Provider-specific construction seams (codex
   * process/client factories, etc.) belong to the provider package and are
   * injected by pre-loading the registry, never by Server — core names no
   * provider's internals.
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
   * dispatcher lifecycle). Defaults to a stderr-only logger per dispatcher; the
   * CLI injects a factory that writes `logs/channel/<id>.log`.
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
  readonly dispatchers: Dispatchers;
  private admin: AdminSocketServer | null = null;
  private shutdownTask: Promise<void> | null = null;
  private acceptingAdminRequests = true;
  private readonly adminRequests = new Set<Promise<unknown>>();
  private readonly opts: ServerOptions;
  private readonly log: DreamuxLogger;
  private readonly providerRegistry: ProviderRegistry;
  private readonly agentRuntimeProviders: AgentRuntimeProviderCatalog;
  private readonly channelProviders: ChannelProviderCatalog;

  constructor(opts: ServerOptions = {}) {
    this.opts = opts;
    this.providerRegistry =
      opts.providerRegistry ?? createBuiltinProviderRegistry();
    const config = opts.config ?? BUILT_IN_DEFAULTS;
    // The catalogs below are pure registry lookups, so when no runtime catalog is
    // injected every referenced provider implementation must already be loaded
    // (production: the loadConfig registry; tests: an injected catalog or a
    // pre-loaded registry). Fail loud at construction, not at dispatcher start.
    if (opts.agentRuntimeProviderCatalog === undefined) {
      assertRuntimeImplementationsLoaded(config, this.providerRegistry);
    }
    setRuntimeConfig(config);
    this.log = opts.logger ?? createLogger({ name: 'server' });
    const channelLoggerFactory =
      opts.channelLoggerFactory ??
      ((id: string) => createLogger({ name: `channel/${id}` }));
    this.agentRuntimeProviders =
      opts.agentRuntimeProviderCatalog ??
      new AgentRuntimeProviderCatalog({ registry: this.providerRegistry });
    this.channelProviders =
      opts.channelProviderCatalog ??
      new ChannelProviderCatalog({ registry: this.providerRegistry });
    this.repos = {
      dispatchers: new DispatcherStore(config),
    };
    this.dispatchers = new Dispatchers({
      config,
      dispatchers: this.repos.dispatchers,
      agentRuntimeProviders: this.agentRuntimeProviders,
      channelProviders: this.channelProviders,
      adminSocketPath: opts.adminSocketPath ?? adminSocketPath(),
      channelLoggerFactory,
      log: this.log,
    });
  }

  /** Bring up admin socket + all enabled dispatchers. */
  async start(): Promise<void> {
    this.dispatchers.setRestartIntent(
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

    // Pre-#199 local state contract (issue #199 Slice 5): a leftover session
    // ledger / identities dir / Team audit ledger from an earlier layout is a
    // hard upgrade blocker — 0.x does not migrate it. Aggregate every
    // dispatcher's findings and fail the whole start loud before launching.
    await this.assertNoLegacyDispatcherState();

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
      try {
        const swept = await this.opts.runtimeSocketSweep();
        this.log.info({ dirs: swept }, 'swept volatile runtime-socket dirs');
      } catch (err) {
        this.log.warn(
          {
            err: errInfo(err),
          },
          'runtime-socket sweep failed; continuing startup',
        );
      }
    }

    const rows = this.repos.dispatchers.listEnabled();
    for (const row of rows) {
      try {
        await this.getDispatcher(row.dispatcher_id).start();
      } catch (err) {
        this.log.error(
          {
            dispatcher_id: row.dispatcher_id,
            err: errInfo(err),
          },
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

  /**
   * Fail loud when any dispatcher still has pre-#199 local state (issue #199
   * Slice 5). Detection only — the legacy paths are never read for migration,
   * rewritten, or removed; the operator deletes them and lets the current layout
   * rebuild. Aggregated like the workspace contract so every stale dispatcher is
   * reported at once.
   */
  private async assertNoLegacyDispatcherState(): Promise<void> {
    const messages: string[] = [];
    for (const row of this.repos.dispatchers.list()) {
      const findings = await detectLegacyDispatcherState(row.dispatcher_id);
      if (findings.length > 0) {
        messages.push(legacyDispatcherStateMessage(row.dispatcher_id, findings));
      }
      // Issue #209 binding store v3: incompatible channel-binding state fails
      // loud at boot with rebuild guidance, not lazily on first inbound.
      const bindingLegacy = await detectLegacyChannelBindingStore(row.dispatcher_id);
      if (bindingLegacy !== null) {
        messages.push(bindingLegacy);
      } else {
        const ambiguousBinding = await detectAmbiguousV2ChannelBindingRoutes(
          row.dispatcher_id,
        );
        if (ambiguousBinding !== null) messages.push(ambiguousBinding);
      }
      messages.push(...(await detectLegacyCronStores(row.dispatcher_id)));
    }
    if (messages.length > 0) {
      throw new Error(
        `dreamux serve cannot start — incompatible local state found:\n${messages.join('\n')}`,
      );
    }
  }

  summarize() {
    return this.dispatchers.summarize();
  }

  getDispatcher(id: string): DispatcherService {
    return this.dispatchers.get(id);
  }

  admitAdminRequest<T>(task: () => Promise<T> | T): Promise<T> {
    if (!this.acceptingAdminRequests) {
      throw new AdminError(
        'SERVER_SHUTTING_DOWN',
        'dreamux server is shutting down',
      );
    }
    const promise = Promise.resolve().then(task);
    this.adminRequests.add(promise);
    void promise.finally(() => {
      this.adminRequests.delete(promise);
    }).catch(() => {});
    return promise;
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
    this.acceptingAdminRequests = false;
    await collectShutdownFailure(failures, () => this.drainAdminRequests());
    await collectShutdownFailure(failures, () => this.dispatchers.shutdown());
    await collectShutdownFailure(failures, async () => {
      if (this.admin === null) return;
      await this.admin.close();
      this.admin = null;
    });
    throwShutdownFailures(failures, 'server shutdown failed');
  }

  private async drainAdminRequests(): Promise<void> {
    while (this.adminRequests.size > 0) {
      await Promise.allSettled([...this.adminRequests]);
    }
  }
}

async function detectLegacyCronStores(dispatcherId: string): Promise<string[]> {
  const messages: string[] = [];
  const dispatcherCron = await detectLegacyCronJobStore(
    dispatcherCronJobsPath(dispatcherId),
    dispatcherId,
  );
  if (dispatcherCron !== null) messages.push(dispatcherCron);
  for (const team of await new TeamStore().list(dispatcherId)) {
    if (team.status === 'closed') continue;
    const teamCron = await detectLegacyCronJobStore(
      dispatcherTeamCronJobsPath(dispatcherId, team.team_id),
      dispatcherId,
    );
    if (teamCron !== null) messages.push(teamCron);
  }
  return messages;
}

/**
 * Every dispatcher's runtime provider must already have a loaded implementation
 * in `registry` (builtin and npm alike load through loadConfig's single dynamic
 * path). A descriptor without an implementation — or a ref that does not resolve
 * at all — means the registry was not the one loadConfig returned. Fail loud.
 */
function assertRuntimeImplementationsLoaded(
  config: DreamuxConfig,
  registry: ProviderRegistry,
): void {
  for (const dispatcher of config.dispatchers) {
    const ref = dispatcher.runtime.provider;
    let loaded = false;
    try {
      loaded = registry.getImplementation(registry.resolve(ref).id) !== undefined;
    } catch {
      loaded = false;
    }
    if (loaded) continue;
    throw new Error(
      `dispatcher '${dispatcher.id}' uses AgentRuntime provider ` +
        `${JSON.stringify(ref)} whose implementation is not loaded; Server was ` +
        'not constructed with the providerRegistry returned by loadConfig() ' +
        '(or an injected agentRuntimeProviderCatalog).',
    );
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
