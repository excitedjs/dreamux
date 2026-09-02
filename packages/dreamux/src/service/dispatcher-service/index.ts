import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import {
  adminSocketPath as defaultAdminSocketPath,
  dispatcherCronJobsPath,
  dispatcherDir,
  teamCollectionDir,
  teamMateCollectionDir,
} from '../../platform/paths.js';
import { errorInfo } from '../../platform/error-info.js';
import type { DispatcherRow } from '../../state/dispatcher-store.js';
import { DispatcherTaskDrain } from './inbound-task-drain.js';
import { DispatcherInputSourceLifecycle } from './input-source-lifecycle.js';
import { stopTeamRuntimes } from './team-runtime-stop.js';
import { admittedTeammateOps } from './teammate-ops.js';
import { teamLeaderHandle, type TeamLeaderHandle } from './team-leader-handle.js';
import {
  dispatcherAgentMcpDelegates,
  teamLeaderMcpDelegates,
} from './mcp-delegates.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import { CompletionDeliveryPolicy } from '../completion-router/index.js';
import { TeammateCollection } from '../teammate-collection/index.js';
import type { TeammateOps } from '../teammate-collection/types.js';
import {
  AgentEntityCollectionStore,
  AgentIdentityStore,
  AgentNameRegistry,
} from '../agent-entity/identity-store.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import { AdmissionLedger } from '../teammate-service/admission-ledger.js';
import { SCHEDULED_SOURCE } from '../submission-sources.js';
import { createConversationProjection } from '../../channel/conversation-projection.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeammateSubmitInput } from '../teammate-service/submission.js';
import { WorktreeManager } from '../worktree/manager.js';
import { TeamCollection } from '../team-collection/index.js';
import { SchedulerService } from '../scheduler/service.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { CronJobStore } from '../scheduler/store.js';
import { ChannelService } from '../channel-service/index.js';
import type { ChannelDescriptor } from './channel-descriptor.js';
import { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamDissolveReceipt,
  TeamDissolveRequesterKind,
  TeamHistoryQuery,
} from '../team-collection/types.js';
import type { TeamService } from '../team-service/index.js';
import {
  asInboundDeliveryResult,
  type TurnAdmission,
} from '../teammate-service/turn-recording.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherServiceOptions,
  DispatcherSummary,
  LiveDispatcherRuntimeStatus,
} from './types.js';
import { DispatcherWorkflows } from './dispatcher-workflows.js';
import {
  dispatcherRuntimeStatus,
  dispatcherSummary,
  liveDispatcherRuntimeStatus,
} from './runtime-status.js';

export type { TeamLeaderHandle };

/**
 * One submission the Dispatcher routes to a Team's TeamLeader.
 *
 * The submission itself is already decided by whoever made it — provenance
 * name, display attributes, body, trailing reminder, dedupe key, recovery
 * subject — and is carried through untouched. The Dispatcher adds the recipient
 * and the Core-only completion wiring, and reads none of the model-facing
 * fields. That is why `source` belongs to the caller and not to this method: a
 * Command adapter submits as `channel` because the Command surface is the
 * Channel-facing one, while an Agent's Team MCP `send` submits as `task`
 * because it is one Agent handing work to another. Before the delegate
 * boundary those two had to share one answer; they no longer do.
 *
 * `deliverCompletion` is deliberately not accepted. Who awaits a leader's
 * completion is the Dispatcher's own fact, stated by
 * `deliverCompletionToDispatcher` rather than supplied by a caller.
 */
export interface TeamSubmitRequest
  extends Omit<TeammateSubmitInput, 'deliverCompletion'> {
  teamId: string;
}

