/**
 * Team domain contracts (declaration-only).
 *
 * The Team owns its canonical Commands and its aggregate state event. Both
 * Command payloads below are the two whose contracts change materially for
 * Channel use; every other canonical Team Command keeps its current domain
 * behavior and is defined by its own domain-owned Command module in Core.
 */
import type { AgentRuntimeSkillSource } from './agent-runtime.js';
import type { ChannelCommandError } from './command.js';
import type { TeamMemberRole, TeammateStatus } from './teammate.js';
import type { InboundTurnInput } from './turn.js';

/**
 * A per-Team managed repository request. It selects the source repository and
 * the ref the Team's managed worktree is created from.
 */
export interface ManagedRepoRequest {
  /** Source repository working directory the worktree branches from. */
  readonly path: string;
  /** Git ref the worktree is created from. */
  readonly base_ref: string;
}

/**
 * Create a Team with restart-durable request identity.
 *
 * Core canonicalizes the validated payload and persists
 * `request_id -> {payload_hash, reserved_team_name, status}` before creating any
 * resource, so the same id and hash always return the same never-reused name —
 * including after a Core restart or Team closure. Reusing an id with a different
 * hash fails with `IDEMPOTENCY_CONFLICT`; a new provisioning generation must use
 * a new request id.
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
  readonly repo?: ManagedRepoRequest;
}

export interface TeamCreateResult {
  /** `closed` is the replay of an accepted id whose Team has since closed. */
  readonly status: 'created' | 'existing' | 'closed';
  readonly team_name: string;
  readonly leader_name: string;
}

/**
 * Submit one turn to a Team.
 *
 * Omitting `team_name` targets the Dispatcher Agent; otherwise Core resolves the
 * stable Team and submits only to its TeamLeader. The `inbound` variant is used
 * by Channel bridges and the invoker scopes its source deduplication to the
 * calling Channel; the `text` variant is the Dreamux-owned plain-text path.
 */
export interface TeamSubmitCommand {
  readonly team_name?: string;
  readonly submission:
    | {
        readonly kind: 'inbound';
        readonly input: InboundTurnInput;
        /**
         * A bounded opaque Channel-chosen string. Core never parses, routes,
         * authorizes, or deduplicates with it, and echoes it unchanged on every
         * related submitted/activity/settled event.
         */
        readonly correlation?: string;
      }
    | {
        readonly kind: 'text';
        readonly text: string;
        readonly intent?: string;
        readonly source_id?: string;
      };
}

/**
 * `submitted` carries the Core `turn_id`; `duplicate` does not invent one,
 * because provider-owned deduplication has no submission identity or
 * source-to-turn ledger. The provider seam's internal `skipped` is normalized to
 * `stopped` here. `ambiguous` is an unknown boundary outcome and is never
 * retried.
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

export interface TeamStateMemberSummary {
  readonly teammate_name: string;
  readonly role: TeamMemberRole;
  readonly status: TeammateStatus;
}

/**
 * The Team aggregate, republished whenever the Team lifecycle changes or a
 * contained TeamLeader/member is created or changes state.
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
  readonly teammates: readonly TeamStateMemberSummary[];
}
