import type {
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import {
  bundledSharedSkillRoot,
  bundledTeamLeaderSkillRoot,
} from '../../platform/paths.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { TeamServiceDeps } from './types.js';
import type { AdmissionLedger } from '../teammate-service/admission-ledger.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';
import type {
  AgentEntityIdentity,
  AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import {
  createTeammateService,
} from '../teammate-service/factory.js';
import {
  assertTeamScopedAgent,
  childAgentRuntimeId,
} from '../agent-entity/runtime-profile.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeammateAgentMcp } from '../teammate-service/types.js';
import type { TeamRecord } from '../team-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';

export interface TeamLeaderAgentDeps {
  dispatcherId: string;
  identity: AgentEntityIdentity;
  mcp: TeammateAgentMcp;
  skillSources: readonly AgentRuntimeSkillSource[];
  disabledFeatures: readonly string[];
  systemPrompt?: AgentRuntimeSystemPrompt;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  admissions: AdmissionLedger;
  conversationProjection?: ConversationProjection;
  worktrees: WorktreeManager;
  log: DreamuxLogger;
}

export function createTeamLeaderAgent(
  deps: TeamLeaderAgentDeps,
): TeammateService {
  const teamId = deps.identity.team_id;
  if (teamId === null) {
    throw new Error('TeamLeader identity must have a team_id');
  }
  return createTeammateService({
    dispatcherId: deps.dispatcherId,
    identity: deps.identity,
    options: {
      runtimeId: childAgentRuntimeId(deps.identity),
      // This Agent is the Team's leader; the role follows from that ownership.
      role: 'team_leader',
      ownsWorktreeOnClose: false,
      loggerFields: { teammate: deps.identity.name },
      assertIdentityScope: assertTeamScopedAgent(teamId),
      mcp: deps.mcp,
      skillSources: deps.skillSources,
      disabledFeatures: deps.disabledFeatures,
      ...(deps.systemPrompt !== undefined
        ? { systemPrompt: deps.systemPrompt }
        : {}),
    },
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities: deps.identities,
    admissions: deps.admissions,
    ...(deps.conversationProjection !== undefined
      ? { conversationProjection: deps.conversationProjection }
      : {}),
    worktrees: deps.worktrees,
    log: deps.log,
  });
}

export interface TeamLeaderForTeamDeps extends Omit<
  TeamLeaderAgentDeps,
  'mcp' | 'skillSources' | 'disabledFeatures' | 'systemPrompt'
> {
  teamId: string;
  /**
   * This leader's own Agent-facing MCP servers, built by the dispatcher that
   * owns every object they reach. The Team supplies its identity; it does not
   * assemble a tool surface.
   */
  leaderMcp(input: {
    teamId: string;
    leaderName: string;
  }): TeammateAgentMcp;
}

/**
 * The stable, Team-owned inputs needed to create a TeamLeader.
 *
 * They are exactly what the Team record already holds plus the creation-time
 * prompt and skill roots. The Team supplies these and nothing else: it does not
 * assemble an identity, and it carries no Provider session or Agent lifecycle
 * state of its own to copy in.
 */
export interface TeamLeaderCreationInput {
  leaderName: string;
  agentRuntime: string;
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: AgentEntityWorktreeIdentity;
  intent: string | null;
  identityPrompt: string | null;
  skillSources?: readonly AgentRuntimeSkillSource[];
}

/**
 * The Team-owned half of {@link TeamLeaderForTeamDeps}: what every leader a
 * Team creates or restores is built from, spelled once.
 */
export function teamLeaderAgentBase<Service>(input: {
  deps: TeamServiceDeps<Service>;
  teamId: string;
  identities: AgentIdentityStore;
}): Omit<TeamLeaderForTeamDeps, 'identity'> {
  const { deps } = input;
  return {
    dispatcherId: deps.dispatcherId,
    teamId: input.teamId,
    leaderMcp: deps.leaderMcp,
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities: input.identities,
    admissions: deps.admissions,
    ...(deps.conversationProjection !== undefined
      ? { conversationProjection: deps.conversationProjection }
      : {}),
    worktrees: deps.worktrees,
    log: deps.log,
  };
}

/**
 * Create this Team's leader.
 *
 * Identity creation belongs here, with the entity: the TeamMate layer persists
 * the record at the Team root and then builds the runtime from the record it
 * just wrote, so there is one creation path and one writer. Whatever occupied
 * that location is replaced — the Team only reaches this operation after
 * finding no usable aligned identity there, so an orphan left at a reused Team
 * name must not block its own replacement.
 */
export async function createTeamLeaderAgentForTeam(
  deps: Omit<TeamLeaderForTeamDeps, 'identity'> & {
    creation: TeamLeaderCreationInput;
  },
): Promise<TeammateService> {
  const { creation, ...rest } = deps;
  const identity = await deps.identities.create({
    name: creation.leaderName,
    teamId: deps.teamId,
    agentRuntime: creation.agentRuntime,
    sourceCwd: creation.sourceCwd,
    sourceRepo: creation.sourceRepo,
    cwd: creation.runtimeCwd,
    runtimeCwd: creation.runtimeCwd,
    worktree: creation.worktree,
    intent: creation.intent,
    identityPrompt: creation.identityPrompt,
    ...(creation.skillSources !== undefined
      ? { skillSources: creation.skillSources }
      : {}),
    status: 'starting',
    replaceExisting: true,
  });
  return restoreTeamLeaderAgentForTeam({ ...rest, identity });
}

/**
 * Build this Team's leader from an identity the Team already proved is its own.
 * The record is used exactly as read — never restamped or regenerated.
 */
export function restoreTeamLeaderAgentForTeam(
  deps: TeamLeaderForTeamDeps,
): TeammateService {
  const { teamId, leaderMcp, ...agentDeps } = deps;
  const leaderName = deps.identity.name;
  return createTeamLeaderAgent({
    ...agentDeps,
    mcp: leaderMcp({ teamId, leaderName }),
    skillSources: [{
      name: 'team-leader',
      path: bundledTeamLeaderSkillRoot(),
      source: 'dreamux-core',
    }, {
      name: 'shared',
      path: bundledSharedSkillRoot(),
      source: 'dreamux-core',
    }, ...deps.identity.skill_sources],
    disabledFeatures: [DISABLE_FEATURE_CRON],
    systemPrompt: teamLeaderSystemPrompt(teamId, deps.identity.identity_prompt),
  });
}

function teamLeaderSystemPrompt(
  teamId: string,
  identityPrompt: string | null,
): AgentRuntimeSystemPrompt {
  const append = [
    `You are the TeamLeader of Dreamux Team ${JSON.stringify(teamId)}.`,
    'Load `team-workflow` before using this Team\'s TeamMate tools, Team tools (`dissolve`), provider-exposed channel tools, or cron tools.',
    'When a prompt-submitting TeamMate tool returns success, the task was submitted successfully; Dreamux core will push the completion back automatically, so do not poll `last` or other read tools, and end the turn naturally if there is no other work.',
  ];
  if (identityPrompt !== null) append.push(identityPrompt);
  return { append };
}

/**
 * Does this identity belong to this Team's leader?
 *
 * Exactly three facts prove ownership: the same dispatcher, the same Team, and
 * the name the Team record itself designates as its leader. Nothing else is
 * compared or synchronized — the Team record is not a second Agent identity, so
 * it has no Provider session or Agent lifecycle state to reconcile against, and
 * a leader that has since gone `degraded` or `stopped` is still this Team's
 * leader.
 */
export function alignedWithLeader(
  identity: AgentEntityIdentity,
  record: TeamRecord,
): boolean {
  return (
    identity.dispatcher_id === record.dispatcher_id &&
    identity.team_id === record.team_id &&
    identity.name === record.leader_name
  );
}