export class DispatcherService {
  readonly id: string;
  private readonly log: DreamuxLogger;
  private readonly _teammates: TeammateCollection;
  private readonly teams: TeamCollection;
  private readonly channels: ChannelService;
  private readonly coreEvents: DispatcherCoreEventBus;
  private readonly inputSources: DispatcherInputSourceLifecycle;
  private readonly scheduler_: SchedulerService;
  private restartIntent: RestartIntentConsumer | null = null;
  private stoppingTask: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly admittedTasks: DispatcherTaskDrain;
  private readonly teammateOps: TeammateOps;
  private readonly workflowOwner: DispatcherWorkflows;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.admittedTasks = new DispatcherTaskDrain(
      () => `dispatcher '${this.id}' is shutting down`,
    );
    this.log = opts.log;
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();
    const completionDelivery = new CompletionDeliveryPolicy({
      dispatcherId: opts.id,
      log: opts.log,
    });
    const workflowLog = opts.workflowLoggerFactory?.(opts.id) ?? opts.log;
    const configuredChannelCount =
      opts.config.dispatchers.find((dispatcher) => dispatcher.id === opts.id)
        ?.channels.length ?? 0;
    this.coreEvents = new DispatcherCoreEventBus({
      dispatcherId: opts.id,
      log: opts.log,
      maxSources: configuredChannelCount,
    });

    const worktrees = new WorktreeManager();
    // The dispatcher composition root: every persistence root below is derived
    // once, here, and handed to the owner that keeps it. Nothing further down
    // rebuilds a path from ids, and no identity field ever selects one.
    const dispatcherRoot = dispatcherDir(opts.id);
    const teamMateRoot = teamMateCollectionDir(dispatcherRoot);
    const teamRoot = teamCollectionDir(dispatcherRoot);
    const identities = new AgentIdentityStore({
      dir: dispatcherRoot,
      dispatcherId: opts.id,
      expectedName: null,
      log: opts.log,
      onPersisted: (identity) => this.publishAgentState(identity, 'dispatcher'),
    });
    const teamMateStore = new AgentEntityCollectionStore({
      root: teamMateRoot,
      dispatcherId: opts.id,
      log: opts.log,
      onPersisted: (identity) => this.publishAgentState(identity, 'teammate'),
    });
    const names = new AgentNameRegistry({
      teamMateRoot,
      teamRoot,
      dispatcherId: opts.id,
      log: opts.log,
    });
    // Dispatcher-lifetime, so source dedupe survives an entity service being
    // retired and rematerialized under the same name.
    const admissions = new AdmissionLedger();
    const conversationProjection = createConversationProjection({
      coreEvents: this.coreEvents.publisher,
      log: opts.log,
      homePathPrefixes: opts.homePathPrefixes,
    });

    this.channels = new ChannelService({
      dispatcherId: opts.id,
      config: opts.config,
      channelProviders: opts.channelProviders,
      channelLoggerFactory: opts.channelLoggerFactory,
    });

    this.scheduler_ = new SchedulerService({
      ownerId: opts.id,
      store: new CronJobStore({
        cronJobsPath: dispatcherCronJobsPath(opts.id),
        dispatcherId: opts.id,
      }),
      admit: (task) => this.admitOperation(task),
      submitScheduled: async (input) =>
        asInboundDeliveryResult(
          await this.mustAgent().submitInput({
            source: SCHEDULED_SOURCE,
            text: input.prompt,
            sourceId: input.sourceId,
          }),
        ),
      log: opts.log,
    });

    this._teammates = new TeammateCollection({
      dispatcherId: opts.id,
      teamScope: null,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      store: teamMateStore,
      names,
      admissions,
      conversationProjection,
      completionDelivery,
      // These TeamMates are the dispatcher's own, so their completions go to
      // the dispatcher's Agent. Ownership decides the recipient.
      initiatorFor: () => Promise.resolve(this.mustAgent()),
      log: opts.log,
    });
    this.teammateOps = admittedTeammateOps({
      teammates: this._teammates,
      admit: (task) => this.admitOperation(task),
    });
    this.teams = new TeamCollection({
      dispatcherId: opts.id,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      root: teamRoot,
      names,
      admissions,
      conversationProjection,
      completionDelivery,
      // A TeamLeader reports back to the dispatcher's own Agent; its Team's
      // TeamMates report to that leader, which the Team itself supplies.
      dispatcherCompletionInitiator: () => Promise.resolve(this.mustAgent()),
      admitOperation: (task) => this.admitOperation(task),
      leaderMcp: ({ teamId, leaderName }) => ({
        leases: opts.mcpLeases,
        adminSocketPath: adminSocket,
        delegates: teamLeaderMcpDelegates({
          dispatcherId: opts.id,
          dispatcher: this,
          channels: this.channels,
          channelProviders: opts.channelProviders,
          teamId,
          leaderName,
        }),
      }),
      log: opts.log,
      workflowLog,
      coreEvents: this.coreEvents.publisher,
    });
    this.workflowOwner = new DispatcherWorkflows({
      dispatcherId: opts.id,
      teammates: this._teammates,
      teams: this.teams,
      completionDelivery,
      completionInitiator: () => this.mustAgent(),
      admit: (task) => this.admitOperation(task),
      log: workflowLog,
    });

