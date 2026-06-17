import { Buffer } from 'node:buffer';

import type { ChannelTarget, InboundTurnInput } from '@excitedjs/dreamux-types';

import type { WorktreeManager } from '../teammate/worktree-manager.js';
import type {
  SpawnTeamMateRequest,
  TeammateCollection,
  TeamMateSharedWorkspace,
} from '../teammate/service.js';
import type { TeammateService } from '../teammate/teammate-service.js';
import { requireLifecycleText } from '../teammate/types.js';
import type { ChannelBindingStore } from '../channel-binding/store.js';
import type { ChannelBinding } from '../channel-binding/store.js';
import { TeamStore } from './store.js';
import type {
  TeamChannelBindingSummary,
  TeamCreateInput,
  TeamCreateResult,
  TeamDissolveInput,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamHistoryRow,
  TeamListRow,
  TeamRecord,
  TeamSummary,
  TeamTransferChannelBackInput,
  TeamView,
} from './types.js';
import { validateTeamId } from './types.js';
import type {
  CloseTeamMateInput,
  SendTeamMateInput,
  TeamMateHistoryQuery,
  TeamMateIdentityStatus,
  TeamMateRuntimeStatus,
} from '../teammate/types.js';

/**
 * The narrow dispatcher seam a {@link TeamService} needs for channel-bound
 * operations, kept as an interface so the Team layer never imports the whole
 * `DispatcherService` (breaks the construction cycle). `DispatcherService`
 * implements it.
 */
export interface TeamChannelContext {
  resolveChannelId(requested?: string): string;
  channelProviderRef(channelId: string): string;
  resolveChannelTarget(meta: unknown, channelId?: string): Promise<ChannelTarget>;
}

export interface TeamCollectionOptions {
  /** The dispatcher this collection belongs to (issue #233 ownership sinking). */
  dispatcherId: string;
  teammates: TeammateCollection;
  /** The per-dispatcher worktree manager, shared with the teammate collection. */
  worktrees: WorktreeManager;
  /** The per-dispatcher channel-binding store, owned by `DispatcherService`. */
  bindings: ChannelBindingStore;
}

/**
 * The dispatcher's team collection (issue #233): one instance per dispatcher,
 * owned by `DispatcherService`. It owns the team store and holds the
 * per-dispatcher channel-binding store and worktree manager, and exposes
 * `create` / `list` / `history` plus channel resolution that runs before a team
 * is known (`resolveChannel` / `transferChannelBack`). Per-team domain operations
 * live on {@link TeamService}, returned fresh from `get` so a held record never
 * goes stale after a dissolve. The dispatcher id is baked in, not threaded per
 * call.
 */
export class TeamCollection {
  private readonly dispatcherId: string;
  private readonly store = new TeamStore();
  private readonly worktrees: WorktreeManager;
  private readonly bindings: ChannelBindingStore;
  /** In-flight `create` calls keyed by team id, so concurrent same-id creates
   * share one result instead of double-writing the record / double-spawning the
   * leader (issue #233; `create` is otherwise a check-then-write). */
  private readonly creating = new Map<string, Promise<TeamCreateResult>>();

  constructor(private readonly opts: TeamCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.worktrees = opts.worktrees;
    this.bindings = opts.bindings;
  }

  async create(input: TeamCreateInput): Promise<TeamCreateResult> {
    const teamId = validateTeamId(input.name);
    const inFlight = this.creating.get(teamId);
    if (inFlight !== undefined) return inFlight;
    const promise = this.doCreate(input).finally(() => {
      this.creating.delete(teamId);
    });
    this.creating.set(teamId, promise);
    return promise;
  }

