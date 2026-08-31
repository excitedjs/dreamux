/**
 * The Team namespace's canonical Commands.
 *
 * The Team owns creation identity, leader submission, its read projections, and
 * dissolve, so all six definitions live with the collection that owns those
 * actions. External channel binding is deliberately absent: it is Channel-owned
 * behavior, not a Core Team Command.
 *
 * These are the shared `admin.sock` and Channel-to-Core surface, and only that.
 * An Agent reaches the same Team through the Team MCP delegate beside this file,
 * which calls the same {@link DispatcherService} methods with its own arguments
 * and its own provenance — so there is no caller-kind selector here, and no tool
 * flattened into a Command. What the two surfaces genuinely share — reading a
 * `team_name`, reading a history query, and the one submission receipt that is
 * more than a copy — belongs to the Team and lives in its own `types.ts`; what
 * stays here is this surface's: the declared payload schema, the caller context,
 * and the `attrs` / `source_id` / bare-`text` fields only a Channel-facing
 * caller sends.
 */
import type {
  AgentRuntimeSkillSource,
  CoreCommandDefinition,
  TeamCreateCommand,
  TeamCreateResult,
  TeamSubmitCommand,
  TeamSubmitResult,
} from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import { mustDispatcher, type CoreCommandHost } from '../../command/host.js';
import { ValidationError } from '../../command/errors.js';
import {
  normalizeSkillSources,
  optionalParsedSkillSources,
} from '../../agent-runtime/skill-sources.js';
import {
  commandPayload,
  mustNonBlankString,
  mustNonEmptyString,
  mustRecord,
  optionalBooleanField,
  optionalNonBlankString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import {
  REPO_REQUEST_SCHEMA,
  repoRequest,
  repoWorktree,
} from '../worktree/repo-request.js';
import {
  BOOLEAN,
  INTEGER,
  NON_EMPTY_STRING,
  NULLABLE_OBJECT,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  boundedString,
  enumOf,
  objectSchema,
} from '../../command/schema.js';
import { CHANNEL_SOURCE } from '../submission-sources.js';
import { isSafeTagName } from '../teammate-service/submission.js';
import {
  MAX_REQUEST_ID_LENGTH,
  TEAM_LEADER_REQUIRED_SKILL_SOURCES,
  teamCreatePayloadHash,
} from './create-request.js';
import {
  optionalTeamNameParam,
  teamHistoryQuery,
  teamNameParam,
  type TeamDissolveReceipt,
  type TeamHistoryQuery,
  type TeamHistoryResult,
  type TeamSummary,
} from './types.js';
import { teamSubmitResult } from '../team-service/types.js';

/**
 * The maximum length of a caller-chosen `source_id`. Core deduplicates with it
 * scoped to the target entity, so it never has to be globally unique — a bound
 * this generous still admits any UUID, message id, or provider-scoped key a
 * Channel actually mints.
 */
const MAX_SOURCE_ID_LENGTH = 512;

interface TeamCreateInput {
  command: TeamCreateCommand;
  payloadHash: string;
  parsedSkillSources: readonly AgentRuntimeSkillSource[] | null;
}

interface TeamSubmitInput {
  command: TeamSubmitCommand;
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

export function teamCommands(host: CoreCommandHost): readonly AnyCoreCommand[] {
  const create: CoreCommandDefinition<'team.create', TeamCreateInput, TeamCreateResult> = {
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
    output: objectSchema(
      {
        status: enumOf(['created', 'existing', 'closed']),
        team_name: STRING,
        leader_name: STRING,
      },
      ['status', 'team_name', 'leader_name'],
    ),
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
        parsedSkillSources,
      };
    },
    async execute(context, input) {
      const dispatcher = mustDispatcher(host, context);
      const skillSources = await normalizeSkillSources(input.parsedSkillSources, {
        requiredSources: TEAM_LEADER_REQUIRED_SKILL_SOURCES,
      });
      const { command } = input;
      const repo = repoWorktree(command.repo ?? null);
      // A named repository request without an explicit path resolves to the
      // dispatcher's own workspace, exactly as the existing creation path does.
      const repoCwd =
        repo === null ? null : repo.cwd ?? (await dispatcher.workspace());
      // No catch: an idempotency conflict, a closed Team, and a missing Team
      // already state themselves, and anything else must reach the boundary
      // that logs it with its stack, name, and cause intact.
      return dispatcher.createTeam({
        requestId: command.request_id,
        payloadHash: input.payloadHash,
        options: {
          namePrefix: command.name_prefix,
          intent: command.intent,
          leaderAgentRuntime: command.leader.agent_runtime,
          ...(repoCwd !== null ? { repoCwd } : {}),
          ...(repo !== null ? { worktree: repo.worktree } : {}),
          ...(command.leader.prompt !== undefined
            ? { prompt: command.leader.prompt }
            : {}),
          ...(command.leader.identity !== undefined
            ? { identity: command.leader.identity }
            : {}),
          ...(skillSources !== null ? { skillSources } : {}),
        },
      });
    },
  };

  const submit: CoreCommandDefinition<'team.submit', TeamSubmitInput, TeamSubmitResult> = {
    name: 'team.submit',
    version: 1,
    input: objectSchema(
      {
        team_name: NON_EMPTY_STRING,
        // The one input object whose own keys are not declarable. Attribute
        // names are open by contract, and this validator's
        // `additionalProperties` is boolean-only, so no schema here can state
        // "open names, string values" — let alone start-tag safety. `parse`
        // owns the precise contract instead, the same split `skill_sources`
        // already uses. Attribute count and size need no separate cap: every
        // payload is already bounded by `COMMAND_PAYLOAD_BOUNDS`.
        attrs: OBJECT,
        text: NON_EMPTY_STRING,
        reminder: STRING,
        intent: NON_EMPTY_STRING,
        source_id: boundedString(MAX_SOURCE_ID_LENGTH),
      },
      ['text'],
    ),
    output: objectSchema(
      {
        status: enumOf(['submitted', 'duplicate', 'stopped', 'failed', 'ambiguous']),
        turn_id: STRING,
        error: objectSchema({ code: STRING, message: STRING }, ['code', 'message']),
      },
      ['status'],
    ),
    parse(payload) {
      const params = commandPayload(payload);
      const teamName = optionalTeamNameParam(params, 'team_name');
      const attrs = submissionAttrs(params);
      const reminder = optionalString(params, 'reminder');
      const intent = optionalNonBlankString(params, 'intent');
      const sourceId = optionalString(params, 'source_id');
      if (sourceId !== null && sourceId.length > MAX_SOURCE_ID_LENGTH) {
        throw new ValidationError(
          `param 'source_id' must be at most ${MAX_SOURCE_ID_LENGTH} characters`,
        );
      }
      return {
        command: {
          ...(teamName !== null ? { team_name: teamName } : {}),
          ...(attrs !== null ? { attrs } : {}),
          text: mustNonEmptyString(params, 'text'),
          ...(reminder !== null ? { reminder } : {}),
          ...(intent !== null ? { intent } : {}),
          ...(sourceId !== null ? { source_id: sourceId } : {}),
        },
      };
    },
    async execute(context, input) {
      const dispatcher = mustDispatcher(host, context);
      const { command } = input;
      const shared = {
        ...(command.attrs !== undefined ? { attrs: command.attrs } : {}),
        text: command.text,
        ...(command.reminder !== undefined ? { reminder: command.reminder } : {}),
        ...(command.source_id !== undefined && command.source_id !== ''
          ? { sourceId: command.source_id }
          : {}),
        ...(command.intent !== undefined ? { intent: command.intent } : {}),
      };
      const admission =
        command.team_name === undefined
          ? await dispatcher.submitToAgent({
              ...shared,
              source: CHANNEL_SOURCE,
            })
          : await dispatcher.submitToTeamLeader({
              ...shared,
              teamId: command.team_name,
              // Every `team.submit` is the Channel-facing surface, whether it
              // arrived over a Channel adapter or `admin.sock`, so it reaches
              // the model under one provenance name.
              source: CHANNEL_SOURCE,
              // No external submission advances the Dispatcher Agent. Who
              // waits for a leader's completion is a property of the
              // operation, not of the adapter that carried it: an Agent
              // handing work to a Team says so explicitly on the Team MCP
              // delegate, while an external caller — Channel or `admin.sock`
              // — is answered by the TeamLeader on its own Channel.
              deliverCompletionToDispatcher: false,
            });
      return teamSubmitResult(admission);
    },
  };

  const list: CoreCommandDefinition<'team.list', void, { teams: unknown[] }> = {
    name: 'team.list',
    version: 1,
    input: objectSchema({}),
    output: objectSchema({ teams: arrayOf(OBJECT) }, ['teams']),
    parse(payload) {
      commandPayload(payload);
    },
    async execute(context) {
      const dispatcher = mustDispatcher(host, context);
      return { teams: await dispatcher.listTeams() };
    },
  };

  const status: CoreCommandDefinition<'team.status', TeamNameInput, TeamSummary> = {
    name: 'team.status',
    version: 1,
    input: objectSchema(
      { team_name: NON_EMPTY_STRING },
      ['team_name'],
    ),
    output: objectSchema(
      {
        team: OBJECT,
        leader: NULLABLE_OBJECT,
        member_count: INTEGER,
      },
      ['team', 'leader', 'member_count'],
    ),
    parse(payload) {
      return { teamName: teamNameParam(commandPayload(payload), 'team_name') };
    },
    async execute(context, input) {
      const dispatcher = mustDispatcher(host, context);
      return dispatcher.getTeamStatus(input.teamName);
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
      const dispatcher = mustDispatcher(host, context);
      return dispatcher.getTeamHistory(input.query);
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
      const dispatcher = mustDispatcher(host, context);
      return dispatcher.dissolveTeam({
        teamId: input.teamName,
        note: input.note,
        ...(input.force !== undefined ? { force: input.force } : {}),
      });
    },
  };

  return [
    create,
    submit,
    list,
    status,
    history,
    dissolve,
  ] as unknown as readonly AnyCoreCommand[];
}

