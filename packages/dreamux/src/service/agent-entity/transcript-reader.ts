import { Buffer } from 'node:buffer';

import type {
  AgentRuntimeTranscriptBlock,
  AgentRuntimeTranscriptError,
  AgentRuntimeTranscriptPage,
  AgentRuntimeTranscriptTurn,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import {
  TRANSCRIPT_BLOCKS_PER_TURN_MAX,
  TRANSCRIPT_MESSAGE_MAX_CHARS,
  TRANSCRIPT_TOOL_VALUE_MAX_CHARS,
} from '@excitedjs/dreamux-utils';

import {
  HOST_INJECT_ENV,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import { resolveAgent } from './agent-config.js';
import {
  type AgentEntityIdentity,
  type AgentEntityLastQuery,
  type AgentEntityTranscriptTurn,
} from './types.js';
import { validateLastTurns } from './read-helpers.js';

export const TRANSCRIPT_OUTPUT_BUDGET_BYTES = 262_144;
const TRANSCRIPT_CURSOR_MAX_LENGTH = 4096;

const TRANSCRIPT_ERROR_REASONS = new Set<
  AgentRuntimeTranscriptError['reason']
>([
  'checkpoint_missing',
  'not_found',
  'unreadable',
  'invalid',
  'locator_outside_root',
  'session_mismatch',
  'cursor_invalid',
  'cursor_query_mismatch',
  'cursor_stale',
  'scan_unsupported',
]);

export class AgentTranscriptReadError extends Error {
  constructor(readonly reason: AgentRuntimeTranscriptError['reason'] | null) {
    super('Agent Runtime transcript read failed');
    this.name = 'AgentTranscriptReadError';
  }
}

export interface ReadAgentTranscriptInput {
  config: DreamuxConfig;
  providers: AgentRuntimeProviderCatalog;
  identity: AgentEntityIdentity;
  query: AgentEntityLastQuery;
  log: DreamuxLogger;
}

export interface ReadAgentTranscriptResult {
  requestedTurns: number;
  turns: AgentEntityTranscriptTurn[];
  nextCursor: string | null;
  truncated: boolean;
}

export async function readAgentTranscript(
  input: ReadAgentTranscriptInput,
): Promise<ReadAgentTranscriptResult> {
  const requestedTurns = validateLastTurns(input.query.turns);
  const cursor = validateTranscriptCursor(input.query.cursor);
  const includeTools = validateIncludeTools(input.query.includeTools);
  const agent = resolveAgent(
    input.config,
    input.identity.dispatcher_id,
    input.identity.agent_runtime,
  );
  const provider = input.providers.resolve(agent.provider);
  let page: AgentRuntimeTranscriptPage;
  try {
    page = await provider.readTranscript(
      {
        turns: requestedTurns,
        ...(cursor !== undefined ? { cursor } : {}),
        includeTools,
      },
      {
        checkpoint:
          input.identity.session_id === null
            ? null
            : {
                id: input.identity.session_id,
                transcript_locator: input.identity.transcript_locator,
              },
        config: agent.config,
        cwd: input.identity.runtime_cwd,
        injectEnv: HOST_INJECT_ENV,
        outputBudgetBytes: TRANSCRIPT_OUTPUT_BUDGET_BYTES,
        logger: input.log,
      },
    );
    verifyTranscriptPage(page, requestedTurns);
  } catch (error) {
    throw mapTranscriptReadError(error, input.log, input.identity.name);
  }
  return {
    requestedTurns,
    turns: page.turns.map((turn) => ({
      started_at: turn.startedAt,
      ended_at: turn.endedAt,
      blocks: turn.blocks.map((block) =>
        block.kind === 'message'
          ? {
              kind: block.kind,
              role: block.role,
              text: block.text,
              truncated: block.truncated,
            }
          : {
              kind: block.kind,
              name: block.name,
              input: block.input,
              output: block.output,
              status: block.status,
              input_truncated: block.inputTruncated,
              output_truncated: block.outputTruncated,
            }),
    })),
    nextCursor: page.nextCursor,
    truncated: page.truncated,
  };
}

function mapTranscriptReadError(
  error: unknown,
  log: DreamuxLogger,
  teammateName: string,
): AgentTranscriptReadError {
  const reason = recognizedTranscriptErrorReason(error);
  log.error(
    {
      teammate: teammateName,
      transcript_reason: reason ?? 'internal',
    },
    'Agent Runtime transcript read failed',
  );
  return new AgentTranscriptReadError(reason);
}

function recognizedTranscriptErrorReason(
  error: unknown,
): AgentRuntimeTranscriptError['reason'] | null {
  if (error === null || typeof error !== 'object') return null;
  const candidate = error as Record<string, unknown>;
  if (candidate['name'] !== 'AgentRuntimeTranscriptError') return null;
  const reason = candidate['reason'];
  return typeof reason === 'string' &&
    TRANSCRIPT_ERROR_REASONS.has(
      reason as AgentRuntimeTranscriptError['reason'],
    )
    ? (reason as AgentRuntimeTranscriptError['reason'])
    : null;
}

function validateTranscriptCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (
    cursor.length === 0 ||
    cursor.length > TRANSCRIPT_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new AgentTranscriptReadError('cursor_invalid');
  }
  return cursor;
}

function validateIncludeTools(value: boolean | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error('last include_tools must be a boolean');
  }
  return value;
}

