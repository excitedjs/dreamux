import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  AgentEntityCollectionStore,
  AgentIdentityStore,
} from '../agent-entity/identity-store.js';
import { teamMateCollectionDir } from '../../platform/paths.js';
import type { AgentEntityIdentityStatus } from '../agent-entity/types.js';
import {
  clampTeamHistoryLimit,
  decodeTeamCursor,
  encodeTeamCursor,
  matchesTeamHistoryQuery,
  previewTeamText,
} from './read-helpers.js';
import type { TeamStore } from './store.js';
import type {
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamHistoryRow,
  TeamListRow,
  TeamRecord,
} from './types.js';

/** Store-only Team list/history projection; never materializes a runtime. */
export class TeamCollectionReadModel {
  constructor(private readonly opts: {
    dispatcherId: string;
    store: TeamStore;
    log: DreamuxLogger;
  }) {}

  async list(): Promise<TeamListRow[]> {
    const out: TeamListRow[] = [];
    for (const team of await this.opts.store.list()) {
      out.push(await this.listRow(team));
    }
    return out;
  }

  async history(input: TeamHistoryQuery): Promise<TeamHistoryResult> {
    const rows: TeamHistoryRow[] = [];
    for (const team of await this.opts.store.list()) {
      const row = await this.historyRow(team);
      if (matchesTeamHistoryQuery(row, input)) rows.push(row);
    }
    rows.sort(
      (a, b) =>
        b.updated_at - a.updated_at ||
        b.created_at - a.created_at ||
        a.team_name.localeCompare(b.team_name),
    );
    const start = input.cursor !== undefined ? decodeTeamCursor(input.cursor) : 0;
    const limit = clampTeamHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeTeamCursor(next) : null,
    };
  }

  private async listRow(team: TeamRecord): Promise<TeamListRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
      dissolve_phase: team.dissolve?.phase ?? null,
      dissolve_accepted_at: team.dissolve?.accepted_at ?? null,
      worktree_cleanup: team.worktree.cleanup_state,
      dissolve_error: team.dissolve?.last_error ?? null,
    };
  }

  private async historyRow(team: TeamRecord): Promise<TeamHistoryRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_agent_runtime: team.leader_agent_runtime,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
      close_note: team.close_note,
      close_note_preview: team.close_note === null
        ? null
        : previewTeamText(team.close_note),
      dissolve_phase: team.dissolve?.phase ?? null,
      dissolve_accepted_at: team.dissolve?.accepted_at ?? null,
      worktree_cleanup: team.worktree.cleanup_state,
      dissolve_error: team.dissolve?.last_error ?? null,
    };
  }

  /**
   * The leader's durable status, read from this Team's root and accepted only
   * when the record names the leader the Team record names. No probing: the
   * leader has exactly one location and this is it.
   */
  private async leaderState(
    team: TeamRecord,
  ): Promise<AgentEntityIdentityStatus | null> {
    const leader = await new AgentIdentityStore({
      dir: this.opts.store.teamRoot(team.team_id),
      dispatcherId: this.opts.dispatcherId,
      expectedName: null,
      log: this.opts.log,
    })
      .read()
      .catch(() => null);
    return leader !== null && leader.name === team.leader_name
      ? leader.status
      : null;
  }

  /** Directory occupancy is the roster fact; an unreadable member still counts. */
  private async memberCount(team: TeamRecord): Promise<number> {
    return (
      await new AgentEntityCollectionStore({
        root: teamMateCollectionDir(this.opts.store.teamRoot(team.team_id)),
        dispatcherId: this.opts.dispatcherId,
        log: this.opts.log,
      }).names()
    ).length;
  }
}
