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
  /**
   * Explicit repository cwd for the Team workspace (issue #199). Omitted when
   * the caller passes no `repo`: the Team then runs in a plain
   * `<dispatcher cwd>/.workspace/work/<team_name>/` directory (no git worktree,
   * dispatcher cwd need not be a git repo). A managed git worktree is created
   * only for an explicit `worktree` request.
   */
  repoCwd?: string;
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
  /** Required dissolve reason recorded on the team record (issue #182 PR-3). */
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

/**
 * Active group binding marker surfaced by the Team read tools (issue #182 PR-7).
 * Bindings are always Feishu group chats, so only the chat id varies.
 */
export interface TeamChannelBindingSummary {
  provider: 'builtin:feishu';
  chat_id: string;
}

/**
 * Public Team record view (issue #199 Slice 2). The status surface speaks the
 * concrete `team_name`; the duplicate `name` / `team_id`, the machine-local
 * `repo_cwd` / `runtime_cwd` / flattened `worktree`, and the persisted `version`
 * are projected away. The persisted {@link TeamRecord} keeps them for internal
 * orchestration and storage (the storage rewrite is Slice 3).
 */
export interface TeamView {
  team_name: string;
  status: TeamStatus;
  intent: string | null;
  source_repo: string | null;
  leader_name: string;
  leader_agent_runtime: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_note: string | null;
}

export interface TeamSummary {
  team: TeamView;
  leader: TeamMateRuntimeStatus | null;
  member_count: number;
  /** The active bound group chat, or null when no group is bound (issue #182 PR-7). */
  binding: TeamChannelBindingSummary | null;
}

/**
 * Compact scan row for `team.list` (issue #199 Slice 1/2). Keyed by the concrete
 * `team_name`; the duplicate `team_id` and the machine-local `repo_cwd` /
 * `worktree_mode` are no longer projected — reach for `team.status` for detail.
 */
export interface TeamListRow {
  team_name: string;
  status: TeamStatus;
  intent: string | null;
  source_repo: string | null;
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
 * team's raw lifecycle event timeline (which no longer exists).
 */
export interface TeamHistoryQuery {
  dispatcherId: string;
  name?: string;
  /** Lifecycle status filter (the retired `close_status` is gone). */
  status?: TeamStatus;
  /** Substring match over `source_repo` / `repo_cwd`. */
  repo?: string;
  /** Substring match over team_name / intent / repo / leader name. */
  grep?: string;
  /** Inclusive lower/upper bounds on `updated_at`. */
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Public Team recovery row (issue #199 Slice 1). A compact projection keyed by
 * the concrete `team_name` (`name`): no `team_id`, no `close_status` duplicate of
 * `status`, and no machine-local `repo_cwd`/`runtime_cwd`/`worktree` paths.
 */
export interface TeamHistoryRow {
  team_name: string;
  status: TeamStatus;
  intent: string | null;
  source_repo: string | null;
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

export function validateTeamId(id: string): string {
  if (!TEAM_ID_PATTERN.test(id)) {
    throw new Error(
      'Team id must be 1-64 ASCII letters, digits, dots, underscores, ' +
        `or dashes, starting with a letter or digit: ${id}`,
    );
  }
  return id;
}
