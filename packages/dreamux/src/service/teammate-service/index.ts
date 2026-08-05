import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeMcpServer,
  AgentRuntimeProvider,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  AgentRuntimeTurnResult,
  InboundTurnInput,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';
import {
  DISABLE_FEATURE_USER_INTERRUPT,
  HOST_INJECT_ENV,
  hostRuntimePaths,
} from '../../agent-runtime/index.js';
import type { ResolvedAgentConfig } from '../../config/config.js';
import { resolveAgent } from '../teammate-collection/agent-config.js';
import {
  foldLastTurns,
  toStatus,
  validateLastTurns,
} from '../teammate-collection/read-helpers.js';
import { AgentRuntimeStateStore } from '../agent-entity/runtime-state.js';
import { recordSettledTurn, recordSubmittedTurn, toTurnResult } from './turn-recording.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import {
  reprepareDeletedManagedWorktree,
} from '../worktree/workspaces.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  requireLifecycleText,
  type AgentEntityCloseResult,
  type AgentEntityIdentity,
  type AgentEntityLastResult,
  type AgentEntityRuntimeStatus,
  type AgentEntitySendResult,
  type AgentEntityTurnOrigin,
  type AgentEntityTurnResult,
  type AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import { dispatcherCompletionSpillDir } from '../../platform/paths.js';
import type {
  CompletionDeliveryResult,
  CompletionEnvelope,
} from '../completion-router/index.js';
import { buildCompletionTurnText } from './completion-renderer.js';
import { TurnSubmissionReadiness } from './submission-readiness.js';
import type {
  TeammateServiceDeps,
  TeammateServiceOptions,
} from './types.js';

/** The provider-construction inputs a {@link TeammateService} needs to launch. */
export interface RuntimeLaunchSpec {
  provider: AgentRuntimeProvider;
  /** The full create context minus the generic pieces the entity supplies. */
  context: Omit<AgentRuntimeCreateContext, 'onTurnSettled' | 'injectEnv'>;
  /** Runtime-native checkpoint id to resume from, or null for a fresh start. */
  checkpointId: string | null;
}

function assertIdentityBelongsToDispatcher(
  identity: AgentEntityIdentity,
  dispatcherId: string,
): void {
  if (identity.dispatcher_id !== dispatcherId) {
    throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
  }
}

/**
 * A single named teammate entity (issue #233): it holds its own identity, its
 * (lazily started) runtime, a per-turn origin cache, and the domain operations
 * `send` / `close` / `status` / `last` / `history` / `channelInput`. It is also a
 * delivery target via `completionInput` — it renders the core completion
 * envelope to a plain runtime turn before the per-dispatcher
 * `CompletionRouter` considers the delivery accepted.
 *
 * Storage stays in the collection's shared stores; the entity holds references
 * to them rather than owning them (collections remain process-wide in Phase 1).
 */
export class TeammateService {
  private runtime: AgentRuntime | null = null;
  private starting: Promise<void> | null = null;
  private readonly settleWrites = new Set<Promise<void>>();
  private readonly turnSubmissions = new TurnSubmissionReadiness((settled) => {
    this.captureSettledTurn(settled);
  });
  private state: AgentRuntimeStateStore;
  private readonly mcpServers: readonly AgentRuntimeMcpServer[];
  private readonly skillSources: readonly AgentRuntimeSkillSource[];
  private readonly disableFeatures: readonly string[];
  private readonly systemPrompt: AgentRuntimeSystemPrompt | undefined;
  private readonly outputSchema: Record<string, unknown> | undefined;
  private readonly runtimeId: string;
  private readonly ownsWorktreeOnClose: boolean;
  private readonly loggerFields: Record<string, unknown>;
  private readonly assertIdentityScope: (
    identity: AgentEntityIdentity,
    dispatcherId: string,
  ) => void;

