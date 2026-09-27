/**
 * The Team namespace's canonical Commands.
 *
 * The Team owns creation identity, leader submission, its read projections, and
 * interrupt, dissolve, so all seven definitions live with the collection that
 * owns those actions. External channel binding is deliberately absent: it is
 * Channel-owned behavior, not a Core Team Command.
 *
 * These are the shared `admin.sock` and Channel-to-Core surface, and only that.
 * An Agent reaches the same Team through the Team MCP delegate beside this file,
 * which calls the same {@link TeamsPort} methods with its own arguments
 * and its own provenance — so there is no caller-kind selector here, and no tool
 * flattened into a Command. What the two surfaces genuinely share — reading a
 * `team_name`, reading a history query, and the one submission receipt that is
 * more than a copy — belongs to the Team and lives in its own `types.ts`; the
 * Channel-facing submission fields both submit Commands share live in
 * `channel-submission.ts`, and `team.submit` composes them with `team_name`.
 */
import type {
  AgentRuntimeInterruptOutcome,
  TeamCreateCommand,
  TeamSummary,
  TeamSubmitCommand,
  TeamSubmitResult,
} from '@excitedjs/dreamux-types';

import type {
  CoreCommandContext,
  CoreCommandDefinition,
} from '../../command/types.js';
import type { AnyCoreCommand } from '../../command/registry.js';
import type { TeamsPort } from './teams-port.js';
import { optionalParsedSkillSources } from '../../agent-runtime/skill-sources.js';
import {
  commandPayload,
  mustNonBlankString,
  mustNonEmptyString,
  mustRecord,
  optionalBooleanField,
  optionalNonBlankString,
  optionalString,
} from '../../command/payload.js';
import { REPO_REQUEST_SCHEMA, repoRequest } from '../worktree/repo-request.js';
import {
  BOOLEAN,
  INTEGER,
  NON_EMPTY_STRING,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  boundedString,
  enumOf,
  objectSchema,
} from '../../command/schema.js';
import {
  CHANNEL_SUBMISSION_PROPERTIES,
  channelSubmitInput,
  parseChannelSubmission,
} from '../agent/channel-submission.js';
import {
  MAX_REQUEST_ID_LENGTH,
  teamCreatePayloadHash,
} from './create-request.js';
import type {
  TeamDissolveReceipt,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamListRow,
} from './types.js';
import {
  teamHistoryQuery,
  teamNameParam,
  teamSubmitResult,
  teamSubmitResultOutput,
} from './requests.js';

interface TeamCreateInput {
  command: TeamCreateCommand;
  payloadHash: string;
}

interface TeamSubmitInput {
  command: TeamSubmitCommand;
}

interface TeamInterruptInput {
  teamName: string;
}

interface TeamNameInput {
  teamName: string;
}

interface TeamHistoryInput {
  query: TeamHistoryQuery;
}

interface TeamDissolveInput {
  teamName: string;
  note: string;
  force?: boolean;
}

