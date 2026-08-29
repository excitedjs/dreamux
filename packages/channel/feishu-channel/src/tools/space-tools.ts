/**
 * The Dispatcher's Collaboration Space tools.
 *
 * Core's Collaboration Space entity is gone; the external product operation is
 * not. An operator still registers one Feishu topic group as a space and gets
 * a Team per topic — but the policy that says so is a Feishu record, the Teams
 * it creates are ordinary Teams, and the bindings it installs are ordinary
 * bindings. Unbinding the space stops future provisioning and nothing else:
 * no Team is dissolved and no existing route is removed.
 */
import type { FeishuSpaceRecord } from '../routing/document.js';
import type { FeishuToolDef, FeishuToolResult } from './types.js';
import {
  asRecord,
  closedObjectSchema,
  nonEmptyString,
  optionalRecord,
  optionalString,
  requireString,
} from './schema.js';

const mutating = { readOnlyHint: false, destructiveHint: false } as const;
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const spaceSchema = closedObjectSchema(
  {
    space_name: nonEmptyString,
    chat_id: nonEmptyString,
    display: { type: ['string', 'null'] },
    generation: { type: 'number' },
    leader_agent_runtime: nonEmptyString,
    has_identity: { type: 'boolean' },
    repo_path: { type: ['string', 'null'] },
    repo_base_ref: { type: ['string', 'null'] },
    created_at: { type: 'number' },
    updated_at: { type: 'number' },
  },
  [
    'space_name',
    'chat_id',
    'display',
    'generation',
    'leader_agent_runtime',
    'has_identity',
    'repo_path',
    'repo_base_ref',
    'created_at',
    'updated_at',
  ],
);

function spaceView(space: FeishuSpaceRecord): FeishuToolResult {
  return {
    space_name: space.space_name,
    chat_id: space.container_chat_id,
    display: space.display,
    generation: space.generation,
    leader_agent_runtime: space.leader_agent_runtime,
    has_identity: space.identity !== null,
    repo_path: space.repo?.path ?? null,
    repo_base_ref: space.repo?.base_ref ?? null,
    created_at: space.created_at,
    updated_at: space.updated_at,
  };
}

interface BindSpaceInput {
  spaceName: string;
  chatId: string;
  display: string | null;
  leaderAgentRuntime: string;
  identity: string | null;
  repo: { path: string; base_ref: string | null } | null;
}

export const bindSpaceDef: FeishuToolDef<BindSpaceInput> = {
  name: 'bind_collaboration_space',
  title: 'Bind a Feishu collaboration space',
  description:
    'Register a Feishu topic group so each new topic in it is provisioned ' +
    'with its own Team and bound automatically. Re-running it updates the ' +
    'policy for future topics only.',
  callers: ['dispatcher'],
  inputSchema: closedObjectSchema(
    {
      space_name: {
        ...nonEmptyString,
        description: 'Operator-chosen name for this space.',
      },
      chat_id: {
        ...nonEmptyString,
        description: 'Feishu chat id of the topic group to register.',
      },
      display: { ...nonEmptyString, description: 'Optional human label.' },
      leader_agent_runtime: {
        ...nonEmptyString,
        description: 'Agent runtime each provisioned TeamLeader runs on.',
      },
      identity: {
        type: 'string',
        description: 'Optional extra TeamLeader identity guidance.',
      },
      repo: closedObjectSchema(
        {
          path: {
            ...nonEmptyString,
            description:
              'Source repository each Team branches a worktree from.',
          },
          base_ref: {
            ...nonEmptyString,
            description: 'Optional base ref for that worktree.',
          },
        },
        ['path'],
      ),
    },
    ['space_name', 'chat_id', 'leader_agent_runtime'],
  ),
  outputSchema: closedObjectSchema({ space: spaceSchema }, ['space']),
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'bind_collaboration_space arguments');
    const repo = optionalRecord(obj, 'repo');
    return {
      spaceName: requireString(obj, 'space_name'),
      chatId: requireString(obj, 'chat_id'),
      display: optionalString(obj, 'display'),
      leaderAgentRuntime: requireString(obj, 'leader_agent_runtime'),
      identity: optionalString(obj, 'identity'),
      repo: repo === null
        ? null
        : {
            path: requireString(repo, 'path'),
            base_ref: optionalString(repo, 'base_ref'),
          },
    };
  },
  async handle(ctx, input) {
    const space = await ctx.session.bindSpace(input);
    return { space: spaceView(space) };
  },
};

export const unbindSpaceDef: FeishuToolDef<{ spaceName: string }> = {
  name: 'unbind_collaboration_space',
  title: 'Unbind a Feishu collaboration space',
  description:
    'Stop provisioning Teams for new topics in a registered space. Teams ' +
    'already created keep running and their bindings keep routing.',
  callers: ['dispatcher'],
  inputSchema: closedObjectSchema({ space_name: nonEmptyString }, [
    'space_name',
  ]),
  outputSchema: closedObjectSchema(
    { space_name: nonEmptyString, unbound: { type: 'boolean' } },
    ['space_name', 'unbound'],
  ),
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'unbind_collaboration_space arguments');
    return { spaceName: requireString(obj, 'space_name') };
  },
  async handle(ctx, input) {
    const removed = await ctx.session.unbindSpace(input.spaceName);
    return { space_name: input.spaceName, unbound: removed !== null };
  },
};

export const getSpaceDef: FeishuToolDef<{ spaceName: string }> = {
  name: 'get_collaboration_space',
  title: 'Read a Feishu collaboration space',
  description:
    'Read one registered space policy and the targets it has provisioned.',
  callers: ['dispatcher'],
  inputSchema: closedObjectSchema({ space_name: nonEmptyString }, [
    'space_name',
  ]),
  outputSchema: closedObjectSchema(
    {
      space: { anyOf: [spaceSchema, { type: 'null' }] },
      targets: {
        type: 'array',
        items: closedObjectSchema(
          {
            chat_id: nonEmptyString,
            thread_id: { type: ['string', 'null'] },
            display: { type: ['string', 'null'] },
            team_name: nonEmptyString,
          },
          ['chat_id', 'thread_id', 'display', 'team_name'],
        ),
      },
    },
    ['space', 'targets'],
  ),
  annotations: readOnly,
  parse(raw) {
    const obj = asRecord(raw, 'get_collaboration_space arguments');
    return { spaceName: requireString(obj, 'space_name') };
  },
  async handle(ctx, input) {
    const space = ctx.session.getSpace(input.spaceName);
    const targets = space === undefined
      ? []
      : ctx.session
          .listBindings()
          .filter((row) => row.space_name === space.space_name)
          .map((row) => ({
            chat_id: row.chat_id,
            thread_id: row.thread_id,
            display: row.display,
            team_name: row.team_name,
          }));
    return {
      space: space === undefined ? null : spaceView(space),
      targets,
    };
  },
};

export const listSpacesDef: FeishuToolDef<Record<string, never>> = {
  name: 'list_collaboration_spaces',
  title: 'List Feishu collaboration spaces',
  description: 'List every registered automatic-provisioning space policy.',
  callers: ['dispatcher'],
  inputSchema: closedObjectSchema({}),
  outputSchema: closedObjectSchema(
    { spaces: { type: 'array', items: spaceSchema } },
    ['spaces'],
  ),
  annotations: readOnly,
  parse(raw) {
    asRecord(raw ?? {}, 'list_collaboration_spaces arguments');
    return {};
  },
  async handle(ctx) {
    return { spaces: ctx.session.listSpaces().map(spaceView) };
  },
};
