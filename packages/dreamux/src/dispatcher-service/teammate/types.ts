import type { AgentRuntimeCapabilities } from "@excitedjs/dreamux-types";
import type { DispatcherStatus } from "../../state/dispatcher-store.js";

export const TEAMMATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

export type TeamMateIdentityStatus =
  | "starting"
  | "running"
  | "degraded"
  | "closed"
  | "stopped";

export type TeamMateRole =
  | "dispatcher"
  | "teammate"
  | "team_leader"
  | "team_member";

export interface TeamMateIdentity {
  version: 1;
  dispatcher_id: string;
  name: string;
  role: TeamMateRole;
  team_id: string | null;
  agent_runtime: string;
  session_id: string | null;
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
  turn_count: number;
  last_seen_at: number;
  last_prompt_preview: string | null;
  last_assistant_preview: string | null;
}

export type TeamMateTurnRecordType = "submit" | "settled";

export interface TeamMateTurnRecord {
  version: 1;
  type: TeamMateTurnRecordType;
  turn_id: string | null;
  timestamp: number;
  turn_origin: TeamMateTurnOrigin | null;
  prompt_preview: string | null;
  intent: string | null;
  settle_status: "completed" | "failed" | "stopped" | null;
  assistant: string | null;
  assistant_preview: string | null;
  assistant_truncated: boolean;
}

export interface TeamMateRepoView {
  mode: TeamMateWorktreeIdentity["mode"];
  path: string;
  source_repo: string | null;
  branch: string | null;
  base_ref: string | null;
  cleanup: TeamMateWorktreeCleanupPolicy;
  cleanup_state: TeamMateWorktreeCleanupState;
}

export interface TeamMateRuntimeStatus {
  name: string;
  session_id: string | null;
  agent_runtime: string;
  repo: TeamMateRepoView;
  intent: string | null;
  status: TeamMateIdentityStatus;
  runtime_status: DispatcherStatus | null;
  last_error: string | null;
  closed_at: number | null;
  close_note: string | null;
}

export type TeamMateTurnOrigin = "channel" | "dispatcher" | "team_leader";

export interface SpawnTeamMateInput {
  teamId?: string;
  name: string;
  prompt: string;
  agentRuntime?: string;
  cwd?: string;
  worktree?: TeamMateWorktreeRequest;
  intent: string;
}

export interface CreateTeamLeaderInput {
  teamId: string;
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
  mode: "reuse-cwd" | "managed";
  slug?: string;
  base_ref?: string;
  branch?: string;
  cleanup?: "keep" | "delete-on-close";
}

export type TeamMateWorktreeCleanupPolicy = "keep" | "delete-on-close";

export type TeamMateWorktreeCleanupState =
  | "not-managed"
  | "managed-active"
  | "kept"
  | "deleted"
  | "retained-dirty"
  | "retained-unmerged"
  | "retained-unique-commits"
  | "retained-error";

export interface TeamMateWorktreeIdentity {
  mode: "reuse-cwd" | "managed";
  slug: string | null;
  path: string;
  branch: string | null;
  base_ref: string | null;
  cleanup: TeamMateWorktreeCleanupPolicy;
  cleanup_state: TeamMateWorktreeCleanupState;
  cleanup_error: string | null;
}

export interface SendTeamMateInput {
  teamId?: string;
  name: string;
  prompt: string;
  intent?: string;
}

export interface CloseTeamMateInput {
  teamId?: string;
  name: string;
  note: string;
}

export interface TeamMateTurnResult {
  status: "submitted" | "duplicate" | "stopped" | "failed";
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
  teamId?: string;
  name?: string;
  status?: TeamMateIdentityStatus;
  agentRuntime?: string;
  repo?: string;
  grep?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

export interface TeamMateResumeHint {
  tool: "send";
  name: string;
}

export interface TeamMateRecordRow {
  name: string;
  turn_count: number;
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

export interface TeamMateLastTurn {
  turn_id: string;
  turn_origin: TeamMateTurnOrigin | null;
  prompt_preview: string | null;
  intent: string | null;
  submitted_at: number | null;
  settled_at: number;
  settle_status: "completed" | "failed" | "stopped" | null;
  assistant: string | null;
  assistant_preview: string | null;
  assistant_truncated: boolean;
}

export interface TeamMateLastResult {
  teammate: TeamMateRuntimeStatus;
  requested_turns: number;
  returned_turns: number;
  turns: TeamMateLastTurn[];
}

export interface TeamMateAgentRuntimeCapability {
  id: string;
  spawn: { agent_runtime: string };
  runtime_available: boolean;
  resume: AgentRuntimeCapabilities["resume"];
  steer: AgentRuntimeCapabilities["steer"];
  events: AgentRuntimeCapabilities["events"];
  last: AgentRuntimeCapabilities["last"];
  context: AgentRuntimeCapabilities["context"];
  unsupported_reason: string | null;
}

export interface TeamMateCapabilities {
  verbs: string[];
  agent_runtimes: TeamMateAgentRuntimeCapability[];
}

export function validateTeamMateName(name: string): string {
  if (!TEAMMATE_NAME_PATTERN.test(name)) {
    throw new Error(
      "TeamMate name must be 1-64 ASCII letters, digits, dots, underscores, " +
        `or dashes, starting with a letter or digit: ${name}`,
    );
  }
  assertNotReservedAgentName(name);
  return name;
}

export function requireLifecycleText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function runtimeStatusToIdentityStatus(
  status: DispatcherStatus,
): TeamMateIdentityStatus {
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
