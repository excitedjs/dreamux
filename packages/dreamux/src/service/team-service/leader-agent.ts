import type {
  AgentRuntimeMcpServer,
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
import type { ConversationProjection } from '../../channel/conversation-projection.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import { cronMcpServerDescriptor } from '../scheduler/mcp-config.js';
import {
  createTeammateService,
} from '../teammate-service/factory.js';
import {
  assertTeamScopedAgent,
  childAgentRuntimeId,
} from '../agent-entity/runtime-profile.js';
import type { TeammateService } from '../teammate-service/index.js';
import { teammateMcpServerDescriptor } from '../teammate-collection/mcp-config.js';
import { teamMcpServerDescriptor } from '../team-collection/mcp-config.js';
import type { WorktreeManager } from '../worktree/manager.js';

export interface TeamLeaderAgentDeps {
  dispatcherId: string;
  identity: AgentEntityIdentity;
  mcpServers: readonly AgentRuntimeMcpServer[];
  skillSources: readonly AgentRuntimeSkillSource[];
  disableFeatures: readonly string[];
  systemPrompt?: AgentRuntimeSystemPrompt;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
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
      ownsWorktreeOnClose: false,
      loggerFields: { teammate: deps.identity.name },
      assertIdentityScope: assertTeamScopedAgent(teamId),
      mcpServers: deps.mcpServers,
      skillSources: deps.skillSources,
      disableFeatures: deps.disableFeatures,
      ...(deps.systemPrompt !== undefined
        ? { systemPrompt: deps.systemPrompt }
        : {}),
    },
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities: deps.identities,
    ...(deps.conversationProjection !== undefined
      ? { conversationProjection: deps.conversationProjection }
      : {}),
    worktrees: deps.worktrees,
    log: deps.log,
  });
}

interface TeamLeaderForTeamDeps extends Omit<
  TeamLeaderAgentDeps,
  'mcpServers' | 'skillSources' | 'disableFeatures' | 'systemPrompt'
> {
  teamId: string;
  adminSocketPath: string;
  leaderChannelDescriptors(input: {
    teamId: string;
    leaderName: string;
  }): readonly AgentRuntimeMcpServer[];
}

export function createTeamLeaderAgentForTeam(
  deps: TeamLeaderForTeamDeps,
): TeammateService {
  const { teamId, adminSocketPath, leaderChannelDescriptors, ...agentDeps } = deps;
  const leaderName = deps.identity.name;
  return createTeamLeaderAgent({
    ...agentDeps,
    mcpServers: [
      teammateMcpServerDescriptor({
        dispatcherId: deps.dispatcherId,
        callerKind: 'team_leader',
        teamId,
        adminSocketPath,
      }),
      cronMcpServerDescriptor({
        dispatcherId: deps.dispatcherId,
        teamId,
        adminSocketPath,
      }),
      teamMcpServerDescriptor({
        dispatcherId: deps.dispatcherId,
        callerKind: 'team_leader',
        teamId,
        leaderName,
        adminSocketPath,
      }),
      ...leaderChannelDescriptors({ teamId, leaderName }),
    ],
    skillSources: [{
      name: 'team-leader',
      path: bundledTeamLeaderSkillRoot(),
      source: 'dreamux-core',
    }, {
      name: 'shared',
      path: bundledSharedSkillRoot(),
      source: 'dreamux-core',
    }, ...deps.identity.skill_sources],
    disableFeatures: [DISABLE_FEATURE_CRON],
    systemPrompt: teamLeaderSystemPrompt(teamId, deps.identity.identity_prompt),
  });
}

function teamLeaderSystemPrompt(
  teamId: string,
  identityPrompt: string | null,
): AgentRuntimeSystemPrompt {
  const append = [
    `You are the TeamLeader of Dreamux Team ${JSON.stringify(teamId)}.`,
    'Load `team-workflow` before using this Team\'s TeamMate tools, Team tools (`dissolve`, `bind_channel`, or `transfer_back`), provider-exposed channel tools, or cron tools.',
    'When a prompt-submitting TeamMate tool returns success, the task was submitted successfully; Dreamux core will push the completion back automatically, so do not poll `last` or other read tools, and end the turn naturally if there is no other work.',
  ];
  if (identityPrompt !== null) append.push(identityPrompt);
  return { append };
}
