import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { isNotFound } from '../../platform/fs-errors.js';
import { dispatcherAgentTurnsPath } from '../../platform/paths.js';
import type { TeamMateRole, TeamMateTurnRecord } from './types.js';

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
  role: TeamMateRole;
}

function turnsPath(scope: AgentTurnsScope): string {
  return dispatcherAgentTurnsPath({
    dispatcherId: scope.dispatcherId,
    name: scope.name,
    teamId: scope.teamId,
    role: scope.role,
  });
}

/** Reuse the neutral logger's `warn` — no forked, message-first shape. */
export type TeamMateTurnsStoreLog = Pick<DreamuxLogger, 'warn'>;

const PREVIEW_MAX = 500;
const PREVIEW_HEAD = 497;

/**
 * Hard cap on the durable assistant output captured in a `settled` turn row
 * (issue #188). The full final output (up to this many chars) is the
 * failed-completion-delivery fallback `last` returns; beyond it the text is
 * truncated and {@link TeamMateTurnRecord.assistant_truncated} is set.
 */
export const ASSISTANT_TEXT_MAX = 160_000;

export interface TeamMateTurnSubmitInput {
  turnId: string | null;
  turnOrigin: TeamMateTurnRecord['turn_origin'];
  prompt: string | null;
  intent: string | null;
}

export interface TeamMateTurnSettledInput {
  turnId: string | null;
  assistant: string | null;
  settleStatus: TeamMateTurnRecord['settle_status'];
}

/**
 * Per-name append-only TeamMate turns archive (issue #199 Slice 3). The only
 * JSONL store: one file per concrete teammate name at
 * `teammate/turns/<name>.jsonl`. Capture is forward-only and best-effort — a
 * write failure is logged and swallowed so capturing a turn fact never fails a
 * lifecycle verb. Reads stream the file line by line so a long archive (a
 * settled row can carry up to 160k chars of assistant text) is never buffered
 * whole.
 */
export class TeamMateTurnsStore {
  constructor(private readonly log: TeamMateTurnsStoreLog) {}

  async appendSubmit(
    scope: AgentTurnsScope,
    input: TeamMateTurnSubmitInput,
  ): Promise<void> {
    await this.append(scope, {
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
    });
  }

  async appendSettled(
    scope: AgentTurnsScope,
    input: TeamMateTurnSettledInput,
  ): Promise<void> {
    const raw = input.assistant ?? null;
    const truncated = raw !== null && raw.length > ASSISTANT_TEXT_MAX;
    const assistant =
      raw === null ? null : truncated ? raw.slice(0, ASSISTANT_TEXT_MAX) : raw;
    await this.append(scope, {
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
    });
  }

  /**
   * Stream a teammate's turn rows in append order, yielding line by line so the
   * caller folds with bounded memory. A missing archive yields nothing; a
   * torn/partial line is skipped rather than failing the read.
   */
  async *stream(scope: AgentTurnsScope): AsyncGenerator<TeamMateTurnRecord> {
    const stream = createReadStream(turnsPath(scope), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        let parsed: TeamMateTurnRecord;
        try {
          parsed = JSON.parse(line) as TeamMateTurnRecord;
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
    row: TeamMateTurnRecord,
  ): Promise<void> {
    try {
      const path = turnsPath(scope);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
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
  role: TeamMateRole;
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