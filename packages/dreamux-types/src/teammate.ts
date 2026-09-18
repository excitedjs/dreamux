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
import type { RuntimeActivity } from './agent-runtime.js';

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
  readonly schemaVersion: 1;
  readonly kind: 'teammate.state';
  readonly occurredAt: number;
  readonly teammateName: string;
  /** Runtime projection supplied by the owning Service; never persisted. */
  readonly role: TeammateRole;
  /** `null` for a Dispatcher, which never appears in a Team summary. */
  readonly teamName: string | null;
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
  readonly schemaVersion: 1;
  readonly occurredAt: number;
  readonly teammateName: string;
  /** Runtime projection supplied by the owning Service; never persisted. */
  readonly role: TeammateRole;
  /** `null` for a Dispatcher, which never belongs to a Team. */
  readonly teamName: string | null;
}

/**
 * Which producer's work an automated push-back reports.
 *
 * Carried only where the body alone cannot say it. A cron fire and a restart
 * notice already name themselves through `source`, and an ordinary task or
 * Channel message is the sender's own words; a completion push-back is the one
 * input whose provenance name is the same for every producer, so the producer
 * is stated here rather than recovered by parsing the notification prose.
 */
export type TeammateInputNotice =
  | { readonly kind: 'teammate_completion'; readonly producer: string }
  | { readonly kind: 'workflow_completion' };

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
  readonly sourceId: string | null;
  /** The source's own body, never the assembled provenance envelope. */
  readonly content: string;
  /**
   * What kind of automated push-back this is, when it is one. `null` for every
   * input a person or an Agent wrote, whose body is what a reader wants. Its
   * producer name is an Agent name the host assigned, not payload text, so it
   * carries neither a secret nor a path.
   */
  readonly notice: TeammateInputNotice | null;
};

/**
 * One runtime activity fact for this TeamMate.
 *
 * A single published kind carries the whole runtime vocabulary, so a runtime
 * that learns to report something new adds a {@link RuntimeActivity} member
 * and changes no event catalog, no seal, and no Channel subscription.
 */
export type TeammateActivityEvent = TeammateActorScope & {
  readonly kind: 'teammate.activity';
  readonly activity: RuntimeActivity;
};
