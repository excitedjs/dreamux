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
 * The identity every conversation display fact carries: the Agent it belongs to
 * and nothing else.
 *
 * Deliberately not a turn scope. A provider folds any number of Dreamux
 * submissions into one native turn, so no display fact can honestly name the
 * submission that produced it; what a live surface shows is one Agent's stream
 * in the order it happened, which is exactly what this scopes.
 */
export interface TeammateActorScope {
  readonly schema_version: 1;
  readonly occurred_at: number;
  readonly teammate_name: string;
  /** Runtime projection supplied by the owning Service; never persisted. */
  readonly role: TeammateRole;
  /** `null` for a Dispatcher, which never belongs to a Team. */
  readonly team_name: string | null;
}

/**
 * Core admitted one input for this TeamMate.
 *
 * Published at the moment of submission, before any runtime has accepted it, so
 * a submission that fails is visible together with the text that failed. It is
 * the only event in this family Core itself produces; everything after it is
 * the runtime's own account of what it did.
 */
export type TeammateInputEvent = TeammateActorScope & {
  readonly kind: 'teammate.input';
  /**
   * The open provenance name the submitting owner chose — the same value Core
   * rendered the model envelope's root from. Deliberately not a Core enum: a
   * new Channel form names itself without a Core contract change, and a
   * consumer that presents inputs differently by provenance owns that mapping
   * itself.
   */
  readonly source: string;
  /**
   * The submitting caller's own id, returned so that caller can recognize its
   * own submission. `null` means none was supplied. A caller compares it
   * against ids it issued; its mere presence proves nothing, because cron
   * fires, task push-backs, and restart notices carry one too.
   */
  readonly source_id: string | null;
  /** The source's own body, never the assembled provenance envelope. */
  readonly content: string;
  readonly redacted: boolean;
};

/**
 * One thing the runtime did, in the runtime's own vocabulary, already
 * redacted by Core. Core bounds nothing here: how much of a payload a
 * surface can show is that surface's own limit, applied where it sends.
 *
 * The member names match `RuntimeActivity`'s on purpose: this is the same
 * fact with its payloads made safe to display, not a second vocabulary a
 * maintainer has to hold beside the first.
 */
export type TeammateActivity =
  | {
      readonly kind: 'assistant.message';
      readonly event_id: string;
      readonly content: string;
      readonly redacted: boolean;
    }
  | {
      readonly kind: 'tool.call';
      readonly event_id: string;
      readonly call_id: string;
      readonly tool_name: string;
      readonly tool_action: RuntimeToolAction | null;
      readonly summary: string | null;
      readonly invocation: string | null;
      readonly items: readonly string[];
      readonly status: 'started' | 'completed' | 'failed';
      readonly arguments_json: string | null;
      readonly result_json: string | null;
      readonly redacted: boolean;
    }
  | {
      /**
       * The runtime stopped producing, once per native turn. It is the display
       * stream's terminal: a surface showing this Agent's activity finishes on
       * it. Core publishes the same fact for an input no runtime ever accepted,
       * because such an input still opened a surface that nothing else closes.
       */
      readonly kind: 'turn.ended';
      readonly status: 'completed' | 'failed' | 'interrupted';
      /** Why it ended, when the producer holds a reason; `null` otherwise. */
      readonly reason: string | null;
      readonly redacted: boolean;
    };

/**
 * One runtime activity fact for this TeamMate.
 *
 * A single published kind carries the whole runtime vocabulary, so a runtime
 * that learns to report something new adds a {@link TeammateActivity} member
 * and changes no event catalog, no seal, and no Channel subscription.
 */
export type TeammateActivityEvent = TeammateActorScope & {
  readonly kind: 'teammate.activity';
  readonly activity: TeammateActivity;
};
