/**
 * Team domain contracts (declaration-only).
 *
 * The Team owns its canonical Commands and its aggregate state event. Both
 * Command payloads below are the two whose contracts change materially for
 * Channel use; every other canonical Team Command keeps its current domain
 * behavior and is defined by its own domain-owned Command module in Core.
 */
import type { AgentRuntimeSkillSource, AgentRuntimeStatus } from './agent-runtime.js';
import type { ChannelCommandError } from './command.js';
import type { TeamContainedRole, TeammateStatus } from './teammate.js';

/**
 * A Team's repository policy. It is the complete existing Team-creation
 * capability, not a Channel-shaped subset: `reuse-cwd` reuses a caller-selected
 * or default working directory, and `managed` creates a git worktree with the
 * existing optional path, base ref, branch, slug, and cleanup controls. An
 * omitted request keeps the dispatcher's default shared work directory.
 *
 * A Channel that owns only a narrow policy — Feishu supplies `path`/`base_ref`
 * — maps it into the `managed` branch before invoking the Command, so no
 * Channel-specific repository shape exists in this contract.
 */
export type TeamCreateRepoRequest =
  | {
      readonly mode: 'reuse-cwd';
      /** Existing working directory to reuse; omitted means the default. */
      readonly path?: string;
    }
  | {
      readonly mode: 'managed';
      /** Source repository the worktree branches from; omitted means the default. */
      readonly path?: string;
      readonly base_ref?: string;
      readonly branch?: string;
      readonly slug?: string;
      readonly cleanup?: 'keep' | 'delete-on-close';
    };

/**
 * Create a Team with restart-durable request identity.
 *
 * Core canonicalizes the validated payload and stores its request id and hash
 * on the exclusively published Team record. That record is the acceptance and
 * concrete-name claim, so the same id and hash always return the same
 * never-reused name — including after a Core restart or Team closure. Reusing
 * an id with a different hash fails with `IDEMPOTENCY_CONFLICT`; a new
 * provisioning generation must use a new request id.
 *
 * Core still injects the mandatory TeamLeader instructions and skill sources:
 * supplied values extend those requirements rather than removing them.
 */
export interface TeamCreateCommand {
  readonly request_id: string;
  readonly name_prefix: string;
  readonly intent: string;
  readonly leader: {
    readonly agent_runtime: string;
    readonly identity?: string;
    readonly prompt?: string;
    readonly skill_sources?: readonly AgentRuntimeSkillSource[];
  };
  readonly repo?: TeamCreateRepoRequest;
}

export type TeamStatus = 'starting' | 'running' | 'closed';

/** The current Team facts shared by create, list, and status. */
export interface TeamSummary {
  readonly team_name: string;
  readonly status: TeamStatus;
  readonly intent: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly closed_at: number | null;
  readonly close_note: string | null;
  readonly leader_name: string;
  readonly leader_agent_runtime: string;
  readonly runtime_cwd: string;
  /** Null when the accepted Team has no readable, aligned leader identity. */
  readonly leader_state: TeammateStatus | null;
  readonly leader_session_id: string | null;
  readonly leader_runtime_status: AgentRuntimeStatus | null;
  readonly leader_intent: string | null;
  readonly leader_last_error: string | null;
  readonly leader_closed_at: number | null;
  readonly leader_close_note: string | null;
  /** Member-directory occupancy, including closed/unreadable identities; leader excluded. */
  readonly member_count: number;
  readonly source_repo: string | null;
  readonly worktree_mode: 'reuse-cwd' | 'managed';
  readonly worktree_cleanup_mode: 'keep' | 'delete-on-close';
  readonly worktree_cleanup:
    | 'not-managed'
    | 'managed-active'
    | 'cleanup-pending'
    | 'kept'
    | 'deleted'
    | 'retained-dirty'
    | 'retained-unmerged'
    | 'retained-unique-commits'
    | 'retained-error';
}

/**
 * Submit one turn to a Team.
 *
 * Omitting `team_name` targets the Dispatcher Agent; supplying it submits only
 * to that Team's TeamLeader. Which of the two a caller wants is the caller's
 * own decision — a Channel routes its external conversation and says so by
 * naming a Team or not naming one — and `admin.sock` has exactly the same two
 * targets. Channel and admin adapters share this one flat payload: the caller
 * interprets its own external envelope and supplies the display attributes,
 * the faithful model-facing `text`, and at most one trailing reminder, while
 * Core assembles the provenance envelope around them and never reads what
 * they mean.
 */
export interface TeamSubmitCommand {
  readonly team_name?: string;
  /**
   * Unordered display attributes rendered onto the envelope's start tag.
   * Omitting them is exactly the empty set. Names are open but must be safe
   * start-tag names; values are arbitrary text and are escaped for the model.
   * Core renders them and never interprets one.
   */
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text: string;
  /**
   * One optional note rendered once after the closed envelope, at the very end
   * of this input. It is the caller's own standing instruction to the model,
   * not a per-message annotation, so it is never repeated inside `text`. An
   * empty string is exactly an omitted one; anything else is rendered as given.
   */
  readonly reminder?: string;
  readonly intent?: string;
  /**
   * Optional stable source identity. Core — not a Provider — deduplicates with
   * it, scoped to the target entity alone, so the owner that chooses the value
   * is the owner responsible for it being stable. Omitted or empty bypasses
   * deduplication entirely.
   */
  readonly source_id?: string;
}

/**
 * `submitted` carries the Core `turn_id`; `duplicate` does not invent one,
 * because Core returns it before runtime admission and therefore creates no
 * second runtime submission or turn identity. The provider seam's internal
 * `skipped` is normalized to `stopped` here. `ambiguous` is an unknown boundary
 * outcome and is never retried.
 */
export interface TeamSubmitResult {
  readonly status:
    | 'submitted'
    | 'duplicate'
    | 'stopped'
    | 'failed'
    | 'ambiguous';
  readonly turn_id?: string;
  readonly error?: ChannelCommandError;
}

export interface TeamStateTeammateSummary {
  readonly teammate_name: string;
  /**
   * Derived by the Team that owns the row — its leader is `team_leader`, every
   * Agent in its TeammateCollection is `teammate`. It is not read from any
   * persisted field.
   */
  readonly role: TeamContainedRole;
  readonly status: TeammateStatus;
}

/**
 * The Team aggregate, republished whenever the Team lifecycle changes or a
 * contained TeamLeader/TeamMate is created or changes state.
 *
 * It is intentionally redundant with `teammate.state`. Its `teammates` array is
 * a current bounded summary, not a second state authority: the Core Team and
 * Agent stores remain authoritative. A Dispatcher never appears in it.
 */
export interface TeamStateEvent {
  readonly schema_version: 1;
  readonly kind: 'team.state';
  readonly occurred_at: number;
  readonly team_name: string;
  readonly leader_name: string;
  readonly status: 'starting' | 'running' | 'closed';
  readonly teammates: readonly TeamStateTeammateSummary[];
}
