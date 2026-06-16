import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type {
  AgentRuntime,
  AgentRuntimeTurnResult,
  AgentRuntimeMcpServer,
  CompletionEnvelope,
} from '@excitedjs/dreamux-types';
import type { DreamuxConfig } from '../../config/config.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { ownerForPrincipal } from './access.js';
import {
  agentRuntimeCapability,
  defaultAgentRuntime,
  resolveAgent,
} from './agent-config.js';
import { deliverTeamMateTurnSettled } from './completion-delivery.js';
import { TeamMateIdentityStore } from './identity-store.js';
import {
  type LiveTeamMate,
  type LiveTeamMateSettledInput,
  LiveTeamMateRegistry,
  recordTurnOrigin,
} from './live-runtime.js';
import { TeammateReadModel } from './read-model.js';
import { TeamMateTurnsStore } from './turns-store.js';
import { allocateConcreteName, type SuffixGenerator } from './name-allocator.js';
import {
  principalTurnOrigin,
  recordSettledTurn,
  recordSubmittedTurn,
  toTurnResult,
} from './turn-recording.js';
import {
  assertManagedWorktreeAvailable,
  dispatcherWorkspace,
  reprepareDeletedManagedWorktree,
  resolveSpawnWorkspace,
} from './workspaces.js';
import { WorktreeManager } from './worktree-manager.js';
import {
  requireLifecycleText,
  validateTeamMateName,
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type SpawnTeamMateInput,
  type TeamMateCapabilities,
  type TeamMateCallerPrincipal,
  type TeamMateCloseResult,
  type CreateTeamLeaderInput,
  type TeamMateHistoryQuery,
  type TeamMateHistoryResult,
  type TeamMateIdentity,
  type TeamMateLastResult,
  type TeamMateRole,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateSpawnResult,
  type TeamMateTurnOrigin,
  type TeamMateTurnResult,
  type TeamMateWorktreeIdentity,
  type TeamMateWorktreeRequest,
  dispatcherPrincipal,
  principalDispatcherId,
  teamServicePrincipal,
} from './types.js';

export interface TeamMateAgentServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
  /** Reverse-delivery sink for terminal teammate turns (issue #147). */
  onTeamMateCompletion?: (
    dispatcherId: string,
    identity: TeamMateIdentity,
    completion: CompletionEnvelope,
    /** Submission origin, or `null` when this process never recorded the turn id. */
    origin: TeamMateTurnOrigin | null,
  ) => void | Promise<void>;
  /**
   * Test seam (issue #188): override the random suffix generator used by
   * concrete-name allocation so collisions and exhaustion are reproducible.
   * Production leaves this unset and uses the CSPRNG default.
   */
  suffixGenerator?: SuffixGenerator;
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
  /** Required recovery subject (issue #182 PR-3). */
  intent: string;
}

export interface ScopedSendTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  prompt: string;
  /** Optional updated recovery subject, applied before the turn (issue #182 PR-3). */
  intent?: string;
}

export interface ScopedCloseTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  /** Required close reason (issue #182 PR-3). */
  note: string;
}

export class TeamMateAgentService {
  private readonly identities: TeamMateIdentityStore;
  private readonly turnsStore: TeamMateTurnsStore;
  private readonly readModel: TeammateReadModel;
  private readonly runtimes: LiveTeamMateRegistry;
  private readonly worktrees = new WorktreeManager();
  private submissionSeq = 0;
  /**
   * In-flight best-effort settled-turn captures (issue #209 slice 6 repair). The
   * settle hook fires `deliverTurnSettled` fire-and-forget so it never perturbs
   * the settle path, but its durable record/turns writes (atomic temp+rename)
   * would otherwise outlive `stopAll()` and race teardown. Tracking the promises
   * here lets shutdown drain them, so a caller that awaits `stopAll()` observes
   * no still-pending writes.
   */
  private readonly inFlightSettleCaptures = new Set<Promise<void>>();

