import type {
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  Team,
} from '@excitedjs/dreamux-types';

import { DISABLE_FEATURE_CRON } from '../../agent-runtime/index.js';
import {
  bundledSharedSkillRoot,
  bundledTeamLeaderSkillRoot,
} from '../../platform/paths.js';
import { composeLaunchDraft } from '../../plugin/hooks.js';
import type { WorkAdmission } from '../../platform/work-fence.js';
import type { AgentServiceFactory, UnbuiltAgent } from '../agent/factory.js';
import { createTeamMateMcpDelegate } from '../agent/mcp.js';
import type {
  AgentEntityIdentity,
  AgentEntityWorktreeIdentity,
} from '../agent/identity.js';
import { childAgentRuntimeId } from '../agent/runtime-id.js';
import type { TeammateServiceOptions } from '../agent/service-types.js';
import type { TeammateOps } from '../agent/types.js';
import { createCronMcpDelegate } from '../scheduler/mcp.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import type { WorkflowOps } from '../workflow-service/index.js';
import { reuseCwdWorktree } from '../worktree/manager.js';
import { createLeaderTeamMcpDelegate } from './leader-mcp.js';
import type {
  TeamCollectionOptions,
  TeamDissolveCommand,
  TeamDissolveReceipt,
  TeamRecord,
} from './types.js';

/**
 * The TeamLeader skill roots Core always injects. A caller's `skill_sources`
 * extend these; they can never remove them.
 */
export const TEAM_LEADER_REQUIRED_SKILL_SOURCES = [
  {
    name: 'team-leader',
    path: bundledTeamLeaderSkillRoot(),
    source: 'dreamux-core',
  },
  {
    name: 'shared',
    path: bundledSharedSkillRoot(),
    source: 'dreamux-core',
  },
] as const;

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
  intent: string | null;
  identityPrompt: string | null;
  skillSources?: readonly AgentRuntimeSkillSource[] | undefined;
}

/**
 * What every leader creation/open/restore entry in this file is built from:
 * the Team-owned facts plus the collaborators the resulting `AgentService`
 * needs. `teamRoot` is the one location fact — this Team's own root
 * directory, where its leader's `identity.json` lives beside `record.json` —
 * and every store bind in this file goes through
 * `AgentServiceFactory.create`/`.open` against it, never a store a caller
 * constructed itself.
 */
interface TeamLeaderLocation {
  teamId: string;
  teamRoot: string;
  agentServiceFactory: AgentServiceFactory;
}

export interface TeamLeaderOptions {
  /** The actual Team owns these operations; this view stores no separate state. */
  team: {
    readonly id: string;
    readonly hooks: Team['hooks'];
    readonly teammates: TeammateOps;
    readonly workflows: WorkflowOps;
    readonly scheduler: SchedulerCommands;
    admitLeaderTools<T>(operation: () => Promise<T>): Promise<T>;
    assertOpen(): void;
    dissolve(input: TeamDissolveCommand): Promise<TeamDissolveReceipt>;
  };
  workspace: AgentEntityWorktreeIdentity;
  mcp: TeamCollectionOptions['mcp'];
  fence: WorkAdmission;
}

/**
 * This leader's role-specific `AgentService` options, computed from the
 * identity the factory just created, read, or upserted.
 *
 * Runs the Team's `leaderLaunch` hook before assembling this role's tools
 * from their actual owners. Plugin skill roots follow the built-in and
 * identity roots, fenced against them; plugin instructions follow the
 * built-in prompt.
 */
export async function teamLeaderOptions(
  deps: TeamLeaderOptions,
  identity: AgentEntityIdentity,
): Promise<Omit<TeammateServiceOptions, 'role'>> {
  const leaderName = identity.name;
  const { team, mcp, fence } = deps;
  const baseSkills = [
    ...TEAM_LEADER_REQUIRED_SKILL_SOURCES,
    ...identity.skill_sources,
  ];
  const draft = await composeLaunchDraft(team.hooks.leaderLaunch, baseSkills);
  const delegates = [
    ...mcp.channels.mcpDelegates(
      { kind: 'team_leader', team_name: team.id, leader_name: leaderName },
      fence,
      team,
    ),
    createLeaderTeamMcpDelegate(team),
    createTeamMateMcpDelegate({ kind: 'team_leader', team }),
    createCronMcpDelegate(team),
  ];
  return {
    runtimeId: childAgentRuntimeId(identity),
    // This Agent is the Team's leader; the role follows from that ownership.
    loggerFields: { teammate: leaderName },
    mcp: {
      leases: mcp.leases,
      adminSocketPath: mcp.adminSocketPath,
      delegates,
    },
    skillSources: [...baseSkills, ...draft.skillSources],
    disabledFeatures: [DISABLE_FEATURE_CRON],
    systemPrompt: teamLeaderSystemPrompt(
      team.id,
      deps.workspace,
      identity.identity_prompt,
      draft.instructions,
    ),
  };
}