  private async doCreate(input: TeamCreateInput): Promise<TeamCreateResult> {
    requireLifecycleText(input.intent, 'Team create intent');
    const teamId = validateTeamId(input.name);
    const existing = await this.store.get(this.dispatcherId, teamId);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`Team ${JSON.stringify(teamId)} already exists`);
    }
    const dispatcherWorkspace = await this.opts.teammates.dispatcherWorkspace();
    const workspace =
      input.worktree === undefined && input.repoCwd === undefined
        ? await this.worktrees.prepareDefaultWorkspace({
            dispatcherWorkspace,
            slug: teamId,
          })
        : await this.worktrees.prepare({
            dispatcherId: this.dispatcherId,
            teammateName: `team-${teamId}`,
            cwd: input.repoCwd ?? dispatcherWorkspace,
            dispatcherWorkspace,
            request: input.worktree ?? {
              mode: 'managed',
              slug: `team-${teamId}`,
              cleanup: 'keep',
            },
          });
    const leaderName = await this.opts.teammates.allocateLeaderName(teamId);
    let team =
      existing ??
      (await this.store.create({
        dispatcher_id: this.dispatcherId,
        team_id: teamId,
        name: input.name,
        repo_cwd: workspace.sourceCwd,
        source_repo: workspace.sourceRepo,
        leader_name: leaderName,
        leader_agent_runtime: input.leaderAgentRuntime,
        runtime_cwd: workspace.runtimeCwd,
        worktree: workspace.worktree,
        status: 'starting',
        intent: input.intent,
        closed_at: null,
        close_note: null,
      }));
    team = await this.store.update(team, {
      status: 'starting',
      closedAt: null,
      closeNote: null,
      worktree: workspace.worktree,
      intent: input.intent,
      leaderName,
    });
    const prompt = input.prompt ?? teamLeaderPrompt(team);
    const { result } = await this.opts.teammates.createTeamLeader({
      teamId,
      name: leaderName,
      prompt,
      agentRuntime: input.leaderAgentRuntime,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent,
    });
    team = await this.store.update(team, { status: 'running' });
    return {
      team: teamView(team),
      leader: result.teammate,
      member_count: await this.memberCount(team),
      binding: null,
      turn: result.turn,
    };
  }

  async list(): Promise<TeamListRow[]> {
    const teams = await this.store.list(this.dispatcherId);
    const out: TeamListRow[] = [];
    for (const team of teams) out.push(await this.listRow(team));
    return out;
  }

  async history(input: TeamHistoryQuery): Promise<TeamHistoryResult> {
    const teams = await this.store.list(this.dispatcherId);
    const rows: TeamHistoryRow[] = [];
    for (const team of teams) {
      const row = await this.historyRow(team);
      if (matchesTeamHistoryQuery(row, input)) rows.push(row);
    }
    rows.sort(
      (a, b) =>
        b.updated_at - a.updated_at ||
        b.created_at - a.created_at ||
        a.team_name.localeCompare(b.team_name),
    );
    const start = input.cursor !== undefined ? decodeTeamCursor(input.cursor) : 0;
    const limit = clampTeamHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeTeamCursor(next) : null,
    };
  }

  /** Load a team's record and return its single-entity service, or throw. */
  async get(teamId: string): Promise<TeamService> {
    const record = await this.mustTeam(teamId);
    return this.serviceFor(record);
  }

  /** A team's leader as its contained {@link TeammateService} (issue #233 Phase 4). */
  private async leaderFor(record: TeamRecord) {
    return this.opts.teammates.leader(record.team_id, record.leader_name);
  }

  async resolveChannel(input: {
    channelId: string;
    targetKey: string;
  }): Promise<ChannelBinding | null> {
    const binding = await this.bindings.resolve({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      targetKey: input.targetKey,
    });
    if (binding === null) return null;
    const team = await this.store.get(this.dispatcherId, binding.team_name);
    if (team === null || team.status === 'closed') return null;
    return binding;
  }

  async transferChannelBack(
    input: TeamTransferChannelBackInput,
  ): Promise<ChannelBinding | null> {
    return this.bindings.transferBack({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      targetKey: input.targetKey,
    });
  }

  private async serviceFor(record: TeamRecord): Promise<TeamService> {
    return new TeamService({
      record,
      leader: await this.leaderFor(record),
      store: this.store,
      bindings: this.bindings,
      worktrees: this.worktrees,
      teammates: this.opts.teammates,
    });
  }

  private async listRow(team: TeamRecord): Promise<TeamListRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      bound_group: await this.activeGroupBinding(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
    };
  }

  private async historyRow(team: TeamRecord): Promise<TeamHistoryRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_agent_runtime: team.leader_agent_runtime,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      bound_group: await this.activeGroupBinding(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
      close_note: team.close_note,
      close_note_preview:
        team.close_note !== null ? previewTeamText(team.close_note) : null,
    };
  }

  private async leaderState(
    team: TeamRecord,
  ): Promise<TeamMateIdentityStatus | null> {
    const leader = await this.opts.teammates
      .status(team.leader_name, team.team_id)
      .catch(() => null);
    return leader?.status ?? null;
  }

  private async activeGroupBinding(
    team: TeamRecord,
  ): Promise<TeamChannelBindingSummary | null> {
    const bindings = await this.bindings.list(this.dispatcherId);
    const active = bindings.find(
      (binding) => binding.active && binding.team_name === team.team_id,
    );
    if (active === undefined) return null;
    const chatId = active.meta['chat_id'];
    return {
      provider: active.provider,
      chat_id: typeof chatId === 'string' ? chatId : active.target_key,
    };
  }

  private async memberCount(team: TeamRecord): Promise<number> {
    // `list(teamId)` is members-only (the leader lives at the team root), so no
    // leader filter is needed (issue #233 Phase 4).
    return (await this.opts.teammates.list(team.team_id)).length;
  }

  private async mustTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(this.dispatcherId, validateTeamId(teamId));
    if (team === null) {
      throw new Error(`Team ${JSON.stringify(teamId)} does not exist`);
    }
    return team;
  }
}

