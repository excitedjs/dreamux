import type {
  AgentRuntimeStatus,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook } from 'tapable';
import type { WorkAdmission } from '../../platform/work-fence.js';
import {
  createTeamMateMcpDelegate,
  type TeamMateMcpDispatcherScope,
} from '../agent/mcp.js';
import type { TeammateSubmitInput } from '../agent/submission.js';
import type { TurnAdmission } from '../agent/turn.js';
import type { CompletionInitiator } from '../completion-router/index.js';
import type { ChannelMcpDelegates } from '../mcp/types.js';
import { createCronMcpDelegate } from '../scheduler/mcp.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { createTeamMcpDelegate } from '../team/mcp.js';
import type { TeamsPort } from '../team/teams-port.js';

import { errorInfo } from '@excitedjs/dreamux-utils';
import { DISABLE_FEATURE_CRON } from '../../agent-runtime/index.js';
import {
  bundledDispatcherSkillRoot,
  bundledSharedSkillRoot,
  dispatcherDir,
} from '../../platform/paths.js';
import { composeLaunchDraft } from '../../plugin/hooks.js';
import type { AgentServiceFactory } from '../agent/factory.js';
import {
  DISPATCHER_AGENT_NAME,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityWorktreeIdentity,
} from '../agent/identity.js';
import { dispatcherRuntimeId } from '../agent/runtime-id.js';
import type {
  TeammateAgentMcp,
  TeammateServiceOptions,
} from '../agent/service-types.js';
import type { AgentService } from '../agent/service.js';
import type {
  AgentIdentityCreateInput,
  AgentIdentityUpdateInput,
} from '../agent/store.js';
import { SYSTEM_SOURCE } from '../submission-sources.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import type { RestartIntentConsumer } from './restart-intent.js';
import type { DispatcherRuntimeStatus } from './types.js';

interface DispatcherAgentOwner extends TeamMateMcpDispatcherScope {
  readonly teams: TeamsPort;
  readonly scheduler: SchedulerCommands;
  readonly fence: WorkAdmission;
}

export interface DispatcherAgentOptions {
  id: string;
  /** This dispatcher's own configured runtime ref, for identity ensure. */
  agentRuntime: string;
  log: DreamuxLogger;
  /**
   * Fixed MCP infrastructure and actual collaborators. Tool delegates are
   * assembled in `build`, after channel initialization and launch hooks.
   */
  mcp: Pick<TeammateAgentMcp, 'leases' | 'adminSocketPath'>;
  dispatcher: DispatcherAgentOwner;
  channels: ChannelMcpDelegates;
  agentServiceFactory: AgentServiceFactory;
  /** This Dispatcher's `launch` hook, run once per Agent construction. */
  launch: AsyncSeriesHook<[LaunchDraft]>;
  /** The one restart marker this process loaded at boot; a constructor value, never reassigned. */
  restartIntent: RestartIntentConsumer;
}

/**
 * The dispatcher's own agent (issue #233 Phase 5), as one owner: identity
 * ensure, construction as a contained {@link AgentService}, the one
 * `mustAgent()` accessor, lazy activation with resume-notice injection, and
 * the one runtime-status projection every dispatcher-status reader shares.
 *
 * The dispatcher *has an* agent rather than *being* one: the shared entity
 * owns the runtime lifecycle (start/resume/stop), the in-process Turn
 * lifecycle and `completionInput` as a delivery target, while
 * `DispatcherService` keeps the dispatcher-only concerns (channel sessions,
 * cross-service orchestration). The holder assembles its own MCP delegates.
 *
 * The agent's runtime is resolved through the same `identity.agent_runtime ->
 * agents[]` path used by TeamLeader and TeamMate. Its `identity.json` is the
 * authoritative runtime recovery state.
 */
export class DispatcherAgent {
  private service: AgentService | null = null;

  constructor(private readonly opts: DispatcherAgentOptions) {}

  /** The built agent, or `null` before `build()` has run. */
  get current(): AgentService | null {
    return this.service;
  }

  /** Ensure the dispatcher-root identity and build the contained AgentService. */
  async build(cwd: string): Promise<AgentService> {
    const identityInput: DispatcherIdentityEnsureInput = {
      agentRuntime: this.opts.agentRuntime,
      cwd,
      worktree: dispatcherRootWorktreeIdentity(cwd),
    };
    const unbuilt = await this.opts.agentServiceFactory.upsert({
      location: { dir: dispatcherDir(this.opts.id), expectedName: null },
      creation: dispatcherIdentityCreation(identityInput),
      reconcile: (existing) =>
        dispatcherIdentityReconcile(existing, identityInput),
      role: 'dispatcher',
    });
    this.service = unbuilt.build(await this.dispatcherOptions());
    return this.service;
  }

