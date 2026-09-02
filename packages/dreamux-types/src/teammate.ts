/**
 * TeamMate domain facts published to Channels (declaration-only).
 *
 * Every Dreamux Agent entity is a TeamMate at this boundary, including the
 * Dispatcher and TeamLeader roles. The `teammate` namespace identifies the Core
 * entity that owns the whole turn event family, so later domains do not overload
 * a global `turn.*` namespace.
 *
 * Persisting a new Dispatcher, TeamLeader, Team-scoped TeamMate, or
 * Dispatcher-scoped TeamMate publishes its first `teammate.state`; later
 * transitions publish the same kind. There is no separate creation event.
 */
import type { RuntimeToolAction } from './agent-runtime.js';

/**
 * The role a TeamMate presents at this boundary.
 *
 * It is a runtime projection the publishing owner derives from the Service or
 * Collection that materialized the Agent, never a persisted field: the
 * Dispatcher Agent is `dispatcher`, a Team's leader is `team_leader`, and every
 * ordinary Agent — Dispatcher-scoped or Team-scoped — is `teammate`. A
 * Dispatcher never belongs to a Team.
 */
export type TeammateRole = 'dispatcher' | 'teammate' | 'team_leader';

/** The role of a TeamMate contained by a Team, derived the same way. */
export type TeamContainedRole = Exclude<TeammateRole, 'dispatcher'>;

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
  /** Runtime projection supplied by the owning Service; never persisted. */
  readonly role: TeammateRole;
  /** `null` for a Dispatcher, which never appears in a Team summary. */
  readonly team_name: string | null;
  readonly status: TeammateStatus;
}

/**
 * The identity every turn event carries. Later turn events correlate to their
 * submission by `turn_id` alone.
 */
export interface TeammateTurnScope {
  readonly schema_version: 1;
  readonly occurred_at: number;
  readonly teammate_name: string;
  /** Runtime projection supplied by the owning Service; never persisted. */
  readonly role: TeammateRole;
  readonly team_name: string | null;
  readonly turn_id: string;
}

export type TeammateTurnSubmittedEvent = TeammateTurnScope & {
  readonly kind: 'teammate.turn.submitted';
  /**
   * The open provenance name the submitting owner chose — the same value Core
   * rendered the model envelope's root from. Deliberately not a Core enum: a
   * new Channel form names itself without a Core contract change, and a
   * consumer that presents turns differently by provenance owns that mapping
   * itself. Required here and not repeated on later turn events, which need
   * only `turn_id` to reach the anchor established at submission.
   */
  readonly turn_source: string;
  /**
   * The submitting caller's own id, returned so that caller can recognize the
   * turn its submission produced. `null` means none was supplied. It is not a
   * routing key, persistence key, or presentation identity.
   */
  readonly source_id: string | null;
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

/**
 * One runtime-native turn ended for this TeamMate.
 *
 * Deliberately actor-scoped rather than turn-scoped. A provider folds any
 * number of Dreamux submissions into one native turn, so no single logical
 * `turn_id` owns the end — and inventing one would make a presentation pick an
 * arbitrary member. The honest fact is "this Agent's runtime stopped
 * producing", published once per native turn, which is exactly what a live
 * progress surface needs to finish whatever it currently shows for that Agent.
 *
 * It is not a lifecycle fact: `teammate.turn.settled` remains the
 * per-submission settlement, and neither event replaces the other.
 */
export interface TeammateNativeTurnEndedEvent {
  readonly schema_version: 1;
  readonly kind: 'teammate.native_turn.ended';
  readonly occurred_at: number;
  readonly teammate_name: string;
  /** Runtime projection supplied by the owning Service; never persisted. */
  readonly role: TeammateRole;
  /** `null` for a Dispatcher, which never belongs to a Team. */
  readonly team_name: string | null;
  readonly status: 'completed' | 'failed' | 'interrupted';
}
