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
 * context. The input codecs live with the Agent entity types and readers
 * that own the facts they read, and a failure states its own reason and next
 * step where the rule is. The TeamMate MCP delegate reads the same helpers;
 * neither adapter reads the other.
 */
import type {
  CoreCommandContext,
  CoreCommandDefinition,
} from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import {
  normalizeSkillSources,
  optionalParsedSkillSources,
} from '../../agent-runtime/skill-sources.js';
import { commandPayload } from '../../command/payload.js';
import {
  agentCloseRequest,
  agentEntityLastQuery,
  agentEntityNameParam,
  agentSendRequest,
  agentSpawnRequest,
  historyQuery,
  teammateReceiptSchema,
  type AgentCloseRequest,
  type AgentSendRequest,
} from './requests.js';
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
import { mapAgentActivityCommandError } from './activity.js';
import type {
  AgentEntityCapabilities,
  AgentEntityCloseResult,
  AgentEntityHistoryQuery,
  AgentEntityHistoryResult,
  AgentEntityLastQuery,
  AgentEntityLastResult,
  AgentEntityRuntimeStatus,
  AgentEntitySpawnResult,
} from './identity.js';
import type { TeamMateWorktreeRequest } from '../worktree/types.js';
import type { TeammateOps } from './types.js';

interface SpawnInput {
  name: string;
  prompt: string;
  intent: string;
  agentRuntime: string | null;
  identity: string | null;
  skillSources: ReturnType<typeof optionalParsedSkillSources>;
  repo: ReturnType<typeof repoRequest>;
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

/** The capabilities `teammateCommands` needs from its addressed dispatcher. */
interface TeammateCommandsDispatcher {
  workspace(): Promise<string>;
  readonly teammates: TeammateOps;
}

export function teammateCommands(
  resolveDispatcher: (
    context: CoreCommandContext,
  ) => TeammateCommandsDispatcher,
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
        prompt: NON_EMPTY_STRING,
        intent: NON_EMPTY_STRING,
        agent_runtime: NON_EMPTY_STRING,
        identity: NON_EMPTY_STRING,
        skill_sources: arrayOf(OBJECT),
        repo: REPO_REQUEST_SCHEMA,
      },
      ['name_prefix', 'prompt', 'intent'],
    ),
    output: teammateReceiptSchema,
    parse(payload) {
      const params = commandPayload(payload);
      return {
        ...agentSpawnRequest(params),
        skillSources: optionalParsedSkillSources(params),
        repo: repoRequest(params, 'repo'),
      };
    },
    async execute(context, input) {
      const dispatcher = resolveDispatcher(context);
      const skillSources = await normalizeSkillSources(input.skillSources);
      const repo = repoWorktree(input.repo);
      const cwd =
        repo === null ? null : (repo.cwd ?? (await dispatcher.workspace()));
      const worktree: TeamMateWorktreeRequest | null = repo?.worktree ?? null;
      const spawnInput = {
        name: input.name,
        prompt: input.prompt,
        intent: input.intent,
        ...(cwd !== null ? { cwd } : {}),
        ...(input.agentRuntime !== null
          ? { agentRuntime: input.agentRuntime }
          : {}),
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
    AgentSendRequest,
    AgentEntitySpawnResult
  > = {
    name: 'teammate.submit',
    version: 1,
    input: objectSchema(
      { name: STRING, prompt: NON_EMPTY_STRING, intent: NON_EMPTY_STRING },
      ['name', 'prompt'],
    ),
    output: teammateReceiptSchema,
    parse(payload) {
      return agentSendRequest(commandPayload(payload));
    },
    async execute(context, input) {
      return resolveDispatcher(context).teammates.send({
        name: input.name,
        prompt: input.prompt,
        ...(input.intent !== null ? { intent: input.intent } : {}),
      });
    },
  };

  const close: CoreCommandDefinition<
    'teammate.close',
    AgentCloseRequest,
    AgentEntityCloseResult
  > = {
    name: 'teammate.close',
    version: 1,
    input: objectSchema({ name: STRING, note: NON_EMPTY_STRING }, [
      'name',
      'note',
    ]),
    output: objectSchema({ teammate: OBJECT }, ['teammate']),
    parse(payload) {
      return agentCloseRequest(commandPayload(payload));
    },
    async execute(context, input) {
      return resolveDispatcher(context).teammates.close({
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
      return await resolveDispatcher(context).teammates.history(input.query);
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
      return {
        teammates: await resolveDispatcher(context).teammates.list(),
      };
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
        teammate: await resolveDispatcher(context).teammates.status(input.name),
      };
    },
  };

  const last: CoreCommandDefinition<
    'teammate.last',
    LastInput,
    AgentEntityLastResult
  > = {
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
        return await resolveDispatcher(context).teammates.last(
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
      return await resolveDispatcher(context).teammates.getCapabilities();
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
