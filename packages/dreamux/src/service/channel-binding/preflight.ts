import { dispatcherChannelBindingsPath } from '../../platform/paths.js';
import { CollaborationSpaceStore } from '../collaboration-space/store.js';
import {
  routeKey,
  targetRouteKey,
} from '../collaboration-space/support.js';
import { readActiveV2ChannelBindingRouteKeys } from './store.js';

/**
 * Issue #209 binding store v3 upgrade preflight.
 *
 * A v2 row with `(channel_id, target_key)` is reusable as an explicit route only
 * when no open collaboration target shares that route key. The store file alone
 * cannot prove whether a v2 route was explicit or collaboration-managed after
 * bb56ab8, so the dispatcher startup/doctor layer checks the two stores
 * together and fails loud on ambiguous overlap.
 */
export async function detectAmbiguousV2ChannelBindingRoutes(
  dispatcherId: string,
): Promise<string | null> {
  const v2Routes = await readActiveV2ChannelBindingRouteKeys(dispatcherId);
  if (v2Routes.length === 0) return null;

  const routeKeys = new Set(
    v2Routes.map((route) => routeKey(route)),
  );
  const targets = await new CollaborationSpaceStore().listTargets(dispatcherId);
  const overlappingTargets = targets.filter(
    (target) =>
      target.lifecycle_status !== 'closed' &&
      target.lifecycle_status !== 'detached' &&
      routeKeys.has(targetRouteKey(target)),
  );
  if (overlappingTargets.length === 0) return null;

  return (
    `channel binding store for dispatcher ${dispatcherId} is version 2 and ` +
    `overlaps ${overlappingTargets.length} open collaboration target route(s). ` +
    'Dreamux 0.x cannot prove whether those routes were explicit binds or ' +
    'collaboration-managed routes — delete ' +
    `${dispatcherChannelBindingsPath(dispatcherId)} and re-bind the affected ` +
    'channel(s) after resolving the collaboration target state.'
  );
}
