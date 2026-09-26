import type { DreamuxLogger, TeamSummary } from '@excitedjs/dreamux-types';

import {
  AgentEntityCollectionStore,
  AgentIdentityStore,
} from '../agent/store.js';
import {
  clampHistoryLimit,
  decodeCursor,
  encodeCursor,
  matchesGrepText,
  previewText,
} from '../../platform/history-page.js';
import { teamMateCollectionDir } from '../../platform/paths.js';
import { toStatus } from '../agent/records.js';
import type { TeamService } from './service.js';
import { teamSummary } from './team-summary.js';
import type {
  AgentEntityIdentity,
  AgentEntityIdentityStatus,
} from '../agent/identity.js';
import type { TeamStore } from './store.js';
import {
  validateTeamId,
  type TeamHistoryQuery,
  type TeamHistoryResult,
  type TeamHistoryRow,
  type TeamListRow,
  type TeamRecord,
} from './types.js';

/** Store-only Team list/summary/history projection; never materializes a runtime. */
export class TeamCollectionReadModel {
  constructor(
    private readonly opts: {
      dispatcherId: string;
      store: TeamStore;
      log: DreamuxLogger;
      /** A non-materializing cache peek at a Team this process already holds
       * live, for `leaderState` to answer from in-memory identity state
       * instead of a fresh file read when one is available. `null` for a
       * Team this process is not currently holding. */
      live: (teamId: string) => TeamService | null;
    },
  ) {}

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
    const start = input.cursor !== undefined ? decodeCursor(input.cursor) : 0;
    const limit = clampHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeCursor(next) : null,
    };
  }

  /**
   * One Team's status, read from its records alone.
   *
   * How a closed Team is reported: it has no runtime left to ask, and
   * constructing one to answer a read would resurrect an entity that is over.
   * The leader's runtime state is `null` because nothing is running, not
   * because nothing is known.
   */
  async summary(team: TeamRecord): Promise<TeamSummary> {
    const leader = await this.leaderIdentity(team);
    return teamSummary(
      team,
      leader === null ? null : toStatus(leader, null),
      await this.memberCount(team),
    );
  }

  private async listRow(team: TeamRecord): Promise<TeamListRow> {
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
      worktree_cleanup: team.worktree.cleanup_state,
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
      close_note_preview:
        team.close_note === null ? null : previewText(team.close_note),
      worktree_cleanup: team.worktree.cleanup_state,
    };
  }

  /**
   * The leader's durable status, read from this Team's root and accepted only
   * when the record names the leader the Team record names. No probing: the
   * leader has exactly one location and this is it.
   *
   * A Team this process already holds live answers from that live entity's
   * own in-memory identity — the more current copy, and one that needs no
   * file read — rather than from a second, independently-cached read over
   * the same `identity.json` a live owner already committed through.
   */
  private async leaderState(
    team: TeamRecord,
  ): Promise<AgentEntityIdentityStatus | null> {
    const live = this.opts.live(team.team_id);
    if (live !== null) return live.leaderIdentityStatus();
    return (await this.leaderIdentity(team))?.status ?? null;
  }

  /**
   * The store decides what an unreadable leader means, and this read accepts
   * that decision unchanged: a missing or corrupt record is the `null` the
   * store already logged, while a record this version refuses to interpret —
   * old state — is raised. Catching here would turn "this file says something
   * Dreamux no longer accepts" into "there is no leader", which is the one
   * answer that is never true.
   */
  private async leaderIdentity(
    team: TeamRecord,
  ): Promise<AgentEntityIdentity | null> {
    const leader = await new AgentIdentityStore({
      dir: this.opts.store.teamRoot(team.team_id),
      dispatcherId: this.opts.dispatcherId,
      expectedName: null,
      log: this.opts.log,
    }).read();
    return leader !== null && leader.name === team.leader_name ? leader : null;
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

function matchesTeamHistoryQuery(
  row: TeamHistoryRow,
  input: Omit<TeamHistoryQuery, 'dispatcherId'>,
): boolean {
  if (
    input.name !== undefined &&
    row.team_name !== validateTeamId(input.name)
  ) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    const hit =
      row.source_repo !== null &&
      row.source_repo.toLowerCase().includes(needle);
    if (!hit) return false;
  }
  if (input.grep !== undefined && !teamRowMatchesText(row, input.grep)) {
    return false;
  }
  if (input.since !== undefined && row.updated_at < input.since) return false;
  if (input.until !== undefined && row.updated_at > input.until) return false;
  return true;
}

function teamRowMatchesText(row: TeamHistoryRow, grep: string): boolean {
  return matchesGrepText(
    [
      row.team_name,
      row.intent,
      row.source_repo,
      row.leader_name,
      row.close_note,
    ],
    grep,
  );
}
