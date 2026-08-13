import type { Readable, Writable } from 'node:stream';

import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import {
  runMcpServer,
  type McpToolDefinition,
  type McpToolMetadata,
  type RunMcpServerOptions,
} from './server.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  OPEN_OBJECT,
  READ_ONLY_ANNOTATIONS,
  arrayOf,
  closedObjectSchema,
  forwardAdmin,
  publicErrorRules,
  toolMetadata,
  type PublicErrorRule,
} from './tool-catalog.js';

export interface CollaborationSpaceMcpOptions {
  dispatcherId: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  transport?: RunMcpServerOptions['transport'];
  log?: (message: string) => void;
}

interface CollaborationSpaceMcpScope {
  dispatcherId: string;
  socketPath: string;
}

const SERVER_IDENTITY = {
  name: 'dreamux-collaboration-space',
  version: '0.3.0',
};

const PUBLIC_ERRORS: readonly PublicErrorRule[] = [
  ...publicErrorRules(
    [
      'collaboration_space.bind',
      'collaboration_space.dissolve',
      'collaboration_space.status',
      'collaboration_space.list',
    ],
    ['BAD_REQUEST', 'DISPATCHER_NOT_FOUND'],
  ),
];

export async function runCollaborationSpaceMcp(
  opts: CollaborationSpaceMcpOptions,
): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  const scope: CollaborationSpaceMcpScope = { dispatcherId, socketPath };
  await runMcpServer({
    identity: SERVER_IDENTITY,
    tools: collaborationSpaceToolDefinitions(scope),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

export function collaborationSpaceTools(): Array<Record<string, unknown>> {
  return collaborationSpaceToolMetadata() as unknown as Array<Record<string, unknown>>;
}

function collaborationSpaceToolMetadata(): McpToolMetadata[] {
  return [
    tool('bind', 'Bind an existing external collaboration space. If the space is unknown, pass container to register its provider-owned opaque container selector. repo is optional: omit it to let Dreamux allocate Teams with the default no-repo workspace policy. bind does not create the external group and does not create a Team immediately; future targets in the bound space create Teams automatically.', {
      channel_id: { type: 'string', minLength: 1, maxLength: 64 },
      space_name: { type: 'string', minLength: 1, maxLength: 64 },
      container: {
        type: 'object',
        additionalProperties: false,
        properties: {
          container_type: { type: 'string', minLength: 1, maxLength: 128 },
          container_key: { type: 'string', minLength: 1, maxLength: 512 },
          display: { type: 'string', minLength: 1, maxLength: 512 },
          canonical_url: { type: 'string', minLength: 1, maxLength: 2048 },
          meta: { type: 'object' },
        },
        required: ['container_type', 'container_key'],
      },
      display: { type: 'string', minLength: 1, maxLength: 512 },
      repo: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', minLength: 1, maxLength: 4096 },
          base_ref: { type: 'string', minLength: 1, maxLength: 512 },
        },
        required: ['cwd'],
      },
      leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      identity: { type: 'string', minLength: 1, maxLength: 4000 },
    }, ['space_name', 'leader_agent_runtime'], {
      title: 'Bind a collaboration space',
      output: closedObjectSchema({ space: OPEN_OBJECT }, ['space']),
      annotations: MUTATING_ANNOTATIONS,
    }),
    tool('dissolve', 'Unbind a collaboration space from Dreamux routing and provisioning. The external space remains in the provider, already-created Teams are not dissolved, and later deliveries fall back to the dispatcher unless the space is bound again.', {
      space_name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['space_name', 'note'], {
      title: 'Unbind a collaboration space',
      output: closedObjectSchema(
        {
          space: OPEN_OBJECT,
          detached_targets: { type: 'integer' },
          released_bindings: { type: 'integer' },
        },
        ['space', 'detached_targets', 'released_bindings'],
      ),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    }),
    tool('status', 'Read one collaboration space and a compact summary of its provisioned targets.', {
      space_name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['space_name'], {
      title: 'Read collaboration space status',
      output: closedObjectSchema(
        { space: OPEN_OBJECT, targets: arrayOf(OPEN_OBJECT) },
        ['space', 'targets'],
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('list', 'List known collaboration spaces and their current binding state.', {}, [], {
      title: 'List collaboration spaces',
      output: closedObjectSchema({ spaces: arrayOf(OPEN_OBJECT) }, ['spaces']),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
  ];
}

function collaborationSpaceToolDefinitions(
  scope: CollaborationSpaceMcpScope,
): McpToolDefinition[] {
  return collaborationSpaceToolMetadata().map((metadata) => ({
    ...metadata,
    handler: (args) => callTool(metadata.name, args, scope),
  }));
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  scope: CollaborationSpaceMcpScope,
): Promise<Record<string, unknown>> {
  const mapped = mapToolCall(name, args);
  return forwardAdmin({
    method: mapped.method,
    params: {
      dispatcher_id: scope.dispatcherId,
      ...mapped.params,
    },
    socketPath: scope.socketPath,
    publicErrors: PUBLIC_ERRORS,
    project: mapped.project,
  });
}

type ProjectFn = (value: unknown) => Record<string, unknown>;

function mapToolCall(
  name: string,
  args: Record<string, unknown>,
): { method: string; params: Record<string, unknown>; project: ProjectFn } {
  switch (name) {
    case 'bind':
      return { method: 'collaboration_space.bind', params: args, project: projectBind };
    case 'dissolve':
      return { method: 'collaboration_space.dissolve', params: args, project: projectDissolve };
    case 'status':
      return { method: 'collaboration_space.status', params: args, project: projectStatus };
    case 'list':
      return { method: 'collaboration_space.list', params: {}, project: projectList };
    default:
      throw new Error(`unknown collaboration_space tool '${String(name)}'`);
  }
}

function projectList(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'collaboration_space list result');
  return { spaces: obj['spaces'] ?? [] };
}

function projectBind(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'collaboration_space bind result');
  return { space: obj['space'] };
}

function projectDissolve(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'collaboration_space dissolve result');
  return {
    space: obj['space'],
    detached_targets: obj['detached_targets'],
    released_bindings: obj['released_bindings'],
  };
}

function projectStatus(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'collaboration_space status result');
  return { space: obj['space'], targets: obj['targets'] ?? [] };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  meta: {
    title: string;
    output: Record<string, unknown>;
    annotations: McpToolMetadata['annotations'];
  },
): McpToolMetadata {
  return toolMetadata({
    name,
    title: meta.title,
    description,
    properties,
    required,
    outputSchema: meta.output,
    annotations: meta.annotations,
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