    this.inputSources = new DispatcherInputSourceLifecycle({
      dispatcherId: opts.id,
      config: opts.config,
      dispatchers: opts.dispatchers,
      channelProviders: opts.channelProviders,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      identities,
      admissions,
      conversationProjection,
      log: opts.log,
      channels: this.channels,
      agentMcp: () => ({
        leases: opts.mcpLeases,
        adminSocketPath: adminSocket,
        delegates: dispatcherAgentMcpDelegates({
          dispatcherId: opts.id,
          dispatcher: this,
          channels: this.channels,
          channelProviders: opts.channelProviders,
        }),
      }),
      commands: opts.commands,
      channelCommands: opts.channelCommands,
      coreEvents: this.coreEvents,
      scheduler: this.scheduler_,
      teams: this.teams,
      teammates: this._teammates,
      admittedTasks: this.admittedTasks,
      workflows: this.workflowOwner,
      isUnavailable: () => this.shuttingDown || this.stoppingTask !== null,
      restartIntent: () => this.restartIntent,
    });
  }

  get scheduler(): SchedulerCommands {
    return this.scheduler_.commands;
  }

  async start(): Promise<void> {
    return this.startInputSources();
  }

  async prepareChannels(): Promise<void> {
    return this.inputSources.prepareChannels();
  }

  async startInputSources(): Promise<void> {
    return this.inputSources.start();
  }

  stop(): Promise<void> {
    if (this.stoppingTask !== null) return this.stoppingTask;
    this.inputSources.closeChannelPortAdmission();
    this.admittedTasks.closeAdmission();
    this.workflowOwner.closeAdmission();
    this.scheduler_.stop();
    this.teams.stopSchedulers();
    // The fence is published before the work behind it starts: stopping reaches
    // back into this aggregate, and a caller it reaches must see the stop
    // already under way rather than begin a second one.
    const task = Promise.resolve()
      .then(() => this.doStop())
      .catch((error: unknown) => {
        this.inputSources.markCleanupPending();
        throw error;
      })
      .finally(() => {
        this.stoppingTask = null;
      });
    this.stoppingTask = task;
    return task;
  }

  /** Publish every aggregate fence synchronously before process-level drain. */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.inputSources.closeChannelPortAdmission();
    this.admittedTasks.closeAdmission();
    this.workflowOwner.closeAdmission();
    this.scheduler_.stop();
    this.teams.stopSchedulers();
  }
  private async doStop(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.scheduler_.stop();
      this.teams.stopSchedulers();
      await collectShutdownFailure(failures, () => this.workflowOwner.stopAll());
      const teamStopError = await stopTeamRuntimes({
        dispatcherId: this.id,
        teams: this.teams,
        log: this.log,
      });
      if (teamStopError !== null) failures.push(teamStopError);
      await stopHostTeammateRuntimes(this._teammates, failures);
      await collectShutdownFailure(failures, async () => {
        await this.inputSources.agent?.stopForHost();
      });
      // Channel/session close and accepted start/work drains may themselves
      // wait on an entity Turn. Release the entity runtimes first so those
      // waits can converge, then drain and repeat the idempotent sweep for any
      // work that was already admitted before the fences.
      //
      // Subscriptions stay attached through the runtime stop above: a runtime
      // settling during shutdown still produces facts a Channel should see.
      // They are revoked once, here, immediately before the sessions holding
      // them are closed.
      this.coreEvents.revokeSources();
      // Everything Core already accepted through a Channel Command settles
      // before the sessions it is running against are closed. The fence itself
      // was published synchronously back in `stop`/`beginShutdown`.
      await collectShutdownFailure(failures, () =>
        this.inputSources.drainChannelCommands());
      await collectShutdownFailure(failures, () =>
        this.channels.closeAll(this.log));
      await collectShutdownFailure(failures, () =>
        this.inputSources.closePreparedChannels());
      this.channels.clear();
      await collectShutdownFailure(failures, () =>
        this.inputSources.waitForSettledStart());
      await collectShutdownFailure(failures, () => this.admittedTasks.drain());
      await collectShutdownFailure(failures, () => this.workflowOwner.stopAll());
      const lateTeamStopError = await stopTeamRuntimes({
        dispatcherId: this.id,
        teams: this.teams,
        log: this.log,
      });
      if (lateTeamStopError !== null) failures.push(lateTeamStopError);
      await stopHostTeammateRuntimes(this._teammates, failures);
      await collectShutdownFailure(failures, async () => {
        await this.inputSources.agent?.stopForHost();
      });
      this.inputSources.markStopped();
      if (failures.length > 0) {
        for (const failure of failures) {
          this.log.error(
            { dispatcher_id: this.id, err: errorInfo(failure) },
            'error stopping dispatcher resource',
          );
        }
      }
    } finally {
      this.inputSources.markStopped();
    }
    throwShutdownFailures(
      failures,
      `multiple resources in dispatcher ${JSON.stringify(this.id)} failed to stop`,
    );
  }

  runtimeStatus(): DispatcherRuntimeStatus {
    return dispatcherRuntimeStatus(this.inputSources.agent);
  }

  /**
   * The non-sensitive read model of this dispatcher's configured Channels.
   *
   * A live aggregate is the only place that knows which Commands are currently
   * registered and how far each session has got, so the read model is asked of
   * it rather than reconstructed from config by a caller.
   */
  channelDescriptors(): ChannelDescriptor[] {
    return this.inputSources.channelDescriptors();
  }

  liveRuntimeStatus(): LiveDispatcherRuntimeStatus | null {
    return liveDispatcherRuntimeStatus(this.inputSources.agent);
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.restartIntent = consumer;
  }

  summary(row: DispatcherRow): DispatcherSummary {
    return dispatcherSummary(row, this.inputSources.agent);
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    await this.stop();
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown || this.stoppingTask !== null) {
      throw new Error(`dispatcher '${this.id}' is shutting down`);
    }
  }

  /**
   * Run one task on behalf of a named TeamLeader.
   *
   * This is the entry a TeamLeader's own MCP delegates dispatch through, and it
   * layers the two fences that matter for that caller: the dispatcher admission
   * gate, and the named Team's own work fence. The runtime-generation lease
   * behind the MCP token already fences a *replaced runtime*, but only the
   * Team's fence refuses a leader's work once that Team is dissolving — so a
   * delegate that reaches a Team object enters it, and one that merely reaches
   * the dispatcher does not.
   */
  runForTeamLeader<T>(teamId: string, task: () => Promise<T>): Promise<T> {
    return this.admitOperation(() => this.teams.admit(teamId, () => task()));
  }

  workspace(): Promise<string> {
    return this._teammates.dispatcherWorkspace();
  }

  get teammates(): TeammateOps {
    return this.teammateOps;
  }

  get workflows() {
    return this.workflowOwner.ops;
  }

  team(teamId: string): Promise<TeamLeaderHandle> {
    return this.admitOperation(async () =>
      teamLeaderHandle({
        teamId: (await this.teams.open(teamId)).id,
        withMutationService: (id, task) =>
          this.admitOperation(() => this.teams.admit(id, task)),
        withReadService: (id, task) => this.teams.read(id, task),
      }),
    );
  }

  teamScheduler(teamId: string) {
    return this.admitOperation(async () =>
      (await this.teams.open(teamId)).scheduler);
  }

  createTeam(input: {
    requestId: string;
    payloadHash: string;
    options: TeamCreateInput;
  }) {
    return this.admitOperation(() => this.teams.createFromRequest(input));
  }

  /**
   * Submit one turn to a Team's TeamLeader.
   *
   * `deliverCompletionToDispatcher` is true when a Core-side caller is waiting
   * for the leader's completion — the reverse-delivery contract the Dispatcher
   * Agent's Team send has always had, stated by that operation itself on the
   * Team MCP delegate. An external Command submission has no Core-side
   * initiator and passes `false`, whichever adapter carried it: the TeamLeader
   * answers on its own Channel instead.
   */
  submitToTeamLeader(
    input: TeamSubmitRequest & { deliverCompletionToDispatcher: boolean },
  ): Promise<TurnAdmission> {
    const { teamId, deliverCompletionToDispatcher, ...submission } = input;
    return this.admitOperation(async () =>
      (await this.teams.open(teamId)).submitToLeader({
        ...submission,
        ...(deliverCompletionToDispatcher
          ? { initiator: this.mustAgent() }
          : {}),
      }),
    );
  }

  /** Submit one turn to this dispatcher's own agent, as its caller stated it. */
  submitToAgent(input: Omit<TeamSubmitRequest, 'teamId'>): Promise<TurnAdmission> {
    return this.admitOperation(() => this.mustAgent().submitInput(input));
  }

  listTeams() {
    return this.teams.list();
  }

  async getTeamStatus(teamId: string) {
    return this.admitOperation(() => this.teams.summary(teamId));
  }

  getTeamHistory(input: TeamHistoryQuery) {
    return this.teams.history(input);
  }

  /**
   * Submit one Team's dissolve.
   *
   * Both entries submit the same operation to the same Team object; they differ
   * only in how the target is established — a Dispatcher names any Team, a
   * TeamLeader reaches only its own. Neither waits for the
   * outcome: once the Team owns the operation the caller has its receipt, and a
   * second submission joins the first instead of dismantling the Team twice.
   */
  private submitDissolve(
    resolve: () => Promise<TeamService>,
    input: {
      note: string;
      force: boolean;
      requester: TeamDissolveRequesterKind;
    },
  ): Promise<TeamDissolveReceipt> {
    return this.admitOperation(async () => (await resolve()).dissolve(input));
  }

  dissolveTeam(input: TeamDissolveInput): Promise<TeamDissolveReceipt> {
    return this.submitDissolve(() => this.teams.open(input.teamId), {
      note: input.note,
      force: input.force === true,
      requester: 'dispatcher',
    });
  }

  dissolveTeamForLeader(input: {
    teamId: string;
    note: string;
    force?: boolean;
  }): Promise<TeamDissolveReceipt> {
    return this.submitDissolve(
      () => this.teams.open(input.teamId),
      {
        note: input.note,
        force: input.force === true,
        requester: 'team_leader',
      },
    );
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
    this.coreEvents.publisher.publish(identity.dispatcher_id, {
      schema_version: 1,
      kind: 'teammate.state',
      occurred_at: identity.updated_at,
      teammate_name: identity.name,
      role,
      team_name: identity.team_id,
      status: identity.status,
    });
  }

  admitOperation<T>(task: () => Promise<T>): Promise<T> {
    return this.admittedTasks.run(async () => {
      this.assertNotShuttingDown();
      return task();
    });
  }

  private mustAgent(): TeammateService {
    const agent = this.inputSources.agent;
    if (agent === null) {
      throw new Error(`dispatcher '${this.id}' agent is not prepared`);
    }
    return agent;
  }
}

/**
 * Release the runtime authority this process took over the dispatcher's own
 * TeamMates.
 *
 * Only entities this process materialized are reached. A durable TeamMate that
 * never ran holds no runtime, no MCP authority, and no accepted turn to
 * converge — materializing one here would make a process stop touch an entity
 * the run never started, and closing it would end a TeamMate nobody closed.
 */
async function stopHostTeammateRuntimes(
  teammates: TeammateCollection,
  failures: unknown[],
): Promise<void> {
  for (const teammate of teammates.materializedEntities()) {
    await collectShutdownFailure(failures, () => teammate.stopForHost());
  }
}
