/**
 * The Dispatcher namespace's canonical Commands.
 *
 * The process-level {@link Dispatchers} collection owns dispatcher enumeration,
 * while the addressed Dispatcher's own Agent owns its turn intake and
 * interrupt, so all four definitions live beside that collection. Each one
 * addresses its target through the caller context; only `dispatcher.list` is
 * process-wide.
 */
import type {
  AgentRuntimeInterruptOutcome,
  CoreCommandContext,
  CoreCommandDefinition,
  SubmitCommand,
  TeamSubmitResult,
} from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import { mustDispatcherId } from '../../command/host.js';
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
import {
  CHANNEL_SUBMISSION_PROPERTIES,
  channelSubmitInput,
  parseChannelSubmission,
} from '../channel-submission.js';
import {
  teamSubmitResult,
  teamSubmitResultOutput,
} from '../team/requests.js';
import type { DispatcherService } from '../dispatcher-service/index.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherSummary,
} from '../dispatcher-service/types.js';
import type { DispatcherRow } from '../../state/dispatcher-store.js';

interface DispatcherSubmitInput {
  command: SubmitCommand;
}

interface DispatcherListResult {
  dispatchers: DispatcherSummary[];
}

interface DispatcherStatusResult {
  dispatcher_id: string;
  channel_identity: string;
  status: string;
  session_id: string | null;
  last_error: string | null;
}

/**
 * Everything `dispatcherCommands` looks up on the process host. Narrower than
 * `server/command-host.ts`'s full `CoreCommandHost`: only the members this
 * namespace's four definitions actually call.
 */
interface DispatcherCommandsResolver {
  summarize(): Promise<DispatcherSummary[]>;
  dispatcherRuntimeStatus(
    dispatcherId: string,
  ): Promise<DispatcherRuntimeStatus>;
  /** Throws when no dispatcher carries this id. */
  dispatcherRow(dispatcherId: string): DispatcherRow;
  /** Throws when the addressed dispatcher is not configured. */
  dispatcher(context: CoreCommandContext): DispatcherService;
}

export function dispatcherCommands(
  resolver: DispatcherCommandsResolver,
): readonly AnyCoreCommand[] {
  const list: CoreCommandDefinition<
    'dispatcher.list',
    void,
    DispatcherListResult
  > = {
    name: 'dispatcher.list',
    version: 1,
    input: NO_INPUT,
    output: objectSchema({ dispatchers: arrayOf(OBJECT) }, ['dispatchers']),
    parse(payload) {
      commandPayload(payload);
    },
    async execute() {
      return { dispatchers: await resolver.summarize() };
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
      },
      [
        'dispatcher_id',
        'channel_identity',
        'status',
        'session_id',
        'last_error',
      ],
    ),
    parse(payload) {
      commandPayload(payload);
    },
    async execute(context) {
      const id = mustDispatcherId(context);
      const row = resolver.dispatcherRow(id);
      const runtime = await resolver.dispatcherRuntimeStatus(id);
      return {
        dispatcher_id: row.dispatcher_id,
        channel_identity: row.channel_identity,
        status: runtime.status ?? 'stopped',
        session_id: runtime.sessionId,
        last_error: runtime.lastError,
      };
    },
  };

  const submit: CoreCommandDefinition<
    'dispatcher.submit',
    DispatcherSubmitInput,
    TeamSubmitResult
  > = {
    name: 'dispatcher.submit',
    version: 1,
    input: objectSchema(CHANNEL_SUBMISSION_PROPERTIES, ['text']),
    output: teamSubmitResultOutput,
    parse(payload) {
      return { command: parseChannelSubmission(commandPayload(payload)) };
    },
    async execute(context, input) {
      return teamSubmitResult(
        await resolver
          .dispatcher(context)
          .submitToAgent(channelSubmitInput(input.command)),
      );
    },
  };

  const interrupt: CoreCommandDefinition<
    'dispatcher.interrupt',
    void,
    AgentRuntimeInterruptOutcome
  > = {
    name: 'dispatcher.interrupt',
    version: 1,
    input: NO_INPUT,
    output: objectSchema({ status: enumOf(['interrupted', 'idle']) }, [
      'status',
    ]),
    parse(payload) {
      commandPayload(payload);
    },
    async execute(context) {
      return resolver.dispatcher(context).interruptAgent();
    },
  };

  return [
    list,
    status,
    submit,
    interrupt,
  ] as unknown as readonly AnyCoreCommand[];
}
