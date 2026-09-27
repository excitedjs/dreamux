/**
 * The shared vocabulary Core-owned delegates build their catalogs from.
 *
 * These are pure JSON builders. Nothing here imports the official MCP SDK,
 * because a delegate runs inside the server process and only ever produces a
 * descriptor: compiling and registering it is the shim's job, on the other side
 * of the wire.
 *
 * What each delegate still owns for itself is everything that carries meaning —
 * the tool names, the descriptions a model reads, which caller sees which tool,
 * and what a result projects to. This module only spells the shapes those share.
 */

import type { JsonSchema } from '@excitedjs/dreamux-types';

import { objectSchema } from '../../command/schema.js';

/**
 * Standard MCP tool annotations as plain JSON.
 *
 * Structurally identical to the `ChannelMcpToolAnnotations` published at the
 * provider seam, and deliberately a separate declaration: that one is part of
 * the external contract Channel packages compile against, this one is Core's
 * own catalog vocabulary, and coupling them would export an internal detail.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One advertised tool, in the wire form a delegate hands to `describe`. */
export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

/**
 * Standard read-only tool annotations. A read tool does not mutate Dreamux
 * state and is not destructive.
 */
export const READ_ONLY_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/**
 * Standard annotations for a mutating, non-destructive submission tool (spawn,
 * send, create, bind, cron create/update). It changes Dreamux state but does
 * not destroy an existing durable resource.
 */
export const MUTATING_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
};

/**
 * Standard annotations for a destructive tool (close, dissolve,
 * cron delete). It tears down or releases a durable resource.
 */
export const DESTRUCTIVE_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
};

/**
 * Build one tool descriptor. `inputSchema` is closed
 * (`additionalProperties: false`) around the supplied properties/required set;
 * `outputSchema` is supplied ready-made by the caller so a tool can declare a
 * closed object, an open extension field, or a specific nested shape.
 */
export function toolMetadata(input: {
  name: string;
  title: string;
  description: string;
  properties: Record<string, JsonSchema>;
  required: string[];
  /** Additional object-schema constraints such as `anyOf`. */
  inputConstraints?: Record<string, unknown> | undefined;
  outputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}): McpToolDescriptor {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: {
      ...objectSchema(input.properties, input.required),
      ...(input.inputConstraints ?? {}),
    },
    outputSchema: input.outputSchema,
    annotations: input.annotations,
  };
}

/**
 * Build one tool descriptor from its scalar parts. The one canonical wrapper
 * around {@link toolMetadata} every MCP delegate calls, so a delegate spells
 * a tool's shape once instead of carrying its own private copy of this
 * wiring.
 */
export function tool(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  meta: {
    title: string;
    output: Record<string, unknown>;
    annotations: McpToolAnnotations;
    inputConstraints?: Record<string, unknown> | undefined;
  },
): McpToolDescriptor {
  return toolMetadata({
    name,
    title: meta.title,
    description,
    properties,
    required,
    inputConstraints: meta.inputConstraints,
    outputSchema: meta.output,
    annotations: meta.annotations,
  });
}
