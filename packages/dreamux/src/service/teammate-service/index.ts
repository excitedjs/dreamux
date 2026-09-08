import type {
  AgentRuntimeStartOutcome,
  AgentRuntimeStatus,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import type { ProjectedAgent } from '../../channel/conversation-projection.js';

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
} from '../agent-entity/types.js';
import type {
  CompletionDeliveryResult,
  PreparedCompletionDelivery,
  PreparedCompletionFact,
} from '../completion-router/index.js';
import { deduplicate } from '../deduplicate.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import { COMPLETION_SOURCE } from '../submission-sources.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { AdmissionLedger, AgentEntityLedgerKey } from './admission-ledger.js';
import { buildCompletionTurnText } from './completion-renderer.js';
import { TeammateClosedPublisher } from './closed-fact.js';
import { CompletionDeliveryScope } from './completion-delivery-scope.js';
import { TeammateRuntimeOwner } from './runtime-owner.js';
import { renderSubmission, type TeammateSubmitInput } from './submission.js';
import {
  asCompletionDeliveryResult,
  failedAdmissionReason,
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

/** One canonical TeamMate entity and the sole owner of its live lifecycle. */
export class TeammateService {
  private state: AgentRuntimeStateStore;
  private readonly runtimeOwner: TeammateRuntimeOwner;
  private readonly turns: EntityTurnCoordinator;
  /**
   * Core's own bounded, process-local source dedupe. It reserves a key before
   * runtime admission, so a repeat never reaches the Provider seam — which
   * carries text alone and has no source identity to deduplicate with.
   *
   * Held by the Dispatcher rather than constructed here: this service object is
   * deleted and rematerialized (reopen, retire), and a service-owned ledger
   * would reset dedupe with it.
   */
  private readonly admissions: AdmissionLedger;
  /** The entity half of every ledger key this service reserves. */
  private readonly ledgerKey: AgentEntityLedgerKey;
  private phase: EntityPhase = 'active';
  private ordinaryMutations = 0;
  private readonly ordinaryIdleWaiters = new Set<() => void>();
  private lockToken: object | null = null;
  /**
   * The host stop converging what this entity already accepted.
   *
   * Separate from {@link EntityPhase} on purpose: a host stop says nothing
   * about this entity's lifecycle, so it must not move a state that means the
   * entity is on its way to closed.
   *
   * It fences the same way a lock does and for exactly its own span, so the
   * operation is the fence: a second sweep joins it instead of starting a
   * second release.
   */
  private hostStop: Promise<void> | null = null;
  /**
   * The process-local relationship under which a new Turn may owe completion.
   *
   * Identity, rather than a Boolean, makes retirement permanent for an
   * admission that started before a fence and attached after future work was
   * enabled again.
   */
  private readonly completionDeliveryScope = new CompletionDeliveryScope();
  private readonly closed: TeammateClosedPublisher;
  private readonly ownsWorktreeOnClose: boolean;
  /** The runtime role this entity's owner derived; the display fact carries it. */
  private readonly role: TeammateRole;

  constructor(
    private readonly deps: TeammateServiceDeps,
    dispatcherId: string,
    identity: AgentEntityIdentity,
    options: TeammateServiceOptions,
  ) {
    this.ownsWorktreeOnClose = options.ownsWorktreeOnClose;
    this.admissions = deps.admissions;
    this.ledgerKey = {
      dispatcherId,
      teamId: identity.team_id,
      name: identity.name,
    };
    this.state = new AgentRuntimeStateStore(deps.identities, identity);
    this.closed = new TeammateClosedPublisher(deps.log);
    this.role = options.role;
    this.turns = new EntityTurnCoordinator({
      identity: () => this.current(),
      isActive: () => this.phase === 'active',
      completionDeliveryScope: this.completionDeliveryScope,
    });
    this.runtimeOwner = new TeammateRuntimeOwner(
      deps,
      dispatcherId,
      this.state,
      options,
      {
        isActive: () => this.phase === 'active',
        markClosing: () => {
          this.phase = 'closing';
        },
      },
    );
  }

  get name(): string {
    return this.current().name;
  }

  current(): AgentEntityIdentity {
    return this.state.current();
  }

  /**
   * This entity is over and its owner may drop it.
   *
   * A closed entity a Workflow still holds is deliberately not retired: its
   * lock is what keeps the collection from materializing a second live instance
   * for the same name while the holder still has the first one.
   */
  isRetired(): boolean {
    return this.phase === 'closed' && this.lockToken === null;
  }

  onClosed(
    listener: (fact: TeammateClosedFact) => void | Promise<void>,
  ): TeammateClosedSubscription {
    return this.closed.subscribe(listener);
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

  /**
   * Submit one turn and report the entity's status with the outcome.
   *
   * This is not a second input path: it is `submitInput` plus the roster view
   * its caller needs, and the lazy completion-delivery resolution that can only
   * run once the caller has decided to submit.
   */
  async send(
    input: TeammateSubmitInput & {
      resolveCompletionDelivery?: () => Promise<TurnCompletionDelivery | null>;
    },
  ): Promise<AgentEntitySendResult> {
    const { resolveCompletionDelivery, ...submission } = input;
    const delivery = submission.deliverCompletion ??
      await resolveCompletionDelivery?.() ?? null;
    const turn = await this.submitInput({
      ...submission,
      ...(delivery !== null ? { deliverCompletion: delivery } : {}),
    });
    return {
      teammate: this.status(),
      ...toSubmissionResult(turn),
    };
  }

  /**
   * The one admitted-input operation.
   *
   * Every ordinary submission — a Channel message, a cron fire, an Agent task,
   * a completion pushback, a Dispatcher notice — states the same seven facts and
   * gets the same treatment: reserve the duplicate key, materialize or reopen
   * the target, record the recovery subject of the turn actually admitted, and
   * hand the Runtime the assembled envelope. There is no per-source wrapper and
   * no caller-selected mode, because there is no per-source behavior left to
   * select.
   */
  async submitInput(input: TeammateSubmitInput): Promise<TurnAdmission> {
    const leave = this.enterOrdinaryMutation('submission');
    try {
      return await this.submitAdmitted(input, { wake: true });
    } finally {
      leave();
    }
  }

  /**
   * The admitted submission itself, without the ordinary-mutation fence.
   *
   * Split out for the two callers that are authorized some other way: the
   * locked Workflow path, which the ordinary fence would refuse precisely
   * because it holds the lock, and a completion push-back, which takes the
   * fence itself and then asks for `wake: false`. Every ledger rule, every
   * rendering rule, and the one display announcement still live here once.
   *
   * `wake` is the whole difference between an ordinary input and a push-back.
   * An ordinary input materializes or reopens its target; a push-back is only
   * meaningful to a runtime that is already live, so a stopped recipient is
   * reported back instead of being silently woken by an answer nobody asked
   * it to read. It is deliberately not on the public surface: no caller
   * chooses it, the kind of submission does.
   */
  private submitAdmitted(
    input: TeammateSubmitInput,
    options: { wake: boolean },
  ): Promise<TurnAdmission> {
    // Rendering is validated before the key is reserved: an unsafe source or
    // attribute name is a defect in the calling path, and it must not consume a
    // duplicate reservation on its way to failing.
    const text = renderSubmission(input);
    return this.admissions.admit(this.ledgerKey, input.sourceId, async () => {
      // Announced before anything below can fail, so a submission that never
      // reaches a runtime is still visible together with the text that failed
      // — which is the whole point of showing it. A deduplicated repeat never
      // gets here, because the original already announced itself.
      this.projectInput(input);
      try {
        const admission = await this.admitToRuntime(input, text, options.wake);
        // Only a `submitted` admission produces a turn, and only a turn's
        // runtime ever reports a native end. Every other outcome would leave
        // the surface this input just opened waiting forever, so Core ends it
        // itself and says why.
        const failure = failedAdmissionReason(admission);
        if (failure !== null) this.projectFailedEnd(failure);
        return admission;
      } catch (error) {
        this.projectFailedEnd(asError(error).message);
        throw error;
      }
    });
  }

  private async admitToRuntime(
    input: TeammateSubmitInput,
    text: string,
    wake: boolean,
  ): Promise<TurnAdmission> {
    if (wake) {
      await this.runtimeOwner.ensureStarted();
    } else if (
      (await this.runtimeOwner.existingRuntimeAfterStart().catch(() => null)) === null
    ) {
      return { status: 'stopped' };
    }
    // Inside the admission closure, so a deduplicated repeat neither
    // rewrites the recovery subject nor submits a second turn.
    if (input.intent !== undefined && input.intent !== '') {
      await this.state.updateIntent(input.intent);
    }
    const runtime = this.runtimeOwner.mustRuntime();
    return this.turns.submitRuntimeTurn(
      () => runtime.submit({ text }),
      input.deliverCompletion ?? null,
    );
  }

  /**
   * Say that this entity accepted an input, on the entity's own display stream.
   *
   * The fact carries the source's own body. The envelope is delivery formatting
   * for the model, and repeating it here would show provenance markup back to a
   * human reader.
   */
  private projectInput(input: TeammateSubmitInput): void {
    this.deps.conversationProjection?.projectInput(this.projectedAgent(), {
      source: input.source,
      sourceId: input.sourceId ?? null,
      text: input.text,
      occurredAt: Date.now(),
    });
  }

  private projectFailedEnd(reason: string): void {
    // Every card is this TeamMate's, one at a time, and this end closes the one
    // that is open. `unsettled_turn` says which shape follows: a non-`submitted`
    // admission never retains a turn of its own, so `true` means work was
    // already running and will open a further card for the rest of itself.
    this.deps.log.warn(
      {
        teammate: this.name,
        unsettled_turn: this.turns.hasUnsettledCurrent(),
        reason,
      },
      'ending the agent display as failed for an input no runtime accepted',
    );
    this.deps.conversationProjection?.projectActivity(this.projectedAgent(), {
      kind: 'turn.ended',
      occurredAt: Date.now(),
      status: 'failed',
      reason,
    });
  }

  private projectedAgent(): ProjectedAgent {
    return { identity: this.current(), role: this.role };
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
      const body = await buildCompletionTurnText(
        completion,
        dispatcherCompletionSpillDir(this.current().dispatcher_id),
      );
      return Object.freeze({
        submit: () => this.submitCompletionInput(body),
      });
    } finally {
      leave();
    }
  }

  /**
   * Release the host's runtime authority over this entity, without closing it.
   *
   * A process stop gives back its native runtime, MCP authority, and write
   * generation, but keeps the entity's durable identity, status, and worktree.
   *
   * Pending completion delivery is abandoned before native stop because the
   * lifecycle relationship no longer owes it; each Turn remains retained until
   * settlement converges. The published host-stop promise fences admission for
   * that span; the owning aggregate explicitly re-arms future completion after
   * release. An entity already closing or closed converges through its terminal
   * path.
   */
  stopForHost(): Promise<void> {
    if (this.phase !== 'active') return Promise.resolve();
    if (this.hostStop !== null) return this.hostStop;
    const task = Promise.resolve()
      .then(() => this.releaseHostRuntime())
      .finally(() => {
        this.hostStop = null;
      });
    this.hostStop = task;
    this.abandonPendingCompletionDelivery();
    return task;
  }

  /** Retire every completion obligation that has not started. */
  abandonPendingCompletionDelivery(): void {
    this.completionDeliveryScope.abandon();
    this.turns.abandonPendingDeliveries();
  }

  /** Give only future admissions a fresh completion-delivery relationship. */
  rearmCompletionDelivery(): void {
    if (this.phase !== 'active' || this.hostStop !== null) return;
    this.completionDeliveryScope.rearm();
  }

  private async releaseHostRuntime(): Promise<void> {
    // A lock is not consulted: an entity a Workflow still holds would
    // otherwise keep a live native runtime past process exit, and the
    // Workflow owner has already been stopped by the same sweep.
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () => this.runtimeOwner.stopRuntime());
    await this.turns.drainAdmissions();
    await this.waitForOrdinaryMutations();
    await collectShutdownFailure(failures, () => this.turns.convergeRetainedTurns());
    throwShutdownFailures(
      failures,
      `TeamMate ${JSON.stringify(this.name)} did not converge during host stop`,
    );
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

  runtimeStatus(): AgentRuntimeStatus | null {
    return this.runtimeOwner.runtimeStatus();
  }

  sessionId(): string | null {
    return this.runtimeOwner.sessionId();
  }

  /**
   * What the live runtime's `start` restored, or `null` when no runtime has
   * started in this process. Callers must not read `null` as "fresh".
   */
  startContinuity(): AgentRuntimeStartOutcome['continuity'] | null {
    return this.runtimeOwner.startContinuity();
  }

  /** Composition-only eager activation; lifecycle callers use admitted inputs. */
  async activate(): Promise<void> {
    const leave = this.enterOrdinaryMutation('activation');
    try {
      await this.runtimeOwner.ensureStarted();
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
    await this.runtimeOwner.ensureStarted();
    this.assertLockToken(token);
    if (this.phase !== 'active') return { status: 'stopped' };
    return this.submitAdmitted(
      { source: input.source, text: input.prompt },
      { wake: true },
    );
  }

  /**
   * Deliver a prepared completion into a running runtime.
   *
   * It is an ordinary admitted input asking not to wake its target, so it gets
   * the same ledger, the same rendering, and the same display announcement as
   * anything else this entity accepts. Only the answer shape differs, and that
   * is one stated mapping of the admission the entity already made.
   */
  private async submitCompletionInput(
    body: string,
  ): Promise<CompletionDeliveryResult> {
    let leave: (() => void) | null = null;
    try {
      leave = this.enterOrdinaryMutation('completion input');
    } catch {
      return { status: 'unsupported', reason: 'teammate is not writable' };
    }
    try {
      return asCompletionDeliveryResult(
        await this.submitAdmitted(
          { source: COMPLETION_SOURCE, text: body },
          { wake: false },
        ),
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
    if (this.phase === 'closed') {
      return Promise.resolve({ teammate: this.status() });
    }
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
      this.phase = 'closed';
      if (token === null) this.closed.publish(this.current(), closedAt);
      return Promise.resolve({ teammate: this.status() });
    }
    if (this.phase === 'active') this.phase = 'closing';
    return this.transitionToClosed(closeNote, token);
  }

  @deduplicate({ type: 'once' })
  private async transitionToClosed(
    closeNote: string,
    token: object | null,
  ): Promise<AgentEntityCloseResult> {
    this.abandonPendingCompletionDelivery();
    await this.runtimeOwner.stopRuntime();
    await this.turns.drainAdmissions();
    await this.waitForOrdinaryMutations();
    await this.turns.convergeRetainedTurns();

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
    this.phase = 'closed';
    // A held entity publishes its terminal fact at unlock instead: an owner
    // that evicted it now would materialize a second live instance for the
    // same name while the holder still has this one.
    if (token === null) {
      this.closed.publish(this.current(), closedAt);
    } else {
      this.assertLockToken(token);
    }
    return { teammate: toStatus(closed, null) };
  }

  private unlock(token: object): void {
    this.assertLockToken(token);
    if (this.phase === 'closing') {
      throw new Error(
        `TeamMate ${JSON.stringify(this.name)} cannot unlock while closing`,
      );
    }
    this.lockToken = null;
    if (this.phase === 'closed') {
      const closedAt = this.current().closed_at;
      if (closedAt === null) {
        throw new Error('closed-held TeamMate has no durable closed_at');
      }
      this.closed.publish(this.current(), closedAt);
    }
  }

  private enterOrdinaryMutation(label: string): () => void {
    if (
      this.phase !== 'active' ||
      this.lockToken !== null ||
      this.hostStop !== null
    ) {
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function unsupportedPreparedCompletion(
  reason: string,
): PreparedCompletionDelivery {
  return Object.freeze({
    submit: async () => ({ status: 'unsupported' as const, reason }),
  });
}
