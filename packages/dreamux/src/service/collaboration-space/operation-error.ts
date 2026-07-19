import type { ChannelScopedOperationFailureCode } from '@excitedjs/dreamux-types';

export type CollaborationTargetOperationFailureCode = Extract<
  ChannelScopedOperationFailureCode,
  | 'collaboration_space_unavailable'
  | 'target_conflict'
  | 'target_closed'
  | 'target_closing'
  | 'route_unavailable'
>;

export class CollaborationTargetOperationError extends Error {
  constructor(
    readonly code: CollaborationTargetOperationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationTargetOperationError';
  }
}
