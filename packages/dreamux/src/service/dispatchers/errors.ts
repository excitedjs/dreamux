import { StatedFailure } from '../../platform/errors.js';

/** The caller addressed a dispatcher id this server does not have configured. */
export class DispatcherNotFoundError extends StatedFailure {
  constructor(dispatcherId: string) {
    super(
      'DISPATCHER_NOT_FOUND',
      `no dispatcher with id '${dispatcherId}'`,
      'Name a dispatcher_id this server is configured with, then call again.',
    );
  }
}
