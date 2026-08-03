import { randomUUID } from 'node:crypto';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { KeyedAsyncQueue } from '../serial-queue.js';
import { TeamDissolveInterruptedError } from '../team-collection/errors.js';
import type { AcceptedTeamDissolve } from '../team-collection/types.js';
import type { CollaborationRouteReconciler } from './route-reconciliation.js';
import type { CollaborationSpaceStore } from './store.js';
import { parseMessage, routeKey, targetRouteKey } from './support.js';
import type {
  AcceptedTargetClose,
  CollaborationSpaceCloseTargetInput,
  ProvisionedTargetRecord,
  ProvisionedTargetView,
} from './types.js';
import { PUBLIC_TARGET_LIFECYCLE_ERROR, targetView } from './view.js';

export type PreparedTargetClose =
  | {
      kind: 'terminal';
      result: { closed: boolean; target: ProvisionedTargetView | null };
    }
  | {
      kind: 'closing';
      target: ProvisionedTargetRecord;
      accepted: AcceptedTeamDissolve | null;
    };

interface CollaborationTargetCloseLifecycleOptions {
  dispatcherId: string;
  store: CollaborationSpaceStore;
  targetLocks: KeyedAsyncQueue;
  routes: CollaborationRouteReconciler;
  log: DreamuxLogger;
}

/** Owns the target half of the generation-checked Team-close handoff. */
export class CollaborationTargetCloseLifecycle {
  constructor(
    private readonly opts: CollaborationTargetCloseLifecycleOptions,
  ) {}

