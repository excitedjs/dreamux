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
  properties: Record<string, unknown>;
  required: string[];
  /** Additional object-schema constraints such as `anyOf`. */
  inputConstraints?: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}): McpToolDescriptor {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: input.properties,
      required: input.required,
      ...(input.inputConstraints ?? {}),
    },
    outputSchema: input.outputSchema,
    annotations: input.annotations,
  };
}

/**
 * A closed JSON Schema object. Top-level Dreamux output objects are closed
 * unless a tool intentionally exposes a JSON-valued extension field.
 */
export function closedObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

/**
 * A permissive object schema for a rich, evolving nested domain DTO (a teammate
 * status row, a team view, a cron job, …). The top-level output object stays
 * closed around its known keys; the deep DTO shapes are validated only as
 * "an object" so an additive domain field cannot break MCP output validation.
 */
export const OPEN_OBJECT: Record<string, unknown> = { type: 'object' };

/** An array schema over `items`. */
export function arrayOf(items: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', items };
}

/** Canonical top-level admission status for prompt-submission receipts. */
export const SUBMISSION_STATUS_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['submitted', 'duplicate', 'stopped', 'failed', 'ambiguous'],
};

/** Optional public error text accompanying failed or ambiguous admission. */
export const SUBMISSION_ERROR_SCHEMA: Record<string, unknown> = {
  type: 'string',
};

/**
 * The `repo` argument shape shared by the Team and TeamMate spawn surfaces. It
 * is the complete canonical `reuse-cwd | managed` union, forwarded verbatim to
 * the domain: a surface that wants a narrower policy narrows it on its own side
 * rather than reshaping this.
 */
export function repoInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: {
        type: 'string',
        enum: ['reuse-cwd', 'managed'],
        description:
          'reuse-cwd runs in an existing directory; managed creates a git ' +
          'worktree from a source repository.',
      },
      path: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description:
          'reuse-cwd: the directory to run in. managed: the source ' +
          'repository; defaults to this agent\'s workspace.',
      },
      base_ref: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description:
          'managed: the ref a newly created branch starts from; default ' +
          'HEAD; ignored when branch already exists.',
      },
      branch: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description:
          'managed: the branch to create or check out; default ' +
          'dreamux/<slug>.',
      },
      slug: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description:
          'managed: label for the worktree directory and the default branch ' +
          'name; defaults to the TeamMate\'s or Team\'s name.',
      },
      cleanup: {
        type: 'string',
        enum: ['keep', 'delete-on-close'],
        description:
          'managed: keep leaves the worktree after close; delete-on-close ' +
          'removes it when the agent closes and the tree is clean.',
      },
    },
    required: ['mode'],
  };
}
