import type { CompletionEnvelope, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { DispatcherRuntimeSlot } from './service.js';

const COMPLETION_DELIVERY_CACHE_LIMIT = 512;

export class DispatcherCompletionDelivery {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly deliveredIds = new Set<string>();
  private readonly deliveredOrder: string[] = [];

  constructor(
    private readonly deps: {
      dispatcherId: string;
      slot: () => DispatcherRuntimeSlot | null;
      log: DreamuxLogger;
    },
  ) {}

  async deliver(completion: CompletionEnvelope): Promise<void> {
    const completionKey = completionDeliveryKey(
      this.deps.dispatcherId,
      completion.id,
    );
    if (this.deliveredIds.has(completionKey)) return;
    const inFlight = this.inFlight.get(completionKey);
    if (inFlight !== undefined) return inFlight;

    const delivery = this.doDeliver(completion, completionKey);
    this.inFlight.set(completionKey, delivery);
    try {
      await delivery;
    } finally {
      this.inFlight.delete(completionKey);
    }
  }

  private async doDeliver(
    completion: CompletionEnvelope,
    completionKey: string,
  ): Promise<void> {
    const dispatcherId = this.deps.dispatcherId;
    const slot = this.deps.slot();
    if (slot === null) {
      this.deps.log.warn(
        {
          dispatcher_id: dispatcherId,
          source: completion.source,
        },
        'dropping teammate completion: dispatcher not running',
      );
      return;
    }
    const deliver = slot.runtime.completionInput;
    if (deliver === undefined) {
      slot.log.warn(
        {
          dispatcher_id: dispatcherId,
          source: completion.source,
        },
        'dropping teammate completion: runtime has no completion delivery',
      );
      return;
    }
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let outcome;
      try {
        outcome = await deliver.call(slot.runtime, completion);
      } catch (err) {
        slot.log.warn(
          {
            dispatcher_id: dispatcherId,
            source: completion.source,
            err: errInfo(err),
          },
          'teammate completion delivery threw',
        );
        return;
      }
      if (outcome.status === 'accepted') {
        this.rememberDelivered(completionKey);
        return;
      }
      if (outcome.status === 'unsupported') {
        slot.log.warn(
          {
            dispatcher_id: dispatcherId,
            source: completion.source,
            reason: outcome.reason,
          },
          'dropping teammate completion: runtime delivery unsupported',
        );
        return;
      }
      slot.log.warn(
        {
          dispatcher_id: dispatcherId,
          source: completion.source,
          attempt,
          max_attempts: maxAttempts,
          err: errInfo(outcome.error),
        },
        'teammate completion delivery failed',
      );
    }
    slot.log.warn(
      {
        dispatcher_id: dispatcherId,
        source: completion.source,
        max_attempts: maxAttempts,
      },
      'teammate completion delivery exhausted retries; dropping',
    );
  }

  private rememberDelivered(key: string): void {
    if (this.deliveredIds.has(key)) return;
    this.deliveredIds.add(key);
    this.deliveredOrder.push(key);
    while (this.deliveredOrder.length > COMPLETION_DELIVERY_CACHE_LIMIT) {
      const evicted = this.deliveredOrder.shift();
      if (evicted !== undefined) this.deliveredIds.delete(evicted);
    }
  }
}

function completionDeliveryKey(dispatcherId: string, completionId: string): string {
  return JSON.stringify([dispatcherId, completionId]);
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
