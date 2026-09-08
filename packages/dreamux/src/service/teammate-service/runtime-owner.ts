import type {
  AgentRuntime,
  AgentRuntimeActivitySink,
  AgentRuntimeCreateContext,
  AgentRuntimeInterruptOutcome,
  AgentRuntimeMcpServer,
  AgentRuntimeProvider,
  AgentRuntimeStartOutcome,
  AgentRuntimeStatus,
} from '@excitedjs/dreamux-types';

import {
  DISABLE_FEATURE_USER_INTERRUPT,
  HOST_INJECT_ENV,
  hostRuntimePaths,
} from '../../agent-runtime/index.js';
import type { ResolvedAgentConfig } from '../../config/config.js';
import { resolveAgent } from '../agent-entity/agent-config.js';
import type {
  AgentRuntimeGenerationLease,
  AgentRuntimeStateStore,
} from '../agent-entity/runtime-state.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import {
  assertUniqueMcpServerNames,
  mcpServerDescriptor,
} from '../mcp/descriptor.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { reprepareDeletedManagedWorktree } from '../worktree/workspaces.js';
import type { TeammateServiceDeps, TeammateServiceOptions } from './types.js';

interface RuntimeLaunchSpec {
  provider: AgentRuntimeProvider<unknown>;
  context: Omit<AgentRuntimeCreateContext<unknown>, 'injectEnv'>;
}

interface TeammateRuntimeOwnerCallbacks {
  isActive: () => boolean;
  markClosing: () => void;
}

/** Raw runtime authority retained exclusively inside one TeamMate entity. */
export class TeammateRuntimeOwner {
  private runtime: AgentRuntime | null = null;
  private starting: Promise<void> | null = null;
  /**
   * The MCP lease tokens the current generation's servers were minted with.
   *
   * Releasing them is this entity's own admission edge, separate from the state
   * generation because the two need opposite orderings: MCP authority has to be
   * gone *before* a native runtime is torn down, since a live shim can start new
   * work at any instant, while the state generation has to survive *until after*
   * it, so the provider can publish its terminal status.
   */
  private mcpTokens: string[] = [];
  /**
   * What the live runtime's own `start` reported. Core reads it instead of
   * asking the runtime, which no longer answers questions about itself.
   */
  private continuity: AgentRuntimeStartOutcome['continuity'] | null = null;
  private readonly assertIdentityScope: (
    identity: AgentEntityIdentity,
    dispatcherId: string,
  ) => void;

  constructor(
    private readonly deps: TeammateServiceDeps,
    private readonly dispatcherId: string,
    private readonly state: AgentRuntimeStateStore,
    private readonly options: TeammateServiceOptions,
    private readonly callbacks: TeammateRuntimeOwnerCallbacks,
  ) {
    this.assertIdentityScope =
      options.assertIdentityScope ?? assertIdentityBelongsToDispatcher;
  }

  async ensureStarted(): Promise<void> {
    this.assertIdentityScope(this.state.current(), this.dispatcherId);
    if (this.starting !== null) return this.starting;
    if (this.runtime !== null) return;
    const promise = this.startFromRecord().finally(() => {
      if (this.starting === promise) this.starting = null;
    });
    this.starting = promise;
    return promise;
  }

  async existingRuntimeAfterStart(): Promise<AgentRuntime | null> {
    await this.starting;
    return this.runtime;
  }

  /** Interrupt only a runtime this process already owns; never start one. */
  async interrupt(): Promise<AgentRuntimeInterruptOutcome> {
    const runtime = await this.existingRuntimeAfterStart();
    return runtime === null ? { status: 'idle' } : runtime.interrupt();
  }

  hasNoRuntimeAuthority(): boolean {
    return this.runtime === null && this.starting === null;
  }

  mustRuntime(): AgentRuntime {
    if (this.runtime === null) {
      throw new Error(
        `TeamMate ${JSON.stringify(this.state.current().name)} is not running`,
      );
    }
    return this.runtime;
  }

