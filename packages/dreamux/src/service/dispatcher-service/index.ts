import type {
  Dispatcher,
  DreamuxLogger,
  LaunchDraft,
  Team,
  TeamCreateParams,
} from '@excitedjs/dreamux-types';
import { AsyncSeriesHook, AsyncSeriesWaterfallHook, SyncHook } from 'tapable';

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
import type { CoreCommandRegistry } from '../../command/types.js';
import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DispatcherConfig } from '../../config/config.js';
import type { ConfigReader } from '../../config/service.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import { configuredDispatcherCwd } from '../dispatcher-workspace.js';
import { DispatcherLifecycle } from './lifecycle.js';
import {
  dispatcherAgentMcpDelegates,
  teamLeaderMcpDelegates,
} from './mcp-delegates.js';
import { CompletionDeliveryPolicy } from '../completion-router/index.js';
import { TeammateCollection } from '../agent/index.js';
import type { TeammateOps } from '../agent/types.js';
import { AgentNameRegistry } from '../agent/store.js';
import type { AgentEntityIdentity } from '../agent/identity.js';
import { AdmissionLedger } from '../agent/admission.js';
import { AgentServiceFactory } from '../agent/factory.js';
import { SCHEDULED_SOURCE } from '../submission-sources.js';
import { createConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import type { AgentService } from '../agent/service.js';
import type { TeammateSubmitInput } from '../agent/submission.js';
import { WorktreeManager } from '../worktree/manager.js';
import { TeamCollection } from '../team/index.js';
import type { TeamsPort } from '../team/teams-port.js';
import { SchedulerService } from '../scheduler/index.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { ChannelService } from '../channel-service/index.js';
import { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import type { TurnAdmission } from '../agent/turn.js';
import type { DispatcherRuntimeStatus } from './types.js';
import {
  WorkflowService,
  type WorkflowOps,
} from '../workflow-service/index.js';
import { DispatcherAgent } from './agent.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';
import type { RestartIntentConsumer } from './restart-intent.js';

/**
 * What `DispatcherService` is constructed from.
 *
 * Declared here rather than in `types.ts`: it names `DispatcherStore` and
 * `McpLeaseRegistry`, both concrete classes, so it is a constructor-options
 * bag rather than a data type.
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
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  /** The process-wide Agent-facing MCP lease registry this dispatcher mints into. */
  mcpLeases: McpLeaseRegistry;
  /**
   * The one restart marker this whole process loaded at boot (issue #78),
   * resolved once by `server.ts` before any `Dispatchers`/`DispatcherService`
   * exists and forwarded unchanged from here on — there is no setter, because
   * a marker loaded after a dispatcher already started could never reach an
   * agent that activates lazily, and R11 removes the only surface
   * (`dispatcher start`) that could have restarted one to pick it up.
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
  workflowLoggerFactory?: ((dispatcherId: string) => DreamuxLogger) | undefined;
  log: DreamuxLogger;
}

export class DispatcherService implements Dispatcher {
  readonly id: string;
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
  private readonly coreEvents: DispatcherCoreEventBus;
  private readonly dispatcherAgent: DispatcherAgent;
  private readonly inputSources: DispatcherLifecycle;
  private readonly scheduler_: SchedulerService;
  private readonly workflowService_: WorkflowService;
  /**
   * Built once, at construction, the same way `DispatcherWorkflows.ops` used
   * to be: `run`/`stop` cross this dispatcher's own admission gate, `status`/
   * `list` answer an inventory read directly (matching `scheduler`'s own
   * `list()`).
   */
  private readonly workflowOps_: WorkflowOps;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
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
      accepting: () => !this.inputSources.isClosing(),
    });
    const workflowLog = opts.workflowLoggerFactory?.(opts.id) ?? opts.log;
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
    const onDispatcherAgentPersisted = (identity: AgentEntityIdentity) =>
      this.publishAgentState(identity, 'dispatcher');
    const names = new AgentNameRegistry({
      teamMateRoot,
      teamRoot,
      dispatcherId: opts.id,
      log: opts.log,
    });
    // Dispatcher-lifetime, so source dedupe survives an entity service being
    // retired and rematerialized under the same name — the factory binds it
    // once, alongside the dispatcher id, for every Agent it builds.
    const agentServiceFactory = new AgentServiceFactory(
      opts.id,
      new AdmissionLedger(),
    );
    const conversationProjection = createConversationProjection({
      coreEvents: this.coreEvents.publisher,
      log: opts.log,
      homePathPrefixes: opts.homePathPrefixes,
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

    this.scheduler_ = new SchedulerService({
      ownerId: opts.id,
      cronJobsPath: dispatcherCronJobsPath(opts.id),
      admit: (task) => this.admitOperation(task),
      submitScheduled: async (input) =>
        this.mustAgent().submitInput({
          source: SCHEDULED_SOURCE,
          text: input.prompt,
          sourceId: input.sourceId,
        }),
      log: opts.log,
    });

    this._teammates = new TeammateCollection({
      dispatcherId: opts.id,
      teamScope: null,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      root: teamMateRoot,
      onPersisted: (identity) => this.publishAgentState(identity, 'teammate'),
      names,
      agentServiceFactory,
      conversationProjection,
      completionDelivery,
      // These TeamMates are the dispatcher's own, so their completions go to
      // the dispatcher's Agent. Ownership decides the recipient.
      initiatorFor: () => Promise.resolve(this.mustAgent()),
      admitOperation: (task) => this.admitOperation(task),
      isClosing: () => this.inputSources.isClosing(),
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
      conversationProjection,
      completionDelivery,
      teammateLaunch: this.hooks.teammateLaunch,
      applyCreateTeamHook: (params) => this.hooks.createTeam.promise(params),
      // A TeamLeader reports back to the dispatcher's own Agent; its Team's
      // TeamMates report to that leader, which the Team itself supplies.
      leaderCompletionInitiator: () => Promise.resolve(this.mustAgent()),
      admitOperation: (task) => this.admitOperation(task),
      isClosing: () => this.inputSources.isClosing(),
      // Every tap and every plugin-added interceptor on `hooks.team` is
      // isolated at hook construction (`isolatedTaps`), so `call` never
      // throws.
      announceTeam: (team, ctx) => this.hooks.team.call(team, ctx),
      leaderMcp: ({ teamId, leaderName }) => ({
        leases: opts.mcpLeases,
        adminSocketPath: adminSocket,
        delegates: teamLeaderMcpDelegates({
          dispatcher: this,
          channels: this.channels,
          teamId,
          leaderName,
        }),
      }),
      log: opts.log,
      workflowLog,
      coreEvents: this.coreEvents.publisher,
    });
    // This dispatcher's own Workflow scope: dispatcher-level runs, reporting
    // to the dispatcher's own Agent. Constructed directly, the same shape
    // `SchedulerService` is built in a few lines above — starting/stopping
    // every Team's own Workflow and scheduler admission
    // (`teams.startAdmissions()`/`stopAdmissions()`) is `DispatcherLifecycle`'s
    // job, called explicitly beside this dispatcher's own admission, not
    // hidden inside a wrapper here.
    this.workflowService_ = new WorkflowService({
      dispatcherId: opts.id,
      teamId: null,
      teammates: {
        createLocked: (spawnInput, options) =>
          this.admitOperation(() =>
            this._teammates.createLocked(spawnInput, options),
          ),
      },
      completionDelivery,
      completionInitiator: () => this.mustAgent(),
      log: workflowLog,
    });
    this.workflowOps_ = {
      run: (input) =>
        this.admitOperation(() => this.workflowService_.run(input)),
      status: (input) => this.workflowService_.status(input),
      stop: (input) =>
        this.admitOperation(() => this.workflowService_.stop(input)),
      list: () => this.workflowService_.list(),
    };

    this.dispatcherAgent = new DispatcherAgent({
      id: opts.id,
      agentRuntime: opts.dispatcher.agentRuntime,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      log: opts.log,
      mcp: () => ({
        leases: opts.mcpLeases,
        adminSocketPath: adminSocket,
        delegates: dispatcherAgentMcpDelegates({
          dispatcher: this,
          channels: this.channels,
        }),
      }),
      onPersisted: onDispatcherAgentPersisted,
      agentServiceFactory,
      conversationProjection,
      launch: this.hooks.launch,
      restartIntent: opts.restartIntent,
    });

    this.inputSources = new DispatcherLifecycle({
      dispatcherId: opts.id,
      config: opts.config,
      dispatchers: opts.dispatchers,
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
   * fences itself on this dispatcher's own `admitOperation` internally, so a
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
   * The one terminal close (R10/R11): no restart, no separate rollback. A
   * failed `start()` reuses this same path, and a second caller joins the
   * close already under way instead of starting another one.
   */
  close(): Promise<void> {
    return this.inputSources.close();
  }

  /** `null` when this dispatcher's agent has not been built yet. */
  liveRuntimeStatus(): DispatcherRuntimeStatus | null {
    return this.dispatcherAgent.status();
  }

  /**
   * This dispatcher's own default workspace directory.
   *
   * Kept here rather than folded away: both the TeamMate and Team Command/MCP
   * surfaces resolve a request's default `cwd` from it when a caller names no
   * explicit path, and it is a dispatcher-level fact neither domain owns.
   */
  workspace(): Promise<string> {
    return this._teammates.dispatcherWorkspace();
  }

  get teammates(): TeammateOps {
    return this._teammates;
  }

  get workflows(): WorkflowOps {
    return this.workflowOps_;
  }

  /** Submit one turn to this dispatcher's own agent, as its caller stated it. */
  submitToAgent(
    input: Omit<TeammateSubmitInput, 'deliverCompletion'>,
  ): Promise<TurnAdmission> {
    return this.admitOperation(() => this.mustAgent().submitInput(input));
  }

  /** Interrupt this dispatcher's own agent. */
  interruptAgent() {
    return this.admitOperation(() => this.mustAgent().interrupt());
  }

  /**
   * Publish one dispatcher-scoped Agent's state.
   *
   * The role is this dispatcher's fact, not the record's: the Agent at the
   * dispatcher root *is* the Dispatcher, and everything in its TeamMate
   * collection is an ordinary TeamMate. Neither belongs to a Team, and
   * `team_id` is read rather than asserted so a mis-scoped record publishes
   * what it actually is instead of what this call assumed.
   */
  private publishAgentState(
    identity: AgentEntityIdentity,
    role: 'dispatcher' | 'teammate',
  ): void {
    this.coreEvents.publisher.publish({
      schemaVersion: 1,
      kind: 'teammate.state',
      occurredAt: identity.updated_at,
      teammateName: identity.name,
      role,
      teamName: identity.team_id,
      status: identity.status,
    });
  }

  admitOperation<T>(task: () => Promise<T>): Promise<T> {
    return this.inputSources.admit(task);
  }

  private mustAgent(): AgentService {
    return this.dispatcherAgent.mustAgent();
  }
}
