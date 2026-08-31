import type {
  AgentActivityRecord,
  AgentRuntimeSessionRef,
  AgentRuntimeSkillSource,
  AgentRuntimeStatus,
  JsonValue,
} from "@excitedjs/dreamux-types";
import { RuleViolation } from '../../platform/errors.js';

export const TEAMMATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The fixed name of the dispatcher's own agent entity (issue #233 Phase 5).
 * Single source of truth: identity-store, dispatcher-agent factory, and
 * runtime-profile scope assertion all import this one constant.
 */
export const DISPATCHER_AGENT_NAME = 'dispatcher';

/**
 * Directory segments an agent (teammate or team) name MUST NOT take (issue
 * #233). With the symmetric layout each entity is a directory whose name is the
 * agent name, sitting beside the legacy leaves that `legacy-state.ts` fail-loud
 * detects (`identities/`, `records/`, `turns/`, `history/`, `sessions.jsonl`,
 * `ledger/`). Reserving those names keeps a real entity dir from recreating a
 * path legacy detection would flag, or shadowing the old layout. Matched
 * case-insensitively so a case-folding filesystem can't smuggle a collision.
 * Keep in sync with the probed leaves in `legacy-state.ts`.
 */
export const RESERVED_AGENT_NAME_SEGMENTS = new Set([
  'dispatcher',
  'identities',
  'records',
  'turns',
  'history',
  'sessions',
  'ledger',
]);

export function assertNotReservedAgentName(name: string): void {
  if (RESERVED_AGENT_NAME_SEGMENTS.has(name.toLowerCase())) {
    throw new RuleViolation(
      `name ${JSON.stringify(name)} is reserved by the dreamux state layout ` +
        `(issue #233); choose another. Reserved: ${[...RESERVED_AGENT_NAME_SEGMENTS].join(', ')}`,
    );
  }
}

export type AgentEntityIdentityStatus =
  | "starting"
  | "running"
  | "degraded"
  | "closed"
  | "stopped";

/**
 * Role is deliberately NOT a persisted identity field and has no type here.
 *
 * Only four owners can materialize an Agent — `DispatcherService` (its own root
 * Agent), the dispatcher's `TeammateCollection`, a `TeamService` (its
 * TeamLeader), and that Team's `TeammateCollection` — and each already knows
 * which it is. Whoever needs a role for a prompt, a route, an assertion, or an
 * event supplies the runtime value `dispatcher` / `team_leader` / `teammate`
 * from that fact. A durable copy could disagree with the directory the record
 * actually lives in, and nothing could then say which one was true. Every
 * Team-scoped ordinary Agent is a TeamMate; there is no contained-member kind.
 */

