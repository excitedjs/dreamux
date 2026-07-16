import type { ChannelService } from '../channel-service/index.js';
import type { KeyedAsyncQueue } from '../serial-queue.js';
import type { CollaborationRouteReconciler } from './route-reconciliation.js';
import type { CollaborationSpaceStore } from './store.js';
import { requiredBinding, targetRouteKey } from './support.js';
import {
  routeClaimIdForTarget,
  targetFromRecord,
} from './target.js';
import type { CollaborationSpaceRecord } from './types.js';

export async function detachActiveTargets(input: {
  dispatcherId: string;
  channels: ChannelService;
  store: CollaborationSpaceStore;
  targetLocks: KeyedAsyncQueue;
  routes: CollaborationRouteReconciler;
  space: CollaborationSpaceRecord;
}): Promise<{ detached_targets: number; released_bindings: number }> {
  const binding = requiredBinding(input.space);
  const targets = await input.store.listTargets(input.dispatcherId, {
    spaceName: input.space.space_name,
    channelId: input.space.channel_id,
    containerKey: input.space.container_key,
    bindingGeneration: binding.generation,
  });
  let detached = 0;
  let released = 0;
  for (const target of targets) {
    if (
      target.lifecycle_status !== 'active' &&
      target.lifecycle_status !== 'creating' &&
      target.lifecycle_status !== 'failed' &&
      target.lifecycle_status !== 'detached'
    ) {
      continue;
    }
    await input.targetLocks.run(targetRouteKey(target), async () => {
      const latest = await input.store.getTarget(input.dispatcherId, {
        channelId: target.channel_id,
        containerKey: target.container_key,
        bindingGeneration: target.binding_generation,
        targetKey: target.target_key,
      });
      if (
        latest === null ||
        (latest.lifecycle_status !== 'active' &&
          latest.lifecycle_status !== 'creating' &&
          latest.lifecycle_status !== 'failed' &&
          latest.lifecycle_status !== 'detached')
      ) {
        return;
      }
      const detachedTarget = latest.lifecycle_status === 'detached'
        ? latest
        : await input.routes.saveDetached(latest);
      if (latest.lifecycle_status !== 'detached') detached += 1;
      const bindingRow = await input.channels.releaseResolvedTargetIfClaimed({
        claimId: routeClaimIdForTarget(detachedTarget),
        channelId: detachedTarget.channel_id,
        target: targetFromRecord(detachedTarget),
      });
      if (bindingRow !== null) released += 1;
    });
  }
  return { detached_targets: detached, released_bindings: released };
}