export function teamCommands(
  teams: (context: CoreCommandContext) => TeamsPort,
): readonly AnyCoreCommand[] {
  const create: CoreCommandDefinition<
    'team.create',
    TeamCreateInput,
    TeamSummary
  > = {
    name: 'team.create',
    version: 1,
    input: objectSchema(
      {
        request_id: boundedString(MAX_REQUEST_ID_LENGTH, 1),
        name_prefix: NON_EMPTY_STRING,
        intent: NON_EMPTY_STRING,
        leader: objectSchema(
          {
            agent_runtime: NON_EMPTY_STRING,
            identity: NON_EMPTY_STRING,
            prompt: STRING,
            skill_sources: arrayOf(OBJECT),
          },
          ['agent_runtime'],
        ),
        repo: REPO_REQUEST_SCHEMA,
      },
      ['request_id', 'name_prefix', 'intent', 'leader'],
    ),
    output: OBJECT,
    parse(payload) {
      const params = commandPayload(payload);
      const leader = mustRecord(params, 'leader');
      const prompt = optionalString(leader, 'prompt');
      const identity = optionalNonBlankString(leader, 'identity');
      const parsedSkillSources = optionalParsedSkillSources(leader);
      const repo = repoRequest(params, 'repo');
      const command: TeamCreateCommand = {
        request_id: mustNonBlankString(params, 'request_id'),
        name_prefix: mustNonBlankString(params, 'name_prefix'),
        intent: mustNonBlankString(params, 'intent'),
        leader: {
          agent_runtime: mustNonEmptyString(leader, 'agent_runtime'),
          ...(identity !== null ? { identity } : {}),
          ...(prompt !== null ? { prompt } : {}),
          ...(parsedSkillSources !== null
            ? { skill_sources: parsedSkillSources }
            : {}),
        },
        ...(repo !== null ? { repo } : {}),
      };
      return {
        command,
        // Hashed over the caller's own validated request, without Core's
        // injected TeamLeader requirements: those change with a Dreamux upgrade
        // and would otherwise turn a legitimate replay into a conflict.
        payloadHash: teamCreatePayloadHash(command),
      };
    },
    async execute(context, input) {
      // The repo/skill-source translation this used to do here now runs
      // inside `createFromRequest`, after the owning Dispatcher's `createTeam`
      // hook: a plugin tap sees (and may change) the same wire-shaped command
      // this parsed, not Core's already-resolved internal shape. No catch: an
      // idempotency conflict, a closed Team, and a missing Team already state
      // themselves, and anything else must reach the boundary that logs it
      // with its stack, name, and cause intact.
      return teams(context).createFromRequest({
        requestId: input.command.request_id,
        payloadHash: input.payloadHash,
        command: input.command,
        // No external submission advances the Dispatcher Agent: `admin.sock`
        // and a Channel Command both leave the TeamLeader to answer on its own
        // Channel, exactly as `team.submit` already states for a follow-up turn.
        deliverCompletionToDispatcher: false,
      });
    },
  };

  const submit: CoreCommandDefinition<
    'team.submit',
    TeamSubmitInput,
    TeamSubmitResult
  > = {
    name: 'team.submit',
    version: 1,
    input: objectSchema(
      {
        team_name: NON_EMPTY_STRING,
        intent: NON_EMPTY_STRING,
        ...CHANNEL_SUBMISSION_PROPERTIES,
      },
      ['text', 'team_name'],
    ),
    output: teamSubmitResultOutput,
    parse(payload) {
      const params = commandPayload(payload);
      const intent = optionalNonBlankString(params, 'intent');
      const command: TeamSubmitCommand = {
        ...parseChannelSubmission(params),
        team_name: teamNameParam(params, 'team_name'),
        ...(intent !== null ? { intent } : {}),
      };
      return { command };
    },
    async execute(context, input) {
      const admission = await teams(context).submitToLeader(
        input.command.team_name,
        {
          ...channelSubmitInput(input.command),
          // `intent` is Team-Command-only: it updates the leader's durable
          // recovery subject, and `dispatcher.submit` has no such field, so
          // the shared projection in channel-submission.ts deliberately
          // omits it. Presence is observable (core-command-adapters.test.ts
          // asserts an omitted intent is an omitted key, not an explicit
          // undefined), so this stays a conditional spread rather than a
          // plain assignment.
          ...(input.command.intent !== undefined
            ? { intent: input.command.intent }
            : {}),
          // No external submission advances the Dispatcher Agent. Who waits
          // for a leader's completion is a property of the operation, not of
          // the adapter that carried it: an Agent handing work to a Team
          // says so explicitly on the Team MCP delegate, while an external
          // caller — Channel or `admin.sock` — is answered by the TeamLeader
          // on its own Channel.
          deliverCompletionToDispatcher: false,
        },
      );
      return teamSubmitResult(admission);
    },
  };

  const interrupt: CoreCommandDefinition<
    'team.interrupt',
    TeamInterruptInput,
    AgentRuntimeInterruptOutcome
  > = {
    name: 'team.interrupt',
    version: 1,
    input: objectSchema({ team_name: NON_EMPTY_STRING }, ['team_name']),
    output: objectSchema({ status: enumOf(['interrupted', 'idle']) }, [
      'status',
    ]),
    parse(payload) {
      return {
        teamName: teamNameParam(commandPayload(payload), 'team_name'),
      };
    },
    async execute(context, input) {
      return teams(context).interruptLeader(input.teamName);
    },
  };

  const list: CoreCommandDefinition<
    'team.list',
    void,
    { teams: TeamListRow[] }
  > = {
    name: 'team.list',
    version: 1,
    input: objectSchema({}),
    output: objectSchema({ teams: arrayOf(OBJECT) }, ['teams']),
    parse(payload) {
      commandPayload(payload);
    },
    async execute(context) {
      return { teams: await teams(context).list() };
    },
  };

  const status: CoreCommandDefinition<
    'team.status',
    TeamNameInput,
    TeamSummary
  > = {
    name: 'team.status',
    version: 1,
    input: objectSchema({ team_name: NON_EMPTY_STRING }, ['team_name']),
    output: OBJECT,
    parse(payload) {
      return { teamName: teamNameParam(commandPayload(payload), 'team_name') };
    },
    async execute(context, input) {
      return teams(context).summary(input.teamName);
    },
  };

  const history: CoreCommandDefinition<
    'team.history',
    TeamHistoryInput,
    TeamHistoryResult
  > = {
    name: 'team.history',
    version: 1,
    input: objectSchema({
      team_name: NON_EMPTY_STRING,
      status: enumOf(['starting', 'running', 'closed']),
      repo: STRING,
      grep: STRING,
      since: INTEGER,
      until: INTEGER,
      limit: INTEGER,
      cursor: STRING,
    }),
    output: objectSchema(
      { items: arrayOf(OBJECT), next_cursor: NULLABLE_STRING },
      ['items', 'next_cursor'],
    ),
    parse(payload) {
      return { query: teamHistoryQuery(commandPayload(payload)) };
    },
    async execute(context, input) {
      return teams(context).history(input.query);
    },
  };

  const dissolve: CoreCommandDefinition<
    'team.dissolve',
    TeamDissolveInput,
    TeamDissolveReceipt
  > = {
    name: 'team.dissolve',
    version: 1,
    input: objectSchema(
      {
        team_name: NON_EMPTY_STRING,
        note: NON_EMPTY_STRING,
        force: BOOLEAN,
      },
      ['team_name', 'note'],
    ),
    output: objectSchema(
      {
        accepted: BOOLEAN,
        team_name: STRING,
        status: STRING,
      },
      ['accepted', 'team_name', 'status'],
    ),
    parse(payload) {
      const params = commandPayload(payload);
      return {
        teamName: teamNameParam(params, 'team_name'),
        note: mustNonBlankString(params, 'note'),
        ...optionalBooleanField(params, 'force'),
      };
    },
    async execute(context, input) {
      return teams(context).dissolve(input.teamName, {
        note: input.note,
        force: input.force === true,
        requester: 'dispatcher',
      });
    },
  };

  return [
    create,
    submit,
    interrupt,
    list,
    status,
    history,
    dissolve,
  ] as unknown as readonly AnyCoreCommand[];
}
