/**
 * The Scheduler namespace's canonical Commands.
 *
 * A cron job belongs to exactly one owner — the Dispatcher Agent, or one Team's
 * TeamLeader — so every Command first resolves that owner's
 * {@link SchedulerCommands} surface and then delegates unchanged. Job validation
 * stays inside the scheduler service; these definitions own only the payload
 * contract and the owner selection.
 */
import type {
  CoreCommandContext,
  CoreCommandDefinition,
  JsonSchema,
} from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import { mustDispatcher, type CoreCommandHost } from '../../command/host.js';
import {
  commandPayload,
  mustNonEmptyString,
  mustString,
  optionalBooleanField,
  optionalNullableStringField,
  optionalRecordField,
  optionalString,
  optionalStringField,
  type CommandPayload,
} from '../../command/payload.js';
import { DreamuxError, errorMessage } from '../../command/errors.js';
import {
  BOOLEAN,
  NON_EMPTY_STRING,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  objectSchema,
} from '../../command/schema.js';
import { isTeamUnavailable } from '../team-collection/errors.js';
import type { CronJob } from './store.js';
import type { CronCreateRequest, CronUpdateRequest, SchedulerCommands } from './types.js';

/** The scheduler owner a cron Command addresses. */
interface CronOwnerInput {
  /** Absent selects the Dispatcher Agent's own scheduler. */
  teamId: string | null;
}

const OWNER_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  team_id: NON_EMPTY_STRING,
};

function cronOwnerInput(params: CommandPayload): CronOwnerInput {
  return { teamId: optionalString(params, 'team_id') };
}

async function schedulerFor(
  host: CoreCommandHost,
  context: CoreCommandContext,
  input: CronOwnerInput,
): Promise<SchedulerCommands> {
  const dispatcher = mustDispatcher(host, context);
  if (input.teamId === null) return dispatcher.scheduler;
  try {
    return await dispatcher.teamScheduler(input.teamId);
  } catch (err) {
    // A cron caller addressing a Team it cannot schedule against gets one fact,
    // whether the Team is missing or closed.
    if (isTeamUnavailable(err)) {
      throw new DreamuxError('TEAM_NOT_FOUND', errorMessage(err));
    }
    throw err;
  }
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
  host: CoreCommandHost,
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
      return (await schedulerFor(host, context, input)).list();
    },
  };

  const create: CoreCommandDefinition<'scheduler.cron.create', CronCreateInput, CronJob> = {
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
        action: OBJECT,
      },
      ['cron', 'prompt'],
    ),
    output: OBJECT,
    parse(payload) {
      const params = commandPayload(payload);
      return {
        ...cronOwnerInput(params),
        request: {
          cron: mustString(params, 'cron'),
          prompt: mustNonEmptyString(params, 'prompt'),
          ...optionalStringField(params, 'title'),
          ...optionalBooleanField(params, 'recurring'),
          ...optionalStringField(params, 'tz'),
          ...optionalRecordField(params, 'action'),
        },
      };
    },
    async execute(context, input) {
      return (await schedulerFor(host, context, input)).create(input.request);
    },
  };

  const update: CoreCommandDefinition<'scheduler.cron.update', CronUpdateInput, CronJob> = {
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
        action: OBJECT,
        enabled: BOOLEAN,
      },
      ['id'],
    ),
    output: OBJECT,
    parse(payload) {
      const params = commandPayload(payload);
      return {
        ...cronOwnerInput(params),
        request: {
          id: mustString(params, 'id'),
          ...optionalStringField(params, 'cron'),
          ...optionalStringField(params, 'prompt'),
          ...optionalNullableStringField(params, 'title'),
          ...optionalBooleanField(params, 'recurring'),
          ...optionalStringField(params, 'tz'),
          ...optionalRecordField(params, 'action'),
          ...optionalBooleanField(params, 'enabled'),
        },
      };
    },
    async execute(context, input) {
      return (await schedulerFor(host, context, input)).update(input.request);
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
      return { ...cronOwnerInput(params), id: mustString(params, 'id') };
    },
    async execute(context, input) {
      return (await schedulerFor(host, context, input)).delete(input.id);
    },
  };

  return [list, create, update, remove] as unknown as readonly AnyCoreCommand[];
}
