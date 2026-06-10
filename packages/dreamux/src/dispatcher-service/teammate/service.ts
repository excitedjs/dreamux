import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderCatalog,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
} from '../../agent-runtime/index.js';
import type { TurnSettledSignal } from '../../agent-runtime/turn.js';
import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  type DispatcherConfig,
  type DreamuxConfig,
  type ResolvedAgentConfig,
} from '../../config/config.js';
import type { DispatcherStore, DispatcherRow } from '../../state/dispatcher-store.js';
import type { DreamuxLogger } from '../../platform/logger.js';
import { teammateClaudeCodeStreamLogPath } from '../../agent-runtime/builtin/claude-code/paths.js';
import {
  teammateCodexAppServerErrorLogPath,
  teammateCodexAppServerLogPath,
} from '../../agent-runtime/builtin/codex/paths.js';
import { dispatcherTeamMateRuntimeDir } from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import { TeamMateIdentityStore } from './identity-store.js';
import { TeamMateRuntimeStateStore } from './runtime-state.js';
import { WorktreeManager } from './worktree-manager.js';
import {
  validateTeamMateName,
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type SpawnTeamMateInput,
  type TeamMateCapabilities,
  type TeamMateCallerPrincipal,
  type TeamMateCloseResult,
  type TeamMateContextResult,
  type CreateTeamLeaderInput,
  type TeamMateHistoryEventsResult,
  type TeamMateHistoryQuery,
  type TeamMateHistoryResult,
  type TeamMateIdentity,
  type TeamMateLedgerRow,
  type TeamMateLastResult,
  type TeamMateAgentRuntimeCapability,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateSpawnResult,
  type TeamMateTurnOrigin,
  type TeamMateTurnResult,
  type TeamMateWorktreeIdentity,
  type TeamMateWorktreeRequest,
  dispatcherPrincipal,
  principalDispatcherId,
} from './types.js';

interface LiveTeamMate {
  runtime: AgentRuntime;
  state: TeamMateRuntimeStateStore;
  /**
   * Per-turn submission origin, keyed by runtime turn id. First-writer-wins:
   * a later input steered into an already-active turn never re-targets that
   * turn's completion. Bounded FIFO (see {@link TURN_ORIGIN_CACHE_LIMIT});
   * entries are kept after settle so duplicate settles of the same turn route
   * consistently.
   */
  turnOrigins: Map<string, TeamMateTurnOrigin>;
}

const TURN_ORIGIN_CACHE_LIMIT = 256;

export interface TeamMateAgentServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
  /**
   * Reverse-delivery sink: invoked when a teammate turn reaches a terminal state
   * (success, failure, or stop). The facade bridges it to the dispatcher
   * runtime's `completionInput`, turning a finished teammate into a fresh
   * dispatcher turn (issue #147). A teammate runtime is launched with
   * `onTurnSettled` only when this sink is present, so settlement never delivers
   * into a void.
   */
  onTeamMateCompletion?: (
    dispatcherId: string,
    identity: TeamMateIdentity,
    completion: CompletionEnvelope,
    /**
     * The settled turn's submission origin, or `null` when the turn id was
     * never recorded by this process (the sink picks the role's safe default).
     */
    origin: TeamMateTurnOrigin | null,
  ) => void | Promise<void>;
  log: DreamuxLogger;
}

export interface TeamMateSharedWorkspace {
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: TeamMateWorktreeIdentity;
}

export interface ScopedSpawnTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  prompt: string;
  agentRuntime?: string;
  cwd?: string;
  worktree?: TeamMateWorktreeRequest;
  sharedWorkspace?: TeamMateSharedWorkspace;
  intent?: string;
}

export interface ScopedSendTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  prompt: string;
}

export interface ScopedCloseTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  note?: string;
}

export class TeamMateAgentService {
  private readonly identities: TeamMateIdentityStore;
  private readonly worktrees = new WorktreeManager();
  private readonly live = new Map<string, LiveTeamMate>();
  private submissionSeq = 0;

  constructor(private readonly opts: TeamMateAgentServiceOptions) {
    this.identities = new TeamMateIdentityStore({
      warn: (message, fields) => opts.log.warn(fields ?? {}, message),
    });
  }

