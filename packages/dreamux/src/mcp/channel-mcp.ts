import type { Readable, Writable } from 'node:stream';

import {
  runMcpServer,
  validateMcpJsonSchema,
  type McpToolDefinition,
  type McpToolMetadata,
  type RunMcpServerOptions,
} from './server.js';
import { forwardAdmin, type PublicErrorRule } from './tool-catalog.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

export interface ChannelMcpOptions {
  dispatcherId: string;
  callerKind?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  /**
   * The channel provider ref this server serves (e.g. `builtin:feishu`).
   * Forwarded to the admin conduit so core can fail loud if the descriptor is
   * wired to the wrong live session.
   */
  providerRef?: string;
  /**
   * Dispatcher-local channel id this server serves. Forwarded with tool calls
   * so a dispatcher with multiple channel providers never falls back to the
   * primary session by accident.
   */
  channelId?: string;
  /**
   * The channel's static, provider-supplied MCP tool catalog. Core owns every
   * descriptor and never authors or interprets a tool; `tools/call` still routes
   * to the live session via `channel.invoke_tool`. The catalog MUST be a valid
   * non-empty descriptor list — the server never silently substitutes an empty
   * tool set.
   */
  tools: readonly unknown[];
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  transport?: RunMcpServerOptions['transport'];
  log?: (message: string) => void;
}

/**
 * A provider-supplied channel tool descriptor after fail-loud validation. Core
 * treats `inputSchema`/`outputSchema` as opaque JSON Schema objects; it never
 * names a provider tool or interprets its result fields.
 */
interface ValidatedChannelTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolMetadata['annotations'];
  icons?: McpToolMetadata['icons'];
}

interface ChannelMcpScope {
  dispatcherId: string;
  callerKind: 'dispatcher' | 'team_leader';
  providerRef?: string;
  channelId?: string;
  teamId?: string;
  leaderName?: string;
  socketPath: string;
}

const SERVER_IDENTITY = { name: 'dreamux-channel', version: '0.2.0' };

const PUBLIC_ERRORS: readonly PublicErrorRule[] = [
  { method: 'channel.invoke_tool', code: 'BAD_REQUEST' },
  { method: 'channel.invoke_tool', code: 'DISPATCHER_NOT_FOUND' },
  { method: 'channel.invoke_tool', code: 'TEAM_NOT_FOUND' },
  { method: 'channel.invoke_tool', code: 'CHANNEL_SCOPE_DENIED' },
];

export async function runChannelMcp(opts: ChannelMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const callerKind = opts.callerKind ?? 'dispatcher';
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  // Fail loud on a missing, malformed, or empty catalog: never serve a channel
  // MCP with a silently substituted empty tool list.
  const tools = validateChannelToolCatalog(opts.tools);
  const scope: ChannelMcpScope = {
    dispatcherId,
    callerKind,
    ...(opts.providerRef !== undefined ? { providerRef: opts.providerRef } : {}),
    ...(opts.channelId !== undefined ? { channelId: opts.channelId } : {}),
    ...(opts.teamId !== undefined ? { teamId: opts.teamId } : {}),
    ...(opts.leaderName !== undefined ? { leaderName: opts.leaderName } : {}),
    socketPath,
  };
  await runMcpServer({
    identity: SERVER_IDENTITY,
    tools: channelToolDefinitions(tools, scope),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

function channelToolDefinitions(
  tools: readonly ValidatedChannelTool[],
  scope: ChannelMcpScope,
): McpToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool.icons !== undefined ? { icons: tool.icons } : {}),
    handler: (args) => invokeChannelTool(tool.name, args, scope),
  }));
}

async function invokeChannelTool(
  name: string,
  args: Record<string, unknown>,
  scope: ChannelMcpScope,
): Promise<Record<string, unknown>> {
  // The server is a blind conduit: forward the raw provider-owned
  // `{ name, arguments }` to the generic `channel.invoke_tool` admin method
  // along with the caller scope. Core resolves the live session vs sessionless
  // path and the TeamLeader egress gate — this server names no tool or selector.
  const result = await forwardAdmin({
    method: 'channel.invoke_tool',
    params: {
      dispatcher_id: scope.dispatcherId,
      name,
      arguments: args,
      ...(scope.providerRef !== undefined ? { provider_ref: scope.providerRef } : {}),
      ...(scope.channelId !== undefined ? { channel_id: scope.channelId } : {}),
      caller_kind: scope.callerKind,
      ...(scope.teamId !== undefined ? { team_id: scope.teamId } : {}),
      ...(scope.leaderName !== undefined ? { leader_name: scope.leaderName } : {}),
    },
    socketPath: scope.socketPath,
    publicErrors: PUBLIC_ERRORS,
    // The provider-owned result is the canonical public value; the shared MCP
    // server validates it against the provider-supplied output schema.
    project: (value) => asRecord(value, 'channel tool result'),
  });
  return result;
}

