import type {
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
  intent?: string;
  prompt?: string;
}

export interface TeamDissolveInput {
  dispatcherId: string;
  teamId: string;
  note?: string;
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

export interface TeamCreateGroupInput {
  dispatcherId: string;
  name: string;
  repoCwd: string;
  leaderAgentRuntime: string;
  sourceChatId: string;
  sourceChatType: 'p2p' | 'group';
  requesterOpenId: string;
  groupName?: string;
  inviteOpenIds?: string[];
  intent?: string;
  prompt?: string;
}

export interface TeamCreateGroupResult extends TeamCreateResult {
  binding: {
    provider: 'builtin:feishu';
    chat_id: string;
    chat_type: 'group';
    team_id: string;
    leader_name: string;
  };
  invited_open_ids: string[];
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

export interface TeamSummary {
  team: TeamRecord;
  leader: TeamMateRuntimeStatus | null;
  member_count: number;
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