  async spawn(input: SpawnTeamMateInput): Promise<TeamMateSpawnResult> {
    return this.spawnScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      prompt: input.prompt,
      ...(input.agentRuntime !== undefined ? { agentRuntime: input.agentRuntime } : {}),
      cwd: input.cwd,
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
    });
  }

  async spawnScoped(input: ScopedSpawnTeamMateInput): Promise<TeamMateSpawnResult> {
    const dispatcherId = principalDispatcherId(input.principal);
    const name = validateTeamMateName(input.name);
    if (input.principal.kind === 'teammate') {
      throw new Error('ordinary TeamMates cannot spawn TeamMates');
    }
    const cwd = input.sharedWorkspace?.sourceCwd ?? input.cwd;
    if (input.principal.kind === 'team_leader' && input.sharedWorkspace === undefined) {
      throw new Error('TeamLeader member spawn requires a shared team workspace');
    }
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new Error('TeamMate spawn requires cwd');
    }
    const existing = await this.identities.get(dispatcherId, name);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`TeamMate ${JSON.stringify(name)} already exists; use send`);
    }
    const agentRuntimeId =
      input.agentRuntime ?? this.defaultAgentRuntime(dispatcherId);
    const agent = this.resolveAgent(dispatcherId, agentRuntimeId);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    const workspace =
      input.sharedWorkspace ??
      (await this.worktrees.prepare({
        dispatcherId,
        teammateName: name,
        cwd,
        request: input.worktree,
      }));
    if (input.sharedWorkspace === undefined) {
      await this.assertManagedWorktreeAvailable(dispatcherId, name, workspace.worktree);
    }
    const owner = ownerForPrincipal(input.principal);
    const role = input.principal.kind === 'team_leader' ? 'team_member' : 'teammate';
    let identity =
      existing ??
      (await this.identities.create({
        dispatcherId,
        name,
        owner,
        role,
        teamId: owner.kind === 'team' ? owner.team_id : null,
        agentRuntime: agentRuntimeId,
        sourceCwd: workspace.sourceCwd,
        sourceRepo: workspace.sourceRepo,
        cwd: workspace.runtimeCwd,
        runtimeCwd: workspace.runtimeCwd,
        worktree: workspace.worktree,
        intent: input.intent ?? null,
      }));
    this.assertPrincipalCanAccess(input.principal, identity);
    identity = await this.identities.update(identity, {
      agentRuntime: agentRuntimeId,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      cwd: workspace.runtimeCwd,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent ?? null,
      status: 'starting',
      closedAt: null,
      closeNote: null,
      lastError: null,
      checkpoint: null,
    });
    const live = await this.startRuntime(dispatcherId, identity, provider, agent);
    identity = live.state.current();
    const turn = await this.submitPrompt(dispatcherId, name, input.prompt, {
      principal: input.principal,
    });
    await this.identities.appendHistory(live.state.current(), {
      type: 'spawn',
      prompt: input.prompt,
      turnId: turn.turn_id ?? null,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    return this.sendScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      prompt: input.prompt,
    });
  }

  async sendScoped(input: ScopedSendTeamMateInput): Promise<TeamMateSendResult> {
    // send subsumes the former `resume` verb (issue #155): a teammate that is
    // not live — including one previously `close`d — is reopened from its
    // persisted checkpoint and the turn is submitted, so send always works as
    // long as the identity exists. reopenClosed scopes this revival to send;
    // read-only verbs (last/ctx/status) never silently reopen a closed teammate.
    const dispatcherId = principalDispatcherId(input.principal);
    const live = await this.ensureRuntime(dispatcherId, input.name, {
      principal: input.principal,
      reopenClosed: true,
    });
    const turn = await this.submitPrompt(dispatcherId, input.name, input.prompt, {
      principal: input.principal,
    });
    await this.identities.appendHistory(live.state.current(), {
      type: 'send',
      prompt: input.prompt,
      turnId: turn.turn_id ?? null,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    return this.closeScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
  }

  async closeScoped(input: ScopedCloseTeamMateInput): Promise<TeamMateCloseResult> {
    const dispatcherId = principalDispatcherId(input.principal);
    const name = validateTeamMateName(input.name);
    const identity = await this.mustIdentity(dispatcherId, name, input.principal);
    const key = liveKey(dispatcherId, name);
    const live = this.live.get(key);
    if (live !== undefined) {
      await live.runtime.stop();
      this.live.delete(key);
    }
    const closed = await this.identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note ?? null,
      worktree: await this.worktrees.cleanup(identity),
    });
    await this.identities.appendHistory(closed, {
      type: 'close',
      note: input.note ?? null,
    });
    return { teammate: this.toStatus(closed, null) };
  }

  async list(dispatcherId: string): Promise<TeamMateRuntimeStatus[]> {
    return this.listScoped(dispatcherPrincipal(dispatcherId));
  }

  async listScoped(principal: TeamMateCallerPrincipal): Promise<TeamMateRuntimeStatus[]> {
    const dispatcherId = principalDispatcherId(principal);
    const identities = await this.identities.list(dispatcherId);
    return identities
      .filter((identity) => principalCanAccess(principal, identity))
      .map((identity) =>
        this.toStatus(identity, this.live.get(liveKey(dispatcherId, identity.name))?.runtime ?? null),
      );
  }

  async status(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateRuntimeStatus> {
    return this.statusScoped(dispatcherPrincipal(dispatcherId), name);
  }

  async statusScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
  ): Promise<TeamMateRuntimeStatus> {
    const dispatcherId = principalDispatcherId(principal);
    const identity = await this.mustIdentity(
      dispatcherId,
      validateTeamMateName(name),
      principal,
    );
    return this.toStatus(
      identity,
      this.live.get(liveKey(dispatcherId, identity.name))?.runtime ?? null,
    );
  }

  async history(input: TeamMateHistoryQuery): Promise<TeamMateHistoryResult> {
    return this.historyScoped({
      ...input,
      principal: input.principal ?? dispatcherPrincipal(input.dispatcherId),
    });
  }

  async historyScoped(
    input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'principal'> & {
      principal: TeamMateCallerPrincipal;
    },
  ): Promise<TeamMateHistoryResult> {
    const dispatcherId = principalDispatcherId(input.principal);
    const identities = await this.identities.list(dispatcherId);
    const rows: TeamMateLedgerRow[] = [];
    for (const identity of identities) {
      const row = await this.toLedgerRow(identity);
      if (
        principalCanAccess(input.principal, identity) &&
        this.matchesLedgerQuery(row, input)
      ) {
        rows.push(row);
      }
    }
    rows.sort((a, b) =>
      b.last_seen_at - a.last_seen_at ||
      b.updated_at - a.updated_at ||
      a.name.localeCompare(b.name),
    );
    const start = input.cursor !== undefined ? decodeCursor(input.cursor) : 0;
    const limit = clampHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeCursor(next) : null,
    };
  }

  async historyEvents(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateHistoryEventsResult> {
    return this.historyEventsScoped(dispatcherPrincipal(dispatcherId), name);
  }

  async historyEventsScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
  ): Promise<TeamMateHistoryEventsResult> {
    const dispatcherId = principalDispatcherId(principal);
    const teammateName = validateTeamMateName(name);
    const identity = await this.identities.get(dispatcherId, teammateName);
    if (identity !== null) this.assertPrincipalCanAccess(principal, identity);
    return {
      teammate:
        identity === null
          ? null
          : this.toStatus(
              identity,
              this.live.get(liveKey(dispatcherId, teammateName))?.runtime ?? null,
            ),
      events: await this.identities.history(dispatcherId, teammateName),
    };
  }

  async last(dispatcherId: string, name: string): Promise<TeamMateLastResult> {
    return this.lastScoped(dispatcherPrincipal(dispatcherId), name);
  }

  async lastScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
  ): Promise<TeamMateLastResult> {
    const dispatcherId = principalDispatcherId(principal);
    const live = await this.ensureRuntime(dispatcherId, name, {
      principal,
    });
    return {
      teammate: this.toStatus(live.state.current(), live.runtime),
      last: await live.runtime.getLast(),
    };
  }

  async context(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateContextResult> {
    return this.contextScoped(dispatcherPrincipal(dispatcherId), name);
  }

  async contextScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
  ): Promise<TeamMateContextResult> {
    const dispatcherId = principalDispatcherId(principal);
    const live = await this.ensureRuntime(dispatcherId, name, {
      principal,
    });
    return {
      teammate: this.toStatus(live.state.current(), live.runtime),
      context: await live.runtime.getContext(),
    };
  }

  async channelInputScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
    input: import('../../agent-runtime/turn.js').InboundTurnInput,
  ): Promise<AgentRuntimeTurnResult> {
    const dispatcherId = principalDispatcherId(principal);
    const live = await this.ensureRuntime(dispatcherId, name, {
      principal,
      reopenClosed: true,
    });
    const result = await live.runtime.channelInput(input);
    if (result.status === 'submitted') {
      recordTurnOrigin(live, result.turnId, 'channel');
    }
    return result;
  }

  async createTeamLeader(input: CreateTeamLeaderInput): Promise<TeamMateSpawnResult> {
    const name = validateTeamMateName(input.name);
    const existing = await this.identities.get(input.dispatcherId, name);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`TeamLeader ${JSON.stringify(name)} already exists`);
    }
    const agent = this.resolveAgent(input.dispatcherId, input.agentRuntime);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    const owner: TeamMateIdentity['owner'] = {
      kind: 'dispatcher',
      dispatcher_id: input.dispatcherId,
    };
    let identity =
      existing ??
      (await this.identities.create({
        dispatcherId: input.dispatcherId,
        name,
        owner,
        role: 'team_leader',
        teamId: input.teamId,
        agentRuntime: input.agentRuntime,
        sourceCwd: input.sourceCwd,
        sourceRepo: input.sourceRepo,
        cwd: input.runtimeCwd,
        runtimeCwd: input.runtimeCwd,
        worktree: input.worktree,
        intent: input.intent ?? null,
      }));
    identity = await this.identities.update(identity, {
      agentRuntime: input.agentRuntime,
      sourceCwd: input.sourceCwd,
      sourceRepo: input.sourceRepo,
      cwd: input.runtimeCwd,
      runtimeCwd: input.runtimeCwd,
      worktree: input.worktree,
      intent: input.intent ?? null,
      status: 'starting',
      closedAt: null,
      closeNote: null,
      lastError: null,
      checkpoint: null,
    });
    const live = await this.startRuntime(input.dispatcherId, identity, provider, agent);
    identity = live.state.current();
    const turn = await this.submitPrompt(input.dispatcherId, name, input.prompt);
    await this.identities.appendHistory(live.state.current(), {
      type: 'spawn',
      prompt: input.prompt,
      turnId: turn.turn_id ?? null,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  getCapabilities(): TeamMateCapabilities {
    return {
      verbs: [
        'spawn',
        'send',
        'close',
        'history',
        'list',
        'status',
        'last',
        'ctx',
        'get_capabilities',
      ],
      agent_runtimes: Object.entries(this.opts.config.agents).map(
        ([agentRuntimeId, agent]) =>
          this.agentRuntimeCapability(agentRuntimeId, agent),
      ),
    };
  }

  async stopAll(): Promise<void> {
    for (const [key, live] of this.live) {
      await live.runtime.stop();
      this.live.delete(key);
    }
  }

  getLiveRuntime(dispatcherId: string, name: string): AgentRuntime | null {
    return this.live.get(liveKey(dispatcherId, validateTeamMateName(name)))?.runtime ?? null;
  }

  private async ensureRuntime(
    dispatcherId: string,
    name: string,
    opts: { principal?: TeamMateCallerPrincipal; reopenClosed?: boolean } = {},
  ): Promise<LiveTeamMate> {
    const teammateName = validateTeamMateName(name);
    const key = liveKey(dispatcherId, teammateName);
    const existing = this.live.get(key);
    if (existing !== undefined) {
      this.assertPrincipalCanAccess(
        opts.principal ?? dispatcherPrincipal(dispatcherId),
        existing.state.current(),
      );
      return existing;
    }
    let identity = await this.mustIdentity(
      dispatcherId,
      teammateName,
      opts.principal ?? dispatcherPrincipal(dispatcherId),
    );
    if (identity.status === 'closed') {
      // Only send reopens a closed teammate (issue #155): clear the closed
      // markers and revive from the persisted checkpoint. `checkpoint` is left
      // intact — it is what distinguishes a reopen (resumes prior context) from
      // a fresh spawn (which nulls it). Read-only verbs pass no flag and still
      // fail-loud on a closed teammate.
      if (opts.reopenClosed !== true) {
        throw new Error(`TeamMate ${JSON.stringify(teammateName)} is closed`);
      }
      identity = await this.reprepareDeletedManagedWorktree(identity);
      identity = await this.identities.update(identity, {
        status: 'starting',
        closedAt: null,
        closeNote: null,
        lastError: null,
      });
    }
    // Re-resolve the persisted agent id against the live agents map: an agent
    // removed from config since spawn fails loud here rather than silently
    // defaulting to some other runtime.
    const agent = this.resolveAgent(dispatcherId, identity.agent_runtime);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    return this.startRuntime(dispatcherId, identity, provider, agent);
  }

  private async reprepareDeletedManagedWorktree(
    identity: TeamMateIdentity,
  ): Promise<TeamMateIdentity> {
    if (
      identity.worktree.mode !== 'managed' ||
      identity.worktree.cleanup_state !== 'deleted'
    ) {
      return identity;
    }
    const workspace = await this.worktrees.prepare({
      dispatcherId: identity.dispatcher_id,
      teammateName: identity.name,
      cwd: identity.source_cwd,
      request: {
        mode: 'managed',
        ...(identity.worktree.slug !== null ? { slug: identity.worktree.slug } : {}),
        ...(identity.worktree.base_ref !== null
          ? { base_ref: identity.worktree.base_ref }
          : {}),
        ...(identity.worktree.branch !== null ? { branch: identity.worktree.branch } : {}),
        cleanup: identity.worktree.cleanup,
      },
    });
    await this.assertManagedWorktreeAvailable(
      identity.dispatcher_id,
      identity.name,
      workspace.worktree,
    );
    return this.identities.update(identity, {
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      cwd: workspace.runtimeCwd,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
    });
  }

  private async startRuntime(
    dispatcherId: string,
    identity: TeamMateIdentity,
    provider: AgentRuntimeProvider,
    agent: ResolvedAgentConfig,
  ): Promise<LiveTeamMate> {
    const resumeCapability = provider.getCapabilities().resume;
    const state = new TeamMateRuntimeStateStore(
      this.identities,
      identity,
      resumeCapability.supported ? resumeCapability.checkpoint : null,
    );
    const row = this.runtimeRow(identity);
    const onTeamMateCompletion = this.opts.onTeamMateCompletion;
    // Bound late so the settle handler closes over the runtime instance directly
    // rather than re-reading the live map: close() deletes the live entry right
    // after stop() fires its terminal `stopped` settles, which would otherwise
    // race the lookup. The origin map is closed over for the same reason.
    let liveRuntime: AgentRuntime | null = null;
    const turnOrigins = new Map<string, TeamMateTurnOrigin>();
    // The teammate's runtime config comes from its own resolved agent (the
    // agents[].id it was spawned with), never inherited from the dispatcher.
    // Hand the provider a create-context dispatcher whose `runtime` is the
    // resolved agent's { provider, config }: a teammate on a different provider
    // than its dispatcher (e.g. a claude teammate under a codex dispatcher) gets
    // its OWN typed config, which structurally removes the cross-provider
    // "is not wired to ..." mismatch. Other dispatcher fields (id, cwd, channels)
    // come from the real dispatcher config when present.
    const dispatcherCfg = this.dispatcherConfig(dispatcherId);
    const createContextDispatcher: DispatcherConfig = {
      ...(dispatcherCfg ?? syntheticDispatcherConfig(dispatcherId)),
      agentRuntime: identity.agent_runtime,
      runtime: { provider: agent.provider, config: agent.config },
    };
    const runtime = provider.createRuntime({
      row,
      dispatcher: createContextDispatcher,
      dispatchers: this.opts.dispatchers,
      cwd: identity.cwd,
      state,
      paths: this.runtimePaths(identity, provider.ref),
      mcpServers: [
        ...(this.opts.mcpServersForTeamMate?.({
          dispatcherId,
          name: identity.name,
          identity,
        }) ?? []),
      ],
      // Attach the settle hook only when a sink is wired (the dispatcher's own
      // runtime never gets one, so it cannot self-deliver). The handler runs off
      // the synchronous callback and isolates every error so a delivery failure
      // can never crash the teammate runtime or the settle path.
      ...(onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled: TurnSettledSignal): void => {
              const settledRuntime = liveRuntime;
              if (settledRuntime === null) return;
              void this.deliverTurnSettled(
                dispatcherId,
                identity.name,
                identity,
                settledRuntime,
                settled,
                turnOrigins,
                onTeamMateCompletion,
              );
            },
          }
        : {}),
      log: (level, message, err) =>
        this.opts.log[level](
          {
            dispatcher_id: dispatcherId,
            teammate: identity.name,
            ...(err !== undefined ? { err: errInfo(err) } : {}),
          },
          message,
        ),
    });
    liveRuntime = runtime;
    if (identity.checkpoint !== null) {
      await runtime.resume({ checkpoint: identity.checkpoint });
    } else {
      await runtime.start();
    }
    const live = { runtime, state, turnOrigins };
    this.live.set(liveKey(dispatcherId, identity.name), live);
    return live;
  }

  private async submitPrompt(
    dispatcherId: string,
    name: string,
    prompt: string,
    opts: { principal?: TeamMateCallerPrincipal } = {},
  ): Promise<TeamMateTurnResult> {
    const live = await this.ensureRuntime(dispatcherId, name, opts);
    const submissionSeq = ++this.submissionSeq;
    const result = await live.runtime.channelInput({
      sourceId: `teammate:${name}:${submissionSeq}`,
      text: prompt,
    });
    if (result.status === 'submitted') {
      recordTurnOrigin(live, result.turnId, principalTurnOrigin(opts.principal));
    }
    return toTurnResult(result);
  }

  /**
   * Seam ② of the reverse-delivery path (issue #147): turn a settled teammate
   * turn into a {@link CompletionEnvelope} and hand it to the sink. Reads the
   * teammate's final assistant-visible result via `getLast`. The settle status
   * (completed/failed/stopped) passes through to the envelope verbatim, so a
   * torn-down teammate surfaces with its real status, never silently vanishing
   * and never mislabeled. Reverse
   * delivery requires a stable non-null turn id because the completion id is the
   * idempotency key; builtin runtimes only settle accepted turns after they have
   * a turn id. The settled turn's recorded submission origin rides along so the
   * sink can route per turn (channel-origin TeamLeader turns stay pull-only).
   * Every step is error-isolated: this runs `void`-ed off the
   * synchronous settle callback, so any escape would become an unhandled
   * rejection.
   */
  private async deliverTurnSettled(
    dispatcherId: string,
    name: string,
    identity: TeamMateIdentity,
    runtime: AgentRuntime,
    settled: TurnSettledSignal,
    turnOrigins: ReadonlyMap<string, TeamMateTurnOrigin>,
    sink: NonNullable<TeamMateAgentServiceOptions['onTeamMateCompletion']>,
  ): Promise<void> {
    try {
      if (settled.turnId === null) {
        this.opts.log.warn(
          {
            dispatcher_id: dispatcherId,
            teammate: name,
            status: settled.status,
          },
          'dropping teammate completion: settled turn has no turn id',
        );
        return;
      }
      let result = '';
      try {
        const last = await runtime.getLast();
        result = last?.text ?? '';
      } catch (err) {
        this.opts.log.warn(
          { dispatcher_id: dispatcherId, teammate: name, err: errInfo(err) },
          'teammate completion getLast failed',
        );
      }
      const envelope: CompletionEnvelope = {
        source: name,
        id: `${name}:${settled.turnId}`,
        // Pass the settle status through verbatim — completed/failed/stopped are
        // the CompletionEnvelope statuses too. (Previously stopped was folded
        // into failed; the runtimes now render a distinct "was stopped" line.)
        status: settled.status,
        result,
      };
      await sink(
        dispatcherId,
        identity,
        envelope,
        turnOrigins.get(settled.turnId) ?? null,
      );
    } catch (err) {
      this.opts.log.warn(
        { dispatcher_id: dispatcherId, teammate: name, err: errInfo(err) },
        'teammate completion delivery failed',
      );
    }
  }

  private async mustIdentity(
    dispatcherId: string,
    name: string,
    principal: TeamMateCallerPrincipal = dispatcherPrincipal(dispatcherId),
  ): Promise<TeamMateIdentity> {
    const identity = await this.identities.get(dispatcherId, name);
    if (identity === null) {
      throw new Error(`TeamMate ${JSON.stringify(name)} does not exist`);
    }
    this.assertPrincipalCanAccess(principal, identity);
    return identity;
  }

  private assertPrincipalCanAccess(
    principal: TeamMateCallerPrincipal,
    identity: TeamMateIdentity,
  ): void {
    if (principalCanAccess(principal, identity)) return;
    throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
  }

  private runtimeRow(identity: TeamMateIdentity): DispatcherRow {
    const runtimeIdentity = runtimeIdentityName(identity);
    return {
      dispatcher_id: runtimeId(identity.dispatcher_id, runtimeIdentity),
      bot_app_id: `teammate-${runtimeIdentity}`,
      bot_secret_ref: '',
      thread_id: identity.checkpoint?.id ?? null,
      status: 'declared',
      enabled: 1,
      created_at: identity.created_at,
      updated_at: identity.updated_at,
      last_started_at: null,
      last_ready_at: null,
      last_error: identity.last_error,
      last_lost_thread_id: null,
    };
  }

  /**
   * Per-teammate path context. The teammate runtime dir is the neutral root both
   * built-in runtimes derive their state files from (Codex `codex.sock`, Claude
   * Code `mcp.json`); only the central-tree log files vary by runtime, so the
   * launcher selects them from the resolved provider ref.
   */
  private runtimePaths(
    identity: TeamMateIdentity,
    providerRef: string,
  ): AgentRuntimePathContext {
    const runtimeIdentity = runtimeIdentityName(identity);
    const dispatcherDir = (): string =>
      dispatcherTeamMateRuntimeDir(identity.dispatcher_id, runtimeIdentity);
    if (providerRef === BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
      const streamLog = (): string =>
        teammateClaudeCodeStreamLogPath(
          identity.dispatcher_id,
          runtimeIdentity,
        );
      return {
        dispatcherDir,
        stdoutLogPath: streamLog,
        stderrLogPath: streamLog,
      };
    }
    return {
      dispatcherDir,
      stdoutLogPath: () =>
        teammateCodexAppServerLogPath(
          identity.dispatcher_id,
          runtimeIdentity,
        ),
      stderrLogPath: () =>
        teammateCodexAppServerErrorLogPath(
          identity.dispatcher_id,
          runtimeIdentity,
        ),
    };
  }

  /**
   * The agents[].id a teammate inherits when `spawn` names none: the
   * dispatcher's own `agentRuntime`. There is no provider-ref fallback — a
   * teammate always resolves to a named agent, never a bare provider.
   */
  private defaultAgentRuntime(dispatcherId: string): string {
    const dispatcherCfg = this.dispatcherConfig(dispatcherId);
    if (dispatcherCfg === null) {
      throw new Error(
        `cannot spawn a teammate for unknown dispatcher '${dispatcherId}': ` +
          'no dispatcher config to resolve a default agentRuntime from. Pass an ' +
          'explicit agentRuntime (an agents[].id).',
      );
    }
    return dispatcherCfg.agentRuntime;
  }

  /**
   * Resolve an agents[].id against the live agents map into its
   * { provider, config }. #98 fail-loud: an id with no matching agents[] entry
   * (e.g. removed from config since the teammate was spawned) throws with
   * rebuild guidance rather than silently defaulting a runtime.
   */
  private resolveAgent(
    dispatcherId: string,
    agentRuntimeId: string,
  ): ResolvedAgentConfig {
    const agent = this.opts.config.agents[agentRuntimeId];
    if (agent === undefined) {
      const known = Object.keys(this.opts.config.agents);
      const knownHint =
        known.length > 0
          ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
          : 'No agents are declared.';
      throw new Error(
        `teammate for dispatcher '${dispatcherId}' references agentRuntime ` +
          `'${agentRuntimeId}', which matches no agents[].id. ${knownHint} ` +
          'Add the agent to config and rebuild, or respawn the teammate with a ' +
          'known agent id.',
      );
    }
    return agent;
  }

  private dispatcherConfig(dispatcherId: string): DispatcherConfig | null {
    return (
      this.opts.config.dispatchers.find((entry) => entry.id === dispatcherId) ??
      null
    );
  }

  private toStatus(
    identity: TeamMateIdentity,
    runtime: AgentRuntime | null,
  ): TeamMateRuntimeStatus {
    return {
      name: identity.name,
      role: identity.role,
      team_id: identity.team_id,
      owner: identity.owner,
      agent_runtime: identity.agent_runtime,
      source_cwd: identity.source_cwd,
      source_repo: identity.source_repo,
      cwd: identity.cwd,
      runtime_cwd: identity.runtime_cwd,
      worktree: identity.worktree,
      intent: identity.intent,
      status: identity.status,
      runtime_status: runtime?.getStatus() ?? null,
      checkpoint: identity.checkpoint,
      last_error: identity.last_error,
      closed_at: identity.closed_at,
      close_note: identity.close_note,
    };
  }

  private async toLedgerRow(identity: TeamMateIdentity): Promise<TeamMateLedgerRow> {
    const runtime = this.live.get(liveKey(identity.dispatcher_id, identity.name))?.runtime ?? null;
    const events = await this.identities.history(identity.dispatcher_id, identity.name);
    const lastEvent = events.at(-1);
    const lastPromptEvent = events.findLast(
      (event) => event.prompt_preview !== null,
    );
    return {
      id: identity.name,
      name: identity.name,
      role: identity.role,
      team_id: identity.team_id,
      owner: identity.owner,
      agent_runtime: identity.agent_runtime,
      source_cwd: identity.source_cwd,
      source_repo: identity.source_repo,
      cwd: identity.cwd,
      runtime_cwd: identity.runtime_cwd,
      worktree: identity.worktree,
      created_at: identity.created_at,
      updated_at: identity.updated_at,
      last_seen_at: lastEvent?.timestamp ?? identity.updated_at,
      state: identity.status,
      status: identity.status,
      runtime_status: runtime?.getStatus() ?? null,
      checkpoint: identity.checkpoint,
      intent: identity.intent,
      close_status: identity.closed_at === null ? 'open' : 'closed',
      closed_at: identity.closed_at,
      close_note: identity.close_note,
      close_note_preview:
        identity.close_note !== null ? previewText(identity.close_note) : null,
      last_prompt_preview: lastPromptEvent?.prompt_preview ?? null,
      last_assistant_preview: null,
      cleanup_state: identity.worktree.cleanup_state,
      resume:
        identity.closed_at === null || identity.checkpoint !== null
          ? { tool: 'send', name: identity.name, checkpoint: identity.checkpoint }
          : null,
    };
  }

  private matchesLedgerQuery(
    row: TeamMateLedgerRow,
    input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'principal'>,
  ): boolean {
    if (input.name !== undefined && row.name !== validateTeamMateName(input.name)) {
      return false;
    }
    if (input.id !== undefined && !row.id.startsWith(input.id)) return false;
    if (
      input.agentRuntime !== undefined &&
      row.agent_runtime !== input.agentRuntime
    ) {
      return false;
    }
    if (input.sourceCwd !== undefined && row.source_cwd !== input.sourceCwd) {
      return false;
    }
    if (input.runtimeCwd !== undefined && row.runtime_cwd !== input.runtimeCwd) {
      return false;
    }
    if (input.state !== undefined) {
      if (input.state === 'active') {
        if (row.state === 'closed' || row.state === 'stopped') return false;
      } else if (row.state !== input.state) {
        return false;
      }
    }
    if (
      input.closeStatus !== undefined &&
      row.close_status !== input.closeStatus
    ) {
      return false;
    }
    if (input.grep !== undefined && !ledgerRowMatchesText(row, input.grep)) {
      return false;
    }
    return true;
  }

  private async assertManagedWorktreeAvailable(
    dispatcherId: string,
    name: string,
    worktree: TeamMateIdentity['worktree'],
  ): Promise<void> {
    if (worktree.mode !== 'managed') return;
    const identities = await this.identities.list(dispatcherId);
    const collision = identities.find(
      (identity) =>
        identity.name !== name &&
        identity.worktree.mode === 'managed' &&
        identity.worktree.path === worktree.path,
    );
    if (collision !== undefined) {
      throw new Error(
        `managed worktree path ${JSON.stringify(worktree.path)} is already ` +
          `owned by TeamMate ${JSON.stringify(collision.name)}`,
      );
    }
  }

  private agentRuntimeCapability(
    agentRuntimeId: string,
    agent: ResolvedAgentConfig,
  ): TeamMateAgentRuntimeCapability {
    let capabilities: AgentRuntimeCapabilities | null = null;
    let unsupportedReason: string | null = null;
    try {
      capabilities = this.opts.agentRuntimeProviders
        .resolve(agent.provider)
        .getCapabilities();
    } catch (err) {
      unsupportedReason = err instanceof Error ? err.message : String(err);
    }
    return {
      id: agentRuntimeId,
      spawn: { agent_runtime: agentRuntimeId },
      runtime_available: capabilities !== null,
      resume: capabilities?.resume ?? { supported: false },
      steer: capabilities?.steer ?? { supported: false },
      events: capabilities?.events ?? { kind: 'synthesized' },
      last: capabilities?.last ?? { supported: false },
      context: capabilities?.context ?? { supported: false },
      unsupported_reason: unsupportedReason,
    };
  }
}

