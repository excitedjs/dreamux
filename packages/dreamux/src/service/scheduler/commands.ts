/**
 * The Scheduler namespace's canonical Commands.
 *
 * A cron job belongs to exactly one owner — the Dispatcher Agent, or one Team's
 * TeamLeader — so every Command first resolves that owner's
 * {@link SchedulerCommands} surface and then delegates unchanged. Job validation
 * stays inside the scheduler service; these definitions own the declared payload
 * schema and the owner selection. The request codecs live with the scheduler's
 * types, the job projection with the store that produces the records, and the
 * failures with the rules that raise them — each stating its own reason and
 * next step. The cron MCP delegate reads the same helpers; neither adapter
 * reads the other.
 */
import type {
  CoreCommandContext,
  CoreCommandDefinition,
  JsonSchema,
} from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import { commandPayload, type CommandPayload } from '../../command/payload.js';
import {
  BOOLEAN,
  NON_EMPTY_STRING,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  objectSchema,
} from '../../command/schema.js';
import { optionalTeamNameParam } from '../team/requests.js';
import { cronJobResult, cronListResult, type CronJob } from './store.js';
import {
  cronCreateRequest,
  cronJobIdParam,
  cronUpdateRequest,
  type CronCreateRequest,
  type CronUpdateRequest,
  type SchedulerCommands,
} from './types.js';

/** The scheduler owner a cron Command addresses. */
interface CronOwnerInput {
  /** Absent selects the Dispatcher Agent's own scheduler. */
  teamId: string | null;
}

const OWNER_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  team_id: NON_EMPTY_STRING,
};

function cronOwnerInput(params: CommandPayload): CronOwnerInput {
  // Read through the Team's own name codec: a `team_id` the Team could never
  // have is this caller's mistake, not an unclassified failure raised inside
  // the lookup it would otherwise reach.
  return { teamId: optionalTeamNameParam(params, 'team_id') };
}

/** The one capability `schedulerCommands` needs from its addressed dispatcher. */
interface SchedulerCommandsDispatcher {
  readonly scheduler: SchedulerCommands;
  teamScheduler(teamId: string): Promise<SchedulerCommands>;
}

async function schedulerFor(
  resolveDispatcher: (
    context: CoreCommandContext,
  ) => SchedulerCommandsDispatcher,
  context: CoreCommandContext,
  input: CronOwnerInput,
): Promise<SchedulerCommands> {
  const dispatcher = resolveDispatcher(context);
  const { teamId } = input;
  if (teamId === null) return dispatcher.scheduler;
  // Resolving a Team-scoped owner can fail with a fact the Team already states:
  // gone and over stay two different answers, each keeping its own code.
  return dispatcher.teamScheduler(teamId);
}

interface CronCreateInput extends CronOwnerInput {
  request: CronCreateRequest;
}

interface CronUpdateInput extends CronOwnerInput {
  request: CronUpdateRequest;
}

interface CronDeleteInput extends CronOwnerInput {
  id: string;
}

export function schedulerCommands(
  dispatcher: (context: CoreCommandContext) => SchedulerCommandsDispatcher,
): readonly AnyCoreCommand[] {
  const list: CoreCommandDefinition<
    'scheduler.cron.list',
    CronOwnerInput,
    { jobs: CronJob[] }
  > = {
    name: 'scheduler.cron.list',
    version: 1,
    input: objectSchema(OWNER_PROPERTIES),
    output: objectSchema({ jobs: arrayOf(OBJECT) }, ['jobs']),
    parse: (payload) => cronOwnerInput(commandPayload(payload)),
    async execute(context, input) {
      return cronListResult(
        await (await schedulerFor(dispatcher, context, input)).list(),
      );
    },
  };

  const create: CoreCommandDefinition<
    'scheduler.cron.create',
    CronCreateInput,
    CronJob
  > = {
    name: 'scheduler.cron.create',
    version: 1,
    input: objectSchema(
      {
        ...OWNER_PROPERTIES,
        cron: STRING,
        prompt: NON_EMPTY_STRING,
        title: STRING,
        recurring: BOOLEAN,
        tz: STRING,
      },
      ['cron', 'prompt'],
    ),
    output: OBJECT,
    parse(payload) {
      const params = commandPayload(payload);
      return {
        ...cronOwnerInput(params),
        request: cronCreateRequest(params),
      };
    },
    async execute(context, input) {
      return cronJobResult(
        await (
          await schedulerFor(dispatcher, context, input)
        ).create(input.request),
      );
    },
  };

  const update: CoreCommandDefinition<
    'scheduler.cron.update',
    CronUpdateInput,
    CronJob
  > = {
    name: 'scheduler.cron.update',
    version: 1,
    input: objectSchema(
      {
        ...OWNER_PROPERTIES,
        id: STRING,
        cron: STRING,
        prompt: STRING,
        title: NULLABLE_STRING,
        recurring: BOOLEAN,
        tz: STRING,
        enabled: BOOLEAN,
      },
      ['id'],
    ),
    output: OBJECT,
    parse(payload) {
      const params = commandPayload(payload);
      return {
        ...cronOwnerInput(params),
        request: cronUpdateRequest(params),
      };
    },
    async execute(context, input) {
      return cronJobResult(
        await (
          await schedulerFor(dispatcher, context, input)
        ).update(input.request),
      );
    },
  };

  const remove: CoreCommandDefinition<
    'scheduler.cron.delete',
    CronDeleteInput,
    { id: string; deleted: boolean }
  > = {
    name: 'scheduler.cron.delete',
    version: 1,
    input: objectSchema({ ...OWNER_PROPERTIES, id: STRING }, ['id']),
    output: objectSchema({ id: STRING, deleted: BOOLEAN }, ['id', 'deleted']),
    parse(payload) {
      const params = commandPayload(payload);
      return { ...cronOwnerInput(params), id: cronJobIdParam(params) };
    },
    async execute(context, input) {
      return (await schedulerFor(dispatcher, context, input)).delete(input.id);
    },
  };

  return [list, create, update, remove] as unknown as readonly AnyCoreCommand[];
}
