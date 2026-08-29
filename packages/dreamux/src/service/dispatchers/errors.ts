import { DreamuxError } from '../../platform/errors.js';

/** The caller addressed a dispatcher id this server does not have configured. */
export class DispatcherNotFoundError extends DreamuxError {
  constructor(dispatcherId: string) {
    super('DISPATCHER_NOT_FOUND', `no dispatcher with id '${dispatcherId}'`);
  }
}