/**
 * A minimal {@link DispatcherConfig} skeleton for the create-context when no
 * matching dispatcher config exists (the teammate was spawned for an id with no
 * declared dispatcher). The runtime block is overwritten by the caller with the
 * teammate's resolved agent; only the neutral fields matter here.
 */
function syntheticDispatcherConfig(dispatcherId: string): DispatcherConfig {
  return {
    id: dispatcherId,
    cwd: null,
    enabled: true,
    channels: [],
    agentRuntime: '',
    runtime: { provider: '', config: {} },
  };
}

function toTurnResult(result: AgentRuntimeTurnResult): TeamMateTurnResult {
  switch (result.status) {
    case 'submitted':
      return { status: 'submitted', turn_id: result.turnId };
    case 'duplicate':
    case 'stopped':
      return { status: result.status };
    case 'failed':
      return { status: 'failed', error: result.error.message };
    case 'skipped':
      return { status: 'stopped', error: 'turn skipped' };
  }
}

/**
 * The completion origin a submitting principal implies: a TeamLeader-submitted
 * turn (member spawn/send) answers to that leader; everything else — including
 * the principal-less `createTeamLeader` bootstrap prompt — answers to the
 * dispatcher. Channel-delivered turns never come through here; they are
 * recorded as `channel` at the `channelInputScoped` seam.
 */
