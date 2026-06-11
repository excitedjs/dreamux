import type { AgentRuntimeCapabilities } from '../../agent-runtime/index.js';
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
  owner: TeamMateOwner;
  /**
   * Minimal internal routing state (issue #199 Slice 3): `owner` is the
   * ownership/visibility authority, but a TeamLeader's `owner.kind` is
   * `dispatcher` (like an ordinary teammate), so `role` is what distinguishes a
   * leader from an ordinary teammate, and `team_id` carries the leader's team
   * (its `owner` has no `team_id`). Both stay off every public surface.
   */
  role: TeamMateRole;
  team_id: string | null;
  /**
   * The `agents[].id` this teammate runs (persisted so resume re-resolves the
   * runtime config from `DreamuxConfig.agents`). Replaces the former
   * `provider_ref`: a teammate references an agent, not a provider directly.
   */
  agent_runtime: string;
  /**
   * Runtime-native session/thread id (issue #199 Slice 3). The runtime reports
   * its resumable thread id and it is persisted here directly; `send` reopens a
   * closed teammate by rebuilding the resume checkpoint from this id plus the
   * runtime's own declared checkpoint kind (the kind is never persisted as a
   * durable concept). Null until the runtime reports a thread. This is also the
   * public `session_id` surfaced by status/list. The former Dreamux-minted
   * ledger key and the persisted `checkpoint` object were removed with the
   * session ledger.
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
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
  /**
   * Rolling recovery summary (issue #199 Slice 3), maintained on each turn so
   * `history` / `list` read the record alone without folding the per-turn
   * archive. `turn_count` counts submitted turns; `last_seen_at` is the last
   * lifecycle/turn timestamp; the previews are bounded forms of the most recent
   * prompt and final assistant output.
   */
  turn_count: number;
  last_seen_at: number;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
}

/**
 * One row in a teammate's per-name turns archive `teammate/turns/<name>.jsonl`
 * (issue #199 Slice 3, the only JSONL store). Append-only, one line per turn
 * event. Rows are COMPACT — turn-specific facts only; the common/recovery facts
 * (name / owner / repo / intent / status) live on `teammate/records/<name>.json`
 * and are not repeated here. `last` folds this file, pairing a `submit` row with
 * its `settled` row by `turn_id`. The file IS the session (concrete names are
 * never reused), so no session key is stored.
 */
export type TeamMateTurnRecordType = 'submit' | 'settled';

export interface TeamMateTurnRecord {
  version: 1;
  type: TeamMateTurnRecordType;
  /** Join key between a turn's `submit` and `settled` rows. */
  turn_id: string | null;
  timestamp: number;
  /** `submit`: where the turn originated (dispatcher / team_leader / channel). */
  turn_origin: TeamMateTurnOrigin | null;
  /** `submit`: a bounded preview of the submitted prompt. */
  prompt_preview: string | null;
  /** `submit`: the recovery subject recorded when the turn was submitted. */
  intent: string | null;
  /** `settled`: the terminal turn status. */
  settle_status: 'completed' | 'failed' | 'stopped' | null;
  /**
   * `settled`: the teammate's final assistant output, captured up to a hard cap
   * (issue #188). The failed-completion-delivery fallback `last` returns; null
   * for `submit` rows or when no output was captured.
   */
  assistant: string | null;
  /** `settled`: a bounded preview of {@link assistant}. */
  assistant_preview: string | null;
  /** `settled`: true when {@link assistant} was truncated at the hard cap. */
  assistant_truncated: boolean;
}

/**
 * Compact `repo` output view (issue #199 Slice 2). Collapses the legacy
 * `source_cwd` / `cwd` / `runtime_cwd` / `source_repo` / flattened `worktree`
 * fields into one object that mirrors the public `repo` INPUT vocabulary: it
 * reports the resolved work directory (`path`), the git-canonical repository
 * identity (`source_repo`), and the worktree mode / cleanup facts. The
 * machine-local `slug` and `cleanup_error` internals stay off the public view.
 */
export interface TeamMateRepoView {
  mode: TeamMateWorktreeIdentity['mode'];
  path: string;
  source_repo: string | null;
  branch: string | null;
  base_ref: string | null;
  cleanup: TeamMateWorktreeCleanupPolicy;
  cleanup_state: TeamMateWorktreeCleanupState;
}

