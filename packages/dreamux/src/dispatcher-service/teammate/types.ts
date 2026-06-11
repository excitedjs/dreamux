import type {
  AgentRuntimeCapabilities,
  AgentRuntimeResumeCheckpoint,
} from '../../agent-runtime/index.js';
import type { DispatcherStatus } from '../../state/dispatcher-store.js';

export const TEAMMATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TeamMateIdentityStatus =
  | 'starting'
  | 'running'
  | 'degraded'
  | 'closed'
  | 'stopped';

export type TeamMateRole = 'teammate' | 'team_leader' | 'team_member';

export interface TeamMateIdentity {
  version: 1;
  dispatcher_id: string;
  /**
   * The concrete, never-reused stable address (issue #188). Allocated by the
   * service from the agent-supplied base slug plus a random suffix; this is the
   * value all later send/status/last/close calls key on.
   */
  name: string;
  /**
   * The agent-supplied base slug / display hint that produced {@link name}
   * (issue #188). Surfaced by list/status/history so a human sees the requested
   * label while `name` stays the address. Null for pre-#188 records (which
   * read back with no display name) — callers fall back to `name`.
   */
  display_name: string | null;
  owner: TeamMateOwner;
  role: TeamMateRole;
  team_id: string | null;
  /**
   * The `agents[].id` this teammate runs (persisted so resume re-resolves the
   * runtime config from `DreamuxConfig.agents`). Replaces the former
   * `provider_ref`: a teammate references an agent, not a provider directly.
   */
  agent_runtime: string;
  /**
   * Stable session identifier (issue #182 PR-5), generated at spawn and reused
   * when `send` reopens a closed teammate from its checkpoint, so the durable
   * session ledger keys on a value that never re-keys to the runtime thread id.
   * Nullable for backward compatibility: identity records written before PR-5
   * read as `null`. A fresh spawn (including reusing a closed record) mints a
   * new id.
   */
  session_id: string | null;
  /**
   * The caller-supplied workspace cwd. `cwd` remains the runtime cwd for
   * compatibility with pre-#169 clients and equals either this value
   * (`reuse-cwd`) or the prepared managed worktree path.
   */
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  intent: string | null;
  created_at: number;
  updated_at: number;
  status: TeamMateIdentityStatus;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

/**
 * One durable session-ledger event (issue #182 PR-5). Append-only, one line per
 * lifecycle fact in the per-dispatcher `sessions.jsonl`. Every event denormalizes
 * the recovery facts (repo / cwd / worktree / name / team / intent / runtime
 * checkpoint id) so a session can be reconstructed weeks later from the ledger
 * alone, without joining other files. No volatile socket path is ever recorded.
 */
export type TeamMateSessionEventType = 'spawn' | 'send' | 'settled' | 'close';

export interface TeamMateSessionLedgerEvent {
  version: 1;
  /** Stable per-session key, minted at spawn (not the runtime thread id). */
  session_id: string;
  event_id: number;
  timestamp: number;
  type: TeamMateSessionEventType;
  dispatcher_id: string;
  name: string;
  /** Agent-supplied base slug / display hint (issue #188); null for legacy events. */
  display_name: string | null;
  role: TeamMateRole;
  team_id: string | null;
  /** Concrete TeamLeader name for a team member, else the leader's own name. */
  leader_name: string | null;
  owner: TeamMateOwner;
  agent_runtime: string;
  source_repo: string | null;
  source_cwd: string;
  cwd: string;
  worktree_slug: string | null;
  worktree_path: string;
  branch: string | null;
  base_ref: string | null;
  intent: string | null;
  /** Runtime checkpoint kind (e.g. the codex/claude session kind), when known. */
  checkpoint_kind: string | null;
  /** Runtime-resumable session/thread id (checkpoint id), when known. Not a socket. */
  session_ref: string | null;
  status: TeamMateIdentityStatus;
  /** `send`/`spawn`: the turn id; null otherwise. */
  turn_id: string | null;
  /**
   * Where a turn-submitting event originated, preserved for recovery (PR #187
   * review P1): `dispatcher` / `team_leader` for spawn+send, `channel` for a
   * turn delivered through a bound Team channel. Null for non-turn events.
   */
  turn_origin: TeamMateTurnOrigin | null;
  /** `send`/`spawn`: a bounded preview of the submitted prompt. */
  prompt_preview: string | null;
  /** `settled`: a bounded preview of the teammate's final assistant output. */
  assistant_preview: string | null;
  /**
   * `settled`: the teammate's final assistant output, captured durably up to a
   * hard cap (issue #188). This is the failed-completion-delivery fallback that
   * `last` returns; null for non-settled events or when no output was captured.
   */
  assistant: string | null;
  /** `settled`: true when {@link assistant} was truncated at the hard cap. */
  assistant_truncated: boolean;
  /** `settled`: the terminal turn status. */
  settle_status: 'completed' | 'failed' | 'stopped' | null;
  /** `close`: the required close/dissolve note. */
  note: string | null;
}

/**
 * A materialized session row (issue #182 PR-5), folded from the ledger events of
 * one `session_id`. This is the recovery view a future read surface (PR-6) will
 * expose; PR-5 builds the durable capture and the in-process materialization.
 */
export interface TeamMateSessionRow {
  session_id: string;
  dispatcher_id: string;
  name: string;
  display_name: string | null;
  role: TeamMateRole;
  team_id: string | null;
  leader_name: string | null;
  agent_runtime: string;
  checkpoint_kind: string | null;
  session_ref: string | null;
  source_repo: string | null;
  source_cwd: string;
  cwd: string;
  worktree_slug: string | null;
  worktree_path: string;
  branch: string | null;
  base_ref: string | null;
  intent: string | null;
  created_at: number;
  last_seen_at: number;
  status: TeamMateIdentityStatus;
  turn_count: number;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
  close_note_preview: string | null;
}

export interface TeamMateRuntimeStatus {
  name: string;
  /** Agent-supplied base slug / display hint (issue #188); null for legacy records. */
  display_name: string | null;
  /** Stable session id, for recovery (issue #182 PR-5/#188); null for legacy records. */
  session_id: string | null;
  owner: TeamMateOwner;
  role: TeamMateRole;
  team_id: string | null;
  agent_runtime: string;
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  intent: string | null;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export type TeamMateOwner =
  | {
      kind: 'dispatcher';
      dispatcher_id: string;
    }
  | {
      kind: 'team';
      dispatcher_id: string;
      team_id: string;
      leader_name: string;
    };

export type TeamMateCallerPrincipal =
  | {
      kind: 'dispatcher';
      dispatcherId: string;
    }
  | {
      kind: 'team_leader';
      dispatcherId: string;
      teamId: string;
      leaderName: string;
    }
  | {
      kind: 'teammate';
      dispatcherId: string;
    };

export interface TeamMateDispatcherOwner {
  kind: 'dispatcher';
  dispatcher_id: string;
}

/**
 * Where a teammate turn was submitted from, recorded per turn id at submit
 * time and resolved again when the turn settles. This is what decides where
 * the completion is delivered: a `channel` turn on a TeamLeader stays
 * pull-only (team ledger), while a `dispatcher`-initiated turn returns to the
 * dispatcher runtime as a completion. A settle whose turn id was never
 * recorded (e.g. submitted before a server restart) resolves to `null` and
 * the facade picks the safe default for the role.
 */
export type TeamMateTurnOrigin = 'channel' | 'dispatcher' | 'team_leader';

export interface SpawnTeamMateInput {
  dispatcherId: string;
  name: string;
  prompt: string;
  /**
   * The `agents[].id` this teammate runs. Resolved against the global agents
   * map (`DreamuxConfig.agents`) into a `{ provider, config }` runtime. Omitted
   * falls back to the dispatcher's own `agentRuntime` id. A teammate may name a
   * different agent than its dispatcher (e.g. a claude teammate under a codex
   * dispatcher) — its config comes from that agent, never inherited.
   */
  agentRuntime?: string;
  cwd: string;
  worktree?: TeamMateWorktreeRequest;
  /** Required recovery subject for the session ledger (issue #182 PR-3). */
  intent: string;
}

export interface CreateTeamLeaderInput {
  dispatcherId: string;
  teamId: string;
  /** The concrete, never-reused TeamLeader address allocated by the caller (issue #188). */
  name: string;
  /** Human-readable display label (e.g. `${teamId}-leader`); falls back to `name`. */
  displayName?: string | null;
  prompt: string;
  agentRuntime: string;
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: TeamMateWorktreeIdentity;
  intent?: string | null;
}

export interface TeamMateWorktreeRequest {
  mode: 'reuse-cwd' | 'managed';
  slug?: string;
  base_ref?: string;
  branch?: string;
  cleanup?: 'keep' | 'delete-on-close';
}

export type TeamMateWorktreeCleanupPolicy = 'keep' | 'delete-on-close';

export type TeamMateWorktreeCleanupState =
  | 'not-managed'
  | 'managed-active'
  | 'kept'
  | 'deleted'
  | 'retained-dirty'
  | 'retained-unmerged'
  | 'retained-unique-commits'
  | 'retained-error';

export interface TeamMateWorktreeIdentity {
  mode: 'reuse-cwd' | 'managed';
  slug: string | null;
  path: string;
  branch: string | null;
  base_ref: string | null;
  cleanup: TeamMateWorktreeCleanupPolicy;
  cleanup_state: TeamMateWorktreeCleanupState;
  cleanup_error: string | null;
}

export interface SendTeamMateInput {
  dispatcherId: string;
  name: string;
  prompt: string;
  /**
   * Optional updated recovery subject (issue #182 PR-3). When supplied, the
   * teammate's recorded `intent` is updated before the turn is submitted.
   */
  intent?: string;
}

export interface CloseTeamMateInput {
  dispatcherId: string;
  name: string;
  /** Required close reason recorded in the ledger (issue #182 PR-3). */
  note: string;
}

export interface TeamMateTurnResult {
  status: 'submitted' | 'duplicate' | 'stopped' | 'failed';
  turn_id?: string;
  error?: string;
}

export interface TeamMateSpawnResult {
  teammate: TeamMateRuntimeStatus;
  turn: TeamMateTurnResult;
}

export interface TeamMateSendResult {
  teammate: TeamMateRuntimeStatus;
  turn: TeamMateTurnResult;
}

export interface TeamMateCloseResult {
  teammate: TeamMateRuntimeStatus;
}

export interface TeamMateHistoryQuery {
  dispatcherId: string;
  principal?: TeamMateCallerPrincipal;
  id?: string;
  name?: string;
  agentRuntime?: string;
  state?: TeamMateIdentityStatus | 'active';
  closeStatus?: 'open' | 'closed';
  sourceCwd?: string;
  runtimeCwd?: string;
  grep?: string;
  limit?: number;
  cursor?: string;
}

export interface TeamMateLedgerResumeHint {
  tool: 'send';
  name: string;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
}

export interface TeamMateLedgerRow {
  id: string;
  name: string;
  display_name: string | null;
  /** Stable session id of the latest session, when known (issue #182 PR-5/#188). */
  session_id: string | null;
  /** Number of submitted turns in the session ledger (0 when no session captured). */
  turn_count: number;
  team_id: string | null;
  role: TeamMateRole;
  owner: TeamMateOwner;
  agent_runtime: string;
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: TeamMateWorktreeIdentity;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  state: TeamMateIdentityStatus;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  intent: string | null;
  close_status: 'open' | 'closed';
  closed_at: number | null;
  close_note: string | null;
  close_note_preview: string | null;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
  cleanup_state: TeamMateWorktreeCleanupState;
  resume: TeamMateLedgerResumeHint | null;
}

export interface TeamMateHistoryResult {
  items: TeamMateLedgerRow[];
  next_cursor: string | null;
}

/**
 * One settled turn returned by `last` (issue #188), folded from the durable
 * session ledger by `session_id` in ledger append order. Each turn pairs the
 * submit-side event (spawn/send/channel) with the settled row by `turn_id`, so
 * recovery sees the prompt/intent/origin alongside the assistant output. This is
 * a pure read of captured facts — it never starts or resumes a runtime, so it
 * works for a closed or stopped teammate.
 */
export interface TeamMateLastTurn {
  /** The turn id; the join key between the submit event and the settled row. */
  turn_id: string;
  /** Where the turn was submitted from (dispatcher/team_leader/channel), if known. */
  turn_origin: TeamMateTurnOrigin | null;
  /** Bounded preview of the submitted prompt, when the submit event was captured. */
  prompt_preview: string | null;
  /** Recovery subject recorded at submit time, when known. */
  intent: string | null;
  /** Ledger timestamp of the submit event, or null if only the settle was seen. */
  submitted_at: number | null;
  /** Ledger timestamp of the settled event. */
  settled_at: number;
  settle_status: 'completed' | 'failed' | 'stopped' | null;
  /** The teammate's final assistant output, captured up to the hard cap. */
  assistant: string | null;
  /** A compact preview of {@link assistant} for terse displays. */
  assistant_preview: string | null;
  /** True when {@link assistant} was truncated at the durable hard cap. */
  assistant_truncated: boolean;
}

export interface TeamMateLastResult {
  teammate: TeamMateRuntimeStatus;
  /** The resolved session the turns were read from, or null when none exists yet. */
  session_id: string | null;
  /** The validated requested turn count (1..5). */
  requested_turns: number;
  /** How many settled turns were actually available (<= requested). */
  returned_turns: number;
  /** Settled turns in append order, oldest first; the last entry is the newest. */
  turns: TeamMateLastTurn[];
}

export interface TeamMateAgentRuntimeCapability {
  /** The spawnable `agents[].id`; pass this as `spawn.agent_runtime`. */
  id: string;
  /** Copyable argument fragment for `spawn({ agent_runtime: id, ... })`. */
  spawn: { agent_runtime: string };
  runtime_available: boolean;
  resume: AgentRuntimeCapabilities['resume'];
  steer: AgentRuntimeCapabilities['steer'];
  events: AgentRuntimeCapabilities['events'];
  last: AgentRuntimeCapabilities['last'];
  context: AgentRuntimeCapabilities['context'];
  unsupported_reason: string | null;
}

export interface TeamMateCapabilities {
  verbs: string[];
  agent_runtimes: TeamMateAgentRuntimeCapability[];
}

export function dispatcherPrincipal(dispatcherId: string): TeamMateCallerPrincipal {
  return { kind: 'dispatcher', dispatcherId };
}

export function teamLeaderPrincipal(input: {
  dispatcherId: string;
  teamId: string;
  leaderName: string;
}): TeamMateCallerPrincipal {
  return {
    kind: 'team_leader',
    dispatcherId: input.dispatcherId,
    teamId: input.teamId,
    leaderName: input.leaderName,
  };
}

export function teammatePrincipal(dispatcherId: string): TeamMateCallerPrincipal {
  return { kind: 'teammate', dispatcherId };
}

export function principalDispatcherId(principal: TeamMateCallerPrincipal): string {
  return principal.dispatcherId;
}

export function validateTeamMateName(name: string): string {
  if (!TEAMMATE_NAME_PATTERN.test(name)) {
    throw new Error(
      'TeamMate name must be 1-64 ASCII letters, digits, dots, underscores, ' +
        `or dashes, starting with a letter or digit: ${name}`,
    );
  }
  return name;
}

/**
 * Service-boundary guard for a required lifecycle field — the recovery subject
 * (`intent`) and the stop reason (`note`) made mandatory in issue #182 PR-3.
 * The MCP shim and admin layer already reject missing/empty values, but
 * in-process callers reach the service methods directly, so the same contract
 * is enforced here too (defense in depth, not only a TypeScript type). `label`
 * is interpolated into the error so the offending field is clear.
 */
export function requireLifecycleText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function runtimeStatusToIdentityStatus(
  status: DispatcherStatus,
): TeamMateIdentityStatus {
  switch (status) {
    case 'ready':
      return 'running';
    case 'starting':
      return 'starting';
    case 'degraded':
      return 'degraded';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'declared':
      return 'stopped';
  }
}