function principalTurnOrigin(
  principal: TeamMateCallerPrincipal | undefined,
): TeamMateTurnOrigin {
  return principal?.kind === 'team_leader' ? 'team_leader' : 'dispatcher';
}

function recordTurnOrigin(
  live: LiveTeamMate,
  turnId: string,
  origin: TeamMateTurnOrigin,
): void {
  // First-writer-wins: a send steered into an already-active turn must not
  // re-target the completion of the turn that absorbed it.
  if (live.turnOrigins.has(turnId)) return;
  live.turnOrigins.set(turnId, origin);
  while (live.turnOrigins.size > TURN_ORIGIN_CACHE_LIMIT) {
    const oldest = live.turnOrigins.keys().next().value;
    if (oldest === undefined) break;
    live.turnOrigins.delete(oldest);
  }
}

function ownerForPrincipal(principal: TeamMateCallerPrincipal): TeamMateIdentity['owner'] {
  if (principal.kind === 'team_leader') {
    return {
      kind: 'team',
      dispatcher_id: principal.dispatcherId,
      team_id: principal.teamId,
      leader_name: principal.leaderName,
    };
  }
  return { kind: 'dispatcher', dispatcher_id: principal.dispatcherId };
}

function principalCanAccess(
  principal: TeamMateCallerPrincipal,
  identity: TeamMateIdentity,
): boolean {
  if (principal.kind === 'dispatcher') {
    return (
      identity.dispatcher_id === principal.dispatcherId &&
      identity.owner.kind === 'dispatcher'
    );
  }
  if (principal.kind === 'team_leader') {
    return (
      identity.dispatcher_id === principal.dispatcherId &&
      identity.owner.kind === 'team' &&
      identity.owner.team_id === principal.teamId &&
      identity.role === 'team_member'
    );
  }
  return false;
}

function clampHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed['offset'] === 'number' &&
      Number.isInteger(parsed['offset']) &&
      parsed['offset'] >= 0
    ) {
      return parsed['offset'];
    }
  } catch {
    // fall through
  }
  throw new Error('invalid history cursor');
}

function ledgerRowMatchesText(row: TeamMateLedgerRow, grep: string): boolean {
  const needle = grep.trim().toLowerCase();
  if (needle === '') return true;
  return [
    row.id,
    row.name,
    row.agent_runtime,
    row.source_cwd,
    row.source_repo,
    row.cwd,
    row.runtime_cwd,
    row.worktree.slug,
    row.worktree.branch,
    row.worktree.base_ref,
    row.intent,
    row.close_note,
    row.last_prompt_preview,
    row.last_assistant_preview,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

function liveKey(dispatcherId: string, name: string): string {
  return `${dispatcherId}\u0000${name}`;
}

function runtimeId(dispatcherId: string, name: string): string {
  const suffix = createHash('sha256')
    .update(`${dispatcherId}\u0000${name}`)
    .digest('hex')
    .slice(0, 12);
  const prefix = dispatcherId.slice(0, 40);
  return validateDispatcherId(`${prefix}.tm.${suffix}`, 'teammate runtime id');
}

function runtimeIdentityName(identity: TeamMateIdentity): string {
  return identity.owner.kind === 'team'
    ? `${identity.owner.team_id}.${identity.name}`
    : identity.name;
}

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