  constructor(private readonly opts: TeamMateAgentServiceOptions) {
    // The stores' log option is the neutral logger's `warn` (fields-first), so
    // the host logger is handed through directly.
    this.identities = new TeamMateIdentityStore({ warn: opts.log.warn.bind(opts.log) });
    this.turnsStore = new TeamMateTurnsStore({ warn: opts.log.warn.bind(opts.log) });
    this.runtimes = new LiveTeamMateRegistry({
      identities: this.identities,
      log: opts.log,
      ...(opts.mcpServersForTeamMate !== undefined
        ? { mcpServersForTeamMate: opts.mcpServersForTeamMate }
        : {}),
    });
    this.readModel = new TeammateReadModel({
      identities: this.identities,
      turnsStore: this.turnsStore,
      runtimeFor: (dispatcherId, name) =>
        this.runtimes.getRuntime(dispatcherId, name),
    });
  }

  /**
   * Read-only access to the per-name turns archive (issue #199 Slice 3),
   * exposed so tests and recovery tooling can stream a teammate's turn rows.
   */
  turns(): TeamMateTurnsStore {
    return this.turnsStore;
  }

  /**
   * Allocate a concrete, never-reused TeamLeader name for a team (issue #188).
   * The Team service calls this once at create time and persists the result as
   * the team's durable `leader_name`; routing reads that stored name rather
   * than reconstructing `${teamId}-leader`.
   */
  async allocateLeaderName(dispatcherId: string, teamId: string): Promise<string> {
    return this.allocateName(dispatcherId, 'team_leader', teamId, teamId);
  }

  /**
   * Allocate a concrete name from an agent-supplied base slug (issue #188).
   * Uniqueness is checked against ALL persisted identities (closed included),
   * so a concrete name is never reused; the suffix is regenerated on collision
   * and the allocation fails loudly if the attempt budget is exhausted.
   */
  private async allocateName(
    dispatcherId: string,
    role: TeamMateRole,
    base: string,
    teamSlug?: string,
  ): Promise<string> {
    const identities = await this.identities.list(dispatcherId);
    const taken = new Set(identities.map((identity) => identity.name));
    return allocateConcreteName({
      role,
      base,
      ...(teamSlug !== undefined ? { teamSlug } : {}),
      exists: (candidate) => taken.has(candidate),
      ...(this.opts.suffixGenerator !== undefined
        ? { generateSuffix: this.opts.suffixGenerator }
        : {}),
    });
  }

