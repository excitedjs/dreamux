import type {
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';

interface CompletionEnvelopeBase {
  source: string;
  id: string;
  status: 'completed' | 'failed' | 'stopped';
  result: string | null;
}

export interface TeammateCompletionEnvelope extends CompletionEnvelopeBase {
  kind: 'teammate';
}

export interface WorkflowCompletionEnvelope extends CompletionEnvelopeBase {
  kind: 'workflow';
  source: 'workflow';
}

/** A settled producer result delivered through the shared completion router. */
export type CompletionEnvelope =
  | TeammateCompletionEnvelope
  | WorkflowCompletionEnvelope;

export type CompletionDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: Error };

/**
 * The delivery target of a settled producer: a dispatcher agent or a team
 * leader. The router never names which — it only forwards the completion
 * envelope into the target's inbox. Do not conflate the initiator with
 * `CompletionEnvelope.source`, which names the producer.
 */
export interface CompletionInitiator {
  completionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult>;
}

const TERMINAL_CACHE_LIMIT = 512;
const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Per-dispatcher completion delivery service. A delivery-initiating
 * action (`send` / `spawn` / team-create-with-prompt / workflow run) registers
 * `completionKey -> initiator`. When that producer settles, the router takes
 * the result, calls
 * `initiator.completionInput(envelope)`, then clears the registration.
 *
 * Gating is intrinsic: only send-initiated turns register, so channel-inbound
 * and remote-control turns are recorded but never pushed. The router is the
 * single delivery chokepoint and applies one at-most-once policy to every target
 * (dispatcher and leader alike).
 */
export class CompletionRouter {
  private readonly pending = new Map<string, CompletionInitiator>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /**
   * Completion keys that reached ANY terminal outcome — not only delivered ones.
   * Recording every terminal branch (accepted / unsupported / dropped / thrown /
   * failed-exhausted) is what makes a duplicate settle never re-attempt.
   */
  private readonly terminal = new Set<string>();
  private readonly terminalOrder: string[] = [];

  constructor(
    private readonly deps: { dispatcherId: string; log: DreamuxLogger },
  ) {}

  /**
   * Associate a settle of `completionKey` with the action's initiator. A bare
   * `turnId` would cross-wire two teammates' in-flight turns, so the key carries
   * the producer name. A null `turnId` means there is nothing to deliver — no
   * registration is made.
   */
  register(completionKey: string | null, initiator: CompletionInitiator): void {
    if (completionKey === null) return;
    this.pending.set(completionKey, initiator);
  }

  /** Mark a registered completion terminal without invoking its initiator. */
  discard(completionKey: string): void {
    this.pending.delete(completionKey);
    this.rememberTerminal(completionKey);
  }

  /**
   * Deliver a settled turn's completion to its registered initiator, then clear
   * the registration. No-op when the key was never registered (a turn nobody is
   * waiting on) or has already reached a terminal outcome.
   */
  async settle(
    completionKey: string,
    completion: CompletionEnvelope,
  ): Promise<void> {
    if (this.terminal.has(completionKey)) {
      this.pending.delete(completionKey);
      return;
    }
    const inFlight = this.inFlight.get(completionKey);
    if (inFlight !== undefined) return inFlight;
    const initiator = this.pending.get(completionKey);
    if (initiator === undefined) return;

    const delivery = this.doDeliver(completionKey, initiator, completion);
    this.inFlight.set(completionKey, delivery);
    try {
      await delivery;
    } finally {
      this.inFlight.delete(completionKey);
      this.pending.delete(completionKey);
    }
  }

  private async doDeliver(
    completionKey: string,
    initiator: CompletionInitiator,
    completion: CompletionEnvelope,
  ): Promise<void> {
    const dispatcherId = this.deps.dispatcherId;
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      let outcome: CompletionDeliveryResult;
      try {
        outcome = await initiator.completionInput(completion);
      } catch (err) {
        // Ambiguous: the call may already have delivered. Drop and record
        // terminal — never retry.
        this.deps.log.warn(
          {
            dispatcher_id: dispatcherId,
            source: completion.source,
            err: errorInfo(err),
          },
          'completion delivery threw; dropping',
        );
        this.rememberTerminal(completionKey);
        return;
      }
      if (outcome.status === 'accepted') {
        this.rememberTerminal(completionKey);
        return;
      }
      if (outcome.status === 'unsupported') {
        // Target not running / no completion surface. Drop and record terminal
        // (no replay queue — a queued replay would surface later as a
        // duplicate); the consumer falls back to `last` / pull.
        this.deps.log.warn(
          {
            dispatcher_id: dispatcherId,
            source: completion.source,
            reason: outcome.reason,
          },
          'dropping completion: delivery unsupported',
        );
        this.rememberTerminal(completionKey);
        return;
      }
      // Explicit failure (definitely not delivered): bounded retry.
      this.deps.log.warn(
        {
          dispatcher_id: dispatcherId,
          source: completion.source,
          attempt,
          max_attempts: MAX_DELIVERY_ATTEMPTS,
          err: errorInfo(outcome.error),
        },
        'completion delivery failed',
      );
    }
    this.deps.log.warn(
      {
        dispatcher_id: dispatcherId,
        source: completion.source,
        max_attempts: MAX_DELIVERY_ATTEMPTS,
      },
      'completion delivery exhausted retries; dropping',
    );
    this.rememberTerminal(completionKey);
  }

  private rememberTerminal(key: string): void {
    if (this.terminal.has(key)) return;
    this.terminal.add(key);
    this.terminalOrder.push(key);
    while (this.terminalOrder.length > TERMINAL_CACHE_LIMIT) {
      const evicted = this.terminalOrder.shift();
      if (evicted !== undefined) this.terminal.delete(evicted);
    }
  }
}

export function completionKey(producerName: string, turnId: string): string {
  return `${producerName}:${turnId}`;
}
