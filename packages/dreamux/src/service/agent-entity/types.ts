import type {
  AgentRuntimeCapabilities,
  AgentRuntimeSkillSource,
  AgentRuntimeStatus,
} from "@excitedjs/dreamux-types";

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
    throw new Error(
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

export type AgentEntityRole =
  | "dispatcher"
  | "teammate"
  | "team_leader"
  | "team_member";

export interface AgentEntityIdentity {
  version: 1;
  dispatcher_id: string;
  name: string;
  role: AgentEntityRole;
  team_id: string | null;
  agent_runtime: string;
  session_id: string | null;
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
  turn_count: number;
  last_seen_at: number;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
}

export type AgentEntityTurnRecordType = "submit" | "settled";

export interface AgentEntityTurnRecord {
  version: 1;
  type: AgentEntityTurnRecordType;
  turn_id: string | null;
  timestamp: number;
  turn_origin: AgentEntityTurnOrigin | null;
  prompt_preview: string | null;
  intent: string | null;
  settle_status: "completed" | "failed" | "stopped" | null;
  assistant: string | null;
  assistant_preview: string | null;
  assistant_truncated: boolean;
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

export type AgentEntityTurnOrigin =
  | "channel"
  | "dispatcher"
  | "team_leader"
  | { kind: "scheduled"; job_id: string };

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

export interface AgentEntityTurnResult {
  status: "submitted" | "duplicate" | "stopped" | "failed";
  turn_id?: string;
  error?: string;
}

export interface AgentEntitySpawnResult {
  teammate: AgentEntityRuntimeStatus;
  turn: AgentEntityTurnResult;
}

export interface AgentEntitySendResult {
  teammate: AgentEntityRuntimeStatus;
  turn: AgentEntityTurnResult;
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
  turn_count: number;
  agent_runtime: string;
  source_repo: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  status: AgentEntityIdentityStatus;
  runtime_status: AgentRuntimeStatus | null;
  intent: string | null;
  closed_at: number | null;
  close_note: string | null;
  close_note_preview: string | null;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
  cleanup_state: AgentEntityWorktreeCleanupState;
  resume: AgentEntityResumeHint | null;
}

export interface AgentEntityHistoryResult {
  items: AgentEntityRecordRow[];
  next_cursor: string | null;
}

export interface AgentEntityLastTurn {
  turn_id: string;
  turn_origin: AgentEntityTurnOrigin | null;
  prompt_preview: string | null;
  intent: string | null;
  submitted_at: number | null;
  settled_at: number;
  settle_status: "completed" | "failed" | "stopped" | null;
  assistant: string | null;
  assistant_preview: string | null;
  assistant_truncated: boolean;
}

export interface AgentEntityLastResult {
  teammate: AgentEntityRuntimeStatus;
  requested_turns: number;
  returned_turns: number;
  turns: AgentEntityLastTurn[];
}

export interface AgentEntityRuntimeCapability {
  id: string;
  spawn: { agent_runtime: string };
  runtime_available: boolean;
  resume: AgentRuntimeCapabilities["resume"];
  unsupported_reason: string | null;
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
    throw new Error(
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
