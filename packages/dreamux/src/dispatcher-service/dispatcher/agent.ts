import type {
  AgentRuntimeMcpServer,
  ChannelSession,
  CompletionEnvelope,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  bundledSkillSourcesForRole,
  dispatcherHostPaths,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DispatcherConfig, DreamuxConfig } from '../../config/config.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import {
  completionKey,
  type CompletionRouter,
} from '../teammate/completion-router.js';
import { TeamMateIdentityStore } from '../teammate/identity-store.js';
import { TeammateReadModel } from '../teammate/read-model.js';
import {
  TeammateService,
  type RuntimeLaunchSpec,
  type TeammateServiceDeps,
} from '../teammate/teammate-service.js';
import { TeamMateTurnsStore } from '../teammate/turns-store.js';
import type { TeamMateIdentity } from '../teammate/types.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';

/**
 * The fixed debug-record name of a dispatcher's own agent (issue #233 Phase 5).
 * Its `identity.json` + `turn.jsonl` live at the dispatcher ROOT (role
 * `dispatcher`), structurally outside the `teammate/` and `team/` collections, so
 * the `teammate.*` read chokepoints never enumerate it. The pair is write-only
 * debug data with no consumer; `status.json` (the `DispatcherStore`) stays the
 * authoritative runtime state.
 */
const DISPATCHER_AGENT_NAME = 'dispatcher';

export interface DispatcherAgentDeps {
  id: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  router: CompletionRouter;
  log: DreamuxLogger;
  adminSocketPath: string;
  /**
   * The dispatcher's validated workspace cwd, resolved by `DispatcherService`
   * before `agent.start()` (`ensureDispatcherWorkspace`). The runtime runs here.
   */
  resolveCwd: () => string;
  /**
   * The dispatcher's live channel sessions at launch, supplied by
   * `DispatcherService` (it owns the channel session map). The dispatcher MCP
   * descriptors are derived from these so the runtime sees its channel tools.
   */
  liveChannels: () => Map<string, ChannelSession>;
}

/**
 * Build the dispatcher's own agent as a contained {@link TeammateService} (issue
 * #233 Phase 5). The dispatcher *has an* agent rather than *being* one: the
 * shared entity owns the runtime lifecycle (start/resume/stop), the
 * `onTurnSettled` → router capture, and `completionInput` as a delivery target,
 * while `DispatcherService` keeps the dispatcher-only concerns (channel sessions,
 * restart-intent injection, MCP descriptor assembly).
 *
 * The agent's runtime is built from the dispatcher config (not an `agents[].id`)
 * and persists its authoritative status/thread to `status.json` via the injected
 * {@link DispatcherStore}; the entity's identity store only writes the write-only
 * debug record at the dispatcher root.
 */
export function createDispatcherAgent(deps: DispatcherAgentDeps): TeammateService {
  const identities = new TeamMateIdentityStore({
    warn: deps.log.warn.bind(deps.log),
  });
  const turnsStore = new TeamMateTurnsStore({
    warn: deps.log.warn.bind(deps.log),
  });
  const readModel = new TeammateReadModel({
    dispatcherId: deps.id,
    identities,
    turnsStore,
    runtimeFor: () => agent.getRuntime(),
  });
  const identity = debugIdentity(deps.id, deps.config);
  // Best-effort: persist the write-only debug record at the dispatcher root. A
  // failure here never blocks launch — `status.json` is the authoritative state.
  void identities
    .create({
      dispatcherId: deps.id,
      name: DISPATCHER_AGENT_NAME,
      role: 'dispatcher',
      agentRuntime: identity.agent_runtime,
      sourceCwd: identity.source_cwd,
      sourceRepo: null,
      cwd: identity.cwd,
      runtimeCwd: identity.runtime_cwd,
      worktree: identity.worktree,
      status: 'running',
    })
    .catch(() => {
      /* debug record only */
    });

  const serviceDeps: TeammateServiceDeps = {
    config: deps.config,
    agentRuntimeProviders: deps.agentRuntimeProviders,
    identities,
    turnsStore,
    readModel,
    // The dispatcher agent has no worktree — it neither spawns nor closes, so it
    // never reaches the worktree manager (issue #233 Phase 5).
    log: deps.log,
    buildLaunch: () => buildDispatcherLaunch(deps),
    nextSubmissionSeq: () => 0,
    trackSettleCapture: () => {
      /* dispatcher settle delivery is awaited inline below */
    },
    routeSettledCompletion: (producerName, turnId, completion) =>
      routeSettled(deps.router, producerName, turnId, completion),
  };

  const agent = new TeammateService(serviceDeps, deps.id, identity);
  return agent;
}

