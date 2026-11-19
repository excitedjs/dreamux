import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { errorInfo } from '@excitedjs/dreamux-utils';

import type { Server } from '../server.js';

/** Process exit bound for both signal and admin-requested shutdown. */
export const SERVER_SHUTDOWN_DEADLINE_MS = 15_000;

/** Install once for the serving process, immediately after starting Server. */
export function installServerShutdown(
  server: Pick<Server, 'shutdownRequested' | 'shutdown'>,
  startup: Promise<void>,
  logger: DreamuxLogger,
): void {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const requestShutdown = (reason: string): void => {
    if (deadline !== undefined) return;
    logger.info({ reason }, 'received shutdown request');
    deadline = setTimeout(() => {
      logger.error(
        { reason, deadline_ms: SERVER_SHUTDOWN_DEADLINE_MS },
        'server shutdown did not settle before its deadline; exiting',
      );
      process.exit(1);
    }, SERVER_SHUTDOWN_DEADLINE_MS);
    // Admin is reachable before startup finishes. Do not close owners while
    // startup can still create them; the deadline also bounds this wait.
    void startup
      .then(() => server.shutdown())
      .then(
        () => {
          clearTimeout(deadline);
          process.exit(0);
        },
        (error: unknown) => {
          clearTimeout(deadline);
          logger.error(
            { reason, err: errorInfo(error) },
            'server shutdown failed; exiting',
          );
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  void server.shutdownRequested.then(() => requestShutdown('admin'));
}