  async closeTarget(input: CollaborationSpaceCloseTargetInput): Promise<{
    closed: boolean;
    target: ProvisionedTargetView | null;
  }> {
    const space = await this.opts.store.findSpaceByContainer({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space === null) return { closed: false, target: null };
    const generation = space.current_binding?.generation ??
      space.last_binding_generation;
    const prepared = await this.opts.targetLocks.run(routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    }), async () => {
      const record = await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: generation,
        targetKey: input.target.target_key,
      });
      return this.prepareUnderHeldTargetLock(record, input.eventId);
    });
    return this.finishPrepared(prepared);
  }

  async acceptTargetClosed(
    input: CollaborationSpaceCloseTargetInput,
  ): Promise<boolean> {
    return (await this.acceptTargetClosedForClose(input)) !== null;
  }

  async acceptTargetClosedForClose(
    input: CollaborationSpaceCloseTargetInput,
  ): Promise<AcceptedTargetClose | null> {
    const space = await this.opts.store.findSpaceByContainer({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space === null) return null;
    const generation = space.current_binding?.generation ??
      space.last_binding_generation;
    return this.opts.targetLocks.run(routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    }), async () => {
      const record = await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: generation,
        targetKey: input.target.target_key,
      });
      const prepared = await this.prepareUnderHeldTargetLock(
        record,
        input.eventId,
      );
      if (prepared.kind === 'terminal') return null;
      return { close: () => this.finishPrepared(prepared) };
    });
  }

  /** Caller must already own this target's route lock. */
  async prepareUnderHeldTargetLock(
    record: ProvisionedTargetRecord | null,
    eventId: string | undefined,
    finalize: 'close' | 'retry-claim' = 'close',
  ): Promise<PreparedTargetClose> {
    if (record === null || record.lifecycle_status === 'detached') {
      return {
        kind: 'terminal',
        result: {
          closed: false,
          target: record === null ? null : targetView(record),
        },
      };
    }
    if (record.lifecycle_status === 'closed') {
      return {
        kind: 'terminal',
        result: { closed: false, target: targetView(record) },
      };
    }
    let closing = await this.opts.store.saveTarget({
      ...record,
      lifecycle_status: 'closing',
      close_event_id: eventId ?? record.close_event_id,
      team_dissolve_handoff_id:
        record.team_dissolve_handoff_id ?? randomUUID(),
      team_dissolve_finalize:
        record.team_dissolve_finalize ?? finalize,
      updated_at: Date.now(),
    });
    let accepted: AcceptedTeamDissolve | null;
    try {
      accepted = await this.opts.routes.acceptTargetTeamDissolve(
        closing,
        `Collaboration target ${closing.target_key} closed.`,
      );
    } catch (error) {
      closing = await this.opts.store.saveTarget({
        ...closing,
        last_error: PUBLIC_TARGET_LIFECYCLE_ERROR,
        updated_at: Date.now(),
      });
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          space_name: closing.space_name,
          target_key: closing.target_key,
          err: { message: parseMessage(error) },
        },
        'collaboration target Team dissolve was rejected before logical close',
      );
      throw error;
    }
    if (
      accepted !== null &&
      closing.team_dissolve_operation_id !== accepted.operationId
    ) {
      try {
        closing = await this.opts.store.saveTarget({
          ...closing,
          team_dissolve_operation_id: accepted.operationId,
          last_error: null,
          updated_at: Date.now(),
        });
      } catch (error) {
        // Team acceptance already fenced work. Start it even if target-side
        // correlation cannot be persisted in this attempt.
        this.opts.routes.startTeamDissolve(accepted);
        throw error;
      }
    }
    return { kind: 'closing', target: closing, accepted };
  }

  /** Wait outside the target lock, then generation-check the final handoff. */
  async finishPrepared(
    prepared: PreparedTargetClose,
  ): Promise<{
    closed: boolean;
    target: ProvisionedTargetView | null;
  }> {
    if (prepared.kind === 'terminal') return prepared.result;
    const closing = prepared.target;
    try {
      if (prepared.accepted !== null) {
        this.opts.routes.startTeamDissolve(prepared.accepted);
        await prepared.accepted.logicalClosed;
      }
    } catch (error) {
      if (error instanceof TeamDissolveInterruptedError) throw error;
      await this.recordCloseFailure(closing, error);
      throw error;
    }
    return this.opts.targetLocks.run(targetRouteKey(closing), async () => {
      const latest = await this.readExactTarget(closing);
      if (!sameClosingHandoff(latest, closing)) {
        return {
          closed: false,
          target: latest === null ? null : targetView(latest),
        };
      }
      await this.opts.routes.releaseClaimedTargetRoute(latest);
      if (latest.team_dissolve_finalize === 'retry-claim') {
        const retryable = await this.opts.store.saveTarget({
          ...latest,
          leader_name: null,
          lifecycle_status: 'failed',
          phase: 'claimed',
          team_dissolve_operation_id: null,
          team_dissolve_handoff_id: null,
          team_dissolve_finalize: null,
          updated_at: Date.now(),
        });
        return { closed: false, target: targetView(retryable) };
      }
      const closed = await this.opts.store.saveTarget({
        ...latest,
        lifecycle_status: 'closed',
        phase: 'closed',
        team_dissolve_finalize: null,
        last_error: null,
        updated_at: Date.now(),
        closed_at: Date.now(),
      });
      return { closed: true, target: targetView(closed) };
    });
  }

  async closeRecord(
    record: ProvisionedTargetRecord,
  ): Promise<{ closed: boolean; target: ProvisionedTargetView | null }> {
    const prepared = await this.opts.targetLocks.run(
      targetRouteKey(record),
      async () => this.prepareUnderHeldTargetLock(
        await this.readExactTarget(record),
        record.close_event_id ?? undefined,
      ),
    );
    return this.finishPrepared(prepared);
  }

  private async recordCloseFailure(
    closing: ProvisionedTargetRecord,
    error: unknown,
  ): Promise<void> {
    await this.opts.targetLocks.run(targetRouteKey(closing), async () => {
      const latest = await this.readExactTarget(closing);
      if (!sameClosingHandoff(latest, closing)) return;
      await this.opts.store.saveTarget({
        ...latest,
        last_error: PUBLIC_TARGET_LIFECYCLE_ERROR,
        updated_at: Date.now(),
      });
    });
    this.opts.log.error(
      {
        dispatcher_id: this.opts.dispatcherId,
        space_name: closing.space_name,
        target_key: closing.target_key,
        err: { message: parseMessage(error) },
      },
      'collaboration target close failed (target remains in closing state for retry)',
    );
  }

  private readExactTarget(
    record: ProvisionedTargetRecord,
  ): Promise<ProvisionedTargetRecord | null> {
    return this.opts.store.getTarget(this.opts.dispatcherId, {
      channelId: record.channel_id,
      containerKey: record.container_key,
      bindingGeneration: record.binding_generation,
      targetKey: record.target_key,
    });
  }
}

function sameClosingHandoff(
  current: ProvisionedTargetRecord | null,
  expected: ProvisionedTargetRecord,
): current is ProvisionedTargetRecord {
  return current !== null &&
    current.lifecycle_status === 'closing' &&
    current.channel_id === expected.channel_id &&
    current.container_key === expected.container_key &&
    current.binding_generation === expected.binding_generation &&
    current.target_key === expected.target_key &&
    current.team_name === expected.team_name &&
    current.leader_name === expected.leader_name &&
    current.team_dissolve_handoff_id === expected.team_dissolve_handoff_id &&
    current.team_dissolve_operation_id ===
      expected.team_dissolve_operation_id &&
    current.team_dissolve_finalize === expected.team_dissolve_finalize;
}
