import type {
  AgentRuntimeInterruptOutcome,
  AgentRuntimeStartOutcome,
  AgentRuntimeStatus,
  RuntimeAdmission,
  RuntimeSubmission,
  TeammateInputNotice,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import type { ProjectedAgent } from '../dispatcher-core-events/conversation-projection.js';

import { dispatcherCompletionSpillDir } from '../../platform/paths.js';
import { errorMessage } from '@excitedjs/dreamux-utils';
import { toRecordRow, toStatus } from './records.js';
import { AgentRuntimeStateStore } from './runtime-state.js';
import {
  requireLifecycleText,
  type AgentEntityCloseResult,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityRecordRow,
  type AgentEntityRuntimeStatus,
  type AgentEntitySendResult,
} from './identity.js';
import type {
  CompletionDeliveryResult,
  PreparedCompletionDelivery,
  PreparedCompletionFact,
} from '../completion-router/index.js';
import { deduplicate } from '../../platform/deduplicate.js';
import { InFlightWork } from '../../platform/in-flight-work.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../../platform/shutdown-errors.js';
import { COMPLETION_SOURCE } from '../submission-sources.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { AgentEntityLedgerKey } from './admission.js';
import { buildCompletionTurnText } from './completion-renderer.js';
import {
  RuntimeGeneration,
  RuntimeTerminationUnproven,
} from './runtime-generation.js';
import { renderSubmission, type TeammateSubmitInput } from './submission.js';
import {
  asCompletionDeliveryResult,
  failedAdmissionReason,
  toSubmissionResult,
  type AdmissionLedger,
} from './admission.js';
import {
  asError,
  EntityTurn,
  type TurnAdmission,
  type TurnCompletionDelivery,
} from './turn.js';
import {
  agentRoleNoun,
  teammateClosedFact,
  type EntityPhase,
  type LockedTeammate,
  type TeammateClosedFact,
  type TeammateServiceDeps,
  type TeammateServiceOptions,
  type WorkflowTeammateSubmitInput,
} from './service-types.js';

/** One canonical Agent entity and the sole owner of its live lifecycle. */
export class AgentService {
  private state: AgentRuntimeStateStore;
  private readonly runtimeGeneration: RuntimeGeneration;
  /**
   * Entity-owned serialization for provider admission.
   *
   * Holds the push-back line and nothing else: which submissions this entity
   * has outstanding, in what order their admissions are attached, and who is
   * waiting for each one's result. Display is not here — a live surface is
   * keyed on the Agent, not on a submission, so it never needed this
   * bookkeeping to find its subject.
   */
  private admissionContinuationTail: Promise<void> = Promise.resolve();
  private readonly retainedTurns = new Set<EntityTurn>();
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
  private readonly ordinaryMutations = new InFlightWork();
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
   * Resolves once, the moment this entity is durably closed — the same moment
   * a `publish()` used to fire. A caller that needs to evict a closed entity
   * attaches with `.then()`; there is no unsubscribe, because a promise
   * settles once and every derived `.then()` is independent.
   */
  readonly closed: Promise<TeammateClosedFact>;
  private resolveClosed!: (fact: TeammateClosedFact) => void;
  /** The runtime role this entity's owner derived; the display fact carries it. */
  private readonly role: TeammateRole;

  constructor(
    private readonly deps: TeammateServiceDeps,
    dispatcherId: string,
    identity: AgentEntityIdentity,
    options: TeammateServiceOptions,
  ) {
    this.admissions = deps.admissions;
    this.ledgerKey = {
      dispatcherId,
      teamId: identity.team_id,
      name: identity.name,
    };
    this.state = new AgentRuntimeStateStore(
      deps.identities,
      identity,
      deps.onPersisted,
    );
    this.role = options.role;
    this.closed = new Promise<TeammateClosedFact>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.runtimeGeneration = new RuntimeGeneration(
      deps,
      dispatcherId,
      this.state,
      options,
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

  /**
   * Once true, a caller holding this instance across a `close()` call may
   * drop it and rebuild fresh from disk next time, whether or not the close's
   * own durable write landed.
   *
   * `isRetired()` alone under-reports this: a close whose runtime stop
   * succeeds but whose identity write then fails (a transient disk error)
   * leaves the phase at `'closing'` forever in this process, and a caller
   * still keying off `isRetired()` would keep re-serving that same stuck
   * instance instead of forgetting it. Requiring `hasNoRuntimeAuthority()`
   * alongside `'closing'` — the same pairing {@link effectiveIdentityStatus}
   * already uses to report that case as `'stopped'` — is what keeps this
   * false for a *different* `'closing'` cause: a failed start whose own
   * rollback stop could not prove the native runtime dead
   * (`RuntimeTerminationUnproven`) leaves `this.runtime` set precisely so
   * nothing forgets it while it might still be alive. Only a `close()` that
   * got as far as fully releasing runtime authority may be forgotten here.
   */
  isSafeToForget(): boolean {
    return (
      this.lockToken === null &&
      (this.phase === 'closed' ||
        (this.phase === 'closing' &&
          this.runtimeGeneration.hasNoRuntimeAuthority()))
    );
  }

  lock(): LockedTeammate {
    if (this.phase !== 'active') {
      throw new Error(`${agentRoleNoun(this.role, this.name)} is not active`);
    }
    if (this.lockToken !== null) {
      throw new Error(
        `${agentRoleNoun(this.role, this.name)} is already locked`,
      );
    }
    if (!this.ordinaryMutations.idle) {
      throw new Error(
        `${agentRoleNoun(this.role, this.name)} is being mutated`,
      );
    }
    if (this.hasUnsettledCurrent()) {
      throw new Error(
        `${agentRoleNoun(this.role, this.name)} has an active Turn`,
      );
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
        requireLifecycleText(
          input.note,
          `${agentRoleNoun(this.role, this.name)} close note`,
        );
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
    const delivery =
      submission.deliverCompletion ??
      (await resolveCompletionDelivery?.()) ??
      null;
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
        this.projectFailedEnd(errorMessage(error));
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
      if (!(await this.ensureRuntimeStarted())) return { status: 'stopped' };
    } else if (
      (await this.runtimeGeneration
        .existingRuntimeAfterStart()
        .catch(() => null)) === null
    ) {
      return { status: 'stopped' };
    }
    // Inside the admission closure, so a deduplicated repeat neither
    // rewrites the recovery subject nor submits a second turn. Every
    // `TeammateSubmitInput` producer reads `intent` through a non-blank-string
    // reader, so a defined value here is never empty.
    if (input.intent !== undefined) {
      await this.state.update({ intent: input.intent });
    }
    const runtime = this.runtimeGeneration.mustRuntime();
    return this.submitRuntimeTurn(
      () => runtime.submit({ text }),
      input.deliverCompletion ?? null,
    );
  }

  private hasUnsettledCurrent(): boolean {
    return [...this.retainedTurns].some((turn) => !turn.isSettled());
  }

  private submitRuntimeTurn(
    operation: () => Promise<RuntimeAdmission>,
    deliverCompletion: TurnCompletionDelivery | null,
  ): Promise<TurnAdmission> {
    if (this.phase !== 'active') return Promise.resolve({ status: 'stopped' });
    let admission: Promise<RuntimeAdmission>;
    try {
      admission = operation();
    } catch (error) {
      return Promise.resolve({ status: 'ambiguous', error: asError(error) });
    }
    const observed = observeRuntimeAdmission(admission);
    return this.enqueueAdmissionContinuation(async () => {
      const result = await observed;
      if (result.status === 'rejected') {
        return { status: 'ambiguous', error: result.error };
      }
      if (result.admission.status !== 'submitted') {
        return result.admission;
      }
      const turn = this.attachSubmission(
        result.admission.submission,
        deliverCompletion,
      );
      return { status: 'submitted', turn };
    });
  }

  /**
   * Wait for every admission continuation this entity has accepted.
   *
   * Admissions run strictly in order, so the tail is the whole queue: awaiting
   * it awaits everything enqueued before it, and the loop covers work enqueued
   * while draining.
   */
  private async drainAdmissions(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.admissionContinuationTail;
      await tail;
    } while (this.admissionContinuationTail !== tail);
  }

  /**
   * Prove every retained turn settled, then wait for whatever each one still
   * delivers. Whether a turn delivers at all is the turn's own decision, made
   * from the `owed` closure `attachSubmission` gave it when it settled.
   */
  private async convergeRetainedTurns(): Promise<void> {
    await Promise.resolve();
    const unsettled = [...this.retainedTurns].filter(
      (turn) => !turn.isSettled(),
    );
    if (unsettled.length > 0) {
      throw new Error(
        `runtime stop returned with ${unsettled.length} unsettled submission(s) for ` +
          `${this.current().name}: ${unsettled.map((turn) => turn.id).join(', ')}`,
      );
    }
    for (const turn of [...this.retainedTurns]) await turn.ensureDelivery();
  }

  private enqueueAdmissionContinuation<T>(task: () => Promise<T>): Promise<T> {
    const continuation = this.admissionContinuationTail.then(task, task);
    this.admissionContinuationTail = continuation.then(
      () => undefined,
      () => undefined,
    );
    return continuation;
  }

  private attachSubmission(
    submission: RuntimeSubmission,
    deliverCompletion: TurnCompletionDelivery | null,
  ): EntityTurn {
    const turn = new EntityTurn(
      submission,
      this.current().name,
      this.role,
      deliverCompletion,
      // Whether a turn that settles now is news this entity still owes its
      // owner. False while the entity is closing or being released by its
      // host: the party that ended the turn is the one that would read the
      // report.
      () => this.phase === 'active' && this.hostStop === null,
    );
    this.retainedTurns.add(turn);
    void turn
      .ensureDelivery()
      .finally(() => {
        this.retainedTurns.delete(turn);
      })
      .catch(() => undefined);
    return turn;
  }

  /**
   * Interrupt the current turn without waking this Agent.
   *
   * Only a runtime this process already owns is interrupted; a runtime is
   * never started to interrupt it. A start that failed leaves nothing to
   * interrupt, so it reads as no runtime the way every other caller of
   * `existingRuntimeAfterStart` reads it — raising it here would answer an
   * interrupt with the spawn's error instead of saying that nothing is
   * running.
   */
  async interrupt(): Promise<AgentRuntimeInterruptOutcome> {
    const runtime = await this.runtimeGeneration
      .existingRuntimeAfterStart()
      .catch(() => null);
    return runtime === null ? { status: 'idle' } : runtime.interrupt();
  }

  /**
   * Say that this entity accepted an input, on the entity's own display stream.
   *
   * The fact carries the source's own body. The envelope is delivery formatting
   * for the model, and repeating it here would show provenance markup back to a
   * human reader.
   */
  private projectInput(input: TeammateSubmitInput): void {
    this.deps.conversationProjection.projectInput(this.projectedAgent(), {
      source: input.source,
      sourceId: input.sourceId ?? null,
      text: input.text,
      notice: input.notice ?? null,
      occurredAt: Date.now(),
    });
  }

  private projectFailedEnd(reason: string): void {
    // Every card is this entity's, one at a time, and this end closes the one
    // that is open. `unsettled_turn` says which shape follows: a non-`submitted`
    // admission never retains a turn of its own, so `true` means work was
    // already running and will open a further card for the rest of itself.
    this.deps.log.warn(
      {
        teammate: this.name,
        unsettled_turn: this.hasUnsettledCurrent(),
        reason,
      },
      'ending the agent display as failed for an input no runtime accepted',
    );
    this.deps.conversationProjection.projectActivity(this.projectedAgent(), {
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
      const runtime = await this.runtimeGeneration
        .existingRuntimeAfterStart()
        .catch(() => null);
      if (runtime === null) {
        return unsupportedPreparedCompletion('teammate runtime not running');
      }
      const body = await buildCompletionTurnText(
        completion,
        dispatcherCompletionSpillDir(this.current().dispatcher_id),
      );
      // The body says whose work finished in prose the model reads; the notice
      // says the same in facts, so a display can show one line without parsing
      // that prose back apart.
      return Object.freeze({
        submit: () =>
          this.submitCompletionInput(
            body,
            completion.kind === 'teammate'
              ? { kind: 'teammate_completion', producer: completion.source }
              : { kind: 'workflow_completion' },
          ),
      });
    } finally {
      leave();
    }
  }

  /**
   * Release the host's runtime authority over this entity, without closing it.
   *
   * A process stop and a failed dispatcher start both have to give back what
   * the run took — the native runtime, its MCP authority, its write generation
   * — and nothing else. The entity keeps its durable identity, its status, and
   * its worktree: nobody asked it to close, and a host that closed it on the
   * way out would be deciding a product lifecycle no operator requested.
   *
   * Accepted work converges first, in the order a close uses. A turn this
   * stop ends is not reported: the host that asked for the stop is the party
   * that would read the report, and a stopped-by-shutdown card is not news to
   * anyone. The fence is published before the native stop, so a turn admitted
   * ahead of it reads the fence when it settles, and one admitted behind it
   * finds the runtime already stopped.
   *
   * Admission is fenced only while that convergence runs. The dispatcher owns
   * the real fences, and the same process may start again without
   * rematerializing this entity, so an entity left permanently refusing input
   * would be fencing the wrong thing. Work admitted before those fences that
   * revives a runtime is what the caller's second, idempotent sweep is for.
   *
   * An entity that is closing, held closed, or retired is already giving up
   * the same authority through its own terminal path; joining it here would
   * only race it.
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
    return task;
  }

  private async releaseHostRuntime(): Promise<void> {
    // A lock is not consulted: an entity a Workflow still holds would
    // otherwise keep a live native runtime past process exit, and the
    // Workflow owner has already been stopped by the same sweep.
    //
    // A native stop that fails does not skip the convergence behind it: an
    // admission that was in flight when the fence went up must still attach
    // while `hostStop` is set, or its turn would settle later with the fence
    // gone and report a stop nobody is left to read.
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () =>
      this.runtimeGeneration.stopRuntime(),
    );
    await this.drainAdmissions();
    await this.ordinaryMutations.drain();
    await collectShutdownFailure(failures, () => this.convergeRetainedTurns());
    throwShutdownFailures(
      failures,
      `${agentRoleNoun(this.role, this.name)} did not converge during host stop`,
    );
  }

  close(input: { note: string }): Promise<AgentEntityCloseResult> {
    requireLifecycleText(
      input.note,
      `${agentRoleNoun(this.role, this.name)} close note`,
    );
    if (this.lockToken !== null) {
      return Promise.reject(
        new Error(`${agentRoleNoun(this.role, this.name)} is locked`),
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
      this.runtimeGeneration.hasNoRuntimeAuthority()
    ) {
      return 'stopped';
    }
    return identity.status;
  }

  runtimeStatus(): AgentRuntimeStatus | null {
    return this.state.runtimeStatus();
  }

  sessionId(): string | null {
    return this.current().session_id;
  }

  /**
   * What the live runtime's `start` restored, or `null` when no runtime has
   * started in this process. Callers must not read `null` as "fresh".
   */
  startContinuity(): AgentRuntimeStartOutcome['continuity'] | null {
    return this.runtimeGeneration.startContinuity();
  }

  /** Composition-only eager activation; lifecycle callers use admitted inputs. */
  async activate(): Promise<void> {
    const leave = this.enterOrdinaryMutation('activation');
    try {
      await this.ensureRuntimeStarted();
    } finally {
      leave();
    }
  }

  /**
   * Start this entity's runtime, keeping this class's own `phase` in sync
   * with what a start actually produced. Every caller of
   * `runtimeGeneration.ensureStarted()` goes through here instead of calling
   * it directly, because `ensureStarted()` no longer notices a close that
   * raced it: it either starts the runtime and returns, or fails to.
   *
   * A close moving `phase` away from `'active'` while a start this method
   * began is still in flight is the one race this method exists for: checked
   * once before spending a launch on an entity already leaving, and again
   * once that launch resolves, since `phase` may have moved during the
   * awaited native start. The runtime a losing start produced is stopped here
   * rather than left for a caller to notice was returned but unusable —
   * `runtimeGeneration.stopRuntime()` is idempotent, so a close racing the
   * same runtime concurrently costs nothing extra. A host stop is not this
   * race: it never moves `phase`, and its own `stopRuntime()` call already
   * joins a start in flight the same way.
   *
   * A start whose own rollback could not prove the runtime dead is the one
   * runtime failure that changes this entity's lifecycle on its own: moving
   * `phase` to `'closing'` is what keeps every later caller from reusing a
   * runtime handle nothing here could stop, since `ensureStarted()` treats a
   * non-null handle as already live and never revisits it.
   *
   * Returns whether the runtime is up and this entity is still active.
   */
  private async ensureRuntimeStarted(): Promise<boolean> {
    if (this.phase !== 'active') return false;
    try {
      await this.runtimeGeneration.ensureStarted();
    } catch (error) {
      if (error instanceof RuntimeTerminationUnproven) this.phase = 'closing';
      throw error;
    }
    if (this.phase !== 'active') {
      await this.runtimeGeneration.stopRuntime();
      return false;
    }
    return true;
  }

  private async submitLocked(
    input: WorkflowTeammateSubmitInput,
    token: object,
  ): Promise<TurnAdmission> {
    this.assertLockToken(token);
    if (!(await this.ensureRuntimeStarted())) return { status: 'stopped' };
    this.assertLockToken(token);
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
    notice: TeammateInputNotice,
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
          { source: COMPLETION_SOURCE, text: body, notice },
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
      this.runtimeGeneration.hasNoRuntimeAuthority()
    ) {
      const closedAt = identity.closed_at;
      if (closedAt === null) {
        return Promise.reject(
          new Error(
            `durable closed ${agentRoleNoun(this.role, this.name)} has no closed_at`,
          ),
        );
      }
      this.phase = 'closed';
      if (token === null)
        this.resolveClosed(teammateClosedFact(this.current(), closedAt));
      return Promise.resolve({ teammate: this.status() });
    }
    if (this.phase === 'active') this.phase = 'closing';
    return this.transitionToClosed(closeNote, token);
  }

  @deduplicate
  private async transitionToClosed(
    closeNote: string,
    token: object | null,
  ): Promise<AgentEntityCloseResult> {
    await this.runtimeGeneration.stopRuntime();
    await this.drainAdmissions();
    await this.ordinaryMutations.drain();
    await this.convergeRetainedTurns();

    const identity = this.current();
    const shouldCleanup =
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
      this.resolveClosed(teammateClosedFact(this.current(), closedAt));
    } else {
      this.assertLockToken(token);
    }
    return { teammate: toStatus(closed, null) };
  }

  private unlock(token: object): void {
    this.assertLockToken(token);
    if (this.phase === 'closing') {
      throw new Error(
        `${agentRoleNoun(this.role, this.name)} cannot unlock while closing`,
      );
    }
    this.lockToken = null;
    if (this.phase === 'closed') {
      const closedAt = this.current().closed_at;
      if (closedAt === null) {
        throw new Error(
          `closed-held ${agentRoleNoun(this.role, this.name)} has no durable closed_at`,
        );
      }
      this.resolveClosed(teammateClosedFact(this.current(), closedAt));
    }
  }

  private enterOrdinaryMutation(label: string): () => void {
    if (
      this.phase !== 'active' ||
      this.lockToken !== null ||
      this.hostStop !== null
    ) {
      throw new Error(
        `${agentRoleNoun(this.role, this.name)} cannot accept ${label}`,
      );
    }
    return this.ordinaryMutations.enter();
  }

  private assertLockToken(token: object): void {
    if (this.lockToken !== token) {
      throw new Error(`stale lock for ${agentRoleNoun(this.role, this.name)}`);
    }
  }

  private mustWorktrees(): WorktreeManager {
    if (this.deps.worktrees === undefined) {
      throw new Error(
        `agent ${JSON.stringify(this.name)} has no worktree manager`,
      );
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

type ObservedRuntimeAdmission =
  | { status: 'fulfilled'; admission: RuntimeAdmission }
  | { status: 'rejected'; error: Error };

function observeRuntimeAdmission(
  admission: Promise<RuntimeAdmission>,
): Promise<ObservedRuntimeAdmission> {
  return admission.then(
    (value) => ({ status: 'fulfilled', admission: value }),
    (error: unknown) => ({ status: 'rejected', error: asError(error) }),
  );
}