  async spawn(input: SpawnTeamMateInput): Promise<TeamMateSpawnResult> {
    return this.spawnScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      prompt: input.prompt,
      intent: input.intent,
      ...(input.agentRuntime !== undefined ? { agentRuntime: input.agentRuntime } : {}),
      cwd: input.cwd,
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    });
  }

  async spawnScoped(input: ScopedSpawnTeamMateInput): Promise<TeamMateSpawnResult> {
    const dispatcherId = principalDispatcherId(input.principal);
    if (input.principal.kind === 'teammate') {
      throw new Error('ordinary TeamMates cannot spawn TeamMates');
    }
    // The agent-supplied `name` is a base slug / display hint, not the final
    // address (issue #188): require it non-empty, then allocate a concrete,
    // never-reused name below and return it in the spawn result.
    const requestedName = requireLifecycleText(input.name, 'TeamMate spawn name');
    // Required recovery subject — enforced here too for in-process callers that
    // bypass the MCP shim / admin layer (issue #182 PR-3).
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    if (input.principal.kind === 'team_leader' && input.sharedWorkspace === undefined) {
      throw new Error('TeamLeader member spawn requires a shared team workspace');
    }
    const owner = ownerForPrincipal(input.principal);
    const role: TeamMateRole =
      input.principal.kind === 'team_leader' ? 'team_member' : 'teammate';
    // Allocate the concrete address from the requested slug (Team members get
    // the `tm-` rule). Checked against all persisted identities, never reused.
    const name = await this.allocateName(dispatcherId, role, requestedName);
    const agentRuntimeId =
      input.agentRuntime ?? defaultAgentRuntime(this.opts.config, dispatcherId);
    const agent = resolveAgent(this.opts.config, dispatcherId, agentRuntimeId);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    const workspace = await resolveSpawnWorkspace({
      config: this.opts.config,
      worktrees: this.worktrees,
      dispatcherId,
      name,
      request: input,
    });
    if (input.sharedWorkspace === undefined) {
      await assertManagedWorktreeAvailable({
        identities: this.identities,
        dispatcherId,
        name,
        worktree: workspace.worktree,
      });
    }
    // #199 Slice 3: no Dreamux-minted session id — session_id is the
    // runtime-native thread id, set when the runtime reports one. The concrete
    // name is fresh, so this is always a create (issue #188).
    let identity = await this.identities.create({
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
      intent: input.intent,
      status: 'starting',
    });
    this.readModel.assertPrincipalCanAccess(input.principal, identity);
    const live = await this.runtimes.start({
      dispatcherId,
      identity,
      provider,
      agent,
      ...(this.opts.onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled) =>
              this.captureSettledTurn(dispatcherId, identity, settled),
          }
        : {}),
    });
    identity = live.state.current();
    const turn = await this.submitPrompt(dispatcherId, name, input.prompt, {
      principal: input.principal,
    });
    await recordSubmittedTurn(this.turnsStore, dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: principalTurnOrigin(input.principal),
      prompt: input.prompt,
    });
    return { teammate: this.readModel.toStatus(live.state.current(), live.runtime), turn };
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    return this.sendScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
    });
  }

  async sendScoped(input: ScopedSendTeamMateInput): Promise<TeamMateSendResult> {
    // send subsumes the former `resume` verb (issue #155): a teammate that is
    // not live — including one previously `close`d — is reopened from its
    // persisted checkpoint and the turn is submitted, so send always works as
    // long as the identity exists. reopenClosed scopes this revival to send;
    // read-only verbs (last/status) never silently reopen a closed teammate.
    const dispatcherId = principalDispatcherId(input.principal);
    const live = await this.ensureRuntime(dispatcherId, input.name, {
      principal: input.principal,
      reopenClosed: true,
    });
    // Optional intent update is applied BEFORE the turn so the recorded recovery
    // subject reflects the work this turn is about (issue #182 PR-3). An empty
    // string is ignored so a stray send never wipes a meaningful subject.
    if (input.intent !== undefined && input.intent !== '') {
      await live.state.updateIntent(input.intent);
    }
    const turn = await this.submitPrompt(dispatcherId, input.name, input.prompt, {
      principal: input.principal,
    });
    await recordSubmittedTurn(this.turnsStore, dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: principalTurnOrigin(input.principal),
      prompt: input.prompt,
    });
    return { teammate: this.readModel.toStatus(live.state.current(), live.runtime), turn };
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    return this.closeScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      note: input.note,
    });
  }

  async closeScoped(input: ScopedCloseTeamMateInput): Promise<TeamMateCloseResult> {
    const dispatcherId = principalDispatcherId(input.principal);
    const name = validateTeamMateName(input.name);
    const identity = await this.readModel.mustIdentity(
      dispatcherId,
      name,
      input.principal,
    );
    // Required close reason — enforced for in-process callers too (issue #182
    // PR-3); the Team dissolve path supplies an explicit note. Checked after the
    // existence/access lookup so an inaccessible teammate reports that first.
    requireLifecycleText(input.note, 'TeamMate close note');
    const live = this.runtimes.get(dispatcherId, name);
    if (live !== undefined) {
      await live.runtime.stop();
      this.runtimes.delete(dispatcherId, name);
    }
    // #199 Slice 3: the close note and updated_at land on the record; history
    // reads the record directly (no separate close event), and the record stays
    // searchable/recoverable after close. No turns row is written for a close.
    const closed = await this.identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      lastSeenAt: Date.now(),
      worktree: await this.worktrees.cleanup(identity),
    });
    return { teammate: this.readModel.toStatus(closed, null) };
  }

  async list(dispatcherId: string): Promise<TeamMateRuntimeStatus[]> {
    return this.readModel.list(dispatcherId);
  }

  async listScoped(principal: TeamMateCallerPrincipal): Promise<TeamMateRuntimeStatus[]> {
    return this.readModel.listScoped(principal);
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
    return this.readModel.statusScoped(principal, name);
  }

  async history(input: TeamMateHistoryQuery): Promise<TeamMateHistoryResult> {
    return this.readModel.history(input);
  }

  async historyScoped(
    input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'principal'> & {
      principal: TeamMateCallerPrincipal;
    },
  ): Promise<TeamMateHistoryResult> {
    return this.readModel.historyScoped(input);
  }

  async last(
    dispatcherId: string,
    name: string,
    turns?: number,
  ): Promise<TeamMateLastResult> {
    return this.lastScoped(dispatcherPrincipal(dispatcherId), name, turns);
  }

  /**
   * Read a closed-or-live teammate's most recent settled turn(s) from the
   * per-name turns archive (issue #199 Slice 3). This is a pure read: it reads
   * the RECORD first (existence / scope / common fields), then folds
   * `turns/<name>.jsonl` — it NEVER starts, resumes, or requires a live runtime,
   * so it works after a teammate is closed or stopped. `turns` defaults to 1 and
   * is clamped-by-rejection to 1..5; the newest turn is `turns.at(-1)`. This is
   * the failed-completion-delivery fallback, so it returns the assistant output
   * as completely as it was durably captured (truncation is flagged).
   */
  async lastScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
    turns?: number,
  ): Promise<TeamMateLastResult> {
    return this.readModel.lastScoped(principal, name, turns);
  }

  async channelInputScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
    input: import('@excitedjs/dreamux-types').InboundTurnInput,
  ): Promise<AgentRuntimeTurnResult> {
    const dispatcherId = principalDispatcherId(principal);
    const live = await this.ensureRuntime(dispatcherId, name, {
      principal,
      reopenClosed: true,
    });
    const result = await live.runtime.channelInput(input);
    if (result.status === 'submitted') {
      recordTurnOrigin(live, result.turnId, 'channel');
      // Capture the channel-origin turn (issue #182 PR-5, PR #187 review P1): a
      // TeamLeader's normal user turns arrive through a bound Team channel here,
      // not via send, and would otherwise be missing from the turns archive.
      await recordSubmittedTurn(this.turnsStore, dispatcherId, live, {
        turnId: result.turnId,
        turnOrigin: 'channel',
        prompt: input.text,
      });
    }
    return result;
  }

  async createTeamLeader(input: CreateTeamLeaderInput): Promise<TeamMateSpawnResult> {
    const name = validateTeamMateName(input.name);
    // #188: a concrete name is never reused — the duplicate check includes closed
    // identities. The caller (TeamService) always passes a freshly allocated `tl-`
    // name, so a pre-existing identity under this name (closed OR live) means a
    // collision or a misuse of this seam; fail loud rather than rebinding the
    // name to a new session (which would map one concrete name to >1 session).
    const existing = await this.identities.get(input.dispatcherId, name);
    if (existing !== null) {
      throw new Error(`TeamLeader ${JSON.stringify(name)} already exists`);
    }
    const agent = resolveAgent(
      this.opts.config,
      input.dispatcherId,
      input.agentRuntime,
    );
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    const owner: TeamMateIdentity['owner'] = {
      kind: 'dispatcher',
      dispatcher_id: input.dispatcherId,
    };
    // #199 Slice 3: session_id is the runtime-native thread id, set when the
    // runtime reports one. The name is freshly allocated — always a create.
    let identity = await this.identities.create({
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
      status: 'starting',
    });
    const live = await this.runtimes.start({
      dispatcherId: input.dispatcherId,
      identity,
      provider,
      agent,
      ...(this.opts.onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled) =>
              this.captureSettledTurn(input.dispatcherId, identity, settled),
          }
        : {}),
    });
    identity = live.state.current();
    // The TeamLeader is not reachable through the public dispatcher principal
    // (issue #199 Slice 4); the bootstrap turn submits under the internal
    // Team-service authority over this leader.
    const turn = await this.submitPrompt(input.dispatcherId, name, input.prompt, {
      principal: teamServicePrincipal({
        dispatcherId: input.dispatcherId,
        teamId: input.teamId,
        leaderName: name,
      }),
    });
    await recordSubmittedTurn(this.turnsStore, input.dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: 'dispatcher',
      prompt: input.prompt,
    });
    return { teammate: this.readModel.toStatus(live.state.current(), live.runtime), turn };
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
        'get_capabilities',
      ],
      agent_runtimes: Object.entries(this.opts.config.agents).map(
        ([agentRuntimeId, agent]) =>
          agentRuntimeCapability(
            this.opts.agentRuntimeProviders,
            agentRuntimeId,
            agent,
          ),
      ),
    };
  }

  async stopAll(): Promise<void> {
    await this.runtimes.stopAll();
    // Drain any best-effort settled-turn captures dispatched before/at stop so a
    // caller awaiting shutdown sees no still-pending durable writes racing
    // teardown (issue #209 slice 6 repair). A capture may enqueue another while
    // we await (a settle landing during stop), so loop until quiescent. Captures
    // self-isolate errors, so allSettled never throws.
    while (this.inFlightSettleCaptures.size > 0) {
      await Promise.allSettled([...this.inFlightSettleCaptures]);
    }
  }

  getLiveRuntime(dispatcherId: string, name: string): AgentRuntime | null {
    return this.runtimes.getRuntime(dispatcherId, validateTeamMateName(name));
  }

  private async ensureRuntime(
    dispatcherId: string,
    name: string,
    opts: { principal?: TeamMateCallerPrincipal; reopenClosed?: boolean } = {},
  ): Promise<LiveTeamMate> {
    const teammateName = validateTeamMateName(name);
    const existing = this.runtimes.get(dispatcherId, teammateName);
    if (existing !== undefined) {
      this.readModel.assertPrincipalCanAccess(
        opts.principal ?? dispatcherPrincipal(dispatcherId),
        existing.state.current(),
      );
      return existing;
    }
    let identity = await this.readModel.mustIdentity(
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
      identity = await reprepareDeletedManagedWorktree({
        config: this.opts.config,
        identities: this.identities,
        worktrees: this.worktrees,
        identity,
      });
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
    const agent = resolveAgent(
      this.opts.config,
      dispatcherId,
      identity.agent_runtime,
    );
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    return this.runtimes.start({
      dispatcherId,
      identity,
      provider,
      agent,
      ...(this.opts.onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled) =>
              this.captureSettledTurn(dispatcherId, identity, settled),
          }
        : {}),
    });
  }

  private captureSettledTurn(
    dispatcherId: string,
    identity: TeamMateIdentity,
    settled: LiveTeamMateSettledInput,
  ): void {
    const sink = this.opts.onTeamMateCompletion;
    if (sink === undefined) return;
    const capture = deliverTeamMateTurnSettled({
      dispatcherId,
      name: identity.name,
      identity,
      runtime: settled.runtime,
      settled: settled.settled,
      turnOrigins: settled.turnOrigins,
      sink,
      log: this.opts.log,
      recordSettledTurn: (input) =>
        recordSettledTurn(
          this.turnsStore,
          dispatcherId,
          identity.name,
          settled.state,
          input,
        ),
    });
    this.inFlightSettleCaptures.add(capture);
    void capture.finally(() => {
      this.inFlightSettleCaptures.delete(capture);
    });
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
   * Resolve and validate the dispatcher workspace cwd (issue #182 PR-4): the
   * root under which managed worktrees are placed. Fails loud when the
   * dispatcher declares no explicit `cwd` — there is no state-dir fallback.
   * Exposed so the Team service (which owns its own WorktreeManager) resolves
   * the same workspace.
   */
  async dispatcherWorkspace(dispatcherId: string): Promise<string> {
    return dispatcherWorkspace(this.opts.config, dispatcherId);
  }
}
