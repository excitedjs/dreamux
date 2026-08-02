import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { isNotFound } from '../../platform/fs-errors.js';
import { appendJsonLine } from '../../platform/jsonl.js';
import { dispatcherAgentTurnsPath } from '../../platform/paths.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import type { AgentEntityRole, AgentEntityTurnRecord } from './types.js';

/**
 * The identity facts that place a turns archive on disk (issue #233 symmetric
 * layout). The archive lives in the entity's own directory next to its
 * `identity.json`, so writing/reading derives the path from role + team — never
 * a flat dispatcher-global file.
 */
export interface AgentTurnsScope {
  dispatcherId: string;
  name: string;
  teamId: string | null;
  role: AgentEntityRole;
}

function turnsPath(scope: AgentTurnsScope): string {
  return dispatcherAgentTurnsPath({
    dispatcherId: scope.dispatcherId,
    name: scope.name,
    teamId: scope.teamId,
    role: scope.role,
  });
}

const PREVIEW_MAX = 500;
const PREVIEW_HEAD = 497;

/**
 * Hard cap on the durable assistant output captured in a `settled` turn row
 * (issue #188). The full final output (up to this many chars) is the
 * failed-completion-delivery fallback `last` returns; beyond it the text is
 * truncated and {@link AgentEntityTurnRecord.assistant_truncated} is set.
 */
export const ASSISTANT_TEXT_MAX = 160_000;

export interface AgentTurnSubmitInput {
  turnId: string | null;
  turnOrigin: AgentEntityTurnRecord['turn_origin'];
  prompt: string | null;
  intent: string | null;
}

export interface AgentTurnSettledInput {
  turnId: string | null;
  assistant: string | null;
  settleStatus: AgentEntityTurnRecord['settle_status'];
  assistantTruncated?: boolean;
}

/**
 * Per-entity append-only TeamMate turns archive (issue #199 Slice 3, #233
 * symmetric layout). The only JSONL store: one `turn.jsonl` inside each agent
 * entity's own directory, whose path is derived from `role` + `team_id` by the
 * entity-directory scheme in `platform/paths.ts` — never a flat
 * dispatcher-global file. Capture is forward-only and best-effort — a write
 * failure is logged and swallowed so capturing a turn fact never fails a
 * lifecycle verb. Reads stream the file line by line so a long archive (a
 * settled row can carry up to 160k chars of assistant text) is never buffered
 * whole.
 */
export class AgentTurnsStore {
  constructor(
    private readonly log: DreamuxLogger,
    private readonly coreEvents?: DispatcherCoreEventPublisher,
  ) {}

  async appendSubmit(
    scope: AgentTurnsScope,
    input: AgentTurnSubmitInput,
  ): Promise<void> {
    const row: AgentEntityTurnRecord = {
      version: 1,
      type: 'submit',
      turn_id: input.turnId,
      timestamp: Date.now(),
      turn_origin: input.turnOrigin,
      prompt_preview: input.prompt !== null ? preview(input.prompt) : null,
      intent: input.intent,
      settle_status: null,
      assistant: null,
      assistant_preview: null,
      assistant_truncated: false,
    };
    await this.append(scope, row);
    this.publishTurn(scope, row);
  }

  async appendSettled(
    scope: AgentTurnsScope,
    input: AgentTurnSettledInput,
  ): Promise<void> {
    const raw = input.assistant ?? null;
    const truncated = input.assistantTruncated === true ||
      (raw !== null && raw.length > ASSISTANT_TEXT_MAX);
    const assistant =
      raw === null
        ? null
        : raw.length > ASSISTANT_TEXT_MAX
          ? raw.slice(0, ASSISTANT_TEXT_MAX)
          : raw;
    const row: AgentEntityTurnRecord = {
      version: 1,
      type: 'settled',
      turn_id: input.turnId,
      timestamp: Date.now(),
      turn_origin: null,
      prompt_preview: null,
      intent: null,
      settle_status: input.settleStatus,
      assistant,
      assistant_preview: raw !== null ? preview(raw) : null,
      assistant_truncated: truncated,
    };
    await this.append(scope, row);
    this.publishTurn(scope, row);
  }

  private publishTurn(
    scope: AgentTurnsScope,
    row: AgentEntityTurnRecord,
  ): void {
    if (
      scope.teamId === null ||
      (scope.role !== 'team_leader' && scope.role !== 'team_member') ||
      row.turn_id === null
    ) {
      return;
    }
    if (row.type === 'submit') {
      this.coreEvents?.publish(scope.dispatcherId, {
        schema_version: 1,
        kind: 'turn.submitted',
        occurred_at: row.timestamp,
        team_name: scope.teamId,
        agent_name: scope.name,
        role: scope.role,
        turn_id: row.turn_id,
      });
      return;
    }
    if (row.settle_status === null) return;
    this.coreEvents?.publish(scope.dispatcherId, {
      schema_version: 1,
      kind: 'turn.settled',
      occurred_at: row.timestamp,
      team_name: scope.teamId,
      agent_name: scope.name,
      role: scope.role,
      turn_id: row.turn_id,
      status: row.settle_status,
      assistant: row.assistant,
      assistant_truncated: row.assistant_truncated,
    });
  }

  /**
   * Stream a teammate's turn rows in append order, yielding line by line so the
   * caller folds with bounded memory. A missing archive yields nothing; a
   * torn/partial line is skipped rather than failing the read.
   */
  async *stream(scope: AgentTurnsScope): AsyncGenerator<AgentEntityTurnRecord> {
    const stream = createReadStream(turnsPath(scope), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        let parsed: AgentEntityTurnRecord;
        try {
          parsed = JSON.parse(line) as AgentEntityTurnRecord;
        } catch {
          continue;
        }
        yield parsed;
      }
    } catch (err) {
      if (!isNotFound(err)) {
        this.log.warn(
          {
            dispatcher_id: scope.dispatcherId,
            name: scope.name,
            error: err instanceof Error ? err.message : String(err),
          },
          'TeamMate turns archive read failed',
        );
      }
    } finally {
      lines.close();
    }
  }

  private async append(
    scope: AgentTurnsScope,
    row: AgentEntityTurnRecord,
  ): Promise<void> {
    try {
      const path = turnsPath(scope);
      await appendJsonLine(path, row);
    } catch (err) {
      this.log.warn(
        {
          dispatcher_id: scope.dispatcherId,
          name: scope.name,
          type: row.type,
          error: err instanceof Error ? err.message : String(err),
        },
        'TeamMate turns archive append failed',
      );
    }
  }
}

/** The turns scope derived from a full identity. */
export function turnsScopeOf(identity: {
  dispatcher_id: string;
  name: string;
  team_id: string | null;
  role: AgentEntityRole;
}): AgentTurnsScope {
  return {
    dispatcherId: identity.dispatcher_id,
    name: identity.name,
    teamId: identity.team_id,
    role: identity.role,
  };
}

export function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= PREVIEW_MAX ? collapsed : `${collapsed.slice(0, PREVIEW_HEAD)}...`;
}