/**
 * The per-Team identity prompt stays last, after plugin instructions: it is
 * the most specific statement of who this leader is.
 */
function teamLeaderSystemPrompt(
  teamId: string,
  workspace: AgentEntityWorktreeIdentity,
  identityPrompt: string | null,
  pluginInstructions: readonly string[],
): AgentRuntimeSystemPrompt {
  const append = [
    `You are the TeamLeader of Dreamux Team ${JSON.stringify(teamId)}.`,
    "Your Dreamux MCP servers: `teammate` (this Team's members, who share the Team workspace, and scripted workflows), `team` (dissolve this Team), `cron` (scheduled prompts that wake this TeamLeader), and one `channel-<provider>` server per configured channel that provides tools, for example `channel-feishu` (that channel's own tools).",
    teamWorkspaceSentence(workspace),
    ...pluginInstructions,
  ];
  if (identityPrompt !== null) append.push(identityPrompt);
  return { append };
}

/**
 * The one workspace fact the leader cannot see from inside the directory: its
 * kind and its cleanup mode. What a cleanup mode means when the Team dissolves
 * is stated only by the `dissolve` description, so a leader that never
 * dissolves never reads about dissolving.
 */
function teamWorkspaceSentence(workspace: AgentEntityWorktreeIdentity): string {
  const kind =
    workspace.mode === 'managed'
      ? 'a managed git worktree'
      : 'a reused directory';
  return `Your Team's workspace ${workspace.path} is ${kind} (cleanup: ${workspace.cleanup}).`;
}

/**
 * Create this Team's leader.
 *
 * Identity creation belongs here, with the entity: the Team hands over its
 * own creation inputs and gets back the factory's unbuilt identity handle.
 * TeamService publishes the initial roster fact before computing role options
 * and building the Agent. Nothing starts here: the leader's
 * runtime starts inside the first submission that needs it — the prompt below
 * when there is one, the first ordinary submission otherwise — so a provider
 * thread is never opened without the turn that makes it durable. Whatever
 * occupied `deps.teamRoot` is replaced — the Team only reaches this operation
 * after finding no usable aligned identity there, so an orphan left at a
 * reused Team name must not block its own replacement.
 */
export async function createTeamLeaderAgentForTeam(input: {
  deps: TeamLeaderLocation;
  creation: TeamLeaderCreationInput;
}): Promise<UnbuiltAgent> {
  const { deps, creation } = input;
  return deps.agentServiceFactory.create({
    location: { dir: deps.teamRoot, expectedName: null },
    creation: {
      name: creation.leaderName,
      teamId: deps.teamId,
      agentRuntime: creation.agentRuntime,
      sourceCwd: creation.sourceCwd,
      sourceRepo: creation.sourceRepo,
      cwd: creation.runtimeCwd,
      runtimeCwd: creation.runtimeCwd,
      // A leader runs in its Team's directory; the Team's record owns the
      // checkout underneath it and every cleanup fact about it.
      worktree: reuseCwdWorktree(creation.runtimeCwd),
      intent: creation.intent,
      identityPrompt: creation.identityPrompt,
      skillSources: creation.skillSources,
      status: 'starting',
      replaceExisting: true,
    },
    role: 'team_leader',
  });
}

/**
 * Open this Team's leader identity if it already belongs to this Team.
 * TeamService uses the unbuilt handle for its restore-or-create decision.
 * `null` when there is nothing to adopt: either
 * no identity was ever written, or what is there is not this Team's.
 */
export async function openTeamLeader(
  deps: TeamLeaderLocation,
  record: TeamRecord,
): Promise<UnbuiltAgent | null> {
  const opened = await deps.agentServiceFactory.open({
    location: { dir: deps.teamRoot, expectedName: null },
    role: 'team_leader',
  });
  return opened !== null && alignedWithLeader(opened.identity, record)
    ? opened
    : null;
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
function alignedWithLeader(
  identity: AgentEntityIdentity,
  record: TeamRecord,
): boolean {
  return (
    identity.dispatcher_id === record.dispatcher_id &&
    identity.team_id === record.team_id &&
    identity.name === record.leader_name
  );
}
