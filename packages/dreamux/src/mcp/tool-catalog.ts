/**
 * Shared building blocks for the domain MCP adapters.
 *
 * Each domain module owns its caller-specific tool visibility, model-facing
 * metadata and schemas, admin-method mapping, descriptor-bound scope, and its
 * allowlist of safe public errors. This module holds only the neutral pieces
 * they share: the tool-metadata builder, the standard success/`fail`-loud
 * helpers over the admin conduit, and the public-error allowlist projector.
 */
import {
  AdminClientError,
  sendAdminRequest,
} from '../admin/client.js';
import {
  PublicToolError,
  type McpToolMetadata,
  type McpToolResult,
} from './server.js';

/**
 * Standard read-only tool annotations. A read tool does not mutate Dreamux
 * state and is not destructive.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

/**
 * Standard annotations for a mutating, non-destructive submission tool (spawn,
 * send, create, bind, cron create/update). It changes Dreamux state but does
 * not destroy an existing durable resource.
 */
export const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
} as const;

/**
 * Standard annotations for a destructive tool (close, dissolve, transfer_back,
 * cron delete). It tears down or releases a durable resource.
 */
export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
} as const;

/**
 * Build one tool advertisement metadata entry. `inputSchema` is closed
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
  annotations: McpToolMetadata['annotations'];
}): McpToolMetadata {
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
 * "an object" so an additive admin field cannot break MCP output validation.
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
 * The projector contract for one tool: it constructs the canonical MCP result
 * from a validated admin value. It selects and shapes public fields rather than
 * exposing the open admin DTO, so extra admin fields never break MCP output
 * validation.
 */
export type SuccessProjector = (adminResult: unknown) => McpToolResult;

/**
 * An allowlist entry mapping one exact admin-method/error-code pair to a safe
 * public tool error message. `code` matches {@link AdminClientError.code};
 * `message`, when present, replaces the admin message with a fixed public one,
 * otherwise the admin message is forwarded verbatim.
 */
export interface PublicErrorRule {
  method: string;
  code: string;
  message?: string;
}

/** Build the explicit method/code cross-product owned by one domain adapter. */
export function publicErrorRules(
  methods: readonly string[],
  codes: readonly string[],
): PublicErrorRule[] {
  return methods.flatMap((method) => codes.map((code) => ({ method, code })));
}

/**
 * Forward one already-scoped admin call and project it into the canonical MCP
 * result. On failure it maps the admin error through the tool's public-error
 * allowlist: an allowlisted code becomes a {@link PublicToolError} the shared
 * executor surfaces verbatim; any other failure re-throws so the shared
 * executor logs it in full and returns the fixed sanitized tool error.
 * `INTERNAL`, catch-all `*_FAILED`, and every unmapped code are never surfaced.
 */
export async function forwardAdmin(input: {
  method: string;
  params: Record<string, unknown>;
  socketPath: string;
  publicErrors: readonly PublicErrorRule[];
  project: SuccessProjector;
}): Promise<McpToolResult> {
  let adminResult: unknown;
  try {
    adminResult = await sendAdminRequest(input.method, input.params, {
      socketPath: input.socketPath,
    });
  } catch (err) {
    throw projectAdminError(err, input.method, input.publicErrors);
  }
  return input.project(adminResult);
}

/**
 * Map an admin failure to either a {@link PublicToolError} (when its code is on
 * the tool's allowlist) or re-throw the original error so the shared executor
 * sanitizes it. `INTERNAL`, catch-all `*_FAILED`, and any unmapped code are
 * never surfaced verbatim.
 */
function projectAdminError(
  err: unknown,
  method: string,
  publicErrors: readonly PublicErrorRule[],
): unknown {
  if (err instanceof AdminClientError) {
    const rule = publicErrors.find(
      (entry) => entry.method === method && entry.code === err.code,
    );
    if (rule !== undefined) {
      return new PublicToolError(rule.message ?? err.message);
    }
  }
  return err;
}