  constructor(
    private readonly deps: TeammateServiceDeps,
    private readonly dispatcherId: string,
    private identity: AgentEntityIdentity,
    options: TeammateServiceOptions,
  ) {
    this.mcpServers = options.mcpServers ?? [];
    this.skillSources = options.skillSources ?? [];
    this.disableFeatures = options.disableFeatures ?? [];
    this.systemPrompt = options.systemPrompt;
    this.outputSchema = options.outputSchema;
    this.runtimeId = options.runtimeId;
    this.ownsWorktreeOnClose = options.ownsWorktreeOnClose;
    this.loggerFields = options.loggerFields ?? { teammate: identity.name };
    this.assertIdentityScope =
      options.assertIdentityScope ?? assertIdentityBelongsToDispatcher;
    this.state = new AgentRuntimeStateStore(deps.identities, identity);
  }

  get name(): string {
    return this.identity.name;
  }

  current(): AgentEntityIdentity {
    return this.state.current();
  }

  getRuntime(): AgentRuntime | null {
    return this.runtime;
  }

  /**
   * Render a completion envelope into a plain text turn and submit it to the
   * runtime, the delivery-target side of the reverse path. The at-most-once
   * policy lives in the `CompletionRouter`; the stable sourceId gives runtimes a
   * provider-owned dedupe/correlation hook across router retries.
   */
  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult> {
    const runtime = this.runtime;
    if (runtime === null) {
      return { status: 'unsupported', reason: 'teammate runtime not running' };
    }
    let text: string;
    try {
      text = await buildCompletionTurnText(
        completion,
        this.resolveCompletionSpillDir(),
      );
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    const result = await this.submitRuntimeTurn(
      () => runtime.completionInput({
        text,
        sourceId: `completion:${completion.id}`,
      }),
      { turnOrigin: null, prompt: text, recordUnsubmitted: false },
    );
    return turnResultToCompletionDelivery(result);
  }

  /**
   * Submit a prompt, lazily (re)starting the runtime. Returns the turn result and
   * the live identity snapshot; the caller registers the completion key with the
   * router so the settled turn routes back to the initiator.
   */
  async send(
    input: {
      prompt: string;
      intent?: string;
      /** The caller-owned source to record in the teammate turn ledger. */
      turnOrigin: AgentEntityTurnOrigin;
    },
  ): Promise<AgentEntitySendResult> {
    await this.ensureStarted({ reopenClosed: true });
    if (input.intent !== undefined && input.intent !== '') {
      await this.state.updateIntent(input.intent);
    }
    const turn = await this.submitPrompt(input.prompt, {
      turnOrigin: input.turnOrigin,
    });
    return { teammate: this.status(), turn };
  }

  /** Submit the first prompt of a freshly created teammate / leader. */
  async submitInitialPrompt(
    prompt: string,
    opts: {
      turnOrigin: AgentEntityTurnOrigin;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<AgentEntityTurnResult> {
    return toTurnResult(await this.submitInitialPromptRuntime(prompt, opts));
  }

  /** Initial submission result before adapting it to the admin-facing DTO. */
  async submitInitialPromptRuntime(
    prompt: string,
    opts: {
      turnOrigin: AgentEntityTurnOrigin;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<AgentRuntimeTurnResult> {
    return this.submitPromptRuntime(prompt, {
      turnOrigin: opts.turnOrigin,
      outputSchema: opts.outputSchema,
    });
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    await this.ensureStarted({ reopenClosed: true });
    const runtime = this.mustRuntime();
    return this.submitRuntimeTurn(
      () => runtime.channelInput(input),
      { turnOrigin: 'channel', prompt: input.text, recordUnsubmitted: false },
    );
  }

  async scheduledInput(input: {
    jobId: string;
    prompt: string;
    sourceId: string;
    signal: AbortSignal;
  }): Promise<AgentRuntimeTurnResult> {
    if (input.signal.aborted) return { status: 'skipped' };
    await this.ensureStarted();
    if (input.signal.aborted) return { status: 'skipped' };
    const runtime = this.mustRuntime();
    return this.submitRuntimeTurn(
      () => runtime.completionInput({
        text: input.prompt,
        sourceId: input.sourceId,
      }),
      {
        turnOrigin: { kind: 'scheduled', job_id: input.jobId },
        prompt: input.prompt,
        recordUnsubmitted: false,
      },
    );
  }

  async close(input: { note: string }): Promise<AgentEntityCloseResult> {
    requireLifecycleText(input.note, 'TeamMate close note');
    return this.transitionToClosed(input.note);
  }

  /** Owner-only close that leaves no user-visible lifecycle note. */
  async release(): Promise<AgentEntityCloseResult> {
    return this.transitionToClosed(null);
  }

  private async transitionToClosed(
    closeNote: string | null,
  ): Promise<AgentEntityCloseResult> {
    await this.stop();
    await this.turnSubmissions.drain();
    while (this.settleWrites.size > 0) {
      await Promise.allSettled([...this.settleWrites]);
    }
    const identity = this.current();
    // Close-time cleanup requires both ownership from the entity profile and
    // delete-on-close metadata from the identity. Shared worktrees can still
    // carry delete-on-close, but their lifecycle belongs to their owner.
    const shouldCleanup =
      this.ownsWorktreeOnClose &&
      identity.worktree.mode === 'managed' &&
      identity.worktree.cleanup === 'delete-on-close';
    const worktree = shouldCleanup
      ? await this.mustWorktrees().cleanup(identity)
      : identity.worktree;
    const closed = await this.deps.identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote,
      lastSeenAt: Date.now(),
      worktree,
    });
    this.identity = closed;
    this.state = new AgentRuntimeStateStore(this.deps.identities, closed);
    return { teammate: toStatus(closed, null) };
  }

  /**
   * Sync this entity's persisted worktree to an owner-performed cleanup result.
   * Borrowers skip close-time cleanup, so their displayed state must be updated
   * when the owning service removes the shared worktree.
   */
  async applyWorktreeCleanup(worktree: AgentEntityWorktreeIdentity): Promise<void> {
    const identity = this.current();
    const updated = await this.deps.identities.update(identity, { worktree });
    this.identity = updated;
    this.state = new AgentRuntimeStateStore(this.deps.identities, updated);
  }

  status(): AgentEntityRuntimeStatus {
    return toStatus(this.current(), this.runtime);
  }

  async last(turns?: number): Promise<AgentEntityLastResult> {
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
   * `runtime === null`) so the runtime is created exactly once. The identity
   * scope check runs eagerly on every caller — including those that join an
   * in-flight start — so corrupt identity scope still fails fast.
   */
  async ensureStarted(opts: { reopenClosed?: boolean } = {}): Promise<void> {
    this.assertIdentityScope(this.current(), this.dispatcherId);
    if (this.runtime !== null) return;
    if (this.starting !== null) return this.starting;
    const promise = this.startFromRecord(opts).finally(() => {
      this.starting = null;
    });
    this.starting = promise;
    return promise;
  }

  private async startFromRecord(opts: { reopenClosed?: boolean }): Promise<void> {
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
      this.state = new AgentRuntimeStateStore(this.deps.identities, identity);
    }
    await this.startRuntime();
  }

  private async startRuntime(): Promise<void> {
    const launch = this.resolveLaunch();
    await this.createAndStart(launch);
  }

  /**
   * Resolve every agent runtime through `identity.agent_runtime -> agents[]`.
   */
  private resolveLaunch(): RuntimeLaunchSpec {
    const identity = this.current();
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
          runtime_id: this.runtimeId,
          checkpoint_id: identity.session_id,
        },
        config: agent.config,
        cwd: identity.cwd,
        skillSources: this.skillSources,
        disableFeatures: this.disableFeatures,
        outputSchema: this.outputSchema,
        ...(this.systemPrompt !== undefined
          ? { systemPrompt: this.systemPrompt }
          : {}),
        state: this.state,
        paths: hostRuntimePaths,
        mcpServers: [...this.mcpServers],
        logger:
          this.deps.log.child?.({
            dispatcher_id: this.dispatcherId,
            ...this.loggerFields,
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
        this.turnSubmissions.capture(settled);
      },
    });
    liveRuntime = runtime;
    if (launch.checkpointId !== null && resumeCapability.supported) {
      await runtime.resume();
    } else {
      await runtime.start();
    }
    this.runtime = runtime;
  }