function verifyTranscriptPage(
  page: AgentRuntimeTranscriptPage,
  requestedTurns: number,
): void {
  if (
    page === null ||
    typeof page !== 'object' ||
    !Array.isArray(page.turns) ||
    typeof page.truncated !== 'boolean' ||
    !isValidPageCursor(page.nextCursor)
  ) {
    throw new Error('Agent Runtime transcript provider returned an invalid page');
  }
  if (page.turns.length > requestedTurns) {
    throw new Error('Agent Runtime transcript provider returned too many turns');
  }
  for (const turn of page.turns) verifyTranscriptTurn(turn);
  const bytes = Buffer.byteLength(JSON.stringify(page.turns), 'utf8');
  if (bytes > TRANSCRIPT_OUTPUT_BUDGET_BYTES) {
    throw new Error(
      `Agent Runtime transcript provider exceeded the ${TRANSCRIPT_OUTPUT_BUDGET_BYTES}-byte output budget`,
    );
  }
}

function verifyTranscriptTurn(turn: AgentRuntimeTranscriptTurn): void {
  if (
    turn === null ||
    typeof turn !== 'object' ||
    !isNullableFiniteNumber(turn.startedAt) ||
    !isNullableFiniteNumber(turn.endedAt) ||
    !Array.isArray(turn.blocks) ||
    turn.blocks.length > TRANSCRIPT_BLOCKS_PER_TURN_MAX
  ) {
    throw new Error('Agent Runtime transcript provider returned an invalid turn');
  }
  for (const block of turn.blocks) verifyTranscriptBlock(block);
}

function verifyTranscriptBlock(block: AgentRuntimeTranscriptBlock): void {
  if (block === null || typeof block !== 'object') {
    throw new Error('Agent Runtime transcript provider returned an invalid block');
  }
  if (block.kind === 'message') {
    if (
      (block.role !== 'user' && block.role !== 'assistant') ||
      typeof block.text !== 'string' ||
      [...block.text].length > TRANSCRIPT_MESSAGE_MAX_CHARS ||
      typeof block.truncated !== 'boolean'
    ) {
      throw new Error(
        'Agent Runtime transcript provider returned an invalid message block',
      );
    }
    return;
  }
  if (
    block.kind !== 'tool' ||
    typeof block.name !== 'string' ||
    !isNullableBoundedString(block.input, TRANSCRIPT_TOOL_VALUE_MAX_CHARS) ||
    !isNullableBoundedString(block.output, TRANSCRIPT_TOOL_VALUE_MAX_CHARS) ||
    (block.status !== 'ok' && block.status !== 'error') ||
    typeof block.inputTruncated !== 'boolean' ||
    typeof block.outputTruncated !== 'boolean'
  ) {
    throw new Error(
      'Agent Runtime transcript provider returned an invalid tool block',
    );
  }
}

function isValidPageCursor(value: string | null): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= TRANSCRIPT_CURSOR_MAX_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(value))
  );
}

function isNullableFiniteNumber(value: number | null): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableBoundedString(
  value: string | null,
  limit: number,
): boolean {
  return value === null || (typeof value === 'string' && [...value].length <= limit);
}
