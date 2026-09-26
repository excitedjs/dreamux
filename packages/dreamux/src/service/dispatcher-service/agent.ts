import type {
  AgentRuntimeStatus,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook } from 'tapable';

import { errorInfo } from '@excitedjs/dreamux-utils';
import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { ConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import type { ConfigReader } from '../../config/service.js';
import type { AgentIdentityStore } from '../agent/store.js';
import type { AgentServiceFactory } from '../agent/factory.js';
import { dispatcherRuntimeId } from '../agent/runtime-id.js';
import type { AgentService } from '../agent/service.js';
import {
  DISPATCHER_AGENT_NAME,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityWorktreeIdentity,
} from '../agent/identity.js';
import type { TeammateAgentMcp } from '../agent/service-types.js';
import { SYSTEM_SOURCE } from '../submission-sources.js';
import type { RestartIntentConsumer } from './restart-intent.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import {
  bundledDispatcherSkillRoot,
  bundledSharedSkillRoot,
} from '../../platform/paths.js';
import { composeLaunchDraft } from '../../plugin/hooks.js';
import type { DispatcherRuntimeStatus } from './types.js';

export interface DispatcherAgentOptions {
  id: string;
  /** This dispatcher's own configured runtime ref, for identity ensure. */
  agentRuntime: string;
  /**
   * Forwarded verbatim into {@link AgentServiceFactory.create}'s own `config`
   * field: this owner itself never reads a fact off it, only builds the
   * contained `AgentService` that will call `.current()` at each launch
   * (`config/service.ts`'s `ConfigReader` doc).
   */
  config: ConfigReader;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  log: DreamuxLogger;
  /**
   * The dispatcher Agent's own MCP surface, built fresh per launch by the
   * dispatcher that owns the objects behind it. A supplier rather than a
   * value because the delegates close over live services (this dispatcher's
   * `ChannelService`) that must already be built by the time `build()` calls
   * it.
   */
  mcp: () => TeammateAgentMcp;
  identities: AgentIdentityStore;
  onPersisted: (identity: AgentEntityIdentity) => void;
  agentServiceFactory: AgentServiceFactory;
  conversationProjection: ConversationProjection;
  /** This Dispatcher's `beforeLaunch` hook, run once per Agent construction. */
  beforeLaunch: AsyncSeriesHook<[LaunchDraft]>;
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
 * cross-service orchestration, MCP delegate assembly).
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

  /**
   * Ensure the dispatcher-root identity and build the contained AgentService.
   *
   * Plugin launch-draft instructions follow the built-in prompt on both
   * prompt channels, because Codex reads only `replace` and Claude Code only
   * `append`; plugin skill roots follow the bundled roots, fenced against
   * them.
   */
  async build(cwd: string): Promise<AgentService> {
    const identity = await ensureDispatcherRootIdentity({
      identities: this.opts.identities,
      dispatcherId: this.opts.id,
      agentRuntime: this.opts.agentRuntime,
      cwd,
      onPersisted: this.opts.onPersisted,
    });
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
    const draft = await composeLaunchDraft(this.opts.beforeLaunch, builtinSkills);
    this.service = await this.opts.agentServiceFactory.create({
      identity,
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      identities: this.opts.identities,
      onPersisted: this.opts.onPersisted,
      conversationProjection: this.opts.conversationProjection,
      // The dispatcher agent has no worktree — it neither spawns nor closes, so it
      // never reaches the worktree manager (issue #233 Phase 5).
      log: this.opts.log,
      options: {
        mcp: this.opts.mcp(),
        runtimeId: dispatcherRuntimeId(this.opts.id),
        // This Agent is the Dispatcher Service's own; the role follows from that.
        role: 'dispatcher',
        loggerFields: {},
        skillSources: [...builtinSkills, ...draft.skillSources],
        disabledFeatures: [DISABLE_FEATURE_CRON],
        systemPrompt: {
          replace: [
            DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
            ...draft.instructions,
          ].join('\n\n'),
          append: [
            DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
            ...draft.instructions,
          ],
        },
      },
    });
    return this.service;
  }

  /** Throws when `build()` has not produced an agent yet. */
  mustAgent(): AgentService {
    const agent = this.service;
    if (agent === null) {
      throw new Error(`dispatcher '${this.opts.id}' agent is not prepared`);
    }
    return agent;
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
  dispatcherId: string;
  agentRuntime: string;
  cwd: string;
  worktree: AgentEntityWorktreeIdentity;
  onPersisted: (identity: AgentEntityIdentity) => void;
}

interface DispatcherRootIdentityInput {
  /** The dispatcher root Agent's own bound identity store. */
  identities: AgentIdentityStore;
  dispatcherId: string;
  agentRuntime: string;
  cwd: string;
  onPersisted: (identity: AgentEntityIdentity) => void;
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

function ensureDispatcherRootIdentity(
  input: DispatcherRootIdentityInput,
): Promise<AgentEntityIdentity> {
  return ensureDispatcherIdentity(input.identities, {
    dispatcherId: input.dispatcherId,
    agentRuntime: input.agentRuntime,
    cwd: input.cwd,
    worktree: dispatcherRootWorktreeIdentity(input.cwd),
    onPersisted: input.onPersisted,
  });
}

/**
 * Upsert the dispatcher-owned root identity while preserving compatible runtime
 * recovery state. This policy is dispatcher config compatibility, not a generic
 * Agent entity store rule.
 */
async function ensureDispatcherIdentity(
  identities: AgentIdentityStore,
  input: DispatcherIdentityEnsureInput,
): Promise<AgentEntityIdentity> {
  const existing = await identities.read();
  const now = Date.now();
  if (existing === null) {
    const identity: AgentEntityIdentity = {
      version: 1,
      dispatcher_id: input.dispatcherId,
      name: DISPATCHER_AGENT_NAME,
      team_id: null,
      agent_runtime: input.agentRuntime,
      session_id: null,
      source_cwd: input.cwd,
      source_repo: null,
      cwd: input.cwd,
      runtime_cwd: input.cwd,
      worktree: input.worktree,
      intent: null,
      identity_prompt: null,
      skill_sources: [],
      created_at: now,
      updated_at: now,
      status: 'stopped',
      last_error: null,
      closed_at: null,
      close_note: null,
    };
    return identities.upsert(identity, input.onPersisted);
  }

  const compatible =
    existing.agent_runtime === input.agentRuntime &&
    existing.cwd === input.cwd &&
    existing.runtime_cwd === input.cwd &&
    worktreeIdentityEquals(existing.worktree, input.worktree);
  const updated: AgentEntityIdentity = {
    ...existing,
    name: DISPATCHER_AGENT_NAME,
    team_id: null,
    agent_runtime: input.agentRuntime,
    source_cwd: input.cwd,
    source_repo: null,
    cwd: input.cwd,
    runtime_cwd: input.cwd,
    worktree: input.worktree,
    // Compatible preparation only refreshes configuration-owned fields. The
    // entity owns lifecycle projection and reopens `closed` through its own
    // mutation gate; construction must preserve status and closed metadata.
    ...(compatible
      ? {}
      : {
          session_id: null,
          status: 'stopped' as const,
          last_error: null,
          closed_at: null,
          close_note: null,
        }),
    updated_at: now,
  };
  return identities.upsert(updated, input.onPersisted);
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
