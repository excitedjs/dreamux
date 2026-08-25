import type {
  AgentRuntime,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import { dispatcherCompletionSpillDir } from '../../platform/paths.js';
import {
  toRecordRow,
  toStatus,
} from '../agent-entity/read-helpers.js';
import { AgentRuntimeStateStore } from '../agent-entity/runtime-state.js';
import {
  requireLifecycleText,
  type AgentEntityCloseResult,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityRecordRow,
  type AgentEntityRuntimeStatus,
  type AgentEntitySendResult,
  type AgentEntitySubmissionResult,
  type AgentEntityTurnOrigin,
  type AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import type {
  CompletionDeliveryResult,
  PreparedCompletionDelivery,
  PreparedCompletionFact,
} from '../completion-router/index.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { buildCompletionTurnText } from './completion-renderer.js';
import { TeammateRuntimeOwner } from './runtime-owner.js';
import {
  toSubmissionResult,
  type TurnAdmission,
  type TurnCompletionDelivery,
} from './turn-recording.js';
import { EntityTurnCoordinator } from './turn-coordinator.js';
import type {
  EntityPhase,
  LockedTeammate,
  TeammateClosedFact,
  TeammateClosedSubscription,
  TeammateServiceDeps,
  TeammateServiceOptions,
  WorkflowTeammateSubmitInput,
} from './types.js';

/** Close failed after the live runtime was already proven terminated. */
export class TeammateClosePhaseError extends Error {
  readonly runtime_terminated = true;

  constructor(teammateName: string, cause: unknown) {
    super(
      `TeamMate ${JSON.stringify(teammateName)} close failed after runtime termination`,
      { cause },
    );
    this.name = 'TeammateClosePhaseError';
  }
}

/** One canonical TeamMate entity and the sole owner of its live lifecycle. */
export class TeammateService {
  private state: AgentRuntimeStateStore;
  private readonly runtimeOwner: TeammateRuntimeOwner;
  private readonly turns: EntityTurnCoordinator;
  private phase: EntityPhase = 'active';
  private ordinaryMutations = 0;
  private readonly ordinaryIdleWaiters = new Set<() => void>();
  private lockToken: object | null = null;
  private closeTask: Promise<AgentEntityCloseResult> | null = null;
  private readonly closedListeners = new Set<
    (fact: TeammateClosedFact) => void | Promise<void>
  >();
  private readonly ownsWorktreeOnClose: boolean;

  constructor(
    private readonly deps: TeammateServiceDeps,
    dispatcherId: string,
    identity: AgentEntityIdentity,
    options: TeammateServiceOptions,
  ) {
    this.ownsWorktreeOnClose = options.ownsWorktreeOnClose;
    this.state = new AgentRuntimeStateStore(deps.identities, identity);
    this.turns = new EntityTurnCoordinator({
      name: () => this.name,
      intent: () => this.current().intent,
      isActive: () => this.phase === 'active',
    });
    this.runtimeOwner = new TeammateRuntimeOwner(
      deps,
      dispatcherId,
      this.state,
      options,
      {
        current: () => this.current(),
        isActive: () => this.phase === 'active',
        markClosing: () => {
          this.phase = 'closing';
        },
        activitySink: this.turns.activitySink,
      },
    );
  }

  get name(): string {
    return this.current().name;
  }

  current(): AgentEntityIdentity {
    return this.state.current();
  }

  isRetired(): boolean {
    return this.phase === 'retired';
  }

  isLocked(): boolean {
    return this.lockToken !== null;
  }

  onClosed(
    listener: (fact: TeammateClosedFact) => void | Promise<void>,
  ): TeammateClosedSubscription {
    this.closedListeners.add(listener);
    let subscribed = true;
    return {
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.closedListeners.delete(listener);
      },
    };
  }

  lock(): LockedTeammate {
    if (this.phase !== 'active') {
      throw new Error(`TeamMate ${JSON.stringify(this.name)} is not active`);
    }
    if (this.lockToken !== null) {
      throw new Error(`TeamMate ${JSON.stringify(this.name)} is already locked`);
    }
    if (this.ordinaryMutations !== 0) {
      throw new Error(`TeamMate ${JSON.stringify(this.name)} is being mutated`);
    }
    if (this.turns.hasUnsettledCurrent()) {
      throw new Error(`TeamMate ${JSON.stringify(this.name)} has an active Turn`);
    }
    const token = Object.freeze({});
    this.lockToken = token;
    const handle: LockedTeammate = {
      name: this.name,
      submit: (input) => {
        this.assertLockToken(token);
        return this.submitLocked(input, token);
      },
      close: (input) => {
        this.assertLockToken(token);
        requireLifecycleText(input.note, 'TeamMate close note');
        return this.closeAuthorized(input.note, token);
      },
      unlock: () => this.unlock(token),
    };
    return Object.freeze(handle);
  }

  async send(input: {
    prompt: string;
    intent?: string;
    turnOrigin: AgentEntityTurnOrigin;
    deliverCompletion?: TurnCompletionDelivery;
    resolveCompletionDelivery?: () => Promise<TurnCompletionDelivery | null>;
  }): Promise<AgentEntitySendResult> {
    const leave = this.enterOrdinaryMutation('send');
    try {
      await this.runtimeOwner.ensureStarted({ reopenClosed: true });
      if (input.intent !== undefined && input.intent !== '') {
        await this.state.updateIntent(input.intent);
      }
      const delivery = input.deliverCompletion ??
        await input.resolveCompletionDelivery?.() ?? null;
      const turn = await this.submitPromptAdmission(input.prompt, {
        turnOrigin: input.turnOrigin,
        ...(delivery !== null
          ? { deliverCompletion: delivery }
          : {}),
      });
      return {
        teammate: this.status(),
        ...toSubmissionResult(turn),
        transcript_path: this.transcriptPath(),
      };
    } finally {
      leave();
    }
  }

  async submitInitialPrompt(
    prompt: string,
    opts: {
      turnOrigin: AgentEntityTurnOrigin;
      outputSchema?: Record<string, unknown>;
      deliverCompletion?: TurnCompletionDelivery;
    },
  ): Promise<AgentEntitySubmissionResult> {
    const leave = this.enterOrdinaryMutation('initial submission');
    try {
      return toSubmissionResult(await this.submitPromptAdmission(prompt, opts));
    } finally {
      leave();
    }
  }

  async submitInitialPromptRuntime(
    prompt: string,
    opts: {
      turnOrigin: AgentEntityTurnOrigin;
      outputSchema?: Record<string, unknown>;
      deliverCompletion?: TurnCompletionDelivery;
    },
  ): Promise<TurnAdmission> {
    const leave = this.enterOrdinaryMutation('initial submission');
    try {
      return await this.submitPromptAdmission(prompt, opts);
    } finally {
      leave();
    }
  }

  async channelInput(input: InboundTurnInput): Promise<TurnAdmission> {
    const leave = this.enterOrdinaryMutation('channel input');
    try {
      await this.runtimeOwner.ensureStarted({ reopenClosed: true });
      const runtime = this.runtimeOwner.mustRuntime();
      return await this.turns.submitRuntimeTurn(
        () => runtime.channelInput(input),
        { turnOrigin: 'channel', prompt: input.text },
      );
    } finally {
      leave();
    }
  }

  async scheduledInput(input: {
    jobId: string;
    prompt: string;
    sourceId: string;
    signal: AbortSignal;
  }): Promise<TurnAdmission> {
    const leave = this.enterOrdinaryMutation('scheduled input');
    try {
      if (input.signal.aborted) return { status: 'skipped' };
      await this.runtimeOwner.ensureStarted({ reopenClosed: true });
      if (input.signal.aborted) return { status: 'skipped' };
      const runtime = this.runtimeOwner.mustRuntime();
      return await this.turns.submitRuntimeTurn(
        () =>
          runtime.completionInput({
            text: input.prompt,
            sourceId: input.sourceId,
          }),
        {
          turnOrigin: { kind: 'scheduled', job_id: input.jobId },
          prompt: input.prompt,
        },
      );
    } finally {
      leave();
    }
  }

  async controlInput(input: {
    text: string;
    sourceId?: string;
  }): Promise<TurnAdmission> {
    const leave = this.enterOrdinaryMutation('control input');
    try {
      await this.runtimeOwner.ensureStarted();
      const runtime = this.runtimeOwner.mustRuntime();
      return await this.turns.submitRuntimeTurn(
        () =>
          runtime.completionInput({
            text: input.text,
            ...(input.sourceId !== undefined
              ? { sourceId: input.sourceId }
              : {}),
          }),
        { turnOrigin: null, prompt: input.text },
      );
    } finally {
      leave();
    }
  }

  async prepareCompletion(
    completion: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery> {
    let leave: (() => void) | null = null;
    try {
      leave = this.enterOrdinaryMutation('completion preparation');
    } catch {
      return unsupportedPreparedCompletion('teammate is not writable');
    }
    try {
      const runtime = await this.runtimeOwner.existingRuntimeAfterStart().catch(
        () => null,
      );
      if (runtime === null) {
        return unsupportedPreparedCompletion('teammate runtime not running');
      }
      const text = await buildCompletionTurnText(
        completion,
        dispatcherCompletionSpillDir(this.current().dispatcher_id),
      );
      return Object.freeze({
        submit: () => this.submitPreparedCompletion(text),
      });
    } finally {
      leave();
    }
  }

  close(input: { note: string }): Promise<AgentEntityCloseResult> {
    requireLifecycleText(input.note, 'TeamMate close note');
    if (this.lockToken !== null) {
      return Promise.reject(
        new Error(`TeamMate ${JSON.stringify(this.name)} is locked`),
      );
    }
    return this.closeAuthorized(input.note, null);
  }

  async applyWorktreeCleanup(
    worktree: AgentEntityWorktreeIdentity,
  ): Promise<void> {
    if (this.phase === 'retired') {
      // A Team's physical worktree cleanup follows logical entity close. The
      // retired leader remains the Team's exact durable-state owner, so accept
      // this idempotent owner projection without reopening runtime admission.
      await this.state.update({ worktree });
      return;
    }
    const leave = this.enterOrdinaryMutation('worktree cleanup');
    try {
      await this.state.update({
        worktree,
      });
    } finally {
      leave();
    }
  }

  status(): AgentEntityRuntimeStatus {
    const identity = this.current();
    return toStatus(
      identity,
      this.runtimeStatus(),
      this.effectiveIdentityStatus(identity),
    );
  }

  historyRow(): AgentEntityRecordRow {
    const identity = this.current();
    return toRecordRow(
      identity,
      this.runtimeStatus(),
      this.effectiveIdentityStatus(identity),
    );
  }

  transcriptPath(): string | null {
    return this.current().transcript_locator;
  }

  /** Read-only lifecycle projection; durable closure is still store-owned. */
  private effectiveIdentityStatus(
    identity: AgentEntityIdentity,
  ): AgentEntityIdentityStatus {
    if (
      this.phase === 'closing' &&
      this.runtimeOwner.hasNoRuntimeAuthority()
    ) {
      return 'stopped';
    }
    return identity.status;
  }

  waitIdle(): Promise<void> {
    return this.runtimeOwner.waitIdle();
  }

  waitIdleCapability(): (() => Promise<void>) | undefined {
    return this.runtimeOwner.waitIdleCapability();
  }

  runtimeStatus(): ReturnType<AgentRuntime['getStatus']> | null {
    return this.runtimeOwner.runtimeStatus();
  }

  checkpointId(): string | null {
    return this.runtimeOwner.checkpointId();
  }

  wasCheckpointResumed(): boolean {
    return this.runtimeOwner.wasCheckpointResumed();
  }

  /** Composition-only eager activation; lifecycle callers use admitted inputs. */
  async activate(): Promise<void> {
    const leave = this.enterOrdinaryMutation('activation');
    try {
      await this.runtimeOwner.ensureStarted({ reopenClosed: true });
    } finally {
      leave();
    }
  }

  private async submitLocked(
    input: WorkflowTeammateSubmitInput,
    token: object,
  ): Promise<TurnAdmission> {
    this.assertLockToken(token);
    if (this.phase !== 'active') return { status: 'stopped' };
    await this.runtimeOwner.ensureStarted({ reopenClosed: true });
    this.assertLockToken(token);
    if (this.phase !== 'active') return { status: 'stopped' };
    return this.submitPromptAdmission(input.prompt, {
      turnOrigin: input.turnOrigin,
      ...(input.outputSchema !== undefined
        ? { outputSchema: input.outputSchema }
        : {}),
    });
  }

  private submitPromptAdmission(
    prompt: string,
    opts: {
      turnOrigin: AgentEntityTurnOrigin;
      outputSchema?: Record<string, unknown>;
      deliverCompletion?: TurnCompletionDelivery;
    },
  ): Promise<TurnAdmission> {
    return this.runtimeOwner.ensureStarted({ reopenClosed: true }).then(() => {
      const runtime = this.runtimeOwner.mustRuntime();
      return this.turns.submitRuntimeTurn(
        () =>
          runtime.completionInput({
            text: prompt,
            ...(opts.outputSchema !== undefined
              ? { outputSchema: opts.outputSchema }
              : {}),
          }),
        {
          turnOrigin: opts.turnOrigin,
          prompt,
          ...(opts.deliverCompletion !== undefined
            ? { deliverCompletion: opts.deliverCompletion }
            : {}),
        },
      );
    });
  }

  private async submitPreparedCompletion(
    text: string,
  ): Promise<CompletionDeliveryResult> {
    let leave: (() => void) | null = null;
    try {
      leave = this.enterOrdinaryMutation('completion input');
    } catch {
      return { status: 'unsupported', reason: 'teammate is not writable' };
    }
    try {
      const runtime = await this.runtimeOwner.existingRuntimeAfterStart().catch(
        () => null,
      );
      if (runtime === null) {
        return { status: 'unsupported', reason: 'teammate runtime not running' };
      }
      return await this.turns.submitCompletion(
        () => runtime.completionInput({ text }),
        { turnOrigin: null, prompt: text },
      );
    } finally {
      leave();
    }
  }

  private closeAuthorized(
    closeNote: string,
    token: object | null,
  ): Promise<AgentEntityCloseResult> {
    if (token !== null) this.assertLockToken(token);
    if (this.phase === 'retired') {
      return Promise.resolve({ teammate: this.status() });
    }
    if (this.phase === 'closedHeld') {
      return Promise.resolve({ teammate: this.status() });
    }
    if (this.closeTask !== null) return this.closeTask;
    const identity = this.current();
    if (
      this.phase === 'active' &&
      identity.status === 'closed' &&
      this.runtimeOwner.hasNoRuntimeAuthority()
    ) {
      const closedAt = identity.closed_at;
      if (closedAt === null) {
        return Promise.reject(
          new Error('durable closed TeamMate has no closed_at'),
        );
      }
      this.phase = token === null ? 'retired' : 'closedHeld';
      if (token === null) this.queueClosedFact(closedAt);
      return Promise.resolve({ teammate: this.status() });
    }
    if (this.phase === 'active') this.phase = 'closing';
    const task = this.transitionToClosed(closeNote, token);
    this.closeTask = task;
    void task.catch(() => {
      if (this.closeTask === task) this.closeTask = null;
    });
    return task;
  }

  private async transitionToClosed(
    closeNote: string,
    token: object | null,
  ): Promise<AgentEntityCloseResult> {
    await this.runtimeOwner.stopForClose();
    try {
      await this.turns.drainAdmissions();
      await this.waitForOrdinaryMutations();
      await this.turns.settleAndDeliverRetained();

      const identity = this.current();
      const shouldCleanup =
        this.ownsWorktreeOnClose &&
        identity.worktree.mode === 'managed' &&
        identity.worktree.cleanup === 'delete-on-close';
      const worktree = shouldCleanup
        ? await this.mustWorktrees().cleanup(identity)
        : identity.worktree;
      const closedAt = Date.now();
      const closed = await this.state.update({
        status: 'closed',
        closedAt,
        closeNote,
        worktree,
      });
      if (token === null) {
        this.phase = 'retired';
        this.queueClosedFact(closedAt);
      } else {
        this.assertLockToken(token);
        this.phase = 'closedHeld';
      }
      return { teammate: toStatus(closed, null) };
    } catch (error) {
      throw error instanceof TeammateClosePhaseError
        ? error
        : new TeammateClosePhaseError(this.name, error);
    }
  }

  private unlock(token: object): void {
    this.assertLockToken(token);
    if (this.phase === 'closing') {
      throw new Error(
        `TeamMate ${JSON.stringify(this.name)} cannot unlock while closing`,
      );
    }
    this.lockToken = null;
    if (this.phase === 'closedHeld') {
      this.phase = 'retired';
      const closedAt = this.current().closed_at;
      if (closedAt === null) {
        throw new Error('closed-held TeamMate has no durable closed_at');
      }
      this.queueClosedFact(closedAt);
    }
  }

  private queueClosedFact(closedAt: number): void {
    const identity = this.current();
    const fact: TeammateClosedFact = Object.freeze({
      schema_version: 1,
      kind: 'teammate.closed',
      dispatcher_id: identity.dispatcher_id,
      team_id: identity.team_id,
      name: identity.name,
      closed_at: closedAt,
    });
    const listeners = [...this.closedListeners];
    queueMicrotask(() => {
      for (const listener of listeners) {
        try {
          void Promise.resolve(listener(fact)).catch((error) => {
            this.deps.log.warn(
              { teammate: identity.name, error },
              'TeamMate retirement listener failed',
            );
          });
        } catch (error) {
          this.deps.log.warn(
            { teammate: identity.name, error },
            'TeamMate retirement listener failed',
          );
        }
      }
    });
  }

  private enterOrdinaryMutation(label: string): () => void {
    if (this.phase !== 'active' || this.lockToken !== null) {
      throw new Error(
        `TeamMate ${JSON.stringify(this.name)} cannot accept ${label}`,
      );
    }
    this.ordinaryMutations += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.ordinaryMutations -= 1;
      if (this.ordinaryMutations === 0) {
        for (const resolve of this.ordinaryIdleWaiters) resolve();
        this.ordinaryIdleWaiters.clear();
      }
    };
  }

  private waitForOrdinaryMutations(): Promise<void> {
    if (this.ordinaryMutations === 0) return Promise.resolve();
    return new Promise((resolve) => this.ordinaryIdleWaiters.add(resolve));
  }

  private assertLockToken(token: object): void {
    if (this.lockToken !== token) {
      throw new Error(`stale TeamMate lock for ${JSON.stringify(this.name)}`);
    }
  }

  private mustWorktrees(): WorktreeManager {
    if (this.deps.worktrees === undefined) {
      throw new Error(`agent ${JSON.stringify(this.name)} has no worktree manager`);
    }
    return this.deps.worktrees;
  }

}

function unsupportedPreparedCompletion(
  reason: string,
): PreparedCompletionDelivery {
  return Object.freeze({
    submit: async () => ({ status: 'unsupported' as const, reason }),
  });
}
