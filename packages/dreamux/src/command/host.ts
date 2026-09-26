/**
 * The one caller-context fact every dispatcher-scoped Command shares: its
 * addressed `dispatcher_id`.
 *
 * This is kernel-safe (no domain type: only `platform/` + a `command/`-local
 * error) because it reads and validates a context field, nothing more —
 * resolving that id to an actual dispatcher requires the concrete
 * `DispatcherService`/`DispatcherRow` types, which is composition-tier work
 * (`server/command-host.ts`'s `mustDispatcher`/`mustDispatcherRow`).
 *
 * Addressing is caller context, not payload: the admin socket lifts the
 * caller-supplied `dispatcher_id` out of its request envelope, and a Channel
 * invoker binds the dispatcher that owns its session. A Command therefore never
 * re-reads `dispatcher_id` from its own input, and its input schema stays
 * closed around domain fields only.
 */
import { validateDispatcherId } from '../platform/dispatcher-id.js';
import type { CoreCommandContext } from '@excitedjs/dreamux-types';
import { ValidationError, throwCallerMistake } from './errors.js';

export function mustDispatcherId(context: CoreCommandContext): string {
  const id = context.dispatcher_id;
  if (id === undefined) {
    throw new ValidationError(
      'this command is dispatcher-scoped and the caller supplied no dispatcher_id',
    );
  }
  try {
    return validateDispatcherId(id);
  } catch (err) {
    // The id rule speaks in its own words; only its type becomes the caller's,
    // and anything else raised here is not the caller's fault to begin with.
    throwCallerMistake(err);
  }
}