/**
 * Read the optional display attributes.
 *
 * Attribute names are open by contract, so no declared schema can check them.
 * The rule that decides whether a name may be written into a start tag belongs
 * to the renderer that writes it and is reused here, at the caller boundary, so
 * a bad name fails as this caller's mistake before anything is resolved,
 * reserved, or started — instead of reaching the renderer, where the same name
 * is an internal defect and would surface as one. An empty object is exactly an
 * omitted one.
 *
 * The record is rebuilt with `Object.fromEntries` rather than by assignment: a
 * canonical payload carries an own `__proto__` key as ordinary data, and
 * assigning that name onto a plain object would reach the inherited setter and
 * silently drop the attribute.
 */
function submissionAttrs(
  params: CommandPayload,
): Readonly<Record<string, string>> | null {
  const value = params['attrs'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError("param 'attrs' must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [name, entry] of entries) {
    if (!isSafeTagName(name)) {
      throw new ValidationError(
        `param 'attrs' name ${JSON.stringify(name)} is not a safe attribute name`,
      );
    }
    if (typeof entry !== 'string') {
      throw new ValidationError(`param 'attrs.${name}' must be a string`);
    }
  }
  return entries.length > 0
    ? (Object.fromEntries(entries) as Record<string, string>)
    : null;
}