export interface AgentEntityIdentity {
  version: 1;
  dispatcher_id: string;
  name: string;
  team_id: string | null;
  agent_runtime: string;
  /**
   * The provider's own session object, persisted verbatim and returned only to
   * the same provider. Core validates and reads `id` and nothing else; every
   * other field is opaque JSON it must not interpret, index, or branch on.
   */
  session: AgentRuntimeSessionRef | null;
  source_cwd: string;
  source_repo: string | null;
  cwd: string;
  runtime_cwd: string;
  worktree: AgentEntityWorktreeIdentity;
  intent: string | null;
  identity_prompt: string | null;
  /** Persisted admin-supplied sources only; bundled role sources stay owner-composed. */
  skill_sources: readonly AgentRuntimeSkillSource[];
  created_at: number;
  updated_at: number;
  status: AgentEntityIdentityStatus;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export interface AgentEntityRepoView {
  mode: AgentEntityWorktreeIdentity["mode"];
  path: string;
  source_repo: string | null;
  branch: string | null;
  base_ref: string | null;
  cleanup: "keep" | "delete-on-close";
  cleanup_state: AgentEntityWorktreeCleanupState;
}

export interface AgentEntityRuntimeStatus {
  name: string;
  session_id: string | null;
  agent_runtime: string;
  repo: AgentEntityRepoView;
  intent: string | null;
  status: AgentEntityIdentityStatus;
  runtime_status: AgentRuntimeStatus | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export interface CreateTeamLeaderInput {
  name: string;
  /**
   * Optional explicit first-turn prompt. When omitted, the leader is started
   * idle and fires no turn at creation — the team no longer fabricates a
   * synthetic default prompt to auto-run a turn. A leader created without a
   * prompt waits for a bound channel or a dispatcher `send` to drive its first
   * real turn.
   */
  prompt?: string;
  agentRuntime: string;
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: AgentEntityWorktreeIdentity;
  intent?: string | null;
  identity?: string;
}

export type AgentEntityWorktreeCleanupState =
  | "not-managed"
  | "managed-active"
  | "cleanup-pending"
  | "kept"
  | "deleted"
  | "retained-dirty"
  | "retained-unmerged"
  | "retained-unique-commits"
  | "retained-error";

export interface AgentEntityWorktreeIdentity {
  mode: "reuse-cwd" | "managed";
  slug: string | null;
  path: string;
  branch: string | null;
  base_ref: string | null;
  cleanup: "keep" | "delete-on-close";
  cleanup_state: AgentEntityWorktreeCleanupState;
  cleanup_error: string | null;
}

export interface AgentEntitySubmissionResult {
  status: "submitted" | "duplicate" | "stopped" | "failed" | "ambiguous";
  error?: string;
}

export interface AgentEntitySpawnResult extends AgentEntitySubmissionResult {
  teammate: AgentEntityRuntimeStatus;
}

export interface AgentEntitySendResult extends AgentEntitySubmissionResult {
  teammate: AgentEntityRuntimeStatus;
}

export interface AgentEntityCloseResult {
  teammate: AgentEntityRuntimeStatus;
}

export interface AgentEntityHistoryQuery {
  teamId?: string;
  name?: string;
  status?: AgentEntityIdentityStatus;
  agentRuntime?: string;
  repo?: string;
  grep?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

export interface AgentEntityResumeHint {
  tool: "send";
  name: string;
}

export interface AgentEntityRecordRow {
  name: string;
  agent_runtime: string;
  source_repo: string | null;
  created_at: number;
  updated_at: number;
  status: AgentEntityIdentityStatus;
  runtime_status: AgentRuntimeStatus | null;
  intent: string | null;
  closed_at: number | null;
  close_note: string | null;
  close_note_preview: string | null;
  cleanup_state: AgentEntityWorktreeCleanupState;
  resume: AgentEntityResumeHint | null;
}

export interface AgentEntityHistoryResult {
  items: AgentEntityRecordRow[];
  next_cursor: string | null;
}

/**
 * One neutral activity fact projected for a `last` read. It mirrors the public
 * {@link AgentActivityRecord} in Core's snake_case read vocabulary; tool
 * arguments, tool results, and native record shapes never reach it.
 */
export type AgentEntityActivityRecord =
  | {
      kind: 'assistant_message';
      text: string;
      occurred_at: string | null;
    }
  | {
      kind: 'tool';
      name: string;
      status: 'started' | 'completed' | 'failed';
      occurred_at: string | null;
    };

export interface AgentEntityLastQuery {
  limit?: number;
  cursor?: string;
  includeTools?: boolean;
}

export interface AgentEntityLastResult {
  teammate: AgentEntityRuntimeStatus;
  requested_records: number;
  returned_records: number;
  records: AgentEntityActivityRecord[];
  next_cursor: string | null;
  truncated: boolean;
}

/**
 * One spawnable agent runtime as the public capability surface reports it.
 *
 * `tags` and `public_config` are the provider's own declared facts, projected
 * through Core's validated snapshot: they let a caller tell two configured
 * runtimes apart without Core naming any provider. Both are empty/`null` when
 * the provider did not resolve.
 */
export interface AgentEntityRuntimeCapability {
  id: string;
  spawn: { agent_runtime: string };
  runtime_available: boolean;
  unsupported_reason: string | null;
  tags: readonly string[];
  public_config: Readonly<Record<string, JsonValue>> | null;
}

export interface AgentEntityCapabilities {
  verbs: string[];
  agent_runtimes: AgentEntityRuntimeCapability[];
}

/**
 * Validate an agent entity name (dispatcher, teammate, team leader, or team
 * member). The neutral name used by the agent-entity stores and shared
 * runtime holder; teammate-facing request/types may keep a `TeamMate*`
 * wrapper or alias on top.
 */
export function validateAgentEntityName(name: string): string {
  if (!TEAMMATE_NAME_PATTERN.test(name)) {
    throw new RuleViolation(
      "Agent entity name must be 1-64 ASCII letters, digits, dots, underscores, " +
        `or dashes, starting with a letter or digit: ${name}`,
    );
  }
  assertNotReservedAgentName(name);
  return name;
}

/**
 * TeamMate-facing alias of {@link validateAgentEntityName}. Kept so
 * teammate-collection request types can express the teammate-specific
 * validation word without the neutral agent-entity layer carrying
 * teammate-only terminology.
 */
export const validateTeamMateName = validateAgentEntityName;

export function requireLifecycleText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function optionalLifecycleText(
  value: unknown,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return trimmed;
}

export function runtimeStatusToIdentityStatus(
  status: AgentRuntimeStatus,
): AgentEntityIdentityStatus {
  switch (status) {
    case "ready":
      return "running";
    case "starting":
      return "starting";
    case "degraded":
      return "degraded";
    case "stopping":
    case "stopped":
      return "stopped";
    case "declared":
      return "stopped";
  }
}