/**
 * Public single-record / list projection for a TeamMate (issue #199 Slice 2).
 * `owner` is the sole ownership/visibility authority — the public `role` and the
 * redundant `team_id` are gone. The Dreamux-made `display_name` and the runtime
 * `checkpoint` wrapper are no longer surfaced. `session_id` now means the
 * runtime-native session/thread id (early `null` is acceptable), not the former
 * Dreamux-minted ledger key. The cwd/worktree family is collapsed into `repo`.
 */
export interface TeamMateRuntimeStatus {
  name: string;
  /** Runtime-native session/thread id (the runtime checkpoint id); null until known. */
  session_id: string | null;
  owner: TeamMateOwner;
  agent_runtime: string;
  repo: TeamMateRepoView;
  intent: string | null;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
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
    }
  | {
      /**
       * Internal Team-service authority (issue #199 Slice 4): grants the Team
       * service control over its OWN Team — the TeamLeader record plus the
       * members of `teamId`. It is constructed ONLY by the Team service (the
       * public admin/MCP layer never derives it from a caller), so it can never
       * widen the dispatcher/team_leader/teammate visibility of the public
       * `teammate.*` surface.
       */
      kind: 'team_service';
      dispatcherId: string;
      teamId: string;
      leaderName: string;
    };

export interface TeamMateDispatcherOwner {
  kind: 'dispatcher';
  dispatcher_id: string;
}

/**
 * Where a teammate turn was submitted from, recorded per turn id at submit
 * time and resolved again when the turn settles. This is what decides where
 * the completion is delivered: a `channel` turn on a TeamLeader stays
 * pull-only, while a `dispatcher`-initiated turn returns to the
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
  /** Required recovery subject for the record (issue #182 PR-3). */
  intent: string;
}

export interface CreateTeamLeaderInput {
  dispatcherId: string;
  teamId: string;
  /** The concrete, never-reused TeamLeader address allocated by the caller (issue #188). */
  name: string;
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
  /** Required close reason recorded on the record (issue #182 PR-3). */
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
  name?: string;
  /** Lifecycle status filter (replaces the retired `state`/`close_status`). */
  status?: TeamMateIdentityStatus;
  agentRuntime?: string;
  /** Substring match over `source_repo`. */
  repo?: string;
  grep?: string;
  /** Inclusive lower/upper bounds on `last_seen_at`. */
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Recovery hint telling the caller how to reattach: there is no separate resume
 * verb, so `send` (by concrete `name`) reopens a closed TeamMate from its
 * persisted checkpoint. The checkpoint itself is internal and never surfaced
 * (issue #199 Slice 1).
 */
export interface TeamMateResumeHint {
  tool: 'send';
  name: string;
}

/**
 * Public TeamMate recovery row (issue #199 Slice 1). A compact projection keyed
 * by the concrete `name`: ownership/visibility via `owner`, no Dreamux-made
 * `session_id`, no `id`/`team_id`/`display_name`/`role`, no `close_status`/`state`
 * duplicate of `status`, and no `checkpoint` or machine-local cwd/worktree paths.
 */
export interface TeamMateRecordRow {
  name: string;
  /** Number of submitted turns recorded on the record (0 when none yet). */
  turn_count: number;
  owner: TeamMateOwner;
  agent_runtime: string;
  source_repo: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  intent: string | null;
  closed_at: number | null;
  close_note: string | null;
  close_note_preview: string | null;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
  cleanup_state: TeamMateWorktreeCleanupState;
  resume: TeamMateResumeHint | null;
}

export interface TeamMateHistoryResult {
  items: TeamMateRecordRow[];
  next_cursor: string | null;
}

/**
 * One settled turn returned by `last` (issue #199 Slice 3), folded from the
 * per-name turns archive in file append order. Each turn pairs the submit row
 * (spawn/send/channel) with the settled row by `turn_id`, so recovery sees the
 * prompt/intent/origin alongside the assistant output. This is a pure read of
 * captured facts — it never starts or resumes a runtime, so it works for a
 * closed or stopped teammate.
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
  /** Turn-archive timestamp of the submit row, or null if only the settle was seen. */
  submitted_at: number | null;
  /** Turn-archive timestamp of the settled row. */
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

/**
 * The internal Team-service authority over one Team (issue #199 Slice 4): the
 * TeamLeader record plus the members of `teamId`. Built ONLY by the Team service.
 */
export function teamServicePrincipal(input: {
  dispatcherId: string;
  teamId: string;
  leaderName: string;
}): TeamMateCallerPrincipal {
  return {
    kind: 'team_service',
    dispatcherId: input.dispatcherId,
    teamId: input.teamId,
    leaderName: input.leaderName,
  };
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
