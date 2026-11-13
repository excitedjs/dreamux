/**
 * The Server namespace's canonical Command.
 *
 * `server.status` is a process-level fact — pid, uptime, and the configured
 * dispatchers — so it is owned here, beside the process it describes, rather
 * than by any dispatcher-local service.
 */
import type { CoreCommandDefinition } from './command/types.js';

import { commandPayload } from './command/payload.js';
import type { AnyCoreCommand } from './command/registry.js';
import {
  BOOLEAN,
  INTEGER,
  NO_INPUT,
  OBJECT,
  arrayOf,
  objectSchema,
} from './command/schema.js';
import type { CoreCommandHost } from './server/command-host.js';
import type { DispatcherSummary } from './service/dispatcher-service/types.js';
import { ValidationError } from './platform/errors.js';

interface ServerStatus {
  pid: number;
  uptimeSec: number;
  dispatchers: DispatcherSummary[];
}

export function serverCommands(
  host: CoreCommandHost,
): readonly AnyCoreCommand[] {
  const status: CoreCommandDefinition<'server.status', void, ServerStatus> = {
    name: 'server.status',
    version: 1,
    input: NO_INPUT,
    output: objectSchema(
      {
        pid: INTEGER,
        uptimeSec: INTEGER,
        dispatchers: arrayOf(OBJECT),
      },
      ['pid', 'uptimeSec', 'dispatchers'],
    ),
    parse(payload) {
      commandPayload(payload);
    },
    async execute() {
      return {
        pid: process.pid,
        uptimeSec: Math.floor(process.uptime()),
        dispatchers: await host.dispatchers.summarize(),
      };
    },
  };
  const shutdown: CoreCommandDefinition<
    'server.shutdown',
    { expectedPid: number },
    { accepted: boolean; pid: number }
  > = {
    name: 'server.shutdown',
    version: 1,
    input: objectSchema({ expectedPid: { type: 'integer', minimum: 1 } }, [
      'expectedPid',
    ]),
    output: objectSchema({ accepted: BOOLEAN, pid: INTEGER }, [
      'accepted',
      'pid',
    ]),
    parse(payload) {
      return { expectedPid: commandPayload(payload).expectedPid as number };
    },
    async execute(_context, { expectedPid }) {
      if (expectedPid !== process.pid) {
        throw new ValidationError(
          'server process changed before shutdown request',
        );
      }
      host.requestShutdown();
      return { accepted: true, pid: process.pid };
    },
  };
  return [status as AnyCoreCommand, shutdown as AnyCoreCommand];
}
