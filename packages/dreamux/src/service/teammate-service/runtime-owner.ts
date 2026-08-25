import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  RuntimeActivitySink,
} from '@excitedjs/dreamux-types';

import {
  DISABLE_FEATURE_USER_INTERRUPT,
  HOST_INJECT_ENV,
  hostRuntimePaths,
} from '../../agent-runtime/index.js';
import type { ResolvedAgentConfig } from '../../config/config.js';
import { resolveAgent } from '../agent-entity/agent-config.js';
import type { AgentRuntimeStateStore } from '../agent-entity/runtime-state.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { reprepareDeletedManagedWorktree } from '../worktree/workspaces.js';
import type { TeammateServiceDeps, TeammateServiceOptions } from './types.js';

interface RuntimeLaunchSpec {
  provider: AgentRuntimeProvider;
  context: Omit<AgentRuntimeCreateContext, 'injectEnv'>;
  checkpointId: string | null;
}

interface TeammateRuntimeOwnerCallbacks {
  current: () => AgentEntityIdentity;
  isActive: () => boolean;
  markClosing: () => void;
  activitySink: RuntimeActivitySink;
}

/** Raw runtime authority retained exclusively inside one TeamMate entity. */
export class TeammateRuntimeOwner {
  private runtime: AgentRuntime | null = null;
  private starting: Promise<void> | null = null;
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

  async ensureStarted(opts: { reopenClosed?: boolean } = {}): Promise<void> {
    this.assertIdentityScope(this.callbacks.current(), this.dispatcherId);
    if (this.starting !== null) return this.starting;
    if (this.runtime !== null) return;
    const promise = this.startFromRecord(opts).finally(() => {
      if (this.starting === promise) this.starting = null;
    });
    this.starting = promise;
    return promise;
  }

  async existingRuntimeAfterStart(): Promise<AgentRuntime | null> {
    await this.starting;
    return this.runtime;
  }

  hasNoRuntimeAuthority(): boolean {
    return this.runtime === null && this.starting === null;
  }

  mustRuntime(): AgentRuntime {
    if (this.runtime === null) {
      throw new Error(
        `TeamMate ${JSON.stringify(this.callbacks.current().name)} is not running`,
      );
    }
    return this.runtime;
  }

  waitIdle(): Promise<void> {
    return this.runtime?.waitIdle?.() ?? Promise.resolve();
  }

  waitIdleCapability(): (() => Promise<void>) | undefined {
    const runtime = this.runtime;
    return runtime?.waitIdle === undefined
      ? undefined
      : () => runtime.waitIdle!();
  }

  runtimeStatus(): ReturnType<AgentRuntime['getStatus']> | null {
    return this.runtime?.getStatus() ?? null;
  }

  checkpointId(): string | null {
    return (
      this.runtime?.getCheckpoint()?.id ?? this.callbacks.current().session_id
    );
  }

  wasCheckpointResumed(): boolean {
    return this.runtime?.wasCheckpointResumed() ?? false;
  }

  async stopForClose(): Promise<void> {
    const starting = this.starting;
    let runtime = this.runtime;
    if (runtime !== null) {
      await runtime.stop();
      if (this.runtime === runtime) this.runtime = null;
    }
    await starting?.catch(() => undefined);
    runtime = this.runtime;
    if (runtime !== null) {
      await runtime.stop();
      if (this.runtime === runtime) this.runtime = null;
    }
  }

  private async startFromRecord(opts: {
    reopenClosed?: boolean;
  }): Promise<void> {
    let identity = this.callbacks.current();
    if (identity.status === 'closed') {
      if (opts.reopenClosed !== true) {
        throw new Error(`TeamMate ${JSON.stringify(identity.name)} is closed`);
      }
      if (
        identity.worktree.mode === 'managed' &&
        identity.worktree.cleanup_state === 'deleted'
      ) {
        identity = await this.state.transact((current) =>
          reprepareDeletedManagedWorktree({
            config: this.deps.config,
            identities: this.deps.identities,
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
    const launch = this.resolveLaunch();
    const resumeCapability = launch.provider.getCapabilities().resume;
    const runtime = launch.provider.createRuntime({
      ...launch.context,
      injectEnv: HOST_INJECT_ENV,
      disableFeatures: [
        DISABLE_FEATURE_USER_INTERRUPT,
        ...(launch.context.disableFeatures ?? []),
      ],
    });
    this.runtime = runtime;
    try {
      if (launch.checkpointId !== null && resumeCapability.supported) {
        await runtime.resume();
      } else {
        await runtime.start();
      }
      if (!this.callbacks.isActive()) {
        await runtime.stop();
        if (this.runtime === runtime) this.runtime = null;
        throw new Error(`TeamMate ${JSON.stringify(identity.name)} is closing`);
      }
    } catch (error) {
      try {
        await runtime.stop();
        if (this.runtime === runtime) this.runtime = null;
      } catch (stopError) {
        this.callbacks.markClosing();
        throw new AggregateError(
          [error, stopError],
          `TeamMate ${JSON.stringify(identity.name)} start failed and runtime termination could not be proved`,
        );
      }
      throw error;
    }
  }

  private resolveLaunch(): RuntimeLaunchSpec {
    const identity = this.callbacks.current();
    const agent: ResolvedAgentConfig = resolveAgent(
      this.deps.config,
      this.dispatcherId,
      identity.agent_runtime,
    );
    const provider = this.deps.agentRuntimeProviders.resolve(agent.provider);
    return {
      provider,
      checkpointId: identity.session_id,
      context: {
        identity: {
          runtime_id: this.options.runtimeId,
          checkpoint:
            identity.session_id === null
              ? null
              : {
                  id: identity.session_id,
                  transcript_locator: identity.transcript_locator,
                },
        },
        config: agent.config,
        cwd: identity.cwd,
        skillSources: this.options.skillSources ?? [],
        disableFeatures: this.options.disableFeatures ?? [],
        outputSchema: this.options.outputSchema,
        activitySink: this.callbacks.activitySink,
        ...(this.options.systemPrompt !== undefined
          ? { systemPrompt: this.options.systemPrompt }
          : {}),
        state: this.state,
        paths: hostRuntimePaths,
        mcpServers: [...(this.options.mcpServers ?? [])],
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

  private mustWorktrees(): WorktreeManager {
    if (this.deps.worktrees === undefined) {
      throw new Error(
        `agent ${JSON.stringify(this.callbacks.current().name)} has no worktree manager`,
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
