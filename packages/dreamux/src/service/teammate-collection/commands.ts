/**
 * The TeamMate namespace's canonical Commands.
 *
 * Every one of them operates on the addressed dispatcher's own TeamMate
 * collection. There is no caller-kind selector: an Agent never reaches these
 * definitions, and a TeamLeader's TeamMate surface is its own MCP delegate,
 * bound to its Team by the lease that admitted the call rather than by a
 * payload field a model could set. Name validation, roster scoping,
 * close/reopen semantics, and Activity reads stay inside the collection and its
 * services; these definitions own the declared payload schema and the caller
 * context. The input codecs live with the agent-entity types and readers
 * that own the facts they read, and a failure states its own reason and next
 * step where the rule is. The TeamMate MCP delegate reads the same helpers;
 * neither adapter reads the other.
 */
import type { CoreCommandDefinition, JsonSchema } from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import { mustDispatcher, type CoreCommandHost } from '../../command/host.js';
import {
  normalizeSkillSources,
  optionalParsedSkillSources,
} from '../../agent-runtime/skill-sources.js';
import {
  commandPayload,
  mustNonBlankString,
  mustString,
  optionalNonBlankString,
  optionalString,
} from '../../command/payload.js';
import { historyQuery } from '../agent-entity/history-query.js';
import {
  REPO_REQUEST_SCHEMA,
  repoRequest,
  repoWorktree,
} from '../worktree/repo-request.js';
import {
  BOOLEAN,
  INTEGER,
  NON_EMPTY_STRING,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  enumOf,
  objectSchema,
} from '../../command/schema.js';
import { mapAgentActivityCommandError } from '../agent-entity/activity-errors.js';
import type {
  AgentEntityCapabilities,
  AgentEntityCloseResult,
  AgentEntityHistoryQuery,
  AgentEntityHistoryResult,
  AgentEntityLastQuery,
  AgentEntityLastResult,
  AgentEntityRuntimeStatus,
  AgentEntitySpawnResult,
} from '../agent-entity/types.js';
import {
  agentEntityLastQuery,
  agentEntityNameParam,
} from '../agent-entity/read-helpers.js';
import type { TeamMateWorktreeRequest } from './types.js';

/** The shared admission-outcome vocabulary of a prompt submission receipt. */
const SUBMISSION_STATUS: JsonSchema = enumOf([
  'submitted',
  'duplicate',
  'stopped',
  'failed',
  'ambiguous',
]);

interface SpawnInput {
  name: string;
  prompt: string;
  intent: string;
  agentRuntime: string | null;
  identity: string | null;
  skillSources: ReturnType<typeof optionalParsedSkillSources>;
  repo: ReturnType<typeof repoRequest>;
}

interface SendInput {
  name: string;
  prompt: string;
  intent: string | null;
}

interface CloseInput {
  name: string;
  note: string;
}

interface NameInput {
  name: string;
}

interface HistoryInput {
  query: AgentEntityHistoryQuery;
}

interface LastInput {
  name: string;
  query: AgentEntityLastQuery;
}

