import type {
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook } from 'tapable';

import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { ConfigReader } from '../../config/service.js';
import { composeLaunchDraft } from '../../plugin/hooks.js';
import {
  bundledSharedSkillRoot,
  bundledTeamLeaderSkillRoot,
} from '../../platform/paths.js';
import type { TeamCollectionOptions, TeamRecord } from './types.js';
import type { AgentServiceFactory } from '../agent/factory.js';
import type { ConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import type {
  AgentEntityIdentity,
  AgentEntityWorktreeIdentity,
} from '../agent/identity.js';
import { childAgentRuntimeId } from '../agent/runtime-id.js';
import type { AgentService } from '../agent/service.js';
import type {
  TeammateAgentMcp,
  TeammateServiceOptions,
} from '../agent/service-types.js';
import { reuseCwdWorktree, type WorktreeManager } from '../worktree/manager.js';

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
 * The slice of `TeamServiceDeps` (declared at `TeamService`'s construction
 * site in `service.ts`) this file actually reads.
 *
 * Picked from `TeamCollectionOptions` — the wider bag `TeamServiceDeps`
 * itself composes from — rather than importing `TeamServiceDeps`: `service.ts`
 * already imports value exports from this file, so a type import running the
 * other way would make the two files a cycle. Every field below is one
 * `TeamCollectionOptions` already declares, not one of `TeamServiceDeps`'s own
 * additions (`teamRoot`, `store`, `settleWorktreeCleanup`), so `Pick` alone
 * covers it.
 */
type TeamLeaderAgentBaseDeps = Pick<
  TeamCollectionOptions,
  | 'leaderMcp'
  | 'config'
  | 'agentRuntimeProviders'
  | 'agentServiceFactory'
  | 'conversationProjection'
  | 'worktrees'
  | 'log'
>;

/**
 * What every leader creation/open/restore entry in this file is built from:
 * the Team-owned facts plus the collaborators the resulting `AgentService`
 * needs. `teamRoot` is the one location fact — this Team's own root
 * directory, where its leader's `identity.json` lives beside `record.json` —
 * and every store bind in this file goes through
 * `AgentServiceFactory.create`/`.open` against it, never a store a caller
 * constructed itself.
 */
export interface TeamLeaderOpenDeps {
  teamId: string;
  teamRoot: string;
  workspace: AgentEntityWorktreeIdentity;
  leaderMcp(input: { teamId: string; leaderName: string }): TeammateAgentMcp;
  /** This Team's `leaderLaunch` hook, run at each leader construction. */
  leaderLaunch: AsyncSeriesHook<[LaunchDraft]>;
  config: ConfigReader;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  onPersisted: (identity: AgentEntityIdentity) => void;
  agentServiceFactory: AgentServiceFactory;
  conversationProjection: ConversationProjection;
  worktrees: WorktreeManager;
  log: DreamuxLogger;
}

/**
 * The Team-owned half of {@link TeamLeaderOpenDeps}: what every leader a
 * Team creates, opens, or restores is built from, spelled once.
 */
export function teamLeaderAgentBase(input: {
  deps: TeamLeaderAgentBaseDeps;
  teamId: string;
  teamRoot: string;
  workspace: AgentEntityWorktreeIdentity;
  onPersisted: (identity: AgentEntityIdentity) => void;
  leaderLaunch: AsyncSeriesHook<[LaunchDraft]>;
}): TeamLeaderOpenDeps {
  const { deps } = input;
  return {
    teamId: input.teamId,
    teamRoot: input.teamRoot,
    workspace: input.workspace,
    leaderMcp: deps.leaderMcp,
    leaderLaunch: input.leaderLaunch,
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    onPersisted: input.onPersisted,
    agentServiceFactory: deps.agentServiceFactory,
    conversationProjection: deps.conversationProjection,
    worktrees: deps.worktrees,
    log: deps.log,
  };
}

/**
 * The `AgentServiceFactory` collaborators every leader build needs besides
 * its identity storage and its role-specific options.
 */
function leaderBuildDeps(deps: TeamLeaderOpenDeps) {
  return {
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    onPersisted: deps.onPersisted,
    conversationProjection: deps.conversationProjection,
    worktrees: deps.worktrees,
    log: deps.log,
  };
}

/**
 * This leader's role-specific `AgentService` options, computed from the
 * identity the factory just created, read, or upserted.
 *
 * Runs the Team's `leaderLaunch` hook first: plugin skill roots follow the
 * built-in and identity roots, fenced against them, and plugin instructions
 * follow the built-in prompt.
 */
async function teamLeaderOptions(
  deps: TeamLeaderOpenDeps,
  identity: AgentEntityIdentity,
): Promise<TeammateServiceOptions> {
  const leaderName = identity.name;
  const baseSkills = [
    ...TEAM_LEADER_REQUIRED_SKILL_SOURCES,
    ...identity.skill_sources,
  ];
  const draft = await composeLaunchDraft(deps.leaderLaunch, baseSkills);
  return {
    runtimeId: childAgentRuntimeId(identity),
    // This Agent is the Team's leader; the role follows from that ownership.
    role: 'team_leader',
    loggerFields: { teammate: leaderName },
    mcp: deps.leaderMcp({ teamId: deps.teamId, leaderName }),
    skillSources: [...baseSkills, ...draft.skillSources],
    disabledFeatures: [DISABLE_FEATURE_CRON],
    systemPrompt: teamLeaderSystemPrompt(
      deps.teamId,
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
 * own creation inputs and gets back a leader, rather than assembling and
 * persisting an Agent identity itself. Nothing starts here: the leader's
 * runtime starts inside the first submission that needs it — the prompt below
 * when there is one, the first ordinary submission otherwise — so a provider
 * thread is never opened without the turn that makes it durable. Whatever
 * occupied `deps.teamRoot` is replaced — the Team only reaches this operation
 * after finding no usable aligned identity there, so an orphan left at a
 * reused Team name must not block its own replacement.
 */
export async function createTeamLeaderAgentForTeam(input: {
  deps: TeamLeaderOpenDeps;
  creation: TeamLeaderCreationInput;
}): Promise<AgentService> {
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
    options: (identity) => teamLeaderOptions(deps, identity),
    deps: leaderBuildDeps(deps),
    log: deps.log,
  });
}

/**
 * Open this Team's leader if a durable identity at its root already belongs
 * to it — the one `open` entry `openTeamLeader` (below) uses for its
 * restore-or-create decision. `null` when there is nothing to adopt: either
 * no identity was ever written, or what is there is not this Team's.
 */
async function adoptTeamLeaderIfAligned(
  deps: TeamLeaderOpenDeps,
  record: TeamRecord,
): Promise<AgentService | null> {
  return deps.agentServiceFactory.open({
    location: { dir: deps.teamRoot, expectedName: null },
    align: (identity) => alignedWithLeader(identity, record),
    options: (identity) => teamLeaderOptions(deps, identity),
    deps: leaderBuildDeps(deps),
    log: deps.log,
  });
}

/**
 * Rebuild this Team's leader: restore the identity already at its root when
 * it is aligned, or finish what creation began by creating it fresh
 * otherwise — the restore-or-create decision `TeamService.rebuild` used to
 * make itself, moved here with the entity it decides about.
 *
 * The caller (`TeamService.rebuild`) seeds its member roster before calling
 * this and remembers the returned leader after: a fresh
 * `createTeamLeaderAgentForTeam` call publishes this Team's aggregate through
 * its own persistence hook the moment it runs, so the roster has to be
 * complete first, and a restored leader raises no such hook (`open` only
 * reads) so it needs remembering explicitly either way.
 */
export async function openTeamLeader(input: {
  deps: TeamLeaderOpenDeps;
  record: TeamRecord;
  creation: TeamLeaderCreationInput;
}): Promise<AgentService> {
  const { deps, record, creation } = input;
  const opened = await adoptTeamLeaderIfAligned(deps, record);
  if (opened !== null) return opened;
  return createTeamLeaderAgentForTeam({ deps, creation });
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