  /**
   * Plugin launch-draft instructions follow the built-in prompt on both
   * prompt channels, because Codex reads only `replace` and Claude Code only
   * `append`; plugin skill roots follow the bundled roots, fenced against
   * them.
   */
  private async dispatcherOptions(): Promise<
    Omit<TeammateServiceOptions, 'role'>
  > {
    const builtinSkills = [
      {
        name: 'dispatcher',
        path: bundledDispatcherSkillRoot(),
        source: 'dreamux-core',
      },
      {
        name: 'shared',
        path: bundledSharedSkillRoot(),
        source: 'dreamux-core',
      },
    ];
    const draft = await composeLaunchDraft(this.opts.launch, builtinSkills);
    return {
      mcp: {
        ...this.opts.mcp,
        delegates: [
          ...this.opts.channels.mcpDelegates(
            { kind: 'dispatcher' },
            this.opts.dispatcher.fence,
          ),
          createTeamMcpDelegate({ teams: this.opts.dispatcher.teams }),
          createTeamMateMcpDelegate({
            kind: 'dispatcher',
            dispatcher: this.opts.dispatcher,
          }),
          createCronMcpDelegate(this.opts.dispatcher.scheduler),
        ],
      },
      runtimeId: dispatcherRuntimeId(this.opts.id),
      // This Agent is the Dispatcher Service's own; the role follows from that.
      loggerFields: {},
      skillSources: [...builtinSkills, ...draft.skillSources],
      disabledFeatures: [DISABLE_FEATURE_CRON],
      systemPrompt: {
        replace: [
          DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
          ...draft.instructions,
        ].join('\n\n'),
        append: [DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS, ...draft.instructions],
      },
    };
  }

  /** Throws when `build()` has not produced an agent yet. */
  mustAgent(): AgentService {
    const agent = this.service;
    if (agent === null) {
      throw new Error(`dispatcher '${this.opts.id}' agent is not prepared`);
    }
    return agent;
  }

  completionRecipient(): CompletionInitiator {
    return this.mustAgent();
  }

  submitInput(input: TeammateSubmitInput): Promise<TurnAdmission> {
    return this.mustAgent().submitInput(input);
  }

  /**
   * Lazily activate the dispatcher runtime when a restart notice targets it,
   * injecting the notice once activation completes. Every other start leaves
   * the runtime dormant: unbound channel inbound, dispatcher cron, or a later
   * explicit resume notice is what actually starts it.
   */
  async activateIfNeeded(): Promise<void> {
    if (!this.shouldActivateForResumeNotice()) return;
    const agent = this.mustAgent();
    if (agent.runtimeStatus() !== null) return;
    await agent.activate();
    await this.injectRestartNoticeIfNeeded(agent);
  }

  private shouldActivateForResumeNotice(): boolean {
    const sessionId = this.service?.current().session_id ?? null;
    return (
      sessionId !== null &&
      this.opts.restartIntent.hasTarget(this.opts.id, Date.now())
    );
  }

  private async injectRestartNoticeIfNeeded(
    agent: AgentService,
  ): Promise<void> {
    // Only an actually-restored session gets the notice: a fresh start has no
    // prior context the notice would explain, and `null` means no runtime started.
    if (agent.startContinuity() !== 'resumed') return;
    const notice = this.opts.restartIntent.claim(this.opts.id, Date.now());
    if (notice === null) return;
    try {
      const result = await agent.submitInput({
        source: SYSTEM_SOURCE,
        text: notice,
        sourceId: `restart-notice:${this.opts.id}`,
      });
      if (result.status === 'failed' || result.status === 'ambiguous') {
        this.opts.log.warn(
          { dispatcher_id: this.opts.id, err: errorInfo(result.error) },
          result.status === 'ambiguous'
            ? 'restart notice injection was ambiguous; not retrying'
            : 'restart notice injection failed',
        );
      }
    } catch (err) {
      this.opts.log.warn(
        { dispatcher_id: this.opts.id, err: errorInfo(err) },
        'restart notice injection errored',
      );
    }
  }

