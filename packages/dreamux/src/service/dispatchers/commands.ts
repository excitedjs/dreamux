/**
 * The Dispatcher namespace's canonical Commands.
 *
 * The process-level {@link Dispatchers} collection owns dispatcher enumeration
 * and lifecycle, so its Commands live beside it. Each one addresses its target
 * through the caller context; only `dispatcher.list` is process-wide.
 */
import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import {
  mustDispatcherId,
  mustDispatcherRow,
  type CoreCommandHost,
} from '../../command/host.js';
import { commandPayload } from '../../command/payload.js';
import {
  NO_INPUT,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  enumOf,
  objectSchema,
} from '../../command/schema.js';
import type { ChannelDescriptor } from '../dispatcher-service/channel-descriptor.js';
import type { DispatcherSummary } from '../dispatcher-service/types.js';

interface DispatcherListResult {
  dispatchers: DispatcherSummary[];
}

interface DispatcherStatusResult {
  dispatcher_id: string;
  channel_identity: string;
  status: string;
  session_id: string | null;
  last_error: string | null;
  channel_descriptors: ChannelDescriptor[];
}

/**
 * The closed shape of one Channel description.
 *
 * Declared here rather than left an open `OBJECT` — the treatment the rich
 * evolving DTOs above get — precisely because this one must not evolve
 * silently: it is the read model that faces a Channel's own callers, and a
 * closed schema makes an undeclared field a loud Core defect instead of a quiet
 * leak of whatever produced it.
 */
const CHANNEL_DESCRIPTOR = objectSchema(
  {
    channel_id: STRING,
    provider: STRING,
    identity: NULLABLE_STRING,
    commands: arrayOf(STRING),
    status: enumOf(['starting', 'ready', 'closing', 'closed']),
  },
  ['channel_id', 'provider', 'identity', 'commands', 'status'],
);

interface DispatcherStartResult {
  dispatcher_id: string;
  status: string | null;
}

const START_OUTPUT = objectSchema(
  { dispatcher_id: STRING, status: NULLABLE_STRING },
  ['dispatcher_id', 'status'],
);

export function dispatcherCommands(
  host: CoreCommandHost,
): readonly AnyCoreCommand[] {
  const list: CoreCommandDefinition<'dispatcher.list', void, DispatcherListResult> = {
    name: 'dispatcher.list',
    version: 1,
    input: NO_INPUT,
    output: objectSchema({ dispatchers: arrayOf(OBJECT) }, ['dispatchers']),
    parse(payload) {
      commandPayload(payload);
    },
    async execute() {
      return { dispatchers: await host.summarize() };
    },
  };

  const status: CoreCommandDefinition<
    'dispatcher.status',
    void,
    DispatcherStatusResult
  > = {
    name: 'dispatcher.status',
    version: 1,
    input: NO_INPUT,
    output: objectSchema(
      {
        dispatcher_id: STRING,
        channel_identity: STRING,
        status: STRING,
        session_id: NULLABLE_STRING,
        last_error: NULLABLE_STRING,
        channel_descriptors: arrayOf(CHANNEL_DESCRIPTOR),
      },
      [
        'dispatcher_id',
        'channel_identity',
        'status',
        'session_id',
        'last_error',
        'channel_descriptors',
      ],
    ),
    parse(payload) {
      commandPayload(payload);
    },
    async execute(context) {
      const id = mustDispatcherId(context);
      const row = mustDispatcherRow(host, id);
      const runtime = await host.dispatcherRuntimeStatus(id);
      return {
        dispatcher_id: row.dispatcher_id,
        channel_identity: row.channel_identity,
        status: runtime.status ?? 'stopped',
        session_id: runtime.sessionId,
        last_error: runtime.lastError,
        channel_descriptors: host.dispatcherChannels(id),
      };
    },
  };

  const start: CoreCommandDefinition<
    'dispatcher.start',
    void,
    DispatcherStartResult
  > = {
    name: 'dispatcher.start',
    version: 1,
    input: NO_INPUT,
    output: START_OUTPUT,
    parse(payload) {
      commandPayload(payload);
    },
    async execute(context) {
      const id = mustDispatcherId(context);
      mustDispatcherRow(host, id);
      const dispatcher = host.dispatcher(id);
      await dispatcher.start();
      return { dispatcher_id: id, status: dispatcher.runtimeStatus().status };
    },
  };

  return [list, status, start] as unknown as readonly AnyCoreCommand[];
}
