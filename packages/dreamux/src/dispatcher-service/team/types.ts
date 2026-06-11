import type {
  TeamMateIdentityStatus,
  TeamMateRuntimeStatus,
  TeamMateTurnResult,
  TeamMateWorktreeIdentity,
  TeamMateWorktreeRequest,
} from '../teammate/types.js';

export const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TeamStatus = 'starting' | 'running' | 'closed';

export interface TeamRecord {
  version: 1;
  dispatcher_id: string;
  team_id: string;
  name: string;
  repo_cwd: string;
  source_repo: string | null;
  leader_name: string;
  leader_agent_runtime: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  status: TeamStatus;
  intent: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_note: string | null;
}

export interface TeamCreateInput {
  dispatcherId: string;
  name: string;
  repoCwd: string;
  leaderAgentRuntime: string;
  worktree?: TeamMateWorktreeRequest;
  /** Required recovery subject for the Team (issue #182 PR-3). */
  intent: string;
  prompt?: string;
  /**
   * Optional: bind an EXISTING Feishu group chat to the new Team at create time
   * (issue #182 PR-7/PR-8). This is the settled replacement for the retired
   * `create_group` flow — it binds an existing group, it does not create one.
   */
  bindGroup?: { chatId: string };
}

export interface TeamDissolveInput {
  dispatcherId: string;
  teamId: string;
  /** Required dissolve reason recorded in the ledger (issue #182 PR-3). */
  note: string;
}

export interface TeamBindChannelInput {
  dispatcherId: string;
  teamId: string;
  provider: 'builtin:feishu';
  chatId: string;
  chatType: 'group' | 'p2p';
}

export interface TeamTransferChannelBackInput {
  dispatcherId: string;
  provider: 'builtin:feishu';
  chatId: string;
  chatType: 'group' | 'p2p';
}

export type TeamLedgerEventType =
  | 'create'
  | 'status'
  | 'artifact'
  | 'decision'
  | 'bind_channel'
  | 'transfer_channel_back'
  | 'create_group'
  | 'leader_turn'
  | 'dissolve';

export interface TeamLedgerEvent {
  version: 1;
  event_id: number;
  timestamp: number;
  dispatcher_id: string;
  team_id: string;
  type: TeamLedgerEventType;
  summary: string;
}

/**
 * Active group binding marker surfaced by the Team read tools (issue #182 PR-7).
 * Bindings are always Feishu group chats, so only the chat id varies.
 */
export interface TeamChannelBindingSummary {
  provider: 'builtin:feishu';
  chat_id: string;
}

export interface TeamSummary {
  team: TeamRecord;
  leader: TeamMateRuntimeStatus | null;
  member_count: number;
  /** The active bound group chat, or null when no group is bound (issue #182 PR-7). */
  binding: TeamChannelBindingSummary | null;
}

/**
 * Cheap scan row for `team.list` (issue #182 PR-7), mirroring the TeamMate
 * `list`/`status` split: compact current-Team fields only, no inlined leader
 * runtime status or full worktree record. Reach for `team.status` for detail.
 */
export interface TeamListRow {
  /** Public Team identifier; equal to `team_id` (the storage key) today. */
  name: string;
  team_id: string;
  status: TeamStatus;
  intent: string | null;
  source_repo: string | null;
  repo_cwd: string;
  worktree_mode: TeamMateWorktreeIdentity['mode'];
  leader_name: string;
  leader_state: TeamMateIdentityStatus | null;
  member_count: number;
  bound_group: TeamChannelBindingSummary | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

/**
 * Filterable recovery search over Teams (issue #182 PR-7), the Team-side mirror
 * of the TeamMate `history` surface: it finds Teams (including closed ones) by
 * name / status / repo / intent text / time range, rather than reading one
 * team's raw lifecycle event timeline (which stays an internal/debug ledger).
 */
export interface TeamHistoryQuery {
  dispatcherId: string;
  name?: string;
  status?: TeamStatus;
  closeStatus?: 'open' | 'closed';
  /** Substring match over `source_repo` / `repo_cwd`. */
  repo?: string;
  /** Substring match over name / intent / repo / leader name. */
  grep?: string;
  /** Inclusive lower/upper bounds on `updated_at`. */
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

export interface TeamHistoryRow {
  name: string;
  team_id: string;
  status: TeamStatus;
  close_status: 'open' | 'closed';
  intent: string | null;
  source_repo: string | null;
  repo_cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  leader_name: string;
  leader_agent_runtime: string;
  leader_state: TeamMateIdentityStatus | null;
  member_count: number;
  bound_group: TeamChannelBindingSummary | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_note: string | null;
  close_note_preview: string | null;
}

export interface TeamHistoryResult {
  items: TeamHistoryRow[];
  next_cursor: string | null;
}

export interface TeamCreateResult extends TeamSummary {
  turn: TeamMateTurnResult;
}

export interface TeamLedgerResult {
  team: TeamRecord | null;
  events: TeamLedgerEvent[];
}

export function validateTeamId(id: string): string {
  if (!TEAM_ID_PATTERN.test(id)) {
    throw new Error(
      'Team id must be 1-64 ASCII letters, digits, dots, underscores, ' +
        `or dashes, starting with a letter or digit: ${id}`,
    );
  }
  return id;
}
