import type {
  Dispatcher,
  DreamuxLogger,
  LaunchDraft,
  Team,
  TeamCreateParams,
} from '@excitedjs/dreamux-types';
import { AsyncSeriesHook, AsyncSeriesWaterfallHook, SyncHook } from 'tapable';
import { WorkFence } from '../../platform/work-fence.js';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/catalog.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { CoreCommandRegistry } from '../../command/types.js';
import type { DispatcherConfig } from '../../config/config.js';
import type { ConfigReader } from '../../config/service.js';
import {
  adminSocketPath as defaultAdminSocketPath,
  dispatcherCronJobsPath,
  dispatcherDir,
  teamCollectionDir,
  teamMateCollectionDir,
} from '../../platform/paths.js';
import {
  isolatedTaps,
  launchDraftTaps,
  waterfallTaps,
} from '../../plugin/hooks.js';
import { AgentServiceFactory } from '../agent/factory.js';
import { TeammateCollection } from '../agent/index.js';
import { AgentNameRegistry } from '../agent/store.js';
import type { TeammateSubmitInput } from '../agent/submission.js';
import type { TurnAdmission } from '../agent/turn.js';
import type { TeammateOps } from '../agent/types.js';
import { ChannelService } from '../channel-service/index.js';
import { CompletionDeliveryPolicy } from '../completion-router/index.js';
import { createConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import {
  configuredDispatcherCwd,
  ensureDispatcherWorkspace,
} from '../dispatcher-workspace.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';
import { SchedulerService } from '../scheduler/index.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { TeamCollection } from '../team/index.js';
import type { TeamsPort } from '../team/teams-port.js';
import {
  WorkflowService,
  type WorkflowOps,
} from '../workflow-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import { DispatcherAgent } from './agent.js';
import { DispatcherLifecycle } from './lifecycle.js';
import type { RestartIntentConsumer } from './restart-intent.js';

/**
 * What `DispatcherService` is constructed from.
 *
 * Declared here rather than in `types.ts`: it names `McpLeaseRegistry`, a
 * concrete class, so it is a constructor-options bag rather than a data type.
 */
export interface DispatcherServiceOptions {
  id: string;
  /**
   * This dispatcher's own config entry, resolved once by
   * `Dispatchers.dispatcherOptions()` instead of re-derived independently
   * here, by `ChannelService`, and by `DispatcherLifecycle` from
   * the same live `config.current().dispatchers.find(...)` lookup.
   */
  dispatcher: DispatcherConfig;
  config: ConfigReader;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  /** The process-wide Agent-facing MCP lease registry this dispatcher mints into. */
  mcpLeases: McpLeaseRegistry;
  /**
   * The one restart marker this whole process loaded at boot (issue #78),
   * resolved once by `server.ts` before any `Dispatchers`/`DispatcherService`
   * exists and forwarded unchanged from here on — there is no setter, because
   * a marker loaded after a dispatcher already started could never reach an
   * agent that activates lazily, and the one surface that could have
   * restarted one to pick it up, `dispatcher start`, no longer exists.
   */
  restartIntent: RestartIntentConsumer;
  /**
   * The process-wide admitted Command port. This dispatcher's Channel sessions
   * invoke Commands through it, so they share the admin socket's catalog,
   * validation, and shutdown fence rather than getting a second surface.
   */
  commands: CoreCommandRegistry;
  /** Host home prefixes resolved by Server before this aggregate is built. */
  homePathPrefixes: readonly string[];
  adminSocketPath?: string | undefined;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  workflowLog: DreamuxLogger;
  log: DreamuxLogger;
}

export class DispatcherService implements Dispatcher {
  readonly id: string;
  readonly fence: WorkFence;
  readonly cwd: string;
  readonly hooks: Dispatcher['hooks'];
  private readonly _teammates: TeammateCollection;
  private readonly _teams: TeamCollection;
  /**
   * The dispatcher's whole channel lifecycle, exposed directly: every verb
   * (`build`/`initialize`/`start`/`closeAdmission`/`closeAll`/`list`/
   * `mcpDelegates`) already reads the facts this class holds, so a caller
   * reaches `ChannelService` itself rather than a forwarding method per verb.
   */
  readonly channels: ChannelService;
  /**
   * This dispatcher's one agent owner, exposed directly, the same shape
   * `channels`/`teams`/`teammates`/`scheduler` already use on this class:
   * a caller reaches `mustAgent()`/`status()` on it itself rather than
   * through a forwarding method per verb.
   */
  readonly dispatcherAgent: DispatcherAgent;
  private readonly coreEvents: DispatcherCoreEventBus;
  private readonly configReader: ConfigReader;
  private readonly inputSources: DispatcherLifecycle;
  private readonly scheduler_: SchedulerService;
  private readonly workflowService_: WorkflowService;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.fence = new WorkFence(opts.id);
    this.configReader = opts.config;
    // `dispatchers[]` is never touched by `config.agents.replace`, so this
    // construction-time resolve is fixed for the dispatcher's whole
    // lifetime; the capability itself (`opts.config`) still forwards live to
    // every child that holds it across more than this constructor call.
    // `opts.dispatcher` is this same dispatcher's own entry, already
    // resolved once by `Dispatchers.dispatcherOptions()`.
    const config = opts.config.current();
    this.cwd = configuredDispatcherCwd(config, opts.id);
    this.hooks = Object.freeze({
      launch: launchDraftTaps(
        new AsyncSeriesHook<[LaunchDraft]>(['draft'], 'launch'),
        opts.log,
      ),
      teammateLaunch: launchDraftTaps(
        new AsyncSeriesHook<[LaunchDraft, Readonly<{ teamId: string | null }>]>(
          ['draft', 'context'],
          'teammateLaunch',
        ),
        opts.log,
      ),
      createTeam: waterfallTaps(
        new AsyncSeriesWaterfallHook<[TeamCreateParams]>(
          ['params'],
          'createTeam',
        ),
        opts.log,
      ),
      team: isolatedTaps(
        new SyncHook<[Team, { readonly origin: 'create' | 'rebuild' }]>(
          ['team', 'ctx'],
          'team',
        ),
        opts.log,
      ),
    });
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();
    const completionDelivery = new CompletionDeliveryPolicy({
      dispatcherId: opts.id,
      log: opts.log,
      fence: this.fence,
    });
    const workflowLog = opts.workflowLog;
    this.coreEvents = new DispatcherCoreEventBus({
      dispatcherId: opts.id,
      log: opts.log,
    });

    const worktrees = new WorktreeManager();
    // The dispatcher composition root: every persistence root below is derived
    // once, here, and handed to the owner that keeps it. Nothing further down
    // rebuilds a path from ids, and no identity field ever selects one.
    const dispatcherRoot = dispatcherDir(opts.id);
    const teamMateRoot = teamMateCollectionDir(dispatcherRoot);
    const teamRoot = teamCollectionDir(dispatcherRoot);
    const names = new AgentNameRegistry({
      teamMateRoot,
      teamRoot,
      dispatcherId: opts.id,
      log: opts.log,
    });
    const conversationProjection = createConversationProjection({
      coreEvents: this.coreEvents,
      log: opts.log,
      homePathPrefixes: opts.homePathPrefixes,
    });
    const agentServiceFactory = new AgentServiceFactory(opts.id, {
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      conversationProjection,
      completionDelivery,
      coreEvents: this.coreEvents,
      worktrees,
      log: opts.log,
    });

    this.channels = new ChannelService({
      dispatcherId: opts.id,
      dispatcher: opts.dispatcher,
      channelProviders: opts.channelProviders,
      channelLoggerFactory: opts.channelLoggerFactory,
      coreEvents: this.coreEvents,
      commands: opts.commands,
      log: opts.log,
    });

    this.dispatcherAgent = new DispatcherAgent({
      id: opts.id,
      agentRuntime: opts.dispatcher.agentRuntime,
      log: opts.log,
      dispatcher: this,
      channels: this.channels,
      mcp: { leases: opts.mcpLeases, adminSocketPath: adminSocket },
      agentServiceFactory,
      launch: this.hooks.launch,
      restartIntent: opts.restartIntent,
    });

    this.scheduler_ = new SchedulerService({
      ownerId: opts.id,
      cronJobsPath: dispatcherCronJobsPath(opts.id),
      fence: this.fence,
      recipient: this.dispatcherAgent,
      log: opts.log,
    });

    this._teammates = new TeammateCollection({
      dispatcherId: opts.id,
      teamScope: null,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      root: teamMateRoot,
      names,
      agentServiceFactory,
      // These TeamMates are the dispatcher's own, so their completions go to
      // the dispatcher's Agent. Ownership decides the recipient.
      completionOwner: this.dispatcherAgent,
      fence: this.fence,
      teammateLaunch: this.hooks.teammateLaunch,
      log: opts.log,
    });
    this._teams = new TeamCollection({
      dispatcherId: opts.id,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      root: teamRoot,
      names,
      agentServiceFactory,
      completionDelivery,
      dispatcherHooks: this.hooks,
      completionOwner: this.dispatcherAgent,
      fence: this.fence,
      mcp: {
        leases: opts.mcpLeases,
        adminSocketPath: adminSocket,
        channels: this.channels,
      },
      log: opts.log,
      workflowLog,
      coreEvents: this.coreEvents,
    });
    // This dispatcher's own Workflow scope: dispatcher-level runs, reporting
    // to the dispatcher's own Agent. Constructed directly, the same shape
    // `SchedulerService` is built in a few lines above — `admit` composes
    // this dispatcher's own admission gate, the same fence `scheduler_`
    // above is given, so `run`/`status`/`stop`/`list` fence themselves.
    // Starting/stopping every Team's own Workflow and scheduler admission
    // (`teams.startAdmissions()`/`stopAdmissions()`) is `DispatcherLifecycle`'s
    // job, called explicitly beside this dispatcher's own admission, not
    // hidden inside a wrapper here.
    this.workflowService_ = new WorkflowService({
      dispatcherId: opts.id,
      teamId: null,
      teammates: this._teammates,
      completionDelivery,
      completionOwner: this.dispatcherAgent,
      fence: this.fence,
      log: workflowLog,
    });

    this.inputSources = new DispatcherLifecycle({
      fence: this.fence,
      dispatcherId: opts.id,
      config: opts.config,
      dispatcher: opts.dispatcher,
      log: opts.log,
      channels: this.channels,
      dispatcherAgent: this.dispatcherAgent,
      scheduler: this.scheduler_,
      teams: this._teams,
      teammates: this._teammates,
      workflows: this.workflowService_,
    });
  }

  get scheduler(): SchedulerCommands {
    return this.scheduler_;
  }

  /**
   * The dispatcher-facing per-Team surface: every `TeamsPort` verb already
   * fences itself on this dispatcher's own work fence internally, so a
   * caller reaches `TeamCollection` through this one narrow port rather than
   * a forwarding method per verb.
   */
  get teams(): TeamsPort {
    return this._teams;
  }

  async start(): Promise<void> {
    return this.inputSources.start();
  }

  /**
   * The one terminal close: no restart, no separate rollback. A
   * failed `start()` reuses this same path, and a second caller joins the
   * close already under way instead of starting another one.
   */
  close(): Promise<void> {
    return this.inputSources.close();
  }

  /**
   * This dispatcher's own default workspace directory.
   *
   * Kept here rather than folded away: both the TeamMate and Team Command/MCP
   * surfaces resolve a request's default `cwd` from it when a caller names no
   * explicit path, and it is a dispatcher-level fact neither domain owns.
   */
  workspace(): Promise<string> {
    return ensureDispatcherWorkspace(this.configReader.current(), this.id);
  }

  get teammates(): TeammateOps {
    return this._teammates;
  }

  get workflows(): WorkflowOps {
    return this.workflowService_;
  }

  /** Submit one turn to this dispatcher's own agent, as its caller stated it. */
  submitToAgent(
    input: Omit<TeammateSubmitInput, 'completionRecipient'>,
  ): Promise<TurnAdmission> {
    return this.fence.admit(() =>
      this.dispatcherAgent.mustAgent().submitInput(input),
    );
  }

  /** Interrupt this dispatcher's own agent. */
  interruptAgent() {
    return this.fence.admit(() => this.dispatcherAgent.mustAgent().interrupt());
  }
}