  private captureSettledTurn(settled: TurnSettledSignal): void {
    const capture = this.deliverSettledTurn(settled);
    this.deps.trackSettleCapture?.(capture);
  }

  /**
   * The producer side of the reverse path: when this teammate's turn settles,
   * record the settled row before routing the completion. A route may release
   * the producer, so allowing its older runtime-state write to finish later
   * could overwrite the durable closed identity with stale running state.
   * Both operations remain best-effort and independent on failure.
   */
  private async deliverSettledTurn(
    settled: TurnSettledSignal,
  ): Promise<void> {
    const identity = this.current();
    const result = settled.result?.text ?? null;
    if (settled.status === 'failed' && settled.error !== undefined) {
      this.deps.log.error(
        {
          teammate: identity.name,
          turn_id: settled.turnId,
          err: {
            name: settled.error.name,
            message: settled.error.message,
            stack: settled.error.stack,
          },
        },
        'teammate turn failed',
      );
    }
    const envelope: CompletionEnvelope = {
      kind: 'teammate',
      source: identity.name,
      id: `${identity.name}:${settled.turnId}`,
      status: settled.status,
      result,
    };
    const settleWrite = this.turnSubmissions.persist(() =>
      recordSettledTurn(this.turnsStore, this.state, {
        turnId: settled.turnId,
        assistant: result,
        settleStatus: settled.status,
        assistantTruncated: settled.result?.truncated === true,
      }));
    this.settleWrites.add(settleWrite);
    await Promise.allSettled([settleWrite]);
    this.settleWrites.delete(settleWrite);
    await Promise.allSettled([
      this.deps.routeSettledCompletion(
        identity.name,
        settled.turnId,
        envelope,
      ),
    ]);
  }

