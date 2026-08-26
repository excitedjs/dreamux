/**
 * Channel binding facts (declaration-only).
 *
 * The immutable snapshots and lifecycle events core publishes when a channel
 * endpoint's Team route or collaboration-space binding changes. They are a leaf
 * of the Channel contract: they name only primitives and each other, so a
 * provider can consume a binding fact without pulling in the session or tool
 * seams. `@excitedjs/dreamux-types` publishes them through the package root.
 */

export interface ChannelBindingEndpointSnapshot {
  readonly provider: string;
  readonly channel_id: string;
  readonly endpoint_type: string;
  readonly endpoint_key: string;
  readonly display: string | null;
  readonly canonical_url: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface ChannelBindingRouteOwnerSnapshot {
  readonly team_name: string;
  readonly leader_name: string;
}

export interface ChannelBindingRouteTeamSnapshot
  extends ChannelBindingRouteOwnerSnapshot {
  readonly leader_agent_runtime: string;
  readonly runtime_cwd: string;
}

export interface ChannelBindingRouteBoundEvent {
  readonly schema_version: 1;
  readonly kind: 'binding.route';
  readonly occurred_at: number;
  readonly action: 'bound';
  readonly transition: 'bound' | 'replaced';
  readonly endpoint: ChannelBindingEndpointSnapshot;
  readonly previous_team: ChannelBindingRouteOwnerSnapshot | null;
  readonly current_team: ChannelBindingRouteTeamSnapshot;
}

export interface ChannelBindingRouteUnboundEvent {
  readonly schema_version: 1;
  readonly kind: 'binding.route';
  readonly occurred_at: number;
  readonly action: 'unbound';
  readonly transition: 'unbound';
  readonly endpoint: ChannelBindingEndpointSnapshot;
  readonly previous_team: ChannelBindingRouteOwnerSnapshot;
  readonly current_team: null;
}

export type ChannelBindingRouteEvent =
  | ChannelBindingRouteBoundEvent
  | ChannelBindingRouteUnboundEvent;

export interface ChannelBindingCollaborationSpacePolicySnapshot {
  readonly leader_agent_runtime: string;
  readonly repo_cwd: string | null;
  readonly worktree:
    | { readonly mode: 'default' }
    | {
        readonly mode: 'managed';
        readonly base_ref: string | null;
        readonly cleanup: 'delete-on-close';
      };
}

export interface ChannelBindingCollaborationSpaceBoundEvent {
  readonly schema_version: 1;
  readonly kind: 'binding.collaboration_space';
  readonly occurred_at: number;
  readonly action: 'bound';
  readonly transition: 'bound';
  readonly container: ChannelBindingEndpointSnapshot;
  readonly space_name: string;
  readonly current_binding: ChannelBindingCollaborationSpacePolicySnapshot;
}

export interface ChannelBindingCollaborationSpaceUnboundEvent {
  readonly schema_version: 1;
  readonly kind: 'binding.collaboration_space';
  readonly occurred_at: number;
  readonly action: 'unbound';
  readonly transition: 'unbound';
  readonly container: ChannelBindingEndpointSnapshot;
  readonly space_name: string;
  readonly current_binding: null;
}

export type ChannelBindingCollaborationSpaceEvent =
  | ChannelBindingCollaborationSpaceBoundEvent
  | ChannelBindingCollaborationSpaceUnboundEvent;
