import { createHash } from 'node:crypto';

import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeStateCallbacks,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
  DreamuxLogger,
  InboundTurnInput,
  TeamMateCompletionDeliveryResult,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

import {
  bundledSkillSourcesForRole,
  DISABLE_FEATURE_USER_INTERRUPT,
  HOST_INJECT_ENV,
  teammateHostPaths,
} from '../../agent-runtime/index.js';
import type { ResolvedAgentConfig } from '../../config/config.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import { resolveAgent } from '../teammate-collection/agent-config.js';
import type { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import {
  assertInRoster,
  foldLastTurns,
  toStatus,
  validateLastTurns,
} from '../teammate-collection/read-helpers.js';
import { TeamMateRuntimeStateStore } from '../teammate-collection/runtime-state.js';
import { recordSettledTurn, recordSubmittedTurn, toTurnResult } from './turn-recording.js';
import type { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import {
  reprepareDeletedManagedWorktree,
} from '../worktree/workspaces.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  requireLifecycleText,
  type CloseTeamMateInput,
  type TeamMateCloseResult,
  type TeamMateIdentity,
  type TeamMateLastResult,
  type TeamMateLaunchPolicy,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateTurnOrigin,
  type TeamMateTurnResult,
  type TeamMateWorktreeIdentity,
} from '../teammate-collection/types.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';

/**
 * The provider-construction inputs a {@link TeammateService} needs to build its
 * runtime, derived per entity (issue #233 Phase 5). It abstracts the one real
 * divergence between a teammate agent and the dispatcher agent: a teammate
 * resolves its runtime config from `agents[].id`, runs in its worktree, and
 * persists state to its identity record; the dispatcher resolves its inline
 * `dispatchers[].runtime`, runs in its validated workspace, and persists state to
 * the authoritative `status.json` store. Everything generic (resume-or-start,
 * `onTurnSettled` → route, `completionInput`) stays in the entity.
 */
export interface RuntimeLaunchSpec {
  provider: AgentRuntimeProvider;
  /** The full create context minus the generic pieces the entity supplies. */
  context: Omit<AgentRuntimeCreateContext, 'onTurnSettled' | 'injectEnv'>;
  /** Runtime-native checkpoint id to resume from, or null for a fresh start. */
  checkpointId: string | null;
}

export interface TeammateServiceDeps {
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
  /**
   * The worktree manager backing `close` (cleanup) and a closed-teammate reopen
   * (reprepare). Omitted only for the dispatcher agent (issue #233 Phase 5),
   * which never closes or reopens, so it never reaches the manager.
   */
  worktrees?: WorktreeManager;
  log: DreamuxLogger;
  /**
   * Build the provider + create context for this entity's runtime (issue #233
   * Phase 5). Omitted for an ordinary teammate, which derives its launch from its
   * own identity record; supplied for the dispatcher agent, whose runtime is
   * built from the dispatcher config and persists to `status.json`.
   */
  buildLaunch?: (
    identity: TeamMateIdentity,
    state: AgentRuntimeStateCallbacks,
  ) => RuntimeLaunchSpec;
  /** Increments per submission across the whole collection so sourceIds stay unique. */
  nextSubmissionSeq: () => number;
  /** Tracks an in-flight settle capture so the collection can drain on shutdown. */
  trackSettleCapture: (capture: Promise<void>) => void;
  /**
   * Route a settled, send-initiated turn's completion to whoever initiated it,
   * via the per-dispatcher `CompletionRouter`. The collection wires this to
   * `router.settle(completionKey(producerName, turnId), envelope)`.
   */
  routeSettledCompletion: (
    producerName: string,
    turnId: string,
    completion: CompletionEnvelope,
  ) => Promise<void>;
}

export interface TeammateServiceOptions {
  /**
   * Role-granted launch additions for THIS entity, fixed at construction. The
   * entity never re-derives this from `identity.role`.
   */
  launchPolicy?: TeamMateLaunchPolicy;
}

/**
 * A single named teammate entity (issue #233): it holds its own identity, its
 * (lazily started) runtime, a per-turn origin cache, and the domain operations
 * `send` / `close` / `status` / `last` / `history` / `channelInput`. It is also a
 * delivery target via `completionInput` — a thin forward into the runtime that
 * the per-dispatcher `CompletionRouter` calls when a member's turn settles.
 *
 * Storage stays in the collection's shared stores; the entity holds references
 * to them rather than owning them (collections remain process-wide in Phase 1).
 */
export class TeammateService {
  private runtime: AgentRuntime | null = null;
  private starting: Promise<void> | null = null;
  private state: TeamMateRuntimeStateStore;
  private readonly launchPolicy: TeamMateLaunchPolicy;

  constructor(
    private readonly deps: TeammateServiceDeps,
    private readonly dispatcherId: string,
    private identity: TeamMateIdentity,
    options: TeammateServiceOptions = {},
  ) {
    this.launchPolicy = options.launchPolicy ?? {
      mcpServers: [],
      disableFeatures: [],
    };
    this.state = new TeamMateRuntimeStateStore(deps.identities, identity);
  }

  get name(): string {
    return this.identity.name;
  }

  current(): TeamMateIdentity {
    return this.state.current();
  }

  getRuntime(): AgentRuntime | null {
    return this.runtime;
  }

  /**
   * Forward a completion envelope into the runtime, the delivery-target side of
   * the reverse path. Thin: the at-most-once policy lives in the
   * `CompletionRouter`, not here. A runtime that is not running or exposes no
   * completion surface reports `unsupported` so the router drops cleanly.
   */
  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult> {
    const runtime = this.runtime;
    if (runtime === null) {
      return { status: 'unsupported', reason: 'teammate runtime not running' };
    }
    const deliver = runtime.completionInput;
    if (deliver === undefined) {
      return {
        status: 'unsupported',
        reason: 'runtime has no completion delivery',
      };
    }
    return deliver.call(runtime, completion);
  }

  /**
   * Submit a prompt, lazily (re)starting the runtime. Returns the turn result and
   * the live identity snapshot; the caller registers the completion key with the
   * router so the settled turn routes back to the initiator.
   */
  async send(
    input: { prompt: string; intent?: string; teamId?: string },
  ): Promise<TeamMateSendResult> {
    await this.ensureStarted({ reopenClosed: true, teamId: input.teamId });
    if (input.intent !== undefined && input.intent !== '') {
      await this.state.updateIntent(input.intent);
    }
    const turn = await this.submitPrompt(input.prompt, {
      teamId: input.teamId,
    });
    await recordSubmittedTurn(this.turnsStore, this.live(), {
      turnId: turn.turn_id ?? null,
      turnOrigin: turnOriginForTeamId(input.teamId),
      prompt: input.prompt,
    });
    return { teammate: this.status(), turn };
  }

  /** Submit the first prompt of a freshly created teammate / leader. */
  async submitInitialPrompt(
    prompt: string,
    opts: { teamId?: string; turnOrigin?: TeamMateTurnOrigin } = {},
  ): Promise<TeamMateTurnResult> {
    const turn = await this.submitPrompt(prompt, { teamId: opts.teamId });
    await recordSubmittedTurn(this.turnsStore, this.live(), {
      turnId: turn.turn_id ?? null,
      turnOrigin: opts.turnOrigin ?? turnOriginForTeamId(opts.teamId),
      prompt,
    });
    return turn;
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    const teamId = this.current().team_id ?? undefined;
    await this.ensureStarted({
      reopenClosed: true,
      ...(teamId !== undefined ? { teamId } : {}),
    });
    const runtime = this.mustRuntime();
    const result = await runtime.channelInput(input);
    if (result.status === 'submitted') {
      await recordSubmittedTurn(this.turnsStore, this.live(), {
        turnId: result.turnId,
        turnOrigin: 'channel',
        prompt: input.text,
      });
    }
    return result;
  }

  async scheduledInput(input: {
    jobId: string;
    prompt: string;
  }): Promise<AgentRuntimeTurnResult> {
    const teamId = this.current().team_id ?? undefined;
    await this.ensureStarted({ ...(teamId !== undefined ? { teamId } : {}) });
    const runtime = this.mustRuntime();
    const result = await runtime.systemInput({
      kind: 'system',
      text: input.prompt,
      reason: 'scheduled',
    });
    if (result.status === 'submitted') {
      await recordSubmittedTurn(this.turnsStore, this.live(), {
        turnId: result.turnId,
        turnOrigin: { kind: 'scheduled', job_id: input.jobId },
        prompt: input.prompt,
      });
    }
    return result;
  }

  async close(input: Pick<CloseTeamMateInput, 'note'>): Promise<TeamMateCloseResult> {
    requireLifecycleText(input.note, 'TeamMate close note');
    await this.stop();
    const identity = this.current();
    // A `team_member` / `team_leader` BORROWS the Team's one shared worktree (a
    // member spawn requires a `sharedWorkspace`, and the leader sits at the team
    // root) — it does not own it. Running `cleanup()` here would
    // `git worktree remove` the live shared dir out from under the leader and
    // every other member; a clean, already-merged shared worktree would actually
    // be deleted. The shared worktree's lifecycle belongs to the Team and is
    // cleaned exactly once at `dissolve`. Only a dispatcher-owned `teammate`
    // cleans its worktree on close.
    const worktree =
      identity.role === 'teammate'
        ? await this.mustWorktrees().cleanup(identity)
        : identity.worktree;
    const closed = await this.deps.identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      lastSeenAt: Date.now(),
      worktree,
    });
    this.identity = closed;
    this.state = new TeamMateRuntimeStateStore(this.deps.identities, closed);
    return { teammate: toStatus(closed, null) };
  }

  /**
   * Sync this entity's persisted worktree to the result of the Team's single
   * authoritative cleanup at `dissolve` (issue #237). A `team_member` /
   * `team_leader` borrows the Team's shared worktree and skips cleanup on its own
   * `close`, so without this its recorded `cleanup_state` would stay
   * `managed-active` after dissolve removed the worktree. dissolve hands every
   * borrower the same identity `WorktreeManager.cleanup()` returned, so the
   * persisted (and displayed, via `status`) state matches reality everywhere.
   */
  async applyWorktreeCleanup(worktree: TeamMateWorktreeIdentity): Promise<void> {
    const identity = this.current();
    // Only a borrowed Team worktree is synced from the Team's dissolve cleanup. A
    // dispatcher-owned `teammate` owns its worktree and updates it on its own
    // `close`; overwriting it from the team result would be wrong, so fail loud.
    if (identity.role !== 'team_leader' && identity.role !== 'team_member') {
      throw new Error(
        `applyWorktreeCleanup is only valid for a team_leader/team_member, not ${JSON.stringify(identity.role)}`,
      );
    }
    const updated = await this.deps.identities.update(identity, { worktree });
    this.identity = updated;
    this.state = new TeamMateRuntimeStateStore(this.deps.identities, updated);
  }

  status(): TeamMateRuntimeStatus {
    return toStatus(this.current(), this.runtime);
  }

  async last(turns?: number): Promise<TeamMateLastResult> {
    const requestedTurns = validateLastTurns(turns);
    const identity = this.current();
    const teammate = toStatus(identity, this.runtime);
    const lastTurns = await foldLastTurns(
      this.turnsStore,
      identity,
      requestedTurns,
    );
    return {
      teammate,
      requested_turns: requestedTurns,
      returned_turns: lastTurns.length,
      turns: lastTurns,
    };
  }

  /** Stop the live runtime if any; leaves the persisted record intact. */
  async stop(): Promise<void> {
    // Await any in-flight start first so we never observe `runtime === null`
    // for a runtime that is about to be assigned (issue #233 concurrency guard).
    if (this.starting !== null) await this.starting.catch(() => {});
    const runtime = this.runtime;
    if (runtime === null) return;
    await runtime.stop();
    this.runtime = null;
  }

  /**
   * Ensure a live runtime, starting or resuming it from the persisted record.
   * Reviving a closed teammate (only when `reopenClosed`) re-prepares a deleted
   * managed worktree and clears the closed markers first.
   *
   * Concurrency guard (issue #233): a single `starting` promise serializes
   * concurrent callers (two `send`/`channelInput`/`spawn` turns that both see
   * `runtime === null`) so the runtime is created exactly once. The roster check
   * runs eagerly on every caller — including those that join an in-flight start —
   * so a wrong-scope caller still fails fast.
   */
  async ensureStarted(
    opts: { reopenClosed?: boolean; teamId?: string } = {},
  ): Promise<void> {
    // The dispatcher agent (injected `buildLaunch`) is not a roster member — it
    // lives at the dispatcher root, outside the teammate/team collections — so
    // the roster guard applies only to ordinary teammates (issue #233 Phase 5).
    if (this.deps.buildLaunch === undefined) {
      assertInRoster(this.current(), this.dispatcherId, opts.teamId);
    }
    if (this.runtime !== null) return;
    if (this.starting !== null) return this.starting;
    const promise = this.startFromRecord(opts).finally(() => {
      this.starting = null;
    });
    this.starting = promise;
    return promise;
  }

  private async startFromRecord(
    opts: { reopenClosed?: boolean; teamId?: string },
  ): Promise<void> {
    let identity = this.current();
    if (identity.status === 'closed') {
      if (opts.reopenClosed !== true) {
        throw new Error(`TeamMate ${JSON.stringify(identity.name)} is closed`);
      }
      identity = await reprepareDeletedManagedWorktree({
        config: this.deps.config,
        identities: this.deps.identities,
        worktrees: this.mustWorktrees(),
        identity,
      });
      identity = await this.deps.identities.update(identity, {
        status: 'starting',
        closedAt: null,
        closeNote: null,
        lastError: null,
      });
      this.identity = identity;
      this.state = new TeamMateRuntimeStateStore(this.deps.identities, identity);
    }
    await this.startRuntime();
  }

  private async startRuntime(): Promise<void> {
    const launch = this.resolveLaunch();
    await this.createAndStart(launch);
  }

  /**
   * Resolve the runtime launch (issue #233 Phase 5). The dispatcher agent injects
   * a `buildLaunch` that builds from the dispatcher config + `status.json` state;
   * an ordinary teammate derives it from its own identity record (config resolved
   * from `agents[].id`, state from its identity store).
   */
  private resolveLaunch(): RuntimeLaunchSpec {
    const identity = this.current();
    if (this.deps.buildLaunch !== undefined) {
      return this.deps.buildLaunch(identity, this.state);
    }
    const agent: ResolvedAgentConfig = resolveAgent(
      this.deps.config,
      this.dispatcherId,
      identity.agent_runtime,
    );
    const provider = this.deps.agentRuntimeProviders.resolve(agent.provider);
    const runtimeName = runtimeIdentityName(identity);
    const launchPolicy = this.launchPolicy;
    return {
      provider,
      checkpointId: identity.session_id,
      context: {
        identity: {
          runtime_id: runtimeId(identity.dispatcher_id, runtimeName),
          checkpoint_id: identity.session_id,
        },
        role: identity.role,
        config: agent.config,
        cwd: identity.cwd,
        skillSources: bundledSkillSourcesForRole(identity.role),
        disableFeatures: launchPolicy.disableFeatures,
        state: this.state,
        paths: teammateHostPaths(identity.dispatcher_id, runtimeName),
        mcpServers: [...launchPolicy.mcpServers],
        logger:
          this.deps.log.child?.({
            dispatcher_id: this.dispatcherId,
            teammate: identity.name,
          }) ?? this.deps.log,
      },
    };
  }

  private async createAndStart(launch: RuntimeLaunchSpec): Promise<void> {
    const resumeCapability = launch.provider.getCapabilities().resume;
    let liveRuntime: AgentRuntime | null = null;
    const runtime = launch.provider.createRuntime({
      ...launch.context,
      injectEnv: HOST_INJECT_ENV,
      // Core-wide rule: every Dreamux agent has the model-facing "ask the user"
      // tool disabled (it would wedge a turn waiting for an out-of-band answer).
      // Role-specific features (e.g. cron) are already on launch.context.
      disableFeatures: [
        DISABLE_FEATURE_USER_INTERRUPT,
        ...(launch.context.disableFeatures ?? []),
      ],
      onTurnSettled: (settled: TurnSettledSignal): void => {
        if (liveRuntime === null) return;
        this.captureSettledTurn(liveRuntime, settled);
      },
    });
    liveRuntime = runtime;
    if (launch.checkpointId !== null && resumeCapability.supported) {
      await runtime.resume({
        checkpoint: {
          kind: resumeCapability.checkpoint,
          id: launch.checkpointId,
        },
      });
    } else {
      await runtime.start();
    }
    this.runtime = runtime;
  }

  private captureSettledTurn(
    runtime: AgentRuntime,
    settled: TurnSettledSignal,
  ): void {
    const capture = this.deliverSettledTurn(runtime, settled);
    this.deps.trackSettleCapture(capture);
  }

  /**
   * The producer side of the reverse path: when this teammate's turn settles,
   * record the settled row and route the completion to whoever initiated the
   * turn. The two lines run with `Promise.allSettled` so the durable record is
   * never gated by, or lost to, delivery.
   */
  private async deliverSettledTurn(
    runtime: AgentRuntime,
    settled: TurnSettledSignal,
  ): Promise<void> {
    const identity = this.current();
    if (settled.turnId === null) {
      this.deps.log.warn(
        {
          dispatcher_id: this.dispatcherId,
          teammate: identity.name,
          status: settled.status,
        },
        'dropping teammate completion: settled turn has no turn id',
      );
      return;
    }
    let result = '';
    try {
      const last = await runtime.getLast();
      result = last?.text ?? '';
    } catch (err) {
      this.deps.log.warn(
        {
          dispatcher_id: this.dispatcherId,
          teammate: identity.name,
          err: errInfo(err),
        },
        'teammate completion getLast failed',
      );
    }
    const envelope: CompletionEnvelope = {
      source: identity.name,
      id: `${identity.name}:${settled.turnId}`,
      status: settled.status,
      result,
    };
    const record = recordSettledTurn(this.turnsStore, this.state, {
      turnId: settled.turnId,
      assistant: result,
      settleStatus: settled.status,
    });
    const route = this.deps.routeSettledCompletion(
      identity.name,
      settled.turnId,
      envelope,
    );
    await Promise.allSettled([record, route]);
  }

  private async submitPrompt(
    prompt: string,
    opts: { teamId?: string } = {},
  ): Promise<TeamMateTurnResult> {
    await this.ensureStarted({ reopenClosed: true, teamId: opts.teamId });
    const runtime = this.mustRuntime();
    const submissionSeq = this.deps.nextSubmissionSeq();
    const result = await runtime.channelInput({
      sourceId: `teammate:${this.name}:${submissionSeq}`,
      text: prompt,
    });
    return toTurnResult(result);
  }

  private get turnsStore(): TeamMateTurnsStore {
    return this.deps.turnsStore;
  }

  private live(): { state: TeamMateRuntimeStateStore } {
    return { state: this.state };
  }

  private mustRuntime(): AgentRuntime {
    const runtime = this.runtime;
    if (runtime === null) {
      throw new Error(`TeamMate ${JSON.stringify(this.name)} is not running`);
    }
    return runtime;
  }

  private mustWorktrees(): WorktreeManager {
    const worktrees = this.deps.worktrees;
    if (worktrees === undefined) {
      throw new Error(
        `agent ${JSON.stringify(this.name)} has no worktree manager`,
      );
    }
    return worktrees;
  }
}

function turnOriginForTeamId(teamId: string | undefined): TeamMateTurnOrigin {
  return teamId === undefined ? 'dispatcher' : 'team_leader';
}

function runtimeId(dispatcherId: string, name: string): string {
  const suffix = createHash('sha256')
    .update(`${dispatcherId} ${name}`)
    .digest('hex')
    .slice(0, 12);
  const prefix = dispatcherId.slice(0, 40);
  return validateDispatcherId(`${prefix}.tm.${suffix}`, 'teammate runtime id');
}

function runtimeIdentityName(identity: TeamMateIdentity): string {
  return identity.team_id !== null
    ? `${identity.team_id}.${identity.name}`
    : identity.name;
}

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