export interface TeamServiceOptions {
  record: TeamRecord;
  /** The team's leader, a contained {@link TeammateService} (issue #233 Phase 4). */
  leader: TeammateService;
  store: TeamStore;
  bindings: ChannelBindingStore;
  worktrees: WorktreeManager;
  teammates: TeammateCollection;
}

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link TeammateService} (Phase 4 — same entity/runtime/turn recording as
 * a regular member, only at the team root), plus the dispatcher-owned stores it
 * needs. It exposes the per-team domain operations (`status` / `dissolve` /
 * `bindChannel` / `deliverToLeader` / `sharedWorkspace`) and the teammate forwards
 * the admin `team_leader` target calls. The leader's identity/turn operations go
 * through that held entity; member listing scans only the team's `teammate/`
 * collection (the leader is never a member row). Channel-bound operations run
 * through an injected {@link TeamChannelContext}.
 */
export class TeamService {
  private record: TeamRecord;
  readonly id: string;
  readonly leader: TeammateService;

  constructor(private readonly opts: TeamServiceOptions) {
    this.record = opts.record;
    this.id = opts.record.team_id;
    this.leader = opts.leader;
  }

  get dispatcherId(): string {
    return this.record.dispatcher_id;
  }

  get leaderName(): string {
    return this.record.leader_name;
  }

