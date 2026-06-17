import { createHash } from 'node:crypto';

import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeProvider,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
  DreamuxLogger,
  InboundTurnInput,
  TeamMateCompletionDeliveryResult,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

import {
  bundledSkillSourcesForRole,
  HOST_INJECT_ENV,
  teammateHostPaths,
} from '../../agent-runtime/index.js';
import type { ResolvedAgentConfig } from '../../config/config.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import { resolveAgent } from './agent-config.js';
import type { TeamMateIdentityStore } from './identity-store.js';
import type { TeammateReadModel } from './read-model.js';
import { TeamMateRuntimeStateStore } from './runtime-state.js';
import { recordSettledTurn, recordSubmittedTurn, toTurnResult } from './turn-recording.js';
import type { TeamMateTurnsStore } from './turns-store.js';
import {
  reprepareDeletedManagedWorktree,
} from './workspaces.js';
import type { WorktreeManager } from './worktree-manager.js';
import {
  requireLifecycleText,
  type CloseTeamMateInput,
  type TeamMateCloseResult,
  type TeamMateIdentity,
  type TeamMateLastResult,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateTurnOrigin,
  type TeamMateTurnResult,
} from './types.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';

export interface TeammateServiceDeps {
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
  readModel: TeammateReadModel;
  worktrees: WorktreeManager;
  log: DreamuxLogger;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
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

  constructor(
    private readonly deps: TeammateServiceDeps,
    private readonly dispatcherId: string,
    private identity: TeamMateIdentity,
  ) {
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
    await this.ensureStarted({ reopenClosed: true });
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

  async close(input: Pick<CloseTeamMateInput, 'note'>): Promise<TeamMateCloseResult> {
    requireLifecycleText(input.note, 'TeamMate close note');
    await this.stop();
    const closed = await this.deps.identities.update(this.current(), {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      lastSeenAt: Date.now(),
      worktree: await this.deps.worktrees.cleanup(this.current()),
    });
    this.identity = closed;
    this.state = new TeamMateRuntimeStateStore(this.deps.identities, closed);
    return { teammate: this.deps.readModel.toStatus(closed, null) };
  }

  status(): TeamMateRuntimeStatus {
    return this.deps.readModel.toStatus(this.current(), this.runtime);
  }

  last(turns?: number, teamId?: string): Promise<TeamMateLastResult> {
    return this.deps.readModel.last(this.name, turns, teamId);
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
    this.deps.readModel.assertInRoster(this.current(), opts.teamId);
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
        worktrees: this.deps.worktrees,
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
    const identity = this.current();
    const agent = resolveAgent(
      this.deps.config,
      this.dispatcherId,
      identity.agent_runtime,
    );
    const provider = this.deps.agentRuntimeProviders.resolve(agent.provider);
    await this.createAndStart(provider, agent);
  }

  private async createAndStart(
    provider: AgentRuntimeProvider,
    agent: ResolvedAgentConfig,
  ): Promise<void> {
    const identity = this.current();
    const resumeCapability = provider.getCapabilities().resume;
    const runtimeName = runtimeIdentityName(identity);
    const mcpServers =
      this.deps.mcpServersForTeamMate?.({
        dispatcherId: this.dispatcherId,
        name: identity.name,
        identity,
      }) ?? [];
    let liveRuntime: AgentRuntime | null = null;
    const runtime = provider.createRuntime({
      identity: {
        runtime_id: runtimeId(identity.dispatcher_id, runtimeName),
        checkpoint_id: identity.session_id,
      },
      role: identity.role,
      config: agent.config,
      cwd: identity.cwd,
      skillSources: bundledSkillSourcesForRole(identity.role),
      state: this.state,
      paths: teammateHostPaths(identity.dispatcher_id, runtimeName),
      injectEnv: HOST_INJECT_ENV,
      mcpServers: [...mcpServers],
      onTurnSettled: (settled: TurnSettledSignal): void => {
        if (liveRuntime === null) return;
        this.captureSettledTurn(liveRuntime, settled);
      },
      logger:
        this.deps.log.child?.({
          dispatcher_id: this.dispatcherId,
          teammate: identity.name,
        }) ?? this.deps.log,
    });
    liveRuntime = runtime;
    if (identity.session_id !== null && resumeCapability.supported) {
      await runtime.resume({
        checkpoint: {
          kind: resumeCapability.checkpoint,
          id: identity.session_id,
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
