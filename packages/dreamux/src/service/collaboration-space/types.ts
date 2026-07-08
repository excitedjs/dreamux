import type {
  ChannelContainer,
  ChannelTarget,
} from '@excitedjs/dreamux-types';

export const COLLABORATION_SPACE_RECORD_VERSION = 1;

export type CollaborationSpaceStatus = 'bound' | 'unbound';

export interface CollaborationSpaceBindingRecord {
  generation: number;
  repo_cwd: string | null;
  worktree:
    | { mode: 'default' }
    | {
        mode: 'managed';
        base_ref: string | null;
        cleanup: 'delete-on-close';
      };
  leader_agent_runtime: string;
  identity: string | null;
  bound_at: number;
}

export interface CollaborationSpaceRecord {
  version: typeof COLLABORATION_SPACE_RECORD_VERSION;
  dispatcher_id: string;
  space_name: string;
  channel_id: string;
  provider: string;
  container_type: string;
  container_key: string;
  display: string | null;
  canonical_url: string | null;
  current_binding: CollaborationSpaceBindingRecord | null;
  last_binding_generation: number;
  status: CollaborationSpaceStatus;
  created_at: number;
  updated_at: number;
  unbound_at: number | null;
  unbound_note: string | null;
}

export type ProvisionedTargetStatus =
  | 'creating'
  | 'active'
  | 'detached'
  | 'closing'
  | 'closed'
  | 'failed';

export type ProvisionedTargetPhase =
  | 'claimed'
  | 'team_created'
  | 'bound'
  | 'closed';

export interface ProvisionedTargetRecord {
  version: typeof COLLABORATION_SPACE_RECORD_VERSION;
  dispatcher_id: string;
  space_name: string;
  channel_id: string;
  provider: string;
  container_key: string;
  binding_generation: number;
  target_key: string;
  target_type: string;
  target_display: string | null;
  team_name: string;
  leader_name: string | null;
  worktree_slug: string;
  lifecycle_status: ProvisionedTargetStatus;
  phase: ProvisionedTargetPhase;
  claim_event_id: string | null;
  close_event_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  detached_at: number | null;
}

export interface CollaborationSpaceView {
  space_name: string;
  channel_id: string;
  provider: string;
  container_type: string;
  container_key: string;
  display: string | null;
  canonical_url: string | null;
  status: CollaborationSpaceStatus;
  current_binding: null | {
    generation: number;
    worktree: CollaborationSpaceBindingRecord['worktree'];
    leader_agent_runtime: string;
    has_identity: boolean;
    bound_at: number;
  };
  last_binding_generation: number;
  target_counts: Record<ProvisionedTargetStatus, number>;
  created_at: number;
  updated_at: number;
  unbound_at: number | null;
  unbound_note: string | null;
}

export interface ProvisionedTargetView {
  space_name: string;
  channel_id: string;
  provider: string;
  container_key: string;
  binding_generation: number;
  target_type: string;
  target_key: string;
  target_display: string | null;
  team_name: string;
  leader_name: string | null;
  lifecycle_status: ProvisionedTargetStatus;
  phase: ProvisionedTargetPhase;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  detached_at: number | null;
}

export interface CollaborationSpaceBindInput {
  channelId?: string;
  spaceName: string;
  container?: ChannelContainer;
  display?: string;
  repo?: {
    cwd: string;
    baseRef?: string;
  };
  leaderAgentRuntime: string;
  identity?: string;
}

export interface CollaborationSpaceDissolveInput {
  spaceName: string;
  note: string;
}

export interface CollaborationSpaceStatusInput {
  spaceName: string;
}

export interface CollaborationSpaceProvisionInput {
  channelId: string;
  provider: string;
  container: ChannelContainer;
  target: ChannelTarget;
  title?: string;
  eventId?: string;
}

export interface CollaborationSpaceDefaultBindingInput {
  repo?: {
    cwd: string;
    baseRef?: string;
  };
  leaderAgentRuntime: string;
  identity?: string;
}

export interface CollaborationSpaceCloseTargetInput {
  channelId: string;
  provider: string;
  container: ChannelContainer;
  target: ChannelTarget;
  eventId?: string;
}