  async status(): Promise<TeamSummary> {
    return {
      team: teamView(this.record),
      leader: this.leader.status(),
      member_count: await this.memberCount(),
      binding: await this.activeGroupBinding(),
    };
  }

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
    requireLifecycleText(input.note, 'Team dissolve note');
    for (const binding of await this.opts.bindings.list(this.dispatcherId)) {
      if (binding.active && binding.team_name === this.id) {
        await this.opts.bindings.transferBack({
          dispatcherId: this.dispatcherId,
          channelId: binding.channel_id,
          targetKey: binding.target_key,
        });
      }
    }
    for (const member of await this.members()) {
      await this.opts.teammates.close({
        teamId: this.id,
        name: member.name,
        note: input.note,
      });
    }
    await this.leader.close({ note: input.note });
    this.record = await this.opts.store.update(this.record, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      worktree: await this.opts.worktrees.cleanup({
        source_cwd: this.record.repo_cwd,
        source_repo: this.record.source_repo,
        worktree: this.record.worktree,
      }),
    });
    return this.status();
  }

  async bindChannel(
    context: TeamChannelContext,
    input: { channelId?: string; meta: Record<string, unknown> },
  ): Promise<ChannelBinding> {
    if (this.record.status === 'closed') {
      throw new Error(`Team ${JSON.stringify(this.id)} is closed`);
    }
    const channelId = context.resolveChannelId(input.channelId);
    const target = await context.resolveChannelTarget(input.meta, channelId);
    return this.opts.bindings.bind({
      dispatcherId: this.dispatcherId,
      channelId,
      provider: context.channelProviderRef(channelId),
      target,
      teamName: this.id,
      leaderName: this.record.leader_name,
    });
  }

  async resolveLeaderChannel(input: {
    leaderName: string;
    targetKey: string;
  }): Promise<string | null> {
    const bindings = await this.opts.bindings.list(this.dispatcherId);
    const match = bindings.find(
      (binding) =>
        binding.active &&
        binding.target_key === input.targetKey &&
        binding.team_name === this.id &&
        binding.leader_name === input.leaderName,
    );
    if (match === undefined) return null;
    if (this.record.status === 'closed') return null;
    return match.channel_id;
  }

  async deliverToLeader(
    turn: InboundTurnInput,
  ): Promise<import('@excitedjs/dreamux-types').AgentRuntimeTurnResult> {
    if (this.record.status === 'closed') return { status: 'stopped' };
    return this.leader.channelInput(turn);
  }

  sharedWorkspace(): TeamMateSharedWorkspace {
    return {
      sourceCwd: this.record.repo_cwd,
      sourceRepo: this.record.source_repo,
      runtimeCwd: this.record.runtime_cwd,
      worktree: this.record.worktree,
    };
  }

  async spawnTeamMate(
    input: Omit<SpawnTeamMateRequest, 'teamId' | 'sharedWorkspace'>,
  ) {
    return this.opts.teammates.spawn({
      teamId: this.id,
      ...input,
      sharedWorkspace: this.sharedWorkspace(),
    });
  }

  sendTeamMate(input: Omit<SendTeamMateInput, 'teamId'>) {
    return this.opts.teammates.send({
      teamId: this.id,
      ...input,
    });
  }

  closeTeamMate(input: Omit<CloseTeamMateInput, 'teamId'>) {
    return this.opts.teammates.close({
      teamId: this.id,
      ...input,
    });
  }

  listTeamMates(): Promise<TeamMateRuntimeStatus[]> {
    return this.opts.teammates.list(this.id);
  }

  getTeamMateStatus(name: string) {
    return this.opts.teammates.status(name, this.id);
  }

  getTeamMateHistory(input: Omit<TeamMateHistoryQuery, 'teamId'>) {
    return this.opts.teammates.history({
      teamId: this.id,
      ...input,
    });
  }

  getTeamMateLast(name: string, turns?: number) {
    return this.opts.teammates.last(name, turns, this.id);
  }

  getTeamMateCapabilities() {
    return this.opts.teammates.getCapabilities();
  }

  private async members(): Promise<TeamMateRuntimeStatus[]> {
    // `list(teamId)` is members-only — the leader lives at the team root and is
    // held as `this.leader`, never a member row (issue #233 Phase 4).
    return this.opts.teammates.list(this.id);
  }

  private async memberCount(): Promise<number> {
    return (await this.members()).length;
  }

  private async activeGroupBinding(): Promise<TeamChannelBindingSummary | null> {
    const bindings = await this.opts.bindings.list(this.dispatcherId);
    const active = bindings.find(
      (binding) => binding.active && binding.team_name === this.id,
    );
    if (active === undefined) return null;
    const chatId = active.meta['chat_id'];
    return {
      provider: active.provider,
      chat_id: typeof chatId === 'string' ? chatId : active.target_key,
    };
  }
}

function teamView(team: TeamRecord): TeamView {
  return {
    team_name: team.team_id,
    status: team.status,
    intent: team.intent,
    source_repo: team.source_repo,
    leader_name: team.leader_name,
    leader_agent_runtime: team.leader_agent_runtime,
    created_at: team.created_at,
    updated_at: team.updated_at,
    closed_at: team.closed_at,
    close_note: team.close_note,
  };
}

function teamLeaderPrompt(team: TeamRecord): string {
  return [
    'You are the TeamLeader for this Dreamux team.',
    `Team: ${team.name}`,
    `Repository cwd: ${team.repo_cwd}`,
    team.intent !== null ? `Intent: ${team.intent}` : '',
  ].filter((line) => line !== '').join('\n');
}

function matchesTeamHistoryQuery(
  row: TeamHistoryRow,
  input: Omit<TeamHistoryQuery, 'dispatcherId'>,
): boolean {
  if (input.name !== undefined && row.team_name !== validateTeamId(input.name)) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    const hit = row.source_repo !== null && row.source_repo.toLowerCase().includes(needle);
    if (!hit) return false;
  }
  if (input.grep !== undefined && !teamRowMatchesText(row, input.grep)) {
    return false;
  }
  if (input.since !== undefined && row.updated_at < input.since) return false;
  if (input.until !== undefined && row.updated_at > input.until) return false;
  return true;
}

function teamRowMatchesText(row: TeamHistoryRow, grep: string): boolean {
  const needle = grep.toLowerCase();
  if (needle === '') return true;
  return [
    row.team_name,
    row.intent,
    row.source_repo,
    row.leader_name,
    row.close_note,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function clampTeamHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

function encodeTeamCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeTeamCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
  }
  throw new Error('invalid history cursor');
}

function previewTeamText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}