async function routeSettled(
  router: CompletionRouter,
  producerName: string,
  turnId: string,
  completion: CompletionEnvelope,
): Promise<void> {
  await router.settle(completionKey(producerName, turnId), completion);
}

/**
 * Build the dispatcher runtime's launch from the dispatcher config + the live
 * channel sessions (issue #233 Phase 5). The runtime persists its status/thread
 * to `status.json` through the injected {@link DispatcherStore}, which is passed
 * as the runtime `state` — NOT the entity's debug identity store.
 */
function buildDispatcherLaunch(deps: DispatcherAgentDeps): RuntimeLaunchSpec {
  const id = deps.id;
  const row = deps.dispatchers.get(id);
  if (row === null) throw new Error(`no dispatcher '${id}'`);
  const dispatcherConfig = mustDispatcherConfig(deps.config, id);
  const provider = deps.agentRuntimeProviders.resolve(
    dispatcherConfig.runtime.provider,
  );
  const cwd = deps.resolveCwd();
  // 'replace' runtimes (codex) consume the full dispatcher prompt as their base
  // instructions; 'append' runtimes (claude-code) receive a focused delta.
  const systemPromptContent =
    provider.getCapabilities().systemPrompt.mode === 'replace'
      ? DREAMUX_DISPATCHER_BASE_INSTRUCTIONS
      : DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS;
  const mcpServers: AgentRuntimeMcpServer[] = dispatcherMcpServerDescriptors({
    dispatcherId: id,
    channels: deps.liveChannels(),
    adminSocketPath: deps.adminSocketPath,
  });
  return {
    provider,
    checkpointId: row.thread_id,
    context: {
      identity: { runtime_id: id, checkpoint_id: row.thread_id },
      role: 'dispatcher',
      config: dispatcherConfig.runtime.config,
      cwd,
      systemPromptContent,
      mcpServers,
      skillSources: bundledSkillSourcesForRole('dispatcher'),
      state: deps.dispatchers,
      paths: dispatcherHostPaths,
      logger: deps.log,
    },
  };
}

function mustDispatcherConfig(
  config: DreamuxConfig,
  id: string,
): DispatcherConfig {
  const dispatcherConfig = config.dispatchers.find((entry) => entry.id === id);
  if (dispatcherConfig === undefined) {
    throw new Error(`dispatcher '${id}' has no config entry`);
  }
  return dispatcherConfig;
}

function debugIdentity(
  dispatcherId: string,
  config: DreamuxConfig,
): TeamMateIdentity {
  const now = Date.now();
  const dispatcherConfig = config.dispatchers.find(
    (entry) => entry.id === dispatcherId,
  );
  const cwd = dispatcherConfig?.cwd ?? '';
  const agentRuntime = dispatcherConfig?.runtime.provider ?? 'dispatcher';
  return {
    version: 1,
    dispatcher_id: dispatcherId,
    name: DISPATCHER_AGENT_NAME,
    role: 'dispatcher',
    team_id: null,
    agent_runtime: agentRuntime,
    session_id: null,
    source_cwd: cwd,
    source_repo: null,
    cwd,
    runtime_cwd: cwd,
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: cwd,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    intent: null,
    created_at: now,
    updated_at: now,
    status: 'running',
    last_error: null,
    closed_at: null,
    close_note: null,
    turn_count: 0,
    last_seen_at: now,
    last_prompt_preview: null,
    last_assistant_preview: null,
  };
}