/**
 * Fail-loud validation of a provider-supplied channel tool catalog. Throws on a
 * non-array, an empty catalog, a non-object descriptor, a missing/blank name, a
 * duplicate name, a non-object `inputSchema`/`outputSchema`, or a non-object
 * `annotations`. Descriptor assembly and the `channel-mcp` CLI both call this
 * so a broken catalog never silently degrades to an empty tool set.
 */
export function validateChannelToolCatalog(
  tools: readonly unknown[],
): ValidatedChannelTool[] {
  if (!Array.isArray(tools)) {
    throw new Error('channel tool catalog must be an array');
  }
  if (tools.length === 0) {
    throw new Error('channel tool catalog must not be empty');
  }
  assertJsonCompatible(tools, 'channel tool catalog', new Set<object>());
  const seen = new Set<string>();
  return tools.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`channel tool descriptor at index ${index} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const allowed = new Set([
      'name',
      'title',
      'description',
      'inputSchema',
      'outputSchema',
      'annotations',
      'icons',
    ]);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        throw new Error(
          `channel tool descriptor at index ${index} has unknown property '${key}'`,
        );
      }
    }
    const name = obj['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`channel tool descriptor at index ${index} must have a non-empty name`);
    }
    if (seen.has(name)) {
      throw new Error(`channel tool descriptor name '${name}' is duplicated`);
    }
    seen.add(name);
    const inputSchema = requireSchemaObject(obj['inputSchema'], `${name}.inputSchema`);
    const outputSchema =
      obj['outputSchema'] === undefined
        ? undefined
        : requireSchemaObject(obj['outputSchema'], `${name}.outputSchema`);
    const annotations = validateAnnotations(obj['annotations'], name);
    const icons = validateIcons(obj['icons'], name);
    const description = obj['description'];
    const title = obj['title'];
    if (title !== undefined && (typeof title !== 'string' || title === '')) {
      throw new Error(`${name}.title must be a non-empty string when present`);
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new Error(`${name}.description must be a string when present`);
    }
    return {
      name,
      title: title ?? name,
      description: description ?? name,
      inputSchema,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
      ...(icons !== undefined ? { icons } : {}),
    };
  });
}

function requireSchemaObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON Schema object`);
  }
  const schema = value as Record<string, unknown>;
  validateMcpJsonSchema(schema, label);
  return schema;
}

function validateAnnotations(
  value: unknown,
  name: string,
): McpToolMetadata['annotations'] {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name}.annotations must be an object`);
  }
  const annotations = value as Record<string, unknown>;
  const allowed = new Set([
    'title',
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ]);
  for (const [key, annotation] of Object.entries(annotations)) {
    if (!allowed.has(key)) {
      throw new Error(`${name}.annotations has unknown property '${key}'`);
    }
    if (key === 'title') {
      if (typeof annotation !== 'string' || annotation === '') {
        throw new Error(`${name}.annotations.title must be a non-empty string`);
      }
    } else if (typeof annotation !== 'boolean') {
      throw new Error(`${name}.annotations.${key} must be a boolean`);
    }
  }
  return annotations as McpToolMetadata['annotations'];
}

function validateIcons(
  value: unknown,
  name: string,
): McpToolMetadata['icons'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${name}.icons must be an array`);
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${name}.icons[${index}] must be an object`);
    }
    const icon = entry as Record<string, unknown>;
    const allowed = new Set(['src', 'mimeType', 'sizes', 'theme']);
    for (const key of Object.keys(icon)) {
      if (!allowed.has(key)) {
        throw new Error(`${name}.icons[${index}] has unknown property '${key}'`);
      }
    }
    if (typeof icon['src'] !== 'string' || icon['src'] === '') {
      throw new Error(`${name}.icons[${index}].src must be a non-empty string`);
    }
    if (
      icon['mimeType'] !== undefined &&
      (typeof icon['mimeType'] !== 'string' || icon['mimeType'] === '')
    ) {
      throw new Error(`${name}.icons[${index}].mimeType must be a non-empty string`);
    }
    if (
      icon['sizes'] !== undefined &&
      (!Array.isArray(icon['sizes']) ||
        icon['sizes'].some((size) => typeof size !== 'string' || size === ''))
    ) {
      throw new Error(
        `${name}.icons[${index}].sizes must be an array of non-empty strings`,
      );
    }
    if (
      icon['theme'] !== undefined &&
      icon['theme'] !== 'light' &&
      icon['theme'] !== 'dark'
    ) {
      throw new Error(`${name}.icons[${index}].theme must be 'light' or 'dark'`);
    }
    return icon as NonNullable<McpToolMetadata['icons']>[number];
  });
}

function assertJsonCompatible(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} contains a non-JSON ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} contains a circular reference`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new Error(`${path} contains a non-plain object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonCompatible(entry, `${path}[${index}]`, ancestors),
    );
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonCompatible(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
