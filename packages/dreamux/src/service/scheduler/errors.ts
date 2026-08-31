/**
 * The one cron fact a caller can act on that is not its own request.
 *
 * A job id that names nothing was a plain `Error`, which made it `INTERNAL` to
 * every adapter: a caller that passed a stale id was told that something went
 * wrong on the server rather than that the job is gone. It is an ordinary
 * business failure — the scheduler knows exactly what is true — so it carries
 * its own stable code.
 */
import { StatedFailure } from '../../platform/errors.js';

export class CronJobNotFoundError extends StatedFailure {
  constructor(message: string) {
    super(
      'CRON_JOB_NOT_FOUND',
      message,
      'List this agent\'s cron jobs through this surface and use an exact id ' +
        'from that list; an id from another owner never resolves here.',
    );
  }
}