  /**
   * The one dispatcher-status projection, speaking the runtime vocabulary
   * (`AgentRuntimeStatus`) directly instead of converting through the
   * TeamMate-identity vocabulary. `null` before `build()` has run; a built but
   * not yet activated agent reports `'declared'`, the runtime's own
   * constructed-not-started state.
   */
  status(): DispatcherRuntimeStatus | null {
    const agent = this.service;
    if (agent === null) return null;
    const identity = agent.current();
    return {
      status: agent.runtimeStatus() ?? 'declared',
      sessionId: agent.sessionId() ?? identity.session_id,
      lastError: identity.last_error,
    };
  }
}

interface DispatcherIdentityEnsureInput {
  agentRuntime: string;
  cwd: string;
  worktree: AgentEntityWorktreeIdentity;
}

function dispatcherRootWorktreeIdentity(
  cwd: string,
): AgentEntityWorktreeIdentity {
  return {
    mode: 'reuse-cwd',
    slug: null,
    path: cwd,
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  };
}

/**
 * The dispatcher root's own creation input, for when `AgentServiceFactory.
 * upsert()` finds nothing at its bound location yet. Every field default
 * (version, timestamps, the rest of `AgentEntityIdentity`) is the store's
 * job, not this module's; a fresh dispatcher-root identity starts `'stopped'`
 * rather than the store's own `'starting'` default, since building this
 * Agent is not the same event as activating its runtime.
 */
function dispatcherIdentityCreation(
  input: DispatcherIdentityEnsureInput,
): AgentIdentityCreateInput {
  return {
    name: DISPATCHER_AGENT_NAME,
    teamId: null,
    agentRuntime: input.agentRuntime,
    sourceCwd: input.cwd,
    sourceRepo: null,
    cwd: input.cwd,
    runtimeCwd: input.cwd,
    worktree: input.worktree,
    status: 'stopped',
  };
}

/**
 * Reconcile the dispatcher-owned root identity against its own live config,
 * preserving compatible runtime recovery state. This policy is dispatcher
 * config compatibility, not a generic Agent entity store rule; the merge and
 * the write around it are `AgentServiceFactory.upsert()`'s job, not this
 * function's.
 */
function dispatcherIdentityReconcile(
  existing: AgentEntityIdentity,
  input: DispatcherIdentityEnsureInput,
): AgentIdentityUpdateInput {
  const compatible =
    existing.agent_runtime === input.agentRuntime &&
    existing.cwd === input.cwd &&
    existing.runtime_cwd === input.cwd &&
    worktreeIdentityEquals(existing.worktree, input.worktree);
  return {
    name: DISPATCHER_AGENT_NAME,
    teamId: null,
    agentRuntime: input.agentRuntime,
    sourceCwd: input.cwd,
    sourceRepo: null,
    cwd: input.cwd,
    runtimeCwd: input.cwd,
    worktree: input.worktree,
    // Compatible preparation only refreshes configuration-owned fields. The
    // entity owns lifecycle projection and reopens `closed` through its own
    // mutation gate; construction must preserve status and closed metadata.
    ...(compatible
      ? {}
      : {
          sessionId: null,
          status: 'stopped' as const,
          lastError: null,
          closedAt: null,
          closeNote: null,
        }),
  };
}

function worktreeIdentityEquals(
  a: AgentEntityWorktreeIdentity,
  b: AgentEntityWorktreeIdentity,
): boolean {
  return (
    a.mode === b.mode &&
    a.slug === b.slug &&
    a.path === b.path &&
    a.branch === b.branch &&
    a.base_ref === b.base_ref &&
    a.cleanup === b.cleanup &&
    a.cleanup_state === b.cleanup_state &&
    a.cleanup_error === b.cleanup_error
  );
}

/**
 * The cold-path counterpart of `DispatcherAgent.status()`, read when no live
 * `DispatcherAgent` exists in this process (the dispatcher was never
 * materialized, or its agent was never built) and the only available fact is
 * the persisted identity. This is the opposite direction of
 * `agent/identity.ts`'s `runtimeStatusToIdentityStatus()`, which maps a live
 * runtime status onto the TeamMate-identity vocabulary for `identity.json`'s
 * own `status` field, not the dispatcher runtime vocabulary
 * `dispatcher.status`/`dispatcher.list` report.
 */
export function identityStatusToRuntimeStatus(
  status: AgentEntityIdentityStatus | null,
): AgentRuntimeStatus {
  if (status === null) return 'declared';
  switch (status) {
    case 'starting':
      return 'starting';
    case 'running':
      return 'ready';
    case 'degraded':
      return 'degraded';
    case 'closed':
    case 'stopped':
      return 'stopped';
  }
}