  /**
   * The runtime's own last-published status. It is read from the state store the
   * runtime pushes into, never pulled back out of the handle.
   */
  runtimeStatus(): AgentRuntimeStatus | null {
    return this.state.runtimeStatus();
  }

  sessionId(): string | null {
    return this.state.current().session_id;
  }

  /**
   * Whether the live runtime restored a prior session. `null` means no runtime
   * has started in this process, so continuity is simply unknown — callers must
   * not read that as "fresh".
   */
  startContinuity(): AgentRuntimeStartOutcome['continuity'] | null {
    return this.continuity;
  }

  /**
   * Release every piece of runtime ownership this entity holds.
   *
   * Runtime authority is all this releases. Whether the entity is closing for
   * good or the host is simply giving back what it started is the caller's
   * question, and nothing here writes durable state either way.
   *
   * Cleanup is terminal, so no step may be abandoned because an earlier one
   * failed: a runtime whose stop rejected must not prevent Core from joining a
   * racing start, stopping the runtime that start produced, or revoking the
   * generation lease. Native termination failures are collected and rethrown
   * together instead of being masked.
   */
  async stopRuntime(): Promise<void> {
    const failures: unknown[] = [];
    const attempted = new Set<AgentRuntime>();
    try {
      await this.stopOwnedRuntime(attempted, failures);
      // A stop racing a still-pending start must also stop the runtime that
      // appears later, so join the start and re-read the field afterwards.
      await this.starting?.catch(() => undefined);
      await this.stopOwnedRuntime(attempted, failures);
    } finally {
      // Unconditional, and after the stops: a runtime Core could not prove dead
      // must still lose its write authority over an entity it no longer owns,
      // but every runtime that stopped normally has already had its last word.
      // MCP authority is not deferred to here — each stop dropped it first, and
      // this repeats the release only to cover an entity that never had a
      // runtime to stop.
      this.continuity = null;
      this.state.revokeRuntimeGeneration();
      this.releaseMcpLeases();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `TeamMate ${JSON.stringify(this.state.current().name)} could not prove runtime termination`,
      );
    }
  }

  /**
   * Stop the runtime this owner currently holds, once. The handle is released
   * only when its own stop succeeded: an unproven termination keeps the
   * authority a retry would need.
   */
  private async stopOwnedRuntime(
    attempted: Set<AgentRuntime>,
    failures: unknown[],
  ): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null || attempted.has(runtime)) return;
    attempted.add(runtime);
    // Before the first await, and once per runtime rather than once per close:
    // a stop that joined a racing start is about to tear down a *newer*
    // generation whose tokens were minted after this close began, and those
    // must lose authority ahead of their own teardown too. Releasing is
    // idempotent, so repeating it costs nothing.
    this.releaseMcpLeases();
    try {
      await runtime.stop();
    } catch (error) {
      failures.push(error);
      return;
    }
    if (this.runtime === runtime) this.runtime = null;
  }

  /** Starting a closed Agent reopens it: that is what starting one means. */
  private async startFromRecord(): Promise<void> {
    let identity = this.state.current();
    if (identity.status === 'closed') {
      if (
        identity.worktree.mode === 'managed' &&
        identity.worktree.cleanup_state === 'deleted'
      ) {
        identity = await this.state.transact((current) =>
          reprepareDeletedManagedWorktree({
            config: this.deps.config,
            identities: this.deps.identities,
            ...(this.deps.peers !== undefined ? { peers: this.deps.peers } : {}),
            worktrees: this.mustWorktrees(),
            identity: current,
          }));
      }
      identity = await this.state.update({
        status: 'starting',
        closedAt: null,
        closeNote: null,
        lastError: null,
      });
    }
    if (!this.callbacks.isActive()) {
      throw new Error(`TeamMate ${JSON.stringify(identity.name)} is closing`);
    }
    // One lease per attempt, covering both push-only sinks. Every failure path
    // below revokes it, so a start that did not complete leaves no partial
    // write authority behind.
    const lease = this.state.leaseRuntimeGeneration();
    let runtime: AgentRuntime;
    try {
      // Resolving the launch mints this generation's MCP servers, and minting
      // validates and freezes each catalog — so a malformed catalog fails here,
      // before any runtime is constructed, and is rolled back the same way a
      // failed construction is.
      const launch = this.resolveLaunch(lease);
      runtime = await launch.provider.createRuntime({
        ...launch.context,
        injectEnv: HOST_INJECT_ENV,
        disabledFeatures: [
          DISABLE_FEATURE_USER_INTERRUPT,
          ...(launch.context.disabledFeatures ?? []),
        ],
      });
    } catch (error) {
      // No runtime exists, so nothing can be holding these tokens and there is
      // no legitimate final write to wait for. Both are dropped now rather than
      // left for a later mint that may never come.
      this.releaseMcpLeases();
      this.state.revokeRuntimeGeneration();
      throw error;
    }
    this.runtime = runtime;
    try {
      // One start path for every provider: recovery is mandatory provider
      // behavior, so Core never branches on a resume capability. The outcome is
      // captured before any submission is admitted.
      const outcome = await runtime.start();
      this.continuity = outcome.continuity;
      if (!this.callbacks.isActive()) {
        throw new Error(`TeamMate ${JSON.stringify(identity.name)} is closing`);
      }
    } catch (error) {
      // Roll back every piece of ownership this attempt took, in the order each
      // piece requires. MCP authority goes first and synchronously: the native
      // runtime is still alive here, and so is any MCP child it already
      // launched. `stop` runs next, because a provider is allowed to publish
      // its final state while stopping and must not be fenced before it does.
      // The state lease is revoked last, on every outcome including a stop that
      // threw.
      this.releaseMcpLeases();
      try {
        await runtime.stop();
        if (this.runtime === runtime) this.runtime = null;
        this.continuity = null;
      } catch (stopError) {
        this.state.revokeRuntimeGeneration();
        this.callbacks.markClosing();
        throw new AggregateError(
          [error, stopError],
          `TeamMate ${JSON.stringify(identity.name)} start failed and runtime termination could not be proved`,
        );
      }
      this.state.revokeRuntimeGeneration();
      throw error;
    }
  }

  /**
   * A generation-scoped activity closure.
   *
   * Activity shares the state lease's generation, so a replaced runtime cannot
   * publish into its successor's conversation stream — including the stream's
   * `turn.ended` terminal, which would otherwise finish its successor's card.
   * The sink is synchronous and non-throwing by contract, so a stale write is
   * dropped and logged (fail-open) rather than raised back into the provider.
   *
   * The activity goes straight to the display projection. This entity's turn
   * bookkeeping is not consulted: a provider folds any number of submissions
   * into one native turn, so there is no submission to attribute the fact to,
   * and the Agent is the only subject it honestly has.
   */
  private generationActivitySink(
    lease: AgentRuntimeGenerationLease,
  ): AgentRuntimeActivitySink {
    return (activity) => {
      if (!lease.isCurrent()) {
        this.deps.log.debug(
          { teammate: this.state.current().name },
          'dropped Agent Runtime activity from a revoked runtime generation',
        );
        return;
      }
      this.deps.conversationProjection?.projectActivity(
        { identity: this.state.current(), role: this.options.role },
        activity,
      );
    };
  }

  private resolveLaunch(lease: AgentRuntimeGenerationLease): RuntimeLaunchSpec {
    const identity = this.state.current();
    const agent: ResolvedAgentConfig = resolveAgent(
      this.deps.config,
      this.dispatcherId,
      identity.agent_runtime,
    );
    const provider = this.deps.agentRuntimeProviders.resolve(agent.provider);
    return {
      provider: provider.implementation,
      context: {
        identity: {
          runtimeId: this.options.runtimeId,
          sessionId: identity.session_id,
        },
        config: agent.config,
        cwd: identity.cwd,
        skillSources: this.options.skillSources ?? [],
        disabledFeatures: this.options.disabledFeatures ?? [],
        ...(this.options.outputSchema !== undefined
          ? { outputSchema: this.options.outputSchema }
          : {}),
        activity: this.generationActivitySink(lease),
        ...(this.options.systemPrompt !== undefined
          ? { systemPrompt: this.options.systemPrompt }
          : {}),
        // A distinct lease per runtime generation: opening it revoked the
        // previous, so a stale writer cannot overwrite its successor.
        state: lease.state,
        paths: hostRuntimePaths,
        mcpServers: this.mcpServerDescriptors(lease),
        logger:
          this.deps.log.child?.({
            dispatcher_id: this.dispatcherId,
            ...(this.options.loggerFields ?? {
              teammate: identity.name,
            }),
          }) ?? this.deps.log,
      },
    };
  }

  /**
   * Mint this generation's MCP servers.
   *
   * One token per delegate that has something to advertise, bound to the
   * generation lease this attempt just opened. Minting is also where Core asks
   * each delegate for its catalog, validates it, and freezes it, so this is the
   * point a bad catalog fails a launch instead of a child process.
   *
   * A delegate that advertises nothing yields no token and no server: the
   * registry says so, generically, rather than each composition site predicting
   * it. Descriptors carry a socket path and an opaque token and nothing else —
   * no dispatcher id, no caller kind, no Team.
   *
   * This is also the only place a runtime's server set exists as a set, so it
   * is where the set is proven configurable: every delegate names its own
   * server, and two of them — an internal one and a Channel's, or two Channels
   * — could otherwise agree on a name, or contribute one no native config can
   * carry. Proving it here means a bad set fails the launch through the same
   * rollback as any other mint failure, before `createRuntime`.
   */
  private mcpServerDescriptors(
    lease: AgentRuntimeGenerationLease,
  ): AgentRuntimeMcpServer[] {
    const mcp = this.options.mcp;
    if (mcp === undefined) return [];
    // Close the previous attempt's edge before opening this one, so a shim from
    // a start that never finished cannot outlive the mint that replaced it.
    this.releaseMcpLeases();
    const servers: AgentRuntimeMcpServer[] = [];
    for (const delegate of mcp.delegates) {
      // The name comes back from the mint rather than being read off the
      // delegate again: one generation's registration key is decided once, when
      // its catalog is frozen, so the name proven here is the name the registry
      // holds and the name a failure will report.
      const minted = mcp.leases.mint(lease, delegate);
      if (minted === null) continue;
      this.mcpTokens.push(minted.token);
      servers.push(
        mcpServerDescriptor({
          name: minted.name,
          token: minted.token,
          adminSocketPath: mcp.adminSocketPath,
        }),
      );
    }
    assertUniqueMcpServerNames(servers);
    return servers;
  }

  /**
   * Drop this entity's MCP authority, synchronously and idempotently.
   *
   * Every caller is a teardown or an abandoned launch, and each one runs this
   * before it touches the native runtime, so there is no window in which a
   * surviving shim can still start work for an entity that is going away.
   */
  private releaseMcpLeases(): void {
    if (this.mcpTokens.length === 0) return;
    const tokens = this.mcpTokens;
    this.mcpTokens = [];
    this.options.mcp?.leases.release(tokens);
  }

  private mustWorktrees(): WorktreeManager {
    if (this.deps.worktrees === undefined) {
      throw new Error(
        `agent ${JSON.stringify(this.state.current().name)} has no worktree manager`,
      );
    }
    return this.deps.worktrees;
  }
}

function assertIdentityBelongsToDispatcher(
  identity: AgentEntityIdentity,
  dispatcherId: string,
): void {
  if (identity.dispatcher_id !== dispatcherId) {
    throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
  }
}