export function teammateCommands(
  host: CoreCommandHost,
): readonly AnyCoreCommand[] {
  const spawn: CoreCommandDefinition<
    'teammate.spawn',
    SpawnInput,
    AgentEntitySpawnResult
  > = {
    name: 'teammate.spawn',
    version: 1,
    input: objectSchema(
      {
        name_prefix: STRING,
        prompt: STRING,
        intent: NON_EMPTY_STRING,
        agent_runtime: STRING,
        identity: NON_EMPTY_STRING,
        skill_sources: arrayOf(OBJECT),
        repo: REPO_REQUEST_SCHEMA,
      },
      ['name_prefix', 'prompt', 'intent'],
    ),
    output: objectSchema(
      {
        teammate: OBJECT,
        status: SUBMISSION_STATUS,
        error: STRING,
      },
      ['teammate', 'status'],
    ),
    parse(payload) {
      const params = commandPayload(payload);
      return {
        name: mustNonBlankString(params, 'name_prefix'),
        prompt: mustString(params, 'prompt'),
        intent: mustNonBlankString(params, 'intent'),
        agentRuntime: optionalString(params, 'agent_runtime'),
        identity: optionalNonBlankString(params, 'identity'),
        skillSources: optionalParsedSkillSources(params),
        repo: repoRequest(params, 'repo'),
      };
    },
    async execute(context, input) {
      const dispatcher = mustDispatcher(host, context);
      const skillSources = await normalizeSkillSources(input.skillSources);
      const repo = repoWorktree(input.repo);
      const cwd =
        repo === null ? null : repo.cwd ?? (await dispatcher.workspace());
      const worktree: TeamMateWorktreeRequest | null = repo?.worktree ?? null;
      const spawnInput = {
        name: input.name,
        prompt: input.prompt,
        intent: input.intent,
        ...(cwd !== null ? { cwd } : {}),
        ...(input.agentRuntime !== null ? { agentRuntime: input.agentRuntime } : {}),
        ...(input.identity !== null ? { identity: input.identity } : {}),
        ...(skillSources !== null ? { skillSources } : {}),
        ...(worktree !== null ? { worktree } : {}),
      };
      // No catch: a spawn's own failures state themselves, and anything else
      // must reach the boundary that logs it with its stack intact.
      return dispatcher.teammates.spawn(spawnInput);
    },
  };

  const submit: CoreCommandDefinition<
    'teammate.submit',
    SendInput,
    AgentEntitySpawnResult
  > = {
    name: 'teammate.submit',
    version: 1,
    input: objectSchema(
      { name: STRING, prompt: STRING, intent: STRING },
      ['name', 'prompt'],
    ),
    output: objectSchema(
      { teammate: OBJECT, status: SUBMISSION_STATUS, error: STRING },
      ['teammate', 'status'],
    ),
    parse(payload) {
      const params = commandPayload(payload);
      return {
        name: agentEntityNameParam(params, 'name'),
        prompt: mustString(params, 'prompt'),
        intent: optionalString(params, 'intent'),
      };
    },
    async execute(context, input) {
      return mustDispatcher(host, context).teammates.send({
        name: input.name,
        prompt: input.prompt,
        ...(input.intent !== null ? { intent: input.intent } : {}),
      });
    },
  };

  const close: CoreCommandDefinition<
    'teammate.close',
    CloseInput,
    AgentEntityCloseResult
  > = {
    name: 'teammate.close',
    version: 1,
    input: objectSchema(
      { name: STRING, note: NON_EMPTY_STRING },
      ['name', 'note'],
    ),
    output: objectSchema({ teammate: OBJECT }, ['teammate']),
    parse(payload) {
      const params = commandPayload(payload);
      return {
        name: agentEntityNameParam(params, 'name'),
        note: mustNonBlankString(params, 'note'),
      };
    },
    async execute(context, input) {
      return mustDispatcher(host, context).teammates.close({
        name: input.name,
        note: input.note,
      });
    },
  };

  const history: CoreCommandDefinition<
    'teammate.history',
    HistoryInput,
    AgentEntityHistoryResult
  > = {
    name: 'teammate.history',
    version: 1,
    input: objectSchema({
      name: STRING,
      status: enumOf(['starting', 'running', 'degraded', 'closed', 'stopped']),
      agent_runtime: STRING,
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
      return { query: historyQuery(commandPayload(payload)) };
    },
    async execute(context, input) {
      return await mustDispatcher(host, context).teammates.history(input.query);
    },
  };

  const list: CoreCommandDefinition<
    'teammate.list',
    Record<string, never>,
    { teammates: AgentEntityRuntimeStatus[] }
  > = {
    name: 'teammate.list',
    version: 1,
    input: objectSchema({}),
    output: objectSchema({ teammates: arrayOf(OBJECT) }, ['teammates']),
    parse: () => ({}),
    async execute(context) {
      return { teammates: await mustDispatcher(host, context).teammates.list() };
    },
  };

  const status: CoreCommandDefinition<
    'teammate.status',
    NameInput,
    { teammate: AgentEntityRuntimeStatus }
  > = {
    name: 'teammate.status',
    version: 1,
    input: objectSchema({ name: STRING }, ['name']),
    output: objectSchema({ teammate: OBJECT }, ['teammate']),
    parse(payload) {
      return { name: agentEntityNameParam(commandPayload(payload), 'name') };
    },
    async execute(context, input) {
      return {
        teammate: await mustDispatcher(host, context).teammates.status(input.name),
      };
    },
  };

  const last: CoreCommandDefinition<'teammate.last', LastInput, AgentEntityLastResult> = {
    name: 'teammate.last',
    version: 1,
    input: objectSchema(
      {
        name: STRING,
        limit: INTEGER,
        cursor: STRING,
        include_tools: BOOLEAN,
      },
      ['name'],
    ),
    output: objectSchema(
      {
        teammate: OBJECT,
        requested_records: INTEGER,
        returned_records: INTEGER,
        records: arrayOf(OBJECT),
        next_cursor: NULLABLE_STRING,
        truncated: BOOLEAN,
      },
      [
        'teammate',
        'requested_records',
        'returned_records',
        'records',
        'next_cursor',
        'truncated',
      ],
    ),
    parse(payload) {
      const params = commandPayload(payload);
      return {
        name: agentEntityNameParam(params, 'name'),
        query: agentEntityLastQuery(params),
      };
    },
    async execute(context, input) {
      try {
        return await mustDispatcher(host, context).teammates.last(
          input.name,
          input.query,
        );
      } catch (error) {
        return mapAgentActivityCommandError(error);
      }
    },
  };

  const capabilities: CoreCommandDefinition<
    'teammate.capabilities',
    Record<string, never>,
    AgentEntityCapabilities
  > = {
    name: 'teammate.capabilities',
    version: 1,
    input: objectSchema({}),
    output: objectSchema(
      { verbs: arrayOf(STRING), agent_runtimes: arrayOf(OBJECT) },
      ['verbs', 'agent_runtimes'],
    ),
    parse: () => ({}),
    async execute(context) {
      return await mustDispatcher(host, context).teammates.getCapabilities();
    },
  };

  return [
    spawn,
    submit,
    close,
    history,
    list,
    status,
    last,
    capabilities,
  ] as unknown as readonly AnyCoreCommand[];
}
