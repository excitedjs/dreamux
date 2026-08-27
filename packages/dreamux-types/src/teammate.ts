/**
 * TeamMate domain facts published to Channels (declaration-only).
 *
 * Every Dreamux Agent entity is a TeamMate at this boundary, including the
 * Dispatcher and TeamLeader roles. The `teammate` namespace identifies the Core
 * entity that owns the whole turn event family, so later domains do not overload
 * a global `turn.*` namespace.
 *
 * Persisting a new Dispatcher, TeamLeader, ordinary member, or standalone
 * TeamMate publishes its first `teammate.state`; later transitions publish the
 * same kind. There is no separate creation event.
 */
import type { RuntimeToolAction } from './agent-runtime.js';

/** The Core role a TeamMate holds. A Dispatcher never belongs to a Team. */
export type TeammateRole =
  | 'dispatcher'
  | 'teammate'
  | 'team_leader'
  | 'team_member';

/** The role of a TeamMate contained by a Team. */
export type TeamMemberRole = 'team_leader' | 'team_member';

export type TeammateStatus =
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopped'
  | 'closed';

export interface TeammateStateEvent {
  readonly schema_version: 1;
  readonly kind: 'teammate.state';
  readonly occurred_at: number;
  readonly teammate_name: string;
  readonly role: TeammateRole;
  /** `null` for a Dispatcher, which never appears in a Team member summary. */
  readonly team_name: string | null;
  readonly status: TeammateStatus;
}

/** Which Core input path submitted a turn. */
export type TeammateTurnSource =
  | 'channel'
  | 'dispatcher'
  | 'team_leader'
  | 'scheduled'
  | 'completion'
  | 'control';

/**
 * The identity every turn event carries. Later turn events correlate to their
 * submission by `turn_id` and repeat the same optional Channel `correlation`.
 */
export interface TeammateTurnScope {
  readonly schema_version: 1;
  readonly occurred_at: number;
  readonly teammate_name: string;
  readonly role: TeammateRole;
  readonly team_name: string | null;
  readonly turn_id: string;
  /**
   * The bounded opaque string the calling Channel chose, echoed unchanged. Core
   * never parses, routes, authorizes, or deduplicates with it.
   */
  readonly correlation?: string;
}

export type TeammateTurnSubmittedEvent = TeammateTurnScope & {
  readonly kind: 'teammate.turn.submitted';
  /**
   * Required here and deliberately not repeated on later turn events: consumers
   * need it only to establish the conversation anchor at submission time.
   */
  readonly turn_source: TeammateTurnSource;
};

export type TeammateTurnSettledEvent = TeammateTurnScope & {
  readonly kind: 'teammate.turn.settled';
  readonly status: 'completed' | 'failed' | 'stopped';
  readonly assistant: string | null;
  readonly assistant_truncated: boolean;
  readonly redacted: boolean;
};

export type TeammateTurnMessageEvent = TeammateTurnScope & {
  readonly kind: 'teammate.turn.message';
  readonly event_id: string;
  readonly message_role: 'user' | 'assistant';
  readonly content: string;
  readonly content_truncated: boolean;
  readonly redacted: boolean;
};

export type TeammateTurnToolCallEvent = TeammateTurnScope & {
  readonly kind: 'teammate.turn.tool_call';
  readonly event_id: string;
  readonly call_id: string;
  readonly tool_name: string;
  readonly tool_action: RuntimeToolAction | null;
  readonly status: 'started' | 'completed' | 'failed';
  readonly arguments_json: string | null;
  readonly result_json: string | null;
  readonly arguments_truncated: boolean;
  readonly result_truncated: boolean;
  readonly redacted: boolean;
};
