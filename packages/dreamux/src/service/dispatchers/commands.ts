/**
 * The Dispatcher namespace's canonical Commands.
 *
 * The process-level {@link Dispatchers} collection owns dispatcher enumeration,
 * while the addressed Dispatcher's own Agent owns its turn intake and
 * interrupt, so all four definitions live beside that collection. Each one
 * addresses its target through the caller context; only `dispatcher.list` is
 * process-wide.
 */
import type { DispatcherCommandHost as AddressedDispatcherHost } from '../../command/host.js';
import type { DispatcherConfig } from '../../config/config.js';
import type { DispatcherService } from '../dispatcher-service/index.js';
import type { Dispatchers } from './index.js';
import type {
  AgentRuntimeInterruptOutcome,
  SubmitCommand,
  TeamSubmitResult,
} from '@excitedjs/dreamux-types';

import { mustDispatcherId } from '../../command/host.js';
import { commandPayload } from '../../command/payload.js';
import type { AnyCoreCommand } from '../../command/registry.js';
import {
  NO_INPUT,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  enumOf,
  objectSchema,
} from '../../command/schema.js';
import type { CoreCommandDefinition } from '../../command/types.js';
import { dispatcherChannelIdentity } from '../../config/config.js';
import {
  CHANNEL_SUBMISSION_PROPERTIES,
  channelSubmitInput,
  parseChannelSubmission,
} from '../agent/channel-submission.js';
import type { DispatcherSummary } from '../dispatcher-service/types.js';
import { teamSubmitResult, teamSubmitResultOutput } from '../team/requests.js';

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
interface DispatcherCommandHost extends AddressedDispatcherHost<DispatcherService> {
  readonly dispatchers: Pick<Dispatchers, 'summarize' | 'status'>;
  configuredDispatcher(id: string): DispatcherConfig;
}

export function dispatcherCommands(
  host: DispatcherCommandHost,
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
      return { dispatchers: await host.dispatchers.summarize() };
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
      const dispatcher = host.configuredDispatcher(id);
      const runtime = await host.dispatchers.status(id);
      return {
        dispatcher_id: dispatcher.id,
        channel_identity: dispatcherChannelIdentity(dispatcher),
        status: runtime.status,
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
        await host
          .addressedDispatcher(context)
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
      return host.addressedDispatcher(context).interruptAgent();
    },
  };

  return [
    list,
    status,
    submit,
    interrupt,
  ] as unknown as readonly AnyCoreCommand[];
}