  private async submitPrompt(
    prompt: string,
    opts: {
      turnOrigin: AgentEntityTurnOrigin;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<AgentEntityTurnResult> {
    return toTurnResult(await this.submitPromptRuntime(prompt, opts));
  }

  /** Submit through the neutral runtime seam before adapting to admin DTOs. */
  private async submitPromptRuntime(
    prompt: string,
    opts: {
      turnOrigin: AgentEntityTurnOrigin;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<AgentRuntimeTurnResult> {
    await this.ensureStarted({ reopenClosed: true });
    const runtime = this.mustRuntime();
    const submissionSeq = this.deps.nextSubmissionSeq();
    const result = await this.submitRuntimeTurn(
      () => runtime.completionInput({
        sourceId: `teammate:${this.name}:${submissionSeq}`,
        text: prompt,
        outputSchema: opts.outputSchema,
      }),
      { turnOrigin: opts.turnOrigin, prompt, recordUnsubmitted: true },
    );
    return result;
  }

  private submitRuntimeTurn(
    operation: () => Promise<AgentRuntimeTurnResult>,
    input: {
      turnOrigin: AgentEntityTurnOrigin | null;
      prompt: string;
      recordUnsubmitted: boolean;
    },
  ): Promise<AgentRuntimeTurnResult> {
    return this.turnSubmissions.submit(operation, async (result) => {
      if (result.status !== 'submitted' && !input.recordUnsubmitted) return;
      await recordSubmittedTurn(this.turnsStore, this.live(), {
        turnId: result.status === 'submitted' ? result.turnId : null,
        turnOrigin: input.turnOrigin,
        prompt: input.prompt,
      });
    });
  }

  private get turnsStore(): AgentTurnsStore {
    return this.deps.turnsStore;
  }

  private live(): { state: AgentRuntimeStateStore } {
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

  private resolveCompletionSpillDir(): string {
    return dispatcherCompletionSpillDir(this.current().dispatcher_id);
  }
}

function turnResultToCompletionDelivery(
  result: AgentRuntimeTurnResult,
): CompletionDeliveryResult {
  switch (result.status) {
    case 'submitted':
    case 'duplicate':
      return { status: 'accepted' };
    case 'stopped':
      return { status: 'unsupported', reason: 'runtime stopped' };
    case 'failed':
      return { status: 'failed', error: result.error };
    case 'skipped':
      return {
        status: 'failed',
        error: new Error('completion delivery unexpectedly skipped'),
      };
  }
}
