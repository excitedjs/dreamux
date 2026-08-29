/**
 * The Server namespace's canonical Command.
 *
 * `server.status` is a process-level fact — pid, uptime, and the configured
 * dispatchers — so it is owned here, beside the process it describes, rather
 * than by any dispatcher-local service.
 */
import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from './command/registry.js';
import type { CoreCommandHost } from './command/host.js';
import { commandPayload } from './command/payload.js';
import {
  INTEGER,
  NO_INPUT,
  OBJECT,
  arrayOf,
  objectSchema,
} from './command/schema.js';
import type { DispatcherSummary } from './service/dispatcher-service/types.js';

interface ServerStatus {
  pid: number;
  uptimeSec: number;
  dispatchers: DispatcherSummary[];
}

export function serverCommands(host: CoreCommandHost): readonly AnyCoreCommand[] {
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
        dispatchers: await host.summarize(),
      };
    },
  };
  return [status as AnyCoreCommand];
}
