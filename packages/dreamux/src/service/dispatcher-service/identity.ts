import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import {
  DISPATCHER_AGENT_NAME,
  type AgentEntityIdentity,
  type AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';

export interface DispatcherIdentityEnsureInput {
  dispatcherId: string;
  agentRuntime: string;
  sourceCwd: string;
  cwd: string;
  runtimeCwd: string;
  worktree: AgentEntityWorktreeIdentity;
}

/**
 * Upsert the dispatcher-owned root identity while preserving compatible runtime
 * recovery state. This policy is dispatcher config compatibility, not a generic
 * agent-entity store rule.
 */
export async function ensureDispatcherIdentity(
  identities: AgentIdentityStore,
  input: DispatcherIdentityEnsureInput,
): Promise<AgentEntityIdentity> {
  const existing = await identities.dispatcherIdentity(input.dispatcherId);
  const now = Date.now();
  if (existing === null) {
    const identity: AgentEntityIdentity = {
      version: 1,
      dispatcher_id: input.dispatcherId,
      name: DISPATCHER_AGENT_NAME,
      role: 'dispatcher',
      team_id: null,
      agent_runtime: input.agentRuntime,
      session_id: null,
      source_cwd: input.sourceCwd,
      source_repo: null,
      cwd: input.cwd,
      runtime_cwd: input.runtimeCwd,
      worktree: input.worktree,
      intent: null,
      identity_prompt: null,
      created_at: now,
      updated_at: now,
      status: 'stopped',
      last_error: null,
      closed_at: null,
      close_note: null,
      turn_count: 0,
      last_seen_at: now,
      last_prompt_preview: null,
      last_assistant_preview: null,
    };
    return identities.upsert(identity);
  }

  const compatible =
    existing.agent_runtime === input.agentRuntime &&
    existing.cwd === input.cwd &&
    existing.runtime_cwd === input.runtimeCwd &&
    worktreeIdentityEquals(existing.worktree, input.worktree);
  const updated: AgentEntityIdentity = {
    ...existing,
    name: DISPATCHER_AGENT_NAME,
    role: 'dispatcher',
    team_id: null,
    agent_runtime: input.agentRuntime,
    source_cwd: input.sourceCwd,
    source_repo: null,
    cwd: input.cwd,
    runtime_cwd: input.runtimeCwd,
    worktree: input.worktree,
    ...(compatible
      ? {}
      : {
          session_id: null,
          status: 'stopped' as const,
          last_error: null,
        }),
    closed_at: null,
    close_note: null,
    updated_at: now,
  };
  return identities.upsert(updated);
}

function worktreeIdentityEquals(
  a: AgentEntityWorktreeIdentity,
  b: AgentEntityWorktreeIdentity,
): boolean {
  return a.mode === b.mode &&
    a.slug === b.slug &&
    a.path === b.path &&
    a.branch === b.branch &&
    a.base_ref === b.base_ref &&
    a.cleanup === b.cleanup &&
    a.cleanup_state === b.cleanup_state &&
    a.cleanup_error === b.cleanup_error;
}
